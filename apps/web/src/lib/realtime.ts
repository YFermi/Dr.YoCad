import { io, type Socket } from 'socket.io-client';
import {
  buildClientEvent,
  fileRoomName,
  REALTIME_EVENTS,
  type ClientEvent,
  type FileJoinPayload,
  type RealtimeEventPayloadMap,
  type ServerEvent,
} from '@cadline/shared';
import { registerSocketIdProvider } from './api';
import { subscribeAuthChange, useAuthStore } from './auth';

type ConnectionListener = (connected: boolean, isReconnect: boolean) => void;
type GenericServerListener = (event: ServerEvent<unknown>) => void;

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (typeof window !== 'undefined' ? window.location.origin : '');

class RealtimeClient {
  private socket: Socket | null = null;
  private activeFileId: string | null = null;
  private hasConnectedOnce = false;
  private lastAuthSignature = '';
  private connectionListeners = new Set<ConnectionListener>();
  private eventListeners = new Map<string, Set<GenericServerListener>>();

  constructor() {
    registerSocketIdProvider(() => this.getSocketId());

    subscribeAuthChange(({ accessToken, userName }) => {
      const nextSig = `${accessToken ?? ''}|${userName ?? ''}`;
      if (!this.socket || nextSig === this.lastAuthSignature) {
        return;
      }
      this.lastAuthSignature = nextSig;
      this.socket.auth = {
        ...(accessToken ? { token: accessToken } : {}),
        ...(userName ? { name: userName } : {}),
      };
      if (this.socket.connected) {
        // Reconnect cleanly so server re-authenticates socket with refreshed JWT
        this.socket.disconnect().connect();
      } else if (this.activeFileId) {
        this.socket.connect();
      }
    });
  }

  private ensureSocket(): Socket {
    if (this.socket) {
      return this.socket;
    }

    const authState = useAuthStore.getState();
    const token = authState.accessToken;
    const name = authState.user?.name ?? null;
    this.lastAuthSignature = `${token ?? ''}|${name ?? ''}`;

    const socket = io(SOCKET_URL, {
      path: '/socket.io',
      autoConnect: false,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 600,
      reconnectionDelayMax: 5000,
      auth: {
        ...(token ? { token } : {}),
        ...(name ? { name } : {}),
      },
    });

    socket.on('connect', () => {
      const isReconnect = this.hasConnectedOnce;
      this.hasConnectedOnce = true;

      if (this.activeFileId) {
        const room = fileRoomName(this.activeFileId);
        const envelope: ClientEvent<FileJoinPayload> = buildClientEvent(room, {
          fileId: this.activeFileId,
        });
        socket.emit(REALTIME_EVENTS.FILE_JOIN, envelope);
      }

      for (const listener of this.connectionListeners) {
        listener(true, isReconnect);
      }
    });

    socket.on('disconnect', () => {
      for (const listener of this.connectionListeners) {
        listener(false, false);
      }
    });

    // Attach already-registered event listeners onto the socket instance
    for (const [eventName, handlers] of this.eventListeners.entries()) {
      for (const handler of handlers) {
        socket.on(eventName, handler);
      }
    }

    this.socket = socket;
    return socket;
  }

  public connect(): void {
    const socket = this.ensureSocket();
    const authState = useAuthStore.getState();
    socket.auth = {
      ...(authState.accessToken ? { token: authState.accessToken } : {}),
      ...(authState.user?.name ? { name: authState.user.name } : {}),
    };
    if (!socket.connected) {
      socket.connect();
    }
  }

  public joinFile(fileId: string): void {
    const prevFileId = this.activeFileId;
    if (prevFileId && prevFileId !== fileId) {
      this.leaveFile(prevFileId);
    }

    this.activeFileId = fileId;
    const socket = this.ensureSocket();

    if (socket.connected) {
      const room = fileRoomName(fileId);
      const envelope: ClientEvent<FileJoinPayload> = buildClientEvent(room, {
        fileId,
      });
      socket.emit(REALTIME_EVENTS.FILE_JOIN, envelope);
    } else {
      this.connect();
    }
  }

  public leaveFile(fileId: string): void {
    if (this.activeFileId === fileId) {
      this.activeFileId = null;
    }

    if (this.socket?.connected) {
      const room = fileRoomName(fileId);
      const envelope: ClientEvent<FileJoinPayload> = buildClientEvent(room, {
        fileId,
      });
      this.socket.emit(REALTIME_EVENTS.FILE_LEAVE, envelope);
    }
  }

  public emit<T>(eventName: string, room: string, payload: T): void {
    if (!this.socket?.connected) return;
    const envelope: ClientEvent<T> = buildClientEvent(room, payload);
    this.socket.emit(eventName, envelope);
  }

  public subscribe<K extends keyof RealtimeEventPayloadMap>(
    eventName: K,
    handler: (event: ServerEvent<RealtimeEventPayloadMap[K]>) => void
  ): () => void {
    const eventKey: string = eventName;
    const wrapped = handler as unknown as GenericServerListener;
    let bucket = this.eventListeners.get(eventKey);
    if (!bucket) {
      bucket = new Set();
      this.eventListeners.set(eventKey, bucket);
    }
    bucket.add(wrapped);

    if (this.socket) {
      this.socket.on(eventKey, wrapped);
    }

    return () => {
      bucket?.delete(wrapped);
      if (bucket && bucket.size === 0) {
        this.eventListeners.delete(eventKey);
      }
      this.socket?.off(eventKey, wrapped);
    };
  }

  public onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  public getSocketId(): string | null {
    return this.socket?.id ?? null;
  }

  public isConnected(): boolean {
    return Boolean(this.socket?.connected);
  }

  public getActiveFileId(): string | null {
    return this.activeFileId;
  }
}

export const realtimeClient = new RealtimeClient();
