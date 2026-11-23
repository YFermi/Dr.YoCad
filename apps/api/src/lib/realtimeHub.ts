import type { Server as SocketIOServer, Socket } from 'socket.io';
import {
  buildServerEvent,
  computeAvatarColor,
  fileRoomName,
  REALTIME_EVENTS,
  type CameraSyncPayload,
  type ClientEvent,
  type ConversionMode,
  type CursorMovePayload,
  type FileJoinPayload,
  type FollowErrorPayload,
  type FollowStartPayload,
  type FollowStopPayload,
  type PresenceJoinPayload,
  type PresenceLeavePayload,
  type PresenceUpdatePayload,
  type PresenceUser,
  type RateLimitErrorPayload,
  type RealtimeActor,
  type RealtimeEventName,
  type RoomState,
  type ViewportSyncPayload,
} from '@cadline/shared';

export interface SocketAuthUser {
  userId: string;
  email: string;
  name: string;
  avatarColor: string;
}

export interface CollaborationHubOptions {
  verifyToken: (token: string) => { userId: string; email: string; name?: string } | null;
  resolveFileMode: (fileId: string) => Promise<ConversionMode> | ConversionMode;
  onLog?: (message: string, meta?: Record<string, unknown>) => void;
}

interface RateBucket {
  timestamps: number[];
  excess5xSince: number | null;
  lastErrorEmitTs: number;
}

const RATE_LIMITS: Record<string, number> = {
  [REALTIME_EVENTS.CURSOR_MOVE]: 20, // max 20/s
  [REALTIME_EVENTS.CAMERA_SYNC]: 15, // max 15/s
  [REALTIME_EVENTS.VIEWPORT_SYNC]: 15, // max 15/s
};

const ABUSE_MULTIPLIER = 5;
const ABUSE_DISCONNECT_WINDOW_MS = 10_000;

/**
 * Helper invoked by REST routes AFTER database persistence succeeds (B3).
 * Excludes the originating socket via `x-socket-id` so the emitter skips its own echo.
 */
export function broadcastFileDelta<T>(
  io: SocketIOServer | undefined,
  fileId: string,
  event: RealtimeEventName,
  payload: T,
  actor: RealtimeActor | null,
  originSocketId?: string
): void {
  if (!io) return;
  const room = fileRoomName(fileId);
  const envelope = buildServerEvent(room, payload, actor, originSocketId);
  if (originSocketId && originSocketId.trim().length > 0) {
    io.to(room).except(originSocketId).emit(event, envelope);
  } else {
    io.to(room).emit(event, envelope);
  }
}

function unwrapFileId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.fileId === 'string' && obj.fileId.length > 0) {
    return obj.fileId;
  }
  if (obj.payload && typeof obj.payload === 'object') {
    const inner = obj.payload as Record<string, unknown>;
    if (typeof inner.fileId === 'string' && inner.fileId.length > 0) {
      return inner.fileId;
    }
  }
  if (typeof obj.room === 'string' && obj.room.startsWith('file:')) {
    return obj.room.slice('file:'.length);
  }
  return null;
}

function unwrapClientEvent<T>(raw: unknown): ClientEvent<T> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.room !== 'string' || !obj.room.startsWith('file:')) {
    return null;
  }
  if (!('payload' in obj)) {
    return null;
  }
  return {
    room: obj.room,
    payload: obj.payload as T,
    clientTs: typeof obj.clientTs === 'number' ? obj.clientTs : Date.now(),
  };
}

function isSocketAuthUser(value: unknown): value is SocketAuthUser {
  if (!value || typeof value !== 'object') return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.userId === 'string' &&
    typeof u.email === 'string' &&
    typeof u.name === 'string' &&
    typeof u.avatarColor === 'string'
  );
}

/**
 * Attaches the Cadline Session 5 real-time collaboration hub to any Socket.IO Server instance.
 * Pure fan-out and ephemeral relay — NEVER writes to the database.
 */
export function attachCollaborationHub(
  io: SocketIOServer,
  options: CollaborationHubOptions
): {
  getRoomUsers: (fileId: string) => PresenceUser[];
} {
  // Map<roomName, Map<socketId, PresenceUser>>
  const roomPresence = new Map<string, Map<string, PresenceUser>>();

  // Map<followerSocketId, { leaderUserId: string; room: string }>
  const followers = new Map<string, { leaderUserId: string; room: string }>();

  // Ephemeral latest pose cache for instant follow sync: key = `${room}::${userId}`
  const latestCameraPoses = new Map<string, CameraSyncPayload>();
  const latestViewportPoses = new Map<string, ViewportSyncPayload>();

  // Per-socket ephemeral event rate buckets: Map<socketId, Map<eventName, RateBucket>>
  const rateBuckets = new Map<string, Map<string, RateBucket>>();

  const getRoomPresenceList = (room: string): PresenceUser[] => {
    const members = roomPresence.get(room);
    if (!members) return [];
    // Deduplicate by userId so multi-tab users show once cleanly in presence list
    const byUser = new Map<string, PresenceUser>();
    for (const member of members.values()) {
      if (!byUser.has(member.userId)) {
        byUser.set(member.userId, member);
      }
    }
    return Array.from(byUser.values());
  };

  const emitPresenceUpdate = (room: string): void => {
    const users = getRoomPresenceList(room);
    const envelope = buildServerEvent<PresenceUpdatePayload>(room, { users }, null);
    io.to(room).emit(REALTIME_EVENTS.PRESENCE_UPDATE, envelope);
  };

  const hasOtherSocketForUserInRoom = (
    room: string,
    userId: string,
    excludeSocketId: string
  ): boolean => {
    const members = roomPresence.get(room);
    if (!members) return false;
    for (const [sid, user] of members.entries()) {
      if (sid !== excludeSocketId && user.userId === userId) {
        return true;
      }
    }
    return false;
  };

  const getSocketUser = (socket: Socket): SocketAuthUser | null => {
    const data = socket.data as Record<string, unknown>;
    return isSocketAuthUser(data.user) ? data.user : null;
  };

  const toActor = (user: SocketAuthUser): RealtimeActor => ({
    userId: user.userId,
    name: user.name,
    avatarColor: user.avatarColor,
  });

  /**
   * Checks per-socket sliding 1-second rate limit for ephemeral events.
   * Returns true if allowed, false if throttled (and emits rate_limit:error).
   * Disconnects sockets exceeding 5x the limit continuously for 10 seconds.
   */
  const checkEphemeralRateLimit = (socket: Socket, eventName: string): boolean => {
    const limitPerSec = RATE_LIMITS[eventName];
    if (!limitPerSec) return true;

    const now = Date.now();
    let perSocket = rateBuckets.get(socket.id);
    if (!perSocket) {
      perSocket = new Map<string, RateBucket>();
      rateBuckets.set(socket.id, perSocket);
    }

    let bucket = perSocket.get(eventName);
    if (!bucket) {
      bucket = { timestamps: [], excess5xSince: null, lastErrorEmitTs: 0 };
      perSocket.set(eventName, bucket);
    }

    // Evict timestamps older than 1000ms
    const cutoff = now - 1000;
    while (bucket.timestamps.length > 0 && bucket.timestamps[0] < cutoff) {
      bucket.timestamps.shift();
    }
    bucket.timestamps.push(now);

    const countInWindow = bucket.timestamps.length;

    if (countInWindow >= limitPerSec * ABUSE_MULTIPLIER) {
      if (bucket.excess5xSince === null) {
        bucket.excess5xSince = now;
      } else if (now - bucket.excess5xSince >= ABUSE_DISCONNECT_WINDOW_MS) {
        const errPayload: RateLimitErrorPayload = {
          code: 'RATE_LIMITED',
          event: eventName,
          message: `Disconnected: sustained ${eventName} flood exceeded 5x limit`,
        };
        socket.emit(
          REALTIME_EVENTS.RATE_LIMIT_ERROR,
          buildServerEvent('', errPayload, null)
        );
        socket.disconnect(true);
        return false;
      }
    } else if (countInWindow <= limitPerSec) {
      bucket.excess5xSince = null;
    }

    if (countInWindow > limitPerSec) {
      if (now - bucket.lastErrorEmitTs >= 250) {
        bucket.lastErrorEmitTs = now;
        const errPayload: RateLimitErrorPayload = {
          code: 'RATE_LIMITED',
          event: eventName,
          message: `Rate limit exceeded for ${eventName} (max ${limitPerSec}/s)`,
          retryAfterMs: 1000,
        };
        socket.emit(
          REALTIME_EVENTS.RATE_LIMIT_ERROR,
          buildServerEvent('', errPayload, null)
        );
      }
      return false;
    }

    return true;
  };

  /**
   * Detects mutual or transitive follow cycles (e.g. B is already following A).
   */
  const wouldCreateFollowCycle = (
    room: string,
    followerUserId: string,
    candidateLeaderUserId: string
  ): boolean => {
    const visited = new Set<string>([followerUserId]);
    let currentLeader: string | null = candidateLeaderUserId;

    while (currentLeader) {
      if (visited.has(currentLeader)) return true;
      visited.add(currentLeader);

      let nextLeader: string | null = null;
      for (const [fSocketId, follow] of followers.entries()) {
        if (follow.room !== room) continue;
        const fMember = roomPresence.get(room)?.get(fSocketId);
        if (fMember && fMember.userId === currentLeader) {
          nextLeader = follow.leaderUserId;
          break;
        }
      }
      currentLeader = nextLeader;
    }

    return false;
  };

  const forceStopFollowersOfLeader = (room: string, leaderUserId: string): void => {
    for (const [followerSocketId, follow] of Array.from(followers.entries())) {
      if (follow.room === room && follow.leaderUserId === leaderUserId) {
        followers.delete(followerSocketId);
        const followerSocket = io.sockets.sockets.get(followerSocketId);
        if (followerSocket) {
          const followerUser = getSocketUser(followerSocket);
          const stopEnvelope = buildServerEvent<FollowStopPayload>(
            room,
            {
              leaderUserId,
              followerUserId: followerUser?.userId,
              reason: 'leader_disconnected',
            },
            null
          );
          followerSocket.emit(REALTIME_EVENTS.FOLLOW_STOP, stopEnvelope);
        }
      }
    }
  };

  const leaveRoom = (socket: Socket, room: string, user: SocketAuthUser): void => {
    const members = roomPresence.get(room);
    if (!members || !members.has(socket.id)) {
      return;
    }

    members.delete(socket.id);
    if (members.size === 0) {
      roomPresence.delete(room);
    }

    // If this socket was following someone in this room, unsubscribe it
    const activeFollow = followers.get(socket.id);
    if (activeFollow && activeFollow.room === room) {
      followers.delete(socket.id);
    }

    // If this user has no other sockets in the room, terminate any followers of this leader
    const stillInRoom = hasOtherSocketForUserInRoom(room, user.userId, socket.id);
    if (!stillInRoom) {
      forceStopFollowersOfLeader(room, user.userId);
      const poseKey = `${room}::${user.userId}`;
      latestCameraPoses.delete(poseKey);
      latestViewportPoses.delete(poseKey);

      const leaveEnvelope = buildServerEvent<PresenceLeavePayload>(
        room,
        { userId: user.userId, socketId: socket.id },
        toActor(user),
        socket.id
      );
      socket.to(room).emit(REALTIME_EVENTS.PRESENCE_LEAVE, leaveEnvelope);
    }

    emitPresenceUpdate(room);
  };

  // JWT auth middleware + deterministic avatarColor assignment
  io.use((socket, next) => {
    const authObj = socket.handshake.auth as Record<string, unknown> | undefined;
    const token = typeof authObj?.token === 'string' ? authObj.token : undefined;
    const requestedName =
      typeof authObj?.name === 'string' && authObj.name.trim().length > 0
        ? authObj.name.trim()
        : undefined;

    if (!token) {
      const guestId = `guest_${socket.id.slice(0, 6)}`;
      (socket.data as Record<string, unknown>).user = {
        userId: guestId,
        email: 'guest@share.local',
        name: requestedName ?? 'Guest Reviewer',
        avatarColor: computeAvatarColor(guestId),
      } satisfies SocketAuthUser;
      next();
      return;
    }

    const verified = options.verifyToken(token);
    if (!verified) {
      next(new Error('Unauthorized socket connection'));
      return;
    }

    (socket.data as Record<string, unknown>).user = {
      userId: verified.userId,
      email: verified.email,
      name: requestedName ?? verified.name ?? verified.email.split('@')[0],
      avatarColor: computeAvatarColor(verified.userId),
    } satisfies SocketAuthUser;
    next();
  });

  io.on('connection', (socket) => {
    const user = getSocketUser(socket);
    if (!user) {
      socket.disconnect(true);
      return;
    }
    const actor = toActor(user);

    // ---- Room Join ----
    socket.on(REALTIME_EVENTS.FILE_JOIN, async (raw: FileJoinPayload | ClientEvent<FileJoinPayload>) => {
      const fileId = unwrapFileId(raw);
      if (!fileId) return;

      const room = fileRoomName(fileId);
      await socket.join(room);

      if (!roomPresence.has(room)) {
        roomPresence.set(room, new Map());
      }

      const presenceEntry: PresenceUser = {
        userId: user.userId,
        name: user.name,
        email: user.email,
        avatarColor: user.avatarColor,
        socketId: socket.id,
        joinedAt: new Date().toISOString(),
      };
      roomPresence.get(room)?.set(socket.id, presenceEntry);

      // Broadcast presence:join to everyone else in room
      socket.to(room).emit(
        REALTIME_EVENTS.PRESENCE_JOIN,
        buildServerEvent<PresenceJoinPayload>(
          room,
          { user: presenceEntry },
          actor,
          socket.id
        )
      );

      emitPresenceUpdate(room);

      // Emit RoomState ONLY to the newly joined socket
      let mode: ConversionMode = '3D';
      try {
        mode = await options.resolveFileMode(fileId);
      } catch {
        mode = '3D';
      }

      const roomState: RoomState = {
        fileId,
        mode,
        activeUsers: getRoomPresenceList(room),
      };
      socket.emit(
        REALTIME_EVENTS.ROOM_STATE,
        buildServerEvent<RoomState>(room, roomState, null)
      );
    });

    // ---- Room Leave ----
    socket.on(REALTIME_EVENTS.FILE_LEAVE, (raw: FileJoinPayload | ClientEvent<FileJoinPayload>) => {
      const fileId = unwrapFileId(raw);
      if (!fileId) return;
      const room = fileRoomName(fileId);
      void socket.leave(room);
      leaveRoom(socket, room, user);
    });

    // ---- Delta Fan-out Relay (REST persists; socket broadcasts to others only) ----
    const deltaEvents: RealtimeEventName[] = [
      REALTIME_EVENTS.ANNOTATION_CREATE,
      REALTIME_EVENTS.ANNOTATION_UPDATE,
      REALTIME_EVENTS.ANNOTATION_DELETE,
      REALTIME_EVENTS.COMMENT_CREATE,
      REALTIME_EVENTS.COMMENT_UPDATE,
      REALTIME_EVENTS.COMMENT_DELETE,
      REALTIME_EVENTS.MEASUREMENT_CREATE,
      REALTIME_EVENTS.MEASUREMENT_DELETE,
    ];

    for (const eventName of deltaEvents) {
      socket.on(eventName, (raw: unknown) => {
        const evt = unwrapClientEvent<unknown>(raw);
        if (!evt) return;
        if (!socket.rooms.has(evt.room)) return;

        socket.to(evt.room).emit(
          eventName,
          buildServerEvent(evt.room, evt.payload, actor, socket.id)
        );
      });
    }

    // ---- Ephemeral Cursor Move (max 20/s) ----
    socket.on(REALTIME_EVENTS.CURSOR_MOVE, (raw: unknown) => {
      if (!checkEphemeralRateLimit(socket, REALTIME_EVENTS.CURSOR_MOVE)) {
        return;
      }
      const evt = unwrapClientEvent<CursorMovePayload>(raw);
      if (!evt || !socket.rooms.has(evt.room)) return;

      socket.to(evt.room).emit(
        REALTIME_EVENTS.CURSOR_MOVE,
        buildServerEvent<CursorMovePayload>(evt.room, evt.payload, actor, socket.id)
      );
    });

    // ---- Ephemeral 3D Camera Sync (max 15/s, delivered ONLY to followers) ----
    socket.on(REALTIME_EVENTS.CAMERA_SYNC, (raw: unknown) => {
      if (!checkEphemeralRateLimit(socket, REALTIME_EVENTS.CAMERA_SYNC)) {
        return;
      }
      const evt = unwrapClientEvent<CameraSyncPayload>(raw);
      if (!evt || !socket.rooms.has(evt.room)) return;

      const poseKey = `${evt.room}::${user.userId}`;
      latestCameraPoses.set(poseKey, evt.payload);

      const envelope = buildServerEvent<CameraSyncPayload>(
        evt.room,
        evt.payload,
        actor,
        socket.id
      );

      for (const [followerSocketId, follow] of followers.entries()) {
        if (
          followerSocketId !== socket.id &&
          follow.room === evt.room &&
          follow.leaderUserId === user.userId
        ) {
          io.to(followerSocketId).emit(REALTIME_EVENTS.CAMERA_SYNC, envelope);
        }
      }
    });

    // ---- Ephemeral 2D Viewport Sync (max 15/s, delivered ONLY to followers) ----
    socket.on(REALTIME_EVENTS.VIEWPORT_SYNC, (raw: unknown) => {
      if (!checkEphemeralRateLimit(socket, REALTIME_EVENTS.VIEWPORT_SYNC)) {
        return;
      }
      const evt = unwrapClientEvent<ViewportSyncPayload>(raw);
      if (!evt || !socket.rooms.has(evt.room)) return;

      const poseKey = `${evt.room}::${user.userId}`;
      latestViewportPoses.set(poseKey, evt.payload);

      const envelope = buildServerEvent<ViewportSyncPayload>(
        evt.room,
        evt.payload,
        actor,
        socket.id
      );

      for (const [followerSocketId, follow] of followers.entries()) {
        if (
          followerSocketId !== socket.id &&
          follow.room === evt.room &&
          follow.leaderUserId === user.userId
        ) {
          io.to(followerSocketId).emit(REALTIME_EVENTS.VIEWPORT_SYNC, envelope);
        }
      }
    });

    // ---- Follow Start / Stop (with Mutual Follow Prevention) ----
    socket.on(REALTIME_EVENTS.FOLLOW_START, (raw: unknown) => {
      const evt = unwrapClientEvent<FollowStartPayload>(raw);
      if (!evt || !socket.rooms.has(evt.room)) return;
      const leaderUserId = evt.payload?.leaderUserId;
      if (typeof leaderUserId !== 'string' || leaderUserId.length === 0) return;

      if (leaderUserId === user.userId) {
        socket.emit(
          REALTIME_EVENTS.FOLLOW_ERROR,
          buildServerEvent<FollowErrorPayload>(
            evt.room,
            {
              code: 'SELF_FOLLOW',
              message: 'You cannot follow your own view.',
            },
            null
          )
        );
        return;
      }

      if (wouldCreateFollowCycle(evt.room, user.userId, leaderUserId)) {
        socket.emit(
          REALTIME_EVENTS.FOLLOW_ERROR,
          buildServerEvent<FollowErrorPayload>(
            evt.room,
            {
              code: 'MUTUAL_FOLLOW',
              message: "You can't follow someone who's following you.",
            },
            null
          )
        );
        return;
      }

      // Verify leader is present in the room
      const roomUsers = getRoomPresenceList(evt.room);
      const leader = roomUsers.find((u) => u.userId === leaderUserId);
      if (!leader) {
        socket.emit(
          REALTIME_EVENTS.FOLLOW_ERROR,
          buildServerEvent<FollowErrorPayload>(
            evt.room,
            {
              code: 'LEADER_NOT_FOUND',
              message: 'Selected reviewer is no longer in this room.',
            },
            null
          )
        );
        return;
      }

      followers.set(socket.id, { leaderUserId, room: evt.room });

      // Broadcast follow:start so UI can show status if desired
      io.to(evt.room).emit(
        REALTIME_EVENTS.FOLLOW_START,
        buildServerEvent(
          evt.room,
          { leaderUserId, followerUserId: user.userId },
          actor,
          socket.id
        )
      );

      // Forward leader's latest pose immediately so follower syncs without waiting
      const leaderActor: RealtimeActor = {
        userId: leader.userId,
        name: leader.name,
        avatarColor: leader.avatarColor ?? computeAvatarColor(leader.userId),
      };
      const poseKey = `${evt.room}::${leaderUserId}`;
      const cachedCam = latestCameraPoses.get(poseKey);
      if (cachedCam) {
        socket.emit(
          REALTIME_EVENTS.CAMERA_SYNC,
          buildServerEvent<CameraSyncPayload>(evt.room, cachedCam, leaderActor)
        );
      }
      const cachedVp = latestViewportPoses.get(poseKey);
      if (cachedVp) {
        socket.emit(
          REALTIME_EVENTS.VIEWPORT_SYNC,
          buildServerEvent<ViewportSyncPayload>(evt.room, cachedVp, leaderActor)
        );
      }
    });

    socket.on(REALTIME_EVENTS.FOLLOW_STOP, (raw: unknown) => {
      const evt = unwrapClientEvent<FollowStopPayload>(raw);
      const existing = followers.get(socket.id);
      if (!existing) return;

      followers.delete(socket.id);
      const room = evt?.room ?? existing.room;

      io.to(room).emit(
        REALTIME_EVENTS.FOLLOW_STOP,
        buildServerEvent<FollowStopPayload>(
          room,
          {
            leaderUserId: existing.leaderUserId,
            followerUserId: user.userId,
            reason: 'stopped',
          },
          actor,
          socket.id
        )
      );
    });

    // ---- Disconnecting Cleanup ----
    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (!room.startsWith('file:')) continue;
        leaveRoom(socket, room, user);
      }
      followers.delete(socket.id);
      rateBuckets.delete(socket.id);
    });
  });

  return {
    getRoomUsers: (fileId: string) => getRoomPresenceList(fileRoomName(fileId)),
  };
}
