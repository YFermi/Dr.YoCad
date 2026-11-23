import { create } from 'zustand';
import type { PresenceUser } from '@cadline/shared';

interface PresenceState {
  users: PresenceUser[];
  /** userId of the leader currently being followed, or null when independent */
  activeUserId: string | null;
  connected: boolean;
  /** Newly arrived remote comment IDs for 200ms soft background flash */
  recentCommentIds: Record<string, number>;
  /** Newly arrived remote annotation IDs for 1.2s pin pulse animation */
  recentAnnotationIds: Record<string, number>;

  setPresence: (users: PresenceUser[]) => void;
  addUser: (user: PresenceUser) => void;
  removeUser: (userId: string, socketId?: string) => void;
  setActive: (leaderUserId: string | null) => void;
  setConnected: (connected: boolean) => void;
  markCommentFlash: (commentId: string) => void;
  markAnnotationPulse: (annotationId: string) => void;
  clear: () => void;
}

const commentFlashTimers = new Map<string, ReturnType<typeof setTimeout>>();
const annotationPulseTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const usePresenceStore = create<PresenceState>((set) => ({
  users: [],
  activeUserId: null,
  connected: false,
  recentCommentIds: {},
  recentAnnotationIds: {},

  setPresence: (users) =>
    set((state) => {
      const leaderStillPresent =
        state.activeUserId !== null &&
        users.some((u) => u.userId === state.activeUserId);
      return {
        users,
        activeUserId: leaderStillPresent ? state.activeUserId : null,
      };
    }),

  addUser: (user) =>
    set((state) => {
      const existsIdx = state.users.findIndex((u) => u.userId === user.userId);
      if (existsIdx >= 0) {
        const next = [...state.users];
        next[existsIdx] = user;
        return { users: next };
      }
      return { users: [...state.users, user] };
    }),

  removeUser: (userId, socketId) =>
    set((state) => {
      const next = state.users.filter((u) => {
        if (u.userId !== userId) return true;
        if (socketId && u.socketId && u.socketId !== socketId) return true;
        return false;
      });
      const leaderGone =
        state.activeUserId !== null &&
        !next.some((u) => u.userId === state.activeUserId);
      return {
        users: next,
        activeUserId: leaderGone ? null : state.activeUserId,
      };
    }),

  setActive: (leaderUserId) => set({ activeUserId: leaderUserId }),

  setConnected: (connected) => set({ connected }),

  markCommentFlash: (commentId) => {
    const existing = commentFlashTimers.get(commentId);
    if (existing) clearTimeout(existing);

    set((state) => ({
      recentCommentIds: { ...state.recentCommentIds, [commentId]: Date.now() },
    }));

    const timer = setTimeout(() => {
      commentFlashTimers.delete(commentId);
      set((state) => {
        if (!(commentId in state.recentCommentIds)) return state;
        const next = { ...state.recentCommentIds };
        delete next[commentId];
        return { recentCommentIds: next };
      });
    }, 320);
    commentFlashTimers.set(commentId, timer);
  },

  markAnnotationPulse: (annotationId) => {
    const existing = annotationPulseTimers.get(annotationId);
    if (existing) clearTimeout(existing);

    set((state) => ({
      recentAnnotationIds: {
        ...state.recentAnnotationIds,
        [annotationId]: Date.now(),
      },
    }));

    const timer = setTimeout(() => {
      annotationPulseTimers.delete(annotationId);
      set((state) => {
        if (!(annotationId in state.recentAnnotationIds)) return state;
        const next = { ...state.recentAnnotationIds };
        delete next[annotationId];
        return { recentAnnotationIds: next };
      });
    }, 1250);
    annotationPulseTimers.set(annotationId, timer);
  },

  clear: () => {
    for (const timer of commentFlashTimers.values()) clearTimeout(timer);
    for (const timer of annotationPulseTimers.values()) clearTimeout(timer);
    commentFlashTimers.clear();
    annotationPulseTimers.clear();
    set({
      users: [],
      activeUserId: null,
      recentCommentIds: {},
      recentAnnotationIds: {},
    });
  },
}));
