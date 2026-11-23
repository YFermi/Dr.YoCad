export enum UserRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
  VIEWER = 'VIEWER',
}

export enum SharePermission {
  VIEW = 'VIEW',
  COMMENT = 'COMMENT',
  MEASURE = 'MEASURE',
  EDIT = 'EDIT',
  ADMIN = 'ADMIN',
}

export const PERMISSION_RANK: Record<SharePermission, number> = {
  [SharePermission.VIEW]: 1,
  [SharePermission.COMMENT]: 2,
  [SharePermission.MEASURE]: 3,
  [SharePermission.EDIT]: 4,
  [SharePermission.ADMIN]: 5,
};

export enum FileStatus {
  UPLOADING = 'UPLOADING',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
}

export type ConversionJobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';

export type ConversionMode = '3D' | '2D_DXF' | '2D_PDF';

export interface PartNode {
  id: string;
  name: string;
  children: PartNode[];
}

export enum AnnotationType {
  PIN = 'PIN',
  CALLOUT = 'CALLOUT',
  FREEHAND = 'FREEHAND',
  CLOUD = 'CLOUD',
  ARROW = 'ARROW',
}

export enum MeasurementType {
  DISTANCE = 'DISTANCE',
  ANGLE = 'ANGLE',
  RADIUS = 'RADIUS',
  DIAMETER = 'DIAMETER',
  AREA = 'AREA',
}

export enum ActivityAction {
  USER_REGISTERED = 'USER_REGISTERED',
  PROJECT_CREATED = 'PROJECT_CREATED',
  PROJECT_UPDATED = 'PROJECT_UPDATED',
  FILE_UPLOAD_INITIATED = 'FILE_UPLOAD_INITIATED',
  FILE_UPLOAD_COMPLETED = 'FILE_UPLOAD_COMPLETED',
  FILE_DELETED = 'FILE_DELETED',
  SHARE_LINK_CREATED = 'SHARE_LINK_CREATED',
  COMMENT_CREATED = 'COMMENT_CREATED',
  ANNOTATION_CREATED = 'ANNOTATION_CREATED',
  MEASUREMENT_CREATED = 'MEASUREMENT_CREATED',
}

export enum AIInsightType {
  SUMMARY = 'SUMMARY',
  DFM_CHECK = 'DFM_CHECK',
  BOM_EXTRACTION = 'BOM_EXTRACTION',
  TOLERANCE_REVIEW = 'TOLERANCE_REVIEW',
}

export interface ApiError {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: UserRole;
  avatarUrl: string | null;
  oauthProvider: string | null;
  oauthSubject: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorSummary {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface Project {
  id: string;
  organizationId: string;
  createdById: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: {
    files: number;
    folders: number;
  };
}

export interface Folder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Public file version DTO (internal S3 storage keys are intentionally excluded). */
export interface FileVersion {
  id: string;
  fileId: string;
  versionNumber: number;
  sizeBytes: number;
  checksum: string | null;
  status: FileStatus;
  uploadedById: string;
  createdAt: string;
  updatedAt: string;
}

export interface File {
  id: string;
  projectId: string;
  folderId: string | null;
  uploadedById: string;
  name: string;
  originalName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  status: FileStatus;
  currentVersion: number;
  versions?: FileVersion[];
  createdAt: string;
  updatedAt: string;
}

/** Alias to avoid clashing with the browser DOM File constructor in frontend modules. */
export type DesignFile = File;

export interface ShareLink {
  id: string;
  token: string;
  fileId: string | null;
  projectId: string | null;
  createdById: string;
  permission: SharePermission;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// 2D Drawing Scene Graph & PDF Page Manifest Types (Session 4)
// ============================================================================

export interface Point2D {
  x: number;
  y: number;
}

export interface DxfBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  units: string;
}

export interface DxfLayerManifestItem {
  name: string;
  color: string;
  visible: boolean;
  frozen?: boolean;
  entityCount: number;
}

export interface DxfEntityBase {
  layer: string;
  color?: string;
  handle?: string;
  lineType?: string;
}

export interface DxfLineEntity extends DxfEntityBase {
  type: 'LINE';
  start: Point2D;
  end: Point2D;
}

export interface DxfCircleEntity extends DxfEntityBase {
  type: 'CIRCLE';
  center: Point2D;
  radius: number;
}

export interface DxfArcEntity extends DxfEntityBase {
  type: 'ARC';
  center: Point2D;
  radius: number;
  /** Degrees, counter-clockwise from +X axis */
  startAngle: number;
  /** Degrees, counter-clockwise from +X axis */
  endAngle: number;
}

export interface DxfPolylineVertex extends Point2D {
  bulge?: number;
}

export interface DxfPolylineEntity extends DxfEntityBase {
  type: 'LWPOLYLINE' | 'POLYLINE';
  vertices: DxfPolylineVertex[];
  closed: boolean;
}

export interface DxfTextEntity extends DxfEntityBase {
  type: 'TEXT' | 'MTEXT';
  position: Point2D;
  text: string;
  height: number;
  rotation?: number;
}

export interface DxfInsertEntity extends DxfEntityBase {
  type: 'INSERT';
  blockName: string;
  position: Point2D;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
}

export interface DxfDimensionEntity extends DxfEntityBase {
  type: 'DIMENSION';
  text?: string;
  start?: Point2D;
  end?: Point2D;
  anchorPoint?: Point2D;
  middleOfText?: Point2D;
  blockName?: string;
  resolvedEntities?: DxfEntity[];
}

export type DxfEntity =
  | DxfLineEntity
  | DxfCircleEntity
  | DxfArcEntity
  | DxfPolylineEntity
  | DxfTextEntity
  | DxfInsertEntity
  | DxfDimensionEntity;

export interface DxfSceneGraph {
  entities: DxfEntity[];
  blocks: Record<string, DxfEntity[]>;
  units: string;
}

export interface PdfPageManifest {
  pageCount: number;
  pageSize: {
    width: number;
    height: number;
  };
  pageKeys: string[];
}

export type File2DSceneResponse =
  | {
      mode: '2D_DXF';
      scene: DxfSceneGraph;
      layers: DxfLayerManifestItem[];
      bounds: DxfBounds;
    }
  | {
      mode: '2D_PDF';
      pageManifest: PdfPageManifest;
    };

export interface File2DPageResponse {
  url: string;
  page: number;
}

// ============================================================================
// Annotation & Measurement Types (3D + 2D Discriminated Unions)
// ============================================================================

export type Vec3Tuple = [number, number, number];

export interface AnnotationCameraPose {
  position: Vec3Tuple;
  target: Vec3Tuple;
  zoom: number;
}

export type CameraPose = AnnotationCameraPose;

export interface AnnotationAnchor3D {
  kind: '3d';
  position: Vec3Tuple;
  normal?: Vec3Tuple;
  cameraPose: AnnotationCameraPose;
  partId?: string;
}

export interface AnnotationAnchor2D {
  kind: '2d';
  sheet: 'dxf' | 'pdf';
  page?: number;
  x: number;
  y: number;
  view: {
    scale: number;
    offsetX: number;
    offsetY: number;
  };
}

export type AnnotationAnchor = AnnotationAnchor3D | AnnotationAnchor2D;

export type AnnotationShape2DKind =
  | 'pin'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'cloud'
  | 'freehand'
  | 'text';

export interface AnnotationShape2D {
  shapeType: AnnotationShape2DKind;
  color?: string;
  strokeWidth?: number;
  points?: Point2D[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  fontSize?: number;
}

export interface AnnotationPayload {
  anchor: AnnotationAnchor;
  shape?: AnnotationShape2D;
  [key: string]: unknown;
}

export interface Annotation {
  id: string;
  fileId: string;
  versionId: string;
  userId: string;
  type: AnnotationType;
  label: string | null;
  payload: AnnotationPayload;
  commentCount?: number;
  resolvedCommentCount?: number;
  author?: AuthorSummary;
  createdAt: string;
  updatedAt: string;
}

export function isAnnotationAnchor3D(
  anchor: AnnotationAnchor | null | undefined
): anchor is AnnotationAnchor3D {
  return Boolean(anchor && anchor.kind === '3d');
}

export function isAnnotationAnchor2D(
  anchor: AnnotationAnchor | null | undefined
): anchor is AnnotationAnchor2D {
  return Boolean(anchor && anchor.kind === '2d');
}

/**
 * Backward-compatibility normalizer (Session 3 -> Session 4):
 * Upgrades legacy 3D annotations stored without `anchor.kind` into `kind: '3d'`.
 */
export function normalizeAnnotationAnchor(raw: unknown): AnnotationAnchor {
  if (!raw || typeof raw !== 'object') {
    return {
      kind: '3d',
      position: [0, 0, 0],
      cameraPose: { position: [0, 0, 100], target: [0, 0, 0], zoom: 1 },
    };
  }

  const candidate = raw as Record<string, unknown>;
  if (candidate.kind === '2d') {
    const view =
      candidate.view && typeof candidate.view === 'object'
        ? (candidate.view as Record<string, unknown>)
        : {};
    return {
      kind: '2d',
      sheet: candidate.sheet === 'pdf' ? 'pdf' : 'dxf',
      ...(typeof candidate.page === 'number' ? { page: candidate.page } : {}),
      x: typeof candidate.x === 'number' ? candidate.x : 0,
      y: typeof candidate.y === 'number' ? candidate.y : 0,
      view: {
        scale: typeof view.scale === 'number' && view.scale > 0 ? view.scale : 1,
        offsetX: typeof view.offsetX === 'number' ? view.offsetX : 0,
        offsetY: typeof view.offsetY === 'number' ? view.offsetY : 0,
      },
    };
  }

  const pos = Array.isArray(candidate.position) && candidate.position.length === 3
    ? (candidate.position as Vec3Tuple)
    : ([0, 0, 0] as Vec3Tuple);
  const normal =
    Array.isArray(candidate.normal) && candidate.normal.length === 3
      ? (candidate.normal as Vec3Tuple)
      : undefined;
  const poseRaw =
    candidate.cameraPose && typeof candidate.cameraPose === 'object'
      ? (candidate.cameraPose as Record<string, unknown>)
      : {};
  const posePosition =
    Array.isArray(poseRaw.position) && poseRaw.position.length === 3
      ? (poseRaw.position as Vec3Tuple)
      : ([pos[0] + 60, pos[1] + 60, pos[2] + 60] as Vec3Tuple);
  const poseTarget =
    Array.isArray(poseRaw.target) && poseRaw.target.length === 3
      ? (poseRaw.target as Vec3Tuple)
      : pos;
  const poseZoom =
    typeof poseRaw.zoom === 'number' && poseRaw.zoom > 0 ? poseRaw.zoom : 1;

  return {
    kind: '3d',
    position: pos,
    ...(normal ? { normal } : {}),
    cameraPose: {
      position: posePosition,
      target: poseTarget,
      zoom: poseZoom,
    },
    ...(typeof candidate.partId === 'string' && candidate.partId.length > 0
      ? { partId: candidate.partId }
      : {}),
  };
}

export function normalizeAnnotation(annotation: Annotation): Annotation {
  const normalizedAnchor = normalizeAnnotationAnchor(annotation.payload?.anchor);
  if (annotation.payload?.anchor?.kind === normalizedAnchor.kind) {
    return annotation;
  }
  return {
    ...annotation,
    payload: {
      ...annotation.payload,
      anchor: normalizedAnchor,
    },
  };
}

export interface Comment {
  id: string;
  fileId: string;
  annotationId: string | null;
  userId: string;
  parentId: string | null;
  body: string;
  resolved: boolean;
  author?: AuthorSummary;
  createdAt: string;
  updatedAt: string;
}

export interface CommentWithReplies extends Comment {
  replies: Comment[];
}

export interface CommentsListResponse {
  items: CommentWithReplies[];
  summary: {
    totalTopLevel: number;
    unresolvedTopLevel: number;
    resolvedTopLevel: number;
  };
}

export interface MeasurementPoint3D {
  x: number;
  y: number;
  z: number;
}

export type SmartMeasurementKind =
  | 'distance'
  | 'angle'
  | 'diameter'
  | 'radius'
  | 'area'
  | 'volume'
  | 'center-to-center'
  | 'min-wall'
  | 'bbox';

export type MeasurementReferenceKind =
  | 'point'
  | 'edge'
  | 'plane'
  | 'cylinder'
  | 'circle'
  | 'part';

export interface MeasurementReference {
  kind: MeasurementReferenceKind;
  partId: string;
  featureId?: string;
  position: Vec3Tuple;
  normal?: Vec3Tuple;
  axis?: Vec3Tuple;
  radius?: number;
  length?: number;
  area?: number;
  label?: string;
  triangleIndices?: number[];
}

export type SmartMeasurementUnit = 'mm' | 'in' | 'deg' | 'mm²' | 'mm³' | 'in²' | 'in³';

export interface SmartMeasurement {
  id: string;
  kind: SmartMeasurementKind;
  value: number;
  unit: SmartMeasurementUnit;
  references: MeasurementReference[];
  anchor: Vec3Tuple;
  lineStart?: Vec3Tuple;
  lineEnd?: Vec3Tuple;
  angleVertex?: Vec3Tuple;
  axis?: Vec3Tuple;
  radius?: number;
  bboxMin?: Vec3Tuple;
  bboxMax?: Vec3Tuple;
  bboxDims?: Vec3Tuple;
  label?: string;
  note?: string;
  createdAt: string;
}

export type ExtractedFeatureKind = 'plane' | 'circle' | 'cylinder';

export interface ExtractedFeature {
  id: string;
  kind: ExtractedFeatureKind;
  partId: string;
  anchor: Vec3Tuple;
  normal?: Vec3Tuple;
  axis?: Vec3Tuple;
  radius?: number;
  diameter?: number;
  length?: number;
  area?: number;
  extentU?: number;
  extentV?: number;
  isHole?: boolean;
  isConcave?: boolean;
  rmsError?: number;
  triangleCount?: number;
  bboxMin?: Vec3Tuple;
  bboxMax?: Vec3Tuple;
  summaryLabel: string;
}

export interface PartMetricsSummary {
  partId: string;
  partName: string;
  bboxMin: Vec3Tuple;
  bboxMax: Vec3Tuple;
  bboxDims: Vec3Tuple;
  surfaceArea: number;
  volume: number;
  centroid: Vec3Tuple;
  triangleCount: number;
  featureIds: string[];
}

export interface FileFeaturesCacheData {
  version: number;
  extractedAt: string;
  features: ExtractedFeature[];
  partSummaries: PartMetricsSummary[];
}

export interface FileFeaturesResponse {
  fileId: string;
  versionId: string;
  cached: boolean;
  data: FileFeaturesCacheData | null;
}

export interface MeasurementPoints3DPayload {
  coordinates: MeasurementPoint3D[];
}

export interface MeasurementPoints2DPayload {
  points2d: Point2D[];
  unitScale?: number;
  sheet?: 'dxf' | 'pdf';
  page?: number;
}

export interface MeasurementPointsSmartPayload {
  smart: SmartMeasurement;
  coordinates?: MeasurementPoint3D[];
}

export type MeasurementPointsPayload =
  | MeasurementPointsSmartPayload
  | MeasurementPoints3DPayload
  | MeasurementPoints2DPayload;

export function isMeasurementPointsSmart(
  points: MeasurementPointsPayload | null | undefined
): points is MeasurementPointsSmartPayload {
  return Boolean(points && 'smart' in points && points.smart && typeof points.smart === 'object');
}

export function isMeasurementPoints2D(
  points: MeasurementPointsPayload | null | undefined
): points is MeasurementPoints2DPayload {
  return Boolean(points && 'points2d' in points && Array.isArray(points.points2d));
}

export function isMeasurementPoints3D(
  points: MeasurementPointsPayload | null | undefined
): points is MeasurementPoints3DPayload {
  return Boolean(
    points &&
      !('smart' in points) &&
      'coordinates' in points &&
      Array.isArray(points.coordinates)
  );
}

export function smartKindToMeasurementType(kind: SmartMeasurementKind): MeasurementType {
  switch (kind) {
    case 'angle':
      return MeasurementType.ANGLE;
    case 'diameter':
      return MeasurementType.DIAMETER;
    case 'radius':
      return MeasurementType.RADIUS;
    case 'area':
    case 'volume':
    case 'bbox':
      return MeasurementType.AREA;
    case 'distance':
    case 'center-to-center':
    case 'min-wall':
    default:
      return MeasurementType.DISTANCE;
  }
}

export function normalizeMeasurementToSmart(measurement: Measurement): SmartMeasurement | null {
  if (isMeasurementPointsSmart(measurement.points)) {
    return {
      ...measurement.points.smart,
      id: measurement.id,
      value: measurement.value,
      unit: (measurement.unit as SmartMeasurementUnit) || measurement.points.smart.unit,
      createdAt: measurement.createdAt,
    };
  }
  if (isMeasurementPoints3D(measurement.points)) {
    const coords = measurement.points.coordinates;
    if (coords.length < 2) return null;
    const toTuple = (p: MeasurementPoint3D): Vec3Tuple => [p.x, p.y, p.z];
    if (measurement.type === MeasurementType.ANGLE && coords.length >= 3) {
      const a = toTuple(coords[0]);
      const v = toTuple(coords[1]);
      const b = toTuple(coords[2]);
      return {
        id: measurement.id,
        kind: 'angle',
        value: measurement.value,
        unit: 'deg',
        references: [
          { kind: 'point', partId: 'mesh', position: a },
          { kind: 'point', partId: 'mesh', position: v },
          { kind: 'point', partId: 'mesh', position: b },
        ],
        anchor: v,
        lineStart: a,
        angleVertex: v,
        lineEnd: b,
        createdAt: measurement.createdAt,
      };
    }
    const start = toTuple(coords[0]);
    const end = toTuple(coords[1]);
    const mid: Vec3Tuple = [
      (start[0] + end[0]) / 2,
      (start[1] + end[1]) / 2,
      (start[2] + end[2]) / 2,
    ];
    return {
      id: measurement.id,
      kind: 'distance',
      value: measurement.value,
      unit: measurement.unit === 'in' ? 'in' : 'mm',
      references: [
        { kind: 'point', partId: 'mesh', position: start },
        { kind: 'point', partId: 'mesh', position: end },
      ],
      anchor: mid,
      lineStart: start,
      lineEnd: end,
      createdAt: measurement.createdAt,
    };
  }
  return null;
}

export interface Measurement {
  id: string;
  fileId: string;
  versionId: string;
  userId: string;
  type: MeasurementType;
  value: number;
  unit: string;
  points: MeasurementPointsPayload;
  author?: AuthorSummary;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityLog {
  id: string;
  organizationId: string;
  projectId: string | null;
  fileId: string | null;
  userId: string;
  action: ActivityAction;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AIInsight {
  id: string;
  fileId: string;
  versionId: string;
  userId: string | null;
  type: AIInsightType;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthSession {
  user: User;
  organization: Organization;
  tokens: AuthTokens;
}

export interface UploadInitResponse {
  file: DesignFile;
  version: FileVersion;
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  presignedUrls: Array<{
    partNumber: number;
    url: string;
  }>;
}

export interface UploadChunkResponse {
  fileId: string;
  uploadId: string;
  partNumber: number;
  etag: string;
  receivedBytes: number;
}

export interface FileStatusResponse {
  status: FileStatus;
  jobStatus: ConversionJobStatus | null;
  mode?: ConversionMode;
  error?: string;
}

export interface FileGlbResponse {
  url: string;
}

export interface FileTreeResponse {
  partTree: PartNode[];
}

export interface ResolvedShareLink {
  shareLink: ShareLink;
  file: DesignFile | null;
  project: Project | null;
}

export interface PresenceUser {
  userId: string;
  name: string;
  email: string;
  avatarColor?: string;
  socketId?: string;
  joinedAt: string;
}

export interface ActivityLogWithAuthor extends ActivityLog {
  author?: AuthorSummary;
  fileName?: string | null;
}

// ============================================================================
// Session 6 — AI Design Assistant Types
// ============================================================================

export interface AiChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiContextStats {
  annotationCount: number;
  commentCount: number;
  measurementCount: number;
  bytesUsed: number;
}

export interface AiChatResponse {
  reply: string;
  referencedAnnotationIds: string[];
  contextStats?: AiContextStats;
}

export type AiIssueSeverity = 'low' | 'medium' | 'high';

export interface AiOpenIssue {
  annotationId: string;
  title: string;
  severity: AiIssueSeverity;
}

export interface AiSummaryResult {
  summary: string;
  openIssues: AiOpenIssue[];
  resolvedCount: number;
  openCount: number;
  recommendedNextSteps: string[];
}

export interface AiSummaryResponse extends AiSummaryResult {
  cached: boolean;
  insightId: string;
  createdAt: string;
}

export interface AiBomItem {
  partNumber: string;
  description: string;
  quantity: number;
  material?: string;
  finish?: string;
  notes?: string;
}

export type AiSourceConfidence = 'high' | 'medium' | 'low';

export interface AiBomResult {
  items: AiBomItem[];
  sourceConfidence: AiSourceConfidence;
  warnings: string[];
}

export interface AiBomResponse extends AiBomResult {
  insightId: string;
  createdAt: string;
}

export type AiDfmSeverity = 'info' | 'warning' | 'error';

export interface AiDfmFinding {
  severity: AiDfmSeverity;
  category: string;
  message: string;
  partId?: string;
  annotationRefs?: string[];
}

export interface AiDfmResult {
  findings: AiDfmFinding[];
}

export interface AiDfmResponse extends AiDfmResult {
  insightId: string;
  createdAt: string;
}

