import type {
  Annotation,
  Comment,
  CommentWithReplies,
  ConversionMode,
  Measurement,
  PresenceUser,
  Vec3Tuple,
} from './types.js';

export const REALTIME_PROTOCOL_VERSION = 1 as const;

export const REALTIME_EVENTS = {
  FILE_JOIN: 'file:join',
  FILE_LEAVE: 'file:leave',
  ROOM_STATE: 'room:state',
  PRESENCE_JOIN: 'presence:join',
  PRESENCE_LEAVE: 'presence:leave',
  PRESENCE_UPDATE: 'presence:update',
  ANNOTATION_CREATE: 'annotation:create',
  ANNOTATION_UPDATE: 'annotation:update',
  ANNOTATION_DELETE: 'annotation:delete',
  COMMENT_CREATE: 'comment:create',
  COMMENT_UPDATE: 'comment:update',
  COMMENT_DELETE: 'comment:delete',
  MEASUREMENT_CREATE: 'measurement:create',
  MEASUREMENT_DELETE: 'measurement:delete',
  CURSOR_MOVE: 'cursor:move',
  CAMERA_SYNC: 'camera:sync',
  VIEWPORT_SYNC: 'viewport:sync',
  FOLLOW_START: 'follow:start',
  FOLLOW_STOP: 'follow:stop',
  FOLLOW_ERROR: 'follow:error',
  RATE_LIMIT_ERROR: 'rate_limit:error',
} as const;

export type RealtimeEventName =
  (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

export interface RealtimeActor {
  userId: string;
  name: string;
  avatarColor: string;
}

/**
 * Every client -> server realtime event uses this envelope.
 */
export interface ClientEvent<T = unknown> {
  room: string; // "file:<id>"
  payload: T;
  clientTs: number; // client clock, for echo dedupe
}

/**
 * Every server -> client realtime event uses this envelope.
 */
export interface ServerEvent<T = unknown> {
  room: string;
  payload: T;
  serverTs: number; // authoritative clock
  actor: RealtimeActor | null; // null on system events
  originSocketId?: string; // set on broadcasts; used by sender to skip own echo
}

/**
 * On-connect snapshot delivered only to the joining socket.
 * Bulk annotations/comments/measurements are loaded via REST; sockets carry deltas only.
 */
export interface RoomState {
  fileId: string;
  mode: ConversionMode;
  activeUsers: PresenceUser[];
}

export interface FileJoinPayload {
  fileId: string;
}

export interface PresenceJoinPayload {
  user: PresenceUser;
}

export interface PresenceLeavePayload {
  userId: string;
  socketId: string;
}

export interface PresenceUpdatePayload {
  users: PresenceUser[];
}

export interface CursorMovePayload {
  x: number;
  y: number;
  z?: number;
  sheet?: 'dxf' | 'pdf';
  page?: number;
}

export interface CameraSyncPayload {
  position: Vec3Tuple;
  target: Vec3Tuple;
  zoom: number;
}

export interface ViewportSyncPayload {
  scale: number;
  offsetX: number;
  offsetY: number;
  page?: number;
}

export interface FollowStartPayload {
  leaderUserId: string;
}

export interface FollowStopPayload {
  leaderUserId?: string;
  followerUserId?: string;
  reason?: 'stopped' | 'leader_disconnected';
}

export interface FollowErrorPayload {
  code: 'MUTUAL_FOLLOW' | 'LEADER_NOT_FOUND' | 'SELF_FOLLOW';
  message: string;
}

export interface RateLimitErrorPayload {
  code: 'RATE_LIMITED';
  event: string;
  message: string;
  retryAfterMs?: number;
}

export interface EntityDeletePayload {
  id: string;
  fileId: string;
  versionId?: string;
}

export interface RealtimeEventPayloadMap {
  [REALTIME_EVENTS.ROOM_STATE]: RoomState;
  [REALTIME_EVENTS.PRESENCE_JOIN]: PresenceJoinPayload;
  [REALTIME_EVENTS.PRESENCE_LEAVE]: PresenceLeavePayload;
  [REALTIME_EVENTS.PRESENCE_UPDATE]: PresenceUpdatePayload;
  [REALTIME_EVENTS.ANNOTATION_CREATE]: Annotation;
  [REALTIME_EVENTS.ANNOTATION_UPDATE]: Annotation;
  [REALTIME_EVENTS.ANNOTATION_DELETE]: EntityDeletePayload;
  [REALTIME_EVENTS.COMMENT_CREATE]: CommentWithReplies;
  [REALTIME_EVENTS.COMMENT_UPDATE]: Comment;
  [REALTIME_EVENTS.COMMENT_DELETE]: EntityDeletePayload;
  [REALTIME_EVENTS.MEASUREMENT_CREATE]: Measurement;
  [REALTIME_EVENTS.MEASUREMENT_DELETE]: EntityDeletePayload;
  [REALTIME_EVENTS.CURSOR_MOVE]: CursorMovePayload;
  [REALTIME_EVENTS.CAMERA_SYNC]: CameraSyncPayload;
  [REALTIME_EVENTS.VIEWPORT_SYNC]: ViewportSyncPayload;
  [REALTIME_EVENTS.FOLLOW_START]: FollowStartPayload & { followerUserId?: string };
  [REALTIME_EVENTS.FOLLOW_STOP]: FollowStopPayload;
  [REALTIME_EVENTS.FOLLOW_ERROR]: FollowErrorPayload;
  [REALTIME_EVENTS.RATE_LIMIT_ERROR]: RateLimitErrorPayload;
}

/**
 * Deterministic avatar color derived from userId hash: hsl(hash % 360, 65%, 55%).
 */
export function computeAvatarColor(userId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

export function fileRoomName(fileId: string): string {
  return `file:${fileId}`;
}

export function buildServerEvent<T>(
  room: string,
  payload: T,
  actor: RealtimeActor | null,
  originSocketId?: string
): ServerEvent<T> {
  return {
    room,
    payload,
    serverTs: Date.now(),
    actor,
    ...(originSocketId ? { originSocketId } : {}),
  };
}

export function buildClientEvent<T>(
  room: string,
  payload: T
): ClientEvent<T> {
  return {
    room,
    payload,
    clientTs: Date.now(),
  };
}
