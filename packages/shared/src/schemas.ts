import { z } from 'zod';
import {
  ActivityAction,
  AIInsightType,
  AnnotationType,
  FileStatus,
  MeasurementType,
  SharePermission,
  UserRole,
  type PartNode,
} from './types.js';

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB (S3 minimum multipart part size)

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export function apiResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.boolean(),
    data: dataSchema.optional(),
    error: apiErrorSchema.optional(),
  });
}

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
});

export const userRoleSchema = z.nativeEnum(UserRole);
export const sharePermissionSchema = z.nativeEnum(SharePermission);
export const fileStatusSchema = z.nativeEnum(FileStatus);
export const annotationTypeSchema = z.nativeEnum(AnnotationType);
export const measurementTypeSchema = z.nativeEnum(MeasurementType);
export const activityActionSchema = z.nativeEnum(ActivityAction);
export const aiInsightTypeSchema = z.nativeEnum(AIInsightType);

export const partNodeSchema: z.ZodType<PartNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    children: z.array(partNodeSchema),
  })
);

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const userSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: userRoleSchema,
  avatarUrl: z.string().nullable(),
  oauthProvider: z.string().nullable(),
  oauthSubject: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const authorSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().nullable(),
});

export const projectSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  createdById: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  _count: z
    .object({
      files: z.number(),
      folders: z.number(),
    })
    .optional(),
});

export const folderSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const fileVersionSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  versionNumber: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  checksum: z.string().nullable(),
  status: fileStatusSchema,
  uploadedById: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const fileSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  folderId: z.string().nullable(),
  uploadedById: z.string(),
  name: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  extension: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  status: fileStatusSchema,
  currentVersion: z.number().int().positive(),
  versions: z.array(fileVersionSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const shareLinkSchema = z.object({
  id: z.string(),
  token: z.string(),
  fileId: z.string().nullable(),
  projectId: z.string().nullable(),
  createdById: z.string(),
  permission: sharePermissionSchema,
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ============================================================================
// Auth, Project, File, Share Schemas
// ============================================================================

export const registerRequestSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128),
  name: z.string().trim().min(1, 'Name is required').max(120),
  organizationName: z.string().trim().min(2).max(120).optional(),
});

export const loginRequestSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});

export const authSessionSchema = z.object({
  user: userSchema,
  organization: organizationSchema,
  tokens: authTokensSchema,
});

export const createProjectRequestSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(120),
  description: z.string().trim().max(1000).optional().nullable(),
});

export const updateProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional().nullable(),
});

export const projectParamsSchema = z.object({
  id: z.string().min(1),
});

export const fileListQuerySchema = z.object({
  projectId: z.string().min(1),
  folderId: z.string().optional(),
});

export const fileParamsSchema = z.object({
  id: z.string().min(1),
});

export const file2DPageParamsSchema = z.object({
  id: z.string().min(1),
  n: z.coerce.number().int().min(1),
});

export const fileVersionQuerySchema = z.object({
  v: z.coerce.number().int().positive().optional(),
  versionId: z.string().min(1).optional(),
});

export const initFileUploadRequestSchema = z.object({
  projectId: z.string().min(1),
  folderId: z.string().min(1).nullable().optional(),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(150).default('application/octet-stream'),
  sizeBytes: z
    .number()
    .int()
    .min(1, 'File cannot be empty')
    .max(MAX_UPLOAD_BYTES, 'File exceeds 500 MB limit'),
  chunkSize: z
    .number()
    .int()
    .min(64 * 1024)
    .max(50 * 1024 * 1024)
    .default(DEFAULT_CHUNK_SIZE),
});

export const uploadChunkQuerySchema = z.object({
  uploadId: z.string().min(1),
  partNumber: z.coerce.number().int().min(1).max(10000),
});

export const completeFileUploadRequestSchema = z.object({
  uploadId: z.string().min(1),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1),
        etag: z.string().min(1),
      })
    )
    .min(1),
  checksum: z.string().max(128).optional(),
});

export const initFileUploadResponseSchema = z.object({
  file: fileSchema,
  version: fileVersionSchema,
  uploadId: z.string(),
  chunkSize: z.number().int().positive(),
  totalChunks: z.number().int().positive(),
  presignedUrls: z.array(
    z.object({
      partNumber: z.number().int().positive(),
      url: z.string(),
    })
  ),
});

export const createShareLinkRequestSchema = z
  .object({
    fileId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    permission: sharePermissionSchema.default(SharePermission.VIEW),
    expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
  })
  .refine((data) => Boolean(data.fileId || data.projectId), {
    message: 'Either fileId or projectId must be provided',
  });

export const shareTokenParamsSchema = z.object({
  token: z.string().min(8),
});

// ============================================================================
// Session 3 & 4 — Annotations, Comments, Measurements Schemas (3D + 2D)
// ============================================================================

export const point2DSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const vec3TupleSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

export const annotationCameraPoseSchema = z.object({
  position: vec3TupleSchema,
  target: vec3TupleSchema,
  zoom: z.number().finite().positive().default(1),
});

/**
 * 3D anchor schema. Defaults `kind` to `'3d'` when omitted so legacy Session 3
 * records deserialize cleanly without requiring destructive migration.
 */
export const annotationAnchor3DSchema = z.object({
  kind: z.literal('3d').default('3d'),
  position: vec3TupleSchema,
  normal: vec3TupleSchema.optional(),
  cameraPose: annotationCameraPoseSchema,
  partId: z.string().min(1).max(120).optional(),
});

export const annotationAnchor2DSchema = z.object({
  kind: z.literal('2d'),
  sheet: z.enum(['dxf', 'pdf']),
  page: z.number().int().min(1).optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  view: z.object({
    scale: z.number().finite().positive(),
    offsetX: z.number().finite(),
    offsetY: z.number().finite(),
  }),
});

export const annotationAnchorSchema = z.union([
  annotationAnchor2DSchema,
  annotationAnchor3DSchema,
]);

export const annotationShape2DSchema = z.object({
  shapeType: z.enum(['pin', 'arrow', 'rect', 'ellipse', 'cloud', 'freehand', 'text']),
  color: z.string().max(32).optional(),
  strokeWidth: z.number().finite().positive().max(32).optional(),
  points: z.array(point2DSchema).max(2000).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite().optional(),
  height: z.number().finite().optional(),
  text: z.string().max(1000).optional(),
  fontSize: z.number().finite().positive().max(256).optional(),
});

export const annotationPayloadSchema = z
  .object({
    anchor: annotationAnchorSchema,
    shape: annotationShape2DSchema.optional(),
  })
  .passthrough();

export const createAnnotationRequestSchema = z.object({
  versionId: z.string().min(1),
  type: annotationTypeSchema.default(AnnotationType.PIN),
  label: z.string().trim().max(240).nullable().optional(),
  payload: annotationPayloadSchema,
});

export const updateAnnotationRequestSchema = z
  .object({
    label: z.string().trim().max(240).nullable().optional(),
    payload: annotationPayloadSchema.optional(),
  })
  .refine((data) => data.label !== undefined || data.payload !== undefined, {
    message: 'At least one of label or payload must be provided',
  });

export const annotationResponseSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  versionId: z.string(),
  userId: z.string(),
  type: annotationTypeSchema,
  label: z.string().nullable(),
  payload: annotationPayloadSchema,
  commentCount: z.number().int().nonnegative().optional(),
  resolvedCommentCount: z.number().int().nonnegative().optional(),
  author: authorSummarySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const annotationsListQuerySchema = z.object({
  versionId: z.string().min(1).optional(),
});

export const createCommentRequestSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Comment cannot be empty')
    .max(5000, 'Comment exceeds 5000 characters'),
  annotationId: z.string().min(1).nullable().optional(),
  parentId: z.string().min(1).nullable().optional(),
});

export const updateCommentRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(5000).optional(),
    resolved: z.boolean().optional(),
  })
  .refine((data) => data.body !== undefined || data.resolved !== undefined, {
    message: 'At least one of body or resolved must be provided',
  });

export const commentsListQuerySchema = z.object({
  versionId: z.string().min(1).optional(),
  annotationId: z.string().min(1).optional(),
  resolved: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const commentResponseSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  annotationId: z.string().nullable(),
  userId: z.string(),
  parentId: z.string().nullable(),
  body: z.string(),
  resolved: z.boolean(),
  author: authorSummarySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const commentWithRepliesSchema = commentResponseSchema.extend({
  replies: z.array(commentResponseSchema),
});

export const commentsListResponseSchema = z.object({
  items: z.array(commentWithRepliesSchema),
  summary: z.object({
    totalTopLevel: z.number().int().nonnegative(),
    unresolvedTopLevel: z.number().int().nonnegative(),
    resolvedTopLevel: z.number().int().nonnegative(),
  }),
});

export const measurementPoint3DSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

export const smartMeasurementKindSchema = z.enum([
  'distance',
  'angle',
  'diameter',
  'radius',
  'area',
  'volume',
  'center-to-center',
  'min-wall',
  'bbox',
]);

export const measurementReferenceKindSchema = z.enum([
  'point',
  'edge',
  'plane',
  'cylinder',
  'circle',
  'part',
]);

export const measurementReferenceSchema = z.object({
  kind: measurementReferenceKindSchema,
  partId: z.string().min(1).max(200),
  featureId: z.string().min(1).max(200).optional(),
  position: vec3TupleSchema,
  normal: vec3TupleSchema.optional(),
  axis: vec3TupleSchema.optional(),
  radius: z.number().finite().nonnegative().optional(),
  length: z.number().finite().nonnegative().optional(),
  area: z.number().finite().nonnegative().optional(),
  label: z.string().max(240).optional(),
  triangleIndices: z.array(z.number().int().nonnegative()).max(2000).optional(),
});

export const smartMeasurementUnitSchema = z.enum([
  'mm',
  'in',
  'deg',
  'mm²',
  'mm³',
  'in²',
  'in³',
]);

export const smartMeasurementSchema = z.object({
  id: z.string().min(1).max(200),
  kind: smartMeasurementKindSchema,
  value: z.number().finite().nonnegative(),
  unit: smartMeasurementUnitSchema,
  references: z.array(measurementReferenceSchema).min(1).max(8),
  anchor: vec3TupleSchema,
  lineStart: vec3TupleSchema.optional(),
  lineEnd: vec3TupleSchema.optional(),
  angleVertex: vec3TupleSchema.optional(),
  axis: vec3TupleSchema.optional(),
  radius: z.number().finite().nonnegative().optional(),
  bboxMin: vec3TupleSchema.optional(),
  bboxMax: vec3TupleSchema.optional(),
  bboxDims: vec3TupleSchema.optional(),
  label: z.string().trim().max(240).optional(),
  note: z.string().trim().max(500).optional(),
  createdAt: z.string().min(1),
});

export const extractedFeatureSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(['plane', 'circle', 'cylinder']),
  partId: z.string().min(1).max(200),
  anchor: vec3TupleSchema,
  normal: vec3TupleSchema.optional(),
  axis: vec3TupleSchema.optional(),
  radius: z.number().finite().nonnegative().optional(),
  diameter: z.number().finite().nonnegative().optional(),
  length: z.number().finite().nonnegative().optional(),
  area: z.number().finite().nonnegative().optional(),
  extentU: z.number().finite().nonnegative().optional(),
  extentV: z.number().finite().nonnegative().optional(),
  isHole: z.boolean().optional(),
  isConcave: z.boolean().optional(),
  rmsError: z.number().finite().nonnegative().optional(),
  triangleCount: z.number().int().nonnegative().optional(),
  bboxMin: vec3TupleSchema.optional(),
  bboxMax: vec3TupleSchema.optional(),
  summaryLabel: z.string().min(1).max(240),
});

export const partMetricsSummarySchema = z.object({
  partId: z.string().min(1).max(200),
  partName: z.string().min(1).max(240),
  bboxMin: vec3TupleSchema,
  bboxMax: vec3TupleSchema,
  bboxDims: vec3TupleSchema,
  surfaceArea: z.number().finite().nonnegative(),
  volume: z.number().finite().nonnegative(),
  centroid: vec3TupleSchema,
  triangleCount: z.number().int().nonnegative(),
  featureIds: z.array(z.string().min(1).max(200)).max(5000),
});

export const saveFileFeaturesRequestSchema = z.object({
  version: z.number().int().positive().default(1),
  extractedAt: z.string().min(1).optional(),
  features: z.array(extractedFeatureSchema).max(5000),
  partSummaries: z.array(partMetricsSummarySchema).max(2000).default([]),
});

export const measurementPointsSmartPayloadSchema = z.object({
  smart: smartMeasurementSchema,
  coordinates: z.array(measurementPoint3DSchema).max(16).optional(),
});

export const measurementPoints3DPayloadSchema = z.object({
  coordinates: z.array(measurementPoint3DSchema).min(2).max(16),
});

export const measurementPoints2DPayloadSchema = z.object({
  points2d: z.array(point2DSchema).min(2).max(64),
  unitScale: z.number().finite().positive().optional(),
  sheet: z.enum(['dxf', 'pdf']).optional(),
  page: z.number().int().min(1).optional(),
});

export const measurementPointsPayloadSchema = z.union([
  measurementPointsSmartPayloadSchema,
  measurementPoints2DPayloadSchema,
  measurementPoints3DPayloadSchema,
]);

export const createMeasurementRequestSchema = z.object({
  versionId: z.string().min(1),
  type: measurementTypeSchema,
  value: z.number().finite().nonnegative(),
  unit: z.string().trim().min(1).max(16).default('mm'),
  points: measurementPointsPayloadSchema,
});

export const updateMeasurementRequestSchema = z
  .object({
    value: z.number().finite().nonnegative().optional(),
    unit: z.string().trim().min(1).max(16).optional(),
    points: measurementPointsPayloadSchema.optional(),
  })
  .refine(
    (data) => data.value !== undefined || data.unit !== undefined || data.points !== undefined,
    { message: 'At least one of value, unit, or points must be provided' }
  );

export const measurementsListQuerySchema = z.object({
  versionId: z.string().min(1).optional(),
});

export const measurementResponseSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  versionId: z.string(),
  userId: z.string(),
  type: measurementTypeSchema,
  value: z.number(),
  unit: z.string(),
  points: measurementPointsPayloadSchema,
  author: authorSummarySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export type InitFileUploadRequest = z.infer<typeof initFileUploadRequestSchema>;
export type CompleteFileUploadRequest = z.infer<typeof completeFileUploadRequestSchema>;
export type CreateShareLinkRequest = z.infer<typeof createShareLinkRequestSchema>;
export type CreateAnnotationRequest = z.infer<typeof createAnnotationRequestSchema>;
export type UpdateAnnotationRequest = z.infer<typeof updateAnnotationRequestSchema>;
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;
export type UpdateCommentRequest = z.infer<typeof updateCommentRequestSchema>;
export type CreateMeasurementRequest = z.infer<typeof createMeasurementRequestSchema>;
export type UpdateMeasurementRequest = z.infer<typeof updateMeasurementRequestSchema>;
export type SaveFileFeaturesRequest = z.infer<typeof saveFileFeaturesRequestSchema>;

// ============================================================================
// Session 6 — AI Design Assistant Schemas
// ============================================================================

export const aiChatHistoryMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(4000),
});

export const aiChatRequestSchema = z.object({
  fileId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  message: z.string().trim().min(1, 'Message cannot be empty').max(4000),
  conversationHistory: z.array(aiChatHistoryMessageSchema).max(30).optional(),
});

export const aiChatResponseSchema = z.object({
  reply: z.string(),
  referencedAnnotationIds: z.array(z.string()),
  contextStats: z
    .object({
      annotationCount: z.number().int().nonnegative(),
      commentCount: z.number().int().nonnegative(),
      measurementCount: z.number().int().nonnegative(),
      bytesUsed: z.number().int().nonnegative(),
    })
    .optional(),
});

export const aiFileTargetRequestSchema = z.object({
  fileId: z.string().min(1),
  versionId: z.string().min(1).optional(),
});

export const aiSummaryQuerySchema = z.object({
  force: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const aiOpenIssueSchema = z.object({
  annotationId: z.string(),
  title: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high']),
});

export const aiSummaryResultSchema = z.object({
  summary: z.string().min(1),
  openIssues: z.array(aiOpenIssueSchema),
  resolvedCount: z.number().int().nonnegative(),
  openCount: z.number().int().nonnegative(),
  recommendedNextSteps: z.array(z.string()),
});

export const aiBomItemSchema = z.object({
  partNumber: z.string().min(1),
  description: z.string().min(1),
  quantity: z.number().int().positive(),
  material: z.string().optional(),
  finish: z.string().optional(),
  notes: z.string().optional(),
});

export const aiBomResultSchema = z.object({
  items: z.array(aiBomItemSchema),
  sourceConfidence: z.enum(['high', 'medium', 'low']),
  warnings: z.array(z.string()),
});

export const aiDfmFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  category: z.string().min(1),
  message: z.string().min(1),
  partId: z.string().optional(),
  annotationRefs: z.array(z.string()).optional(),
});

export const aiDfmResultSchema = z.object({
  findings: z.array(aiDfmFindingSchema),
});

export const aiInsightsListQuerySchema = z.object({
  fileId: z.string().min(1),
});

export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;
export type AiFileTargetRequest = z.infer<typeof aiFileTargetRequestSchema>;
export type AiSummaryResultParsed = z.infer<typeof aiSummaryResultSchema>;
export type AiBomResultParsed = z.infer<typeof aiBomResultSchema>;
export type AiDfmResultParsed = z.infer<typeof aiDfmResultSchema>;

