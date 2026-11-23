import { create } from 'zustand';
import type { CameraSyncPayload, ViewportSyncPayload } from '@cadline/shared';

export interface RemoteCursor {
  userId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  z?: number;
  sheet?: 'dxf' | 'pdf';
  page?: number;
  lastSeen: number;
}

export interface RemoteCameraTarget extends CameraSyncPayload {
  leaderUserId: string;
  receivedAt: number;
}

export interface RemoteViewportTarget extends ViewportSyncPayload {
  leaderUserId: string;
  receivedAt: number;
}

interface CursorState {
  cursors: Record<string, RemoteCursor>;
  remoteCameraPose: RemoteCameraTarget | null;
  remoteViewportPose: RemoteViewportTarget | null;

  updateCursor: (userId: string, cursor: RemoteCursor) => void;
  removeCursor: (userId: string) => void;
  pruneStale: (maxAgeMs?: number) => void;
  setRemoteCameraPose: (pose: RemoteCameraTarget | null) => void;
  setRemoteViewportPose: (pose: RemoteViewportTarget | null) => void;
  clear: () => void;
}

export const useCursorStore = create<CursorState>((set) => ({
  cursors: {},
  remoteCameraPose: null,
  remoteViewportPose: null,

  updateCursor: (userId, cursor) =>
    set((state) => ({
      cursors: {
        ...state.cursors,
        [userId]: cursor,
      },
    })),

  removeCursor: (userId) =>
    set((state) => {
      if (!(userId in state.cursors)) return state;
      const next = { ...state.cursors };
      delete next[userId];
      return { cursors: next };
    }),

  pruneStale: (maxAgeMs = 5000) =>
    set((state) => {
      const now = Date.now();
      let changed = false;
      const next: Record<string, RemoteCursor> = {};
      for (const [id, cursor] of Object.entries(state.cursors)) {
        if (now - cursor.lastSeen <= maxAgeMs) {
          next[id] = cursor;
        } else {
          changed = true;
        }
      }
      return changed ? { cursors: next } : state;
    }),

  setRemoteCameraPose: (pose) => set({ remoteCameraPose: pose }),

  setRemoteViewportPose: (pose) => set({ remoteViewportPose: pose }),

  clear: () =>
    set({
      cursors: {},
      remoteCameraPose: null,
      remoteViewportPose: null,
    }),
}));
