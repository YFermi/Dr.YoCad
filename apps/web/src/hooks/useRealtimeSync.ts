import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  computeAvatarColor,
  fileRoomName,
  normalizeAnnotation,
  REALTIME_EVENTS,
  type Annotation,
  type CameraSyncPayload,
  type Comment,
  type CommentsListResponse,
  type CommentWithReplies,
  type CursorMovePayload,
  type FollowStartPayload,
  type FollowStopPayload,
  type Measurement,
  type ViewportSyncPayload,
} from '@cadline/shared';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { realtimeClient } from '@/lib/realtime';
import { usePresenceStore } from '@/stores/presenceStore';
import { useCursorStore } from '@/stores/cursorStore';
import { toast } from '@/components/ui/toast';

const CURSOR_THROTTLE_MS = 50; // 20 Hz max
const CAMERA_THROTTLE_MS = 67; // 15 Hz max
const VIEWPORT_THROTTLE_MS = 67; // 15 Hz max

let lastCursorEmitAt = 0;
let lastCameraEmitAt = 0;
let lastViewportEmitAt = 0;
let lastCameraSig = '';
let lastViewportSig = '';

function sortByCreatedAtAsc<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

function dedupeAndSortByCreatedAt<T extends { id: string; createdAt: string }>(
  items: T[]
): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return sortByCreatedAtAsc(Array.from(byId.values()));
}

function recomputeCommentSummary(items: CommentWithReplies[]): {
  totalTopLevel: number;
  unresolvedTopLevel: number;
  resolvedTopLevel: number;
} {
  let unresolvedTopLevel = 0;
  for (const item of items) {
    if (!item.resolved) unresolvedTopLevel += 1;
  }
  return {
    totalTopLevel: items.length,
    unresolvedTopLevel,
    resolvedTopLevel: items.length - unresolvedTopLevel,
  };
}

/**
 * Throttled 20 Hz cursor emitter (safe to call from pointermove handlers).
 */
export function emitRealtimeCursorMove(payload: CursorMovePayload): void {
  const fileId = realtimeClient.getActiveFileId();
  if (!fileId || !realtimeClient.isConnected()) return;

  const now = performance.now();
  if (now - lastCursorEmitAt < CURSOR_THROTTLE_MS) return;
  lastCursorEmitAt = now;

  realtimeClient.emit(REALTIME_EVENTS.CURSOR_MOVE, fileRoomName(fileId), payload);
}

/**
 * Throttled 15 Hz 3D camera emitter; suppressed while following another user
 * or when pose has not meaningfully changed.
 */
export function emitRealtimeCameraSync(payload: CameraSyncPayload): void {
  const fileId = realtimeClient.getActiveFileId();
  if (!fileId || !realtimeClient.isConnected()) return;
  if (usePresenceStore.getState().activeUserId !== null) return;

  const now = performance.now();
  if (now - lastCameraEmitAt < CAMERA_THROTTLE_MS) return;

  const sig = `${payload.position.map((v) => v.toFixed(2)).join(',')}|${payload.target
    .map((v) => v.toFixed(2))
    .join(',')}|${payload.zoom.toFixed(3)}`;
  if (sig === lastCameraSig) return;

  lastCameraEmitAt = now;
  lastCameraSig = sig;
  realtimeClient.emit(REALTIME_EVENTS.CAMERA_SYNC, fileRoomName(fileId), payload);
}

/**
 * Throttled 15 Hz 2D viewport emitter; suppressed while following another user
 * or when transform has not changed.
 */
export function emitRealtimeViewportSync(payload: ViewportSyncPayload): void {
  const fileId = realtimeClient.getActiveFileId();
  if (!fileId || !realtimeClient.isConnected()) return;
  if (usePresenceStore.getState().activeUserId !== null) return;

  const now = performance.now();
  if (now - lastViewportEmitAt < VIEWPORT_THROTTLE_MS) return;

  const sig = `${payload.scale.toFixed(4)}|${payload.offsetX.toFixed(1)}|${payload.offsetY.toFixed(1)}|${payload.page ?? 0}`;
  if (sig === lastViewportSig) return;

  lastViewportEmitAt = now;
  lastViewportSig = sig;
  realtimeClient.emit(REALTIME_EVENTS.VIEWPORT_SYNC, fileRoomName(fileId), payload);
}

export function startFollowingUser(leaderUserId: string): void {
  const fileId = realtimeClient.getActiveFileId();
  if (!fileId) return;

  const selfId = useAuthStore.getState().user?.id;
  if (selfId && leaderUserId === selfId) return;

  usePresenceStore.getState().setActive(leaderUserId);
  useCursorStore.getState().setRemoteCameraPose(null);
  useCursorStore.getState().setRemoteViewportPose(null);

  const payload: FollowStartPayload = { leaderUserId };
  realtimeClient.emit(REALTIME_EVENTS.FOLLOW_START, fileRoomName(fileId), payload);
}

export function stopFollowingUser(): void {
  const fileId = realtimeClient.getActiveFileId();
  const prevLeader = usePresenceStore.getState().activeUserId;
  usePresenceStore.getState().setActive(null);
  useCursorStore.getState().setRemoteCameraPose(null);
  useCursorStore.getState().setRemoteViewportPose(null);

  if (fileId && prevLeader) {
    const payload: FollowStopPayload = {
      leaderUserId: prevLeader,
      reason: 'stopped',
    };
    realtimeClient.emit(REALTIME_EVENTS.FOLLOW_STOP, fileRoomName(fileId), payload);
  }
}

interface UseRealtimeSyncOptions {
  fileId: string | undefined;
  versionId?: string;
  shareToken?: string;
  onFollowPageChange?: (page: number) => void;
}

/**
 * Single real-time collaboration hook mounted once per FileViewer.
 * Handles room join/leave, presence, live cursors, follow mode,
 * direct TanStack Query cache delta merges (no list refetch per event),
 * reconnect reconciliation, and HTTP presence ping fallback.
 */
export function useRealtimeSync({
  fileId,
  shareToken,
  onFollowPageChange,
}: UseRealtimeSyncOptions): void {
  const queryClient = useQueryClient();
  const onFollowPageChangeRef = React.useRef(onFollowPageChange);
  onFollowPageChangeRef.current = onFollowPageChange;

  React.useEffect(() => {
    if (!fileId) return;

    const room = fileRoomName(fileId);
    lastCameraSig = '';
    lastViewportSig = '';

    usePresenceStore.getState().clear();
    useCursorStore.getState().clear();
    usePresenceStore.getState().setConnected(realtimeClient.isConnected());

    const isOwnEcho = (originSocketId?: string): boolean => {
      const localSocketId = realtimeClient.getSocketId();
      return Boolean(localSocketId && originSocketId && originSocketId === localSocketId);
    };

    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(
      realtimeClient.onConnectionChange((connected, isReconnect) => {
        usePresenceStore.getState().setConnected(connected);
        if (connected && isReconnect) {
          // Reconcile any missed updates while disconnected
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ['annotations', fileId] }),
            queryClient.invalidateQueries({ queryKey: ['comments', fileId] }),
            queryClient.invalidateQueries({ queryKey: ['measurements', fileId] }),
          ]);
        }
      })
    );

    // 1. Initial room snapshot (delivered only to joining socket)
    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.ROOM_STATE, (event) => {
        if (event.room !== room) return;
        usePresenceStore.getState().setPresence(event.payload.activeUsers);
      })
    );

    // 2. Presence updates
    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.PRESENCE_JOIN, (event) => {
        if (event.room !== room) return;
        usePresenceStore.getState().addUser(event.payload.user);
      })
    );

    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.PRESENCE_LEAVE, (event) => {
        if (event.room !== room) return;
        usePresenceStore
          .getState()
          .removeUser(event.payload.userId, event.payload.socketId);
        useCursorStore.getState().removeCursor(event.payload.userId);
      })
    );

    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.PRESENCE_UPDATE, (event) => {
        if (event.room !== room) return;
        usePresenceStore.getState().setPresence(event.payload.users);
      })
    );

    // 3. Annotation deltas — merge directly into TanStack Query cache without refetch
    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.ANNOTATION_CREATE, (event) => {
        if (event.room !== room || isOwnEcho(event.originSocketId)) return;
        const incoming = normalizeAnnotation(event.payload);

        const entries = queryClient.getQueriesData<Annotation[]>({
          queryKey: ['annotations', fileId],
        });
        for (const [key, current] of entries) {
          if (!current) continue;
          const keyVersion = key[2];
          if (keyVersion !== 'all' && keyVersion !== incoming.versionId) continue;
          queryClient.setQueryData<Annotation[]>(
            key,
            dedupeAndSortByCreatedAt([...current, incoming])
          );
        }

        usePresenceStore.getState().markAnnotationPulse(incoming.id);
      })
    );

    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.ANNOTATION_UPDATE, (event) => {
        if (event.room !== room || isOwnEcho(event.originSocketId)) return;
        const updated = normalizeAnnotation(event.payload);

        queryClient.setQueriesData<Annotation[]>(
          { queryKey: ['annotations', fileId] },
          (current) => {
            if (!current) return current;
            const exists = current.some((a) => a.id === updated.id);
            if (!exists) return current;
            return current.map((a) => (a.id === updated.id ? { ...a, ...updated } : a));
          }
        );
      })
    );

    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.ANNOTATION_DELETE, (event) => {
        if (event.room !== room || isOwnEcho(event.originSocketId)) return;
        const deletedId = event.payload.id;

        queryClient.setQueriesData<Annotation[]>(
          { queryKey: ['annotations', fileId] },
          (current) => {
            if (!current) return current;
            return current.filter((a) => a.id !== deletedId);
          }
        );
      })
    );

    // 4. Comment deltas — merge into CommentsListResponse cache without refetch
    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.COMMENT_CREATE, (event) => {
        if (event.room !== room || isOwnEcho(event.originSocketId)) return;
        const incoming: CommentWithReplies = {
          ...event.payload,
          replies: event.payload.replies ?? [],
        };

        const entries = queryClient.getQueriesData<CommentsListResponse>({
          queryKey: ['comments', fileId],
        });

        for (const [key, snapshot] of entries) {
          if (!snapshot) continue;
          const filterAnnotationId = key[3];
          const filterResolved = key[4];

          if (incoming.parentId) {
            let matchedParent = false;
            const nextItems = snapshot.items.map((thread) => {
              if (thread.id !== incoming.parentId) return thread;
              matchedParent = true;
              const nextReplies = dedupeAndSortByCreatedAt<Comment>([
                ...thread.replies,
                incoming,
              ]);
              return { ...thread, replies: nextReplies };
            });
            if (matchedParent) {
              queryClient.setQueryData<CommentsListResponse>(key, {
                ...snapshot,
                items: nextItems,
              });
            }
          } else {
            if (
              filterAnnotationId !== 'all' &&
              filterAnnotationId !== incoming.annotationId
            ) {
              continue;
            }
            if (filterResolved === 'true' && !incoming.resolved) continue;
            if (filterResolved === 'false' && incoming.resolved) continue;

            const mergedItems = dedupeAndSortByCreatedAt<CommentWithReplies>([
              ...snapshot.items,
              incoming,
            ]);
            queryClient.setQueryData<CommentsListResponse>(key, {
              items: mergedItems,
              summary: recomputeCommentSummary(mergedItems),
            });
          }
        }

        // Update linked annotation commentCount in cache without refetching
        if (incoming.annotationId && !incoming.parentId) {
          queryClient.setQueriesData<Annotation[]>(
            { queryKey: ['annotations', fileId] },
            (current) =>
              current?.map((ann) =>
                ann.id === incoming.annotationId
                  ? {
                      ...ann,
                      commentCount: (ann.commentCount ?? 0) + 1,
                      resolvedCommentCount:
                        (ann.resolvedCommentCount ?? 0) + (incoming.resolved ? 1 : 0),
                    }
                  : ann
              )
          );
        }

        usePresenceStore.getState().markCommentFlash(incoming.id);
      })
    );

    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.COMMENT_UPDATE, (event) => {
        if (event.room !== room || isOwnEcho(event.originSocketId)) return;
        const updated = event.payload;
        let resolvedDelta = 0;

        const entries = queryClient.getQueriesData<CommentsListResponse>({
          queryKey: ['comments', fileId],
        });

        for (const [key, snapshot] of entries) {
          if (!snapshot) continue;
          const filterResolved = key[4];
          let changed = false;

          const nextItems = snapshot.items
            .map((thread) => {
              if (thread.id === updated.id) {
                changed = true;
                if (thread.resolved !== updated.resolved) {
                  resolvedDelta = updated.resolved ? 1 : -1;
                }
                return { ...thread, ...updated };
              }
              if (thread.replies.some((r) => r.id === updated.id)) {
                changed = true;
                return {
                  ...thread,
                  replies: thread.replies.map((r) =>
                    r.id === updated.id ? { ...r, ...updated } : r
                  ),
                };
              }
              return thread;
            })
            .filter((thread) => {
              if (filterResolved === 'false') return !thread.resolved;
              if (filterResolved === 'true') return thread.resolved;
              return true;
            });

          if (changed) {
            queryClient.setQueryData<CommentsListResponse>(key, {
              items: nextItems,
              summary: recomputeCommentSummary(nextItems),
            });
          }
        }

        if (resolvedDelta !== 0 && updated.annotationId && !updated.parentId) {
          queryClient.setQueriesData<Annotation[]>(
            { queryKey: ['annotations', fileId] },
            (current) =>
              current?.map((ann) =>
                ann.id === updated.annotationId
                  ? {
                      ...ann,
                      resolvedCommentCount: Math.max(
                        0,
                        (ann.resolvedCommentCount ?? 0) + resolvedDelta
                      ),
                    }
                  : ann
              )
          );
        }
      })
    );

    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.COMMENT_DELETE, (event) => {
        if (event.room !== room || isOwnEcho(event.originSocketId)) return;
        const deletedId = event.payload.id;

        queryClient.setQueriesData<CommentsListResponse>(
          { queryKey: ['comments', fileId] },
          (snapshot) => {
            if (!snapshot) return snapshot;
            const nextItems = snapshot.items
              .filter((thread) => thread.id !== deletedId)
              .map((thread) => ({
                ...thread,
                replies: thread.replies.filter((r) => r.id !== deletedId),
              }));
            return {
              items: nextItems,
              summary: recomputeCommentSummary(nextItems),
            };
          }
        );
      })
    );

    // 5. Measurement deltas — merge directly into TanStack Query cache
    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.MEASUREMENT_CREATE, (event) => {
        if (event.room !== room || isOwnEcho(event.originSocketId)) return;
        const incoming = event.payload;

        const entries = queryClient.getQueriesData<Measurement[]>({
          queryKey: ['measurements', fileId],
        });
        for (const [key, current] of entries) {
          if (!current) continue;
          const keyVersion = key[2];
          if (keyVersion !== 'all' && keyVersion !== incoming.versionId) continue;
          queryClient.setQueryData<Measurement[]>(
            key,
            dedupeAndSortByCreatedAt([...current, incoming])
          );
        }
      })
    );

    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.MEASUREMENT_DELETE, (event) => {
        if (event.room !== room || isOwnEcho(event.originSocketId)) return;
        const deletedId = event.payload.id;

        queryClient.setQueriesData<Measurement[]>(
          { queryKey: ['measurements', fileId] },
          (current) => current?.filter((m) => m.id !== deletedId)
        );
      })
    );

    // 6. Ephemeral live cursors
    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.CURSOR_MOVE, (event) => {
        if (event.room !== room || isOwnEcho(event.originSocketId) || !event.actor) {
          return;
        }
        const selfId = useAuthStore.getState().user?.id;
        if (selfId && event.actor.userId === selfId) return;

        useCursorStore.getState().updateCursor(event.actor.userId, {
          userId: event.actor.userId,
          name: event.actor.name,
          color: event.actor.avatarColor || computeAvatarColor(event.actor.userId),
          x: event.payload.x,
          y: event.payload.y,
          z: event.payload.z,
          sheet: event.payload.sheet,
          page: event.payload.page,
          lastSeen: Date.now(),
        });
      })
    );

    // 7. Follow-mode camera & viewport sync
    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.CAMERA_SYNC, (event) => {
        if (event.room !== room || !event.actor) return;
        const followingId = usePresenceStore.getState().activeUserId;
        if (!followingId || event.actor.userId !== followingId) return;

        useCursorStore.getState().setRemoteCameraPose({
          ...event.payload,
          leaderUserId: event.actor.userId,
          receivedAt: Date.now(),
        });
      })
    );

    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.VIEWPORT_SYNC, (event) => {
        if (event.room !== room || !event.actor) return;
        const followingId = usePresenceStore.getState().activeUserId;
        if (!followingId || event.actor.userId !== followingId) return;

        useCursorStore.getState().setRemoteViewportPose({
          ...event.payload,
          leaderUserId: event.actor.userId,
          receivedAt: Date.now(),
        });

        if (event.payload.page !== undefined) {
          onFollowPageChangeRef.current?.(event.payload.page);
        }
      })
    );

    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.FOLLOW_STOP, (event) => {
        if (event.room !== room) return;
        const currentLeader = usePresenceStore.getState().activeUserId;
        if (
          currentLeader &&
          (!event.payload.leaderUserId ||
            event.payload.leaderUserId === currentLeader)
        ) {
          usePresenceStore.getState().setActive(null);
          useCursorStore.getState().setRemoteCameraPose(null);
          useCursorStore.getState().setRemoteViewportPose(null);
          if (event.payload.reason === 'leader_disconnected') {
            toast.info('Follow mode ended', 'The user you were following left the file.');
          }
        }
      })
    );

    unsubscribers.push(
      realtimeClient.subscribe(REALTIME_EVENTS.FOLLOW_ERROR, (event) => {
        if (event.room !== room) return;
        usePresenceStore.getState().setActive(null);
        useCursorStore.getState().setRemoteCameraPose(null);
        useCursorStore.getState().setRemoteViewportPose(null);
        toast.info('Follow unavailable', event.payload.message);
      })
    );

    // Join the file room now that all subscriptions are active
    realtimeClient.joinFile(fileId);

    // Prune stale remote cursors (>5s without movement) every 1s
    const pruneInterval = setInterval(() => {
      useCursorStore.getState().pruneStale(5000);
    }, 1000);

    // HTTP presence ping fallback when WebSocket is disconnected (15s interval)
    const fallbackPingInterval = setInterval(() => {
      if (realtimeClient.isConnected()) return;
      if (shareToken || !useAuthStore.getState().accessToken) return;
      void apiFetch(`/files/${fileId}/presence/ping`, {
        method: 'POST',
      }).catch(() => {
        // Silent fallback error
      });
    }, 15000);

    return () => {
      clearInterval(pruneInterval);
      clearInterval(fallbackPingInterval);
      for (const unsub of unsubscribers) unsub();
      realtimeClient.leaveFile(fileId);
      usePresenceStore.getState().clear();
      useCursorStore.getState().clear();
    };
  }, [fileId, queryClient, shareToken]);
}
