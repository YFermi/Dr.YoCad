import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server as SocketIOServer } from 'socket.io';
import { ZodError } from 'zod';
import {
  ActivityAction,
  AIInsightType,
  aiBomResultSchema,
  aiChatRequestSchema,
  aiDfmResultSchema,
  aiFileTargetRequestSchema,
  aiInsightsListQuerySchema,
  aiSummaryQuerySchema,
  aiSummaryResultSchema,
  annotationsListQuerySchema,
  AnnotationType,
  commentsListQuerySchema,
  completeFileUploadRequestSchema,
  computeAvatarColor,
  createAnnotationRequestSchema,
  createCommentRequestSchema,
  createMeasurementRequestSchema,
  createProjectRequestSchema,
  createShareLinkRequestSchema,
  fileListQuerySchema,
  FileStatus,
  initFileUploadRequestSchema,
  loginRequestSchema,
  logoutRequestSchema,
  measurementsListQuerySchema,
  MeasurementType,
  paginationQuerySchema,
  PERMISSION_RANK,
  REALTIME_EVENTS,
  refreshRequestSchema,
  registerRequestSchema,
  saveFileFeaturesRequestSchema,
  SharePermission,
  updateAnnotationRequestSchema,
  updateCommentRequestSchema,
  updateMeasurementRequestSchema,
  updateProjectRequestSchema,
  uploadChunkQuerySchema,
  UserRole,
  type ActivityLog,
  type ActivityLogWithAuthor,
  type AiBomResponse,
  type AiChatResponse,
  type AiDfmResponse,
  type AIInsight,
  type AiSummaryResponse,
  type Annotation,
  type AuthorSummary,
  type Comment,
  type CommentsListResponse,
  type CommentWithReplies,
  type ConversionMode,
  type DesignFile,
  type DxfBounds,
  type DxfLayerManifestItem,
  type DxfSceneGraph,
  type EntityDeletePayload,
  type FileFeaturesCacheData,
  type FileVersion,
  type Folder,
  type Measurement,
  type Organization,
  type PartNode,
  type PdfPageManifest,
  type PresenceUser,
  type Project,
  type ShareLink,
  type User,
} from './packages/shared/src/index.ts';
import {
  DWG_UNSUPPORTED_REASON,
  is2DExtension,
  parseDxfBufferToScene,
  rasterizePdfBufferToPngPages,
} from './apps/api/src/lib/converter2d.ts';
import {
  attachCollaborationHub,
  broadcastFileDelta,
} from './apps/api/src/lib/realtimeHub.ts';
import {
  buildCalibrationCubeGlb,
  buildPlanetaryGearboxGlb,
  convertUploadedBuffer,
} from './apps/api/src/lib/proceduralGlb.ts';
import {
  AI_BOM_RESPONSE_SCHEMA,
  AI_DFM_RESPONSE_SCHEMA,
  AI_MODELS,
  AI_SUMMARY_RESPONSE_SCHEMA,
  AiBadResponseError,
  AiNotConfiguredError,
  generateJson,
  generateText,
  isAiConfigured,
} from './apps/api/src/lib/ai.ts';
import {
  buildAiFileContext,
  extractDxfBomHints,
  extractReferencedAnnotationIds,
} from './apps/api/src/lib/aiContext.ts';
import {
  checkAiRateLimit,
  type AiRateLimitBucket,
} from './apps/api/src/lib/aiRateLimit.ts';

const PORT = Number(process.env.PORT ?? 3000);
const ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? 'cadline-preview-access-secret-32chars';
const REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? 'cadline-preview-refresh-secret-32chars';
const UPLOAD_ROOT = path.resolve(process.cwd(), '.tmp-uploads');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

interface StoredUser extends User {
  passwordHash: string;
}

interface StoredRefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  revokedAt: number | null;
}

interface StoredUploadSession {
  uploadId: string;
  fileId: string;
  versionId: string;
  storageKey: string;
  parts: Map<number, { etag: string; size: number; path: string }>;
}

interface StoredConversionArtifact {
  glbBuffer: Uint8Array;
  partTree: PartNode[];
}

type Stored2DArtifact =
  | {
      mode: '2D_DXF';
      scene: DxfSceneGraph;
      layers: DxfLayerManifestItem[];
      bounds: DxfBounds;
    }
  | {
      mode: '2D_PDF';
      pageManifest: PdfPageManifest;
      pages: Map<number, Buffer>;
    };

interface AccessPayload {
  sub: string;
  orgId: string;
  email: string;
  role: UserRole;
  type: 'access';
}

interface AuthedRequest extends Request {
  authUser?: {
    id: string;
    organizationId: string;
    email: string;
    name: string;
    role: UserRole;
  };
  effectivePermission?: SharePermission;
}

// Procedural & Uploaded GLB Geometry Builders live in apps/api/src/lib/proceduralGlb.ts

// ============================================================================
// Seeded runtime state for AI Studio preview (mirrors apps/api/prisma/seed.ts)
// ============================================================================

const nowIso = new Date().toISOString();
const demoPasswordHash = bcrypt.hashSync('Password123!', 10);

const orgs = new Map<string, Organization>([
  [
    'org_demo_engineering',
    {
      id: 'org_demo_engineering',
      name: 'Demo Engineering',
      slug: 'demo-engineering',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
]);

const users = new Map<string, StoredUser>([
  [
    'usr_demo_admin',
    {
      id: 'usr_demo_admin',
      organizationId: 'org_demo_engineering',
      email: 'admin@demo.local',
      passwordHash: demoPasswordHash,
      name: 'Alex Morgan',
      role: UserRole.ADMIN,
      avatarUrl: null,
      oauthProvider: null,
      oauthSubject: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
  [
    'usr_demo_member',
    {
      id: 'usr_demo_member',
      organizationId: 'org_demo_engineering',
      email: 'user@demo.local',
      passwordHash: demoPasswordHash,
      name: 'Samira Chen',
      role: UserRole.MEMBER,
      avatarUrl: null,
      oauthProvider: null,
      oauthSubject: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
]);

const refreshTokens = new Map<string, StoredRefreshToken>();

const projects = new Map<string, Project>([
  [
    'prj_demo_gearbox',
    {
      id: 'prj_demo_gearbox',
      organizationId: 'org_demo_engineering',
      createdById: 'usr_demo_admin',
      name: 'Planetary Gearbox Assembly',
      description:
        'Rev C drivetrain housing, planetary gear train, and 50mm calibration cube reference.',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
]);

const folders = new Map<string, Folder>([
  [
    'fld_demo_assemblies',
    {
      id: 'fld_demo_assemblies',
      projectId: 'prj_demo_gearbox',
      parentId: null,
      name: 'Assemblies',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
]);

// Server-side-only maps (never exposed to clients — Session 2 A4)
const internalStorageKeys = new Map<string, string>([
  [
    'ver_demo_housing_1',
    'orgs/org_demo_engineering/projects/prj_demo_gearbox/fil_demo_housing/v1/gearbox-housing-rev-c.step',
  ],
  [
    'ver_demo_cube_1',
    'orgs/org_demo_engineering/projects/prj_demo_gearbox/fil_demo_cube/v1/cube-50mm.stl',
  ],
]);
const versionArtifacts = new Map<string, StoredConversionArtifact>();
const version2DArtifacts = new Map<string, Stored2DArtifact>();
const versionModes = new Map<string, ConversionMode>([
  ['ver_demo_housing_1', '3D'],
  ['ver_demo_cube_1', '3D'],
  ['ver_demo_plate_dxf_1', '2D_DXF'],
  ['ver_demo_sheet_pdf_1', '2D_PDF'],
  ['ver_demo_legacy_dwg_1', '2D_DXF'],
]);
const versionErrors = new Map<string, string>([
  ['ver_demo_legacy_dwg_1', DWG_UNSUPPORTED_REASON],
]);
const versionSourceBuffers = new Map<string, { buffer: Buffer; fileName: string }>();

const files = new Map<string, DesignFile>([
  [
    'fil_demo_housing',
    {
      id: 'fil_demo_housing',
      projectId: 'prj_demo_gearbox',
      folderId: 'fld_demo_assemblies',
      uploadedById: 'usr_demo_admin',
      name: 'gearbox-housing-rev-c.step',
      originalName: 'gearbox-housing-rev-c.step',
      mimeType: 'application/step',
      extension: 'step',
      sizeBytes: 248320,
      status: FileStatus.READY,
      currentVersion: 1,
      versions: [
        {
          id: 'ver_demo_housing_1',
          fileId: 'fil_demo_housing',
          versionNumber: 1,
          sizeBytes: 248320,
          checksum: null,
          status: FileStatus.READY,
          uploadedById: 'usr_demo_admin',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
  [
    'fil_demo_cube',
    {
      id: 'fil_demo_cube',
      projectId: 'prj_demo_gearbox',
      folderId: 'fld_demo_assemblies',
      uploadedById: 'usr_demo_admin',
      name: 'cube-50mm.stl',
      originalName: 'cube-50mm.stl',
      mimeType: 'model/stl',
      extension: 'stl',
      sizeBytes: 2048,
      status: FileStatus.READY,
      currentVersion: 1,
      versions: [
        {
          id: 'ver_demo_cube_1',
          fileId: 'fil_demo_cube',
          versionNumber: 1,
          sizeBytes: 2048,
          checksum: null,
          status: FileStatus.READY,
          uploadedById: 'usr_demo_admin',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
  [
    'fil_demo_plate_dxf',
    {
      id: 'fil_demo_plate_dxf',
      projectId: 'prj_demo_gearbox',
      folderId: 'fld_demo_assemblies',
      uploadedById: 'usr_demo_admin',
      name: 'plate-150x100.dxf',
      originalName: 'plate-150x100.dxf',
      mimeType: 'application/dxf',
      extension: 'dxf',
      sizeBytes: 3120,
      status: FileStatus.READY,
      currentVersion: 1,
      versions: [
        {
          id: 'ver_demo_plate_dxf_1',
          fileId: 'fil_demo_plate_dxf',
          versionNumber: 1,
          sizeBytes: 3120,
          checksum: null,
          status: FileStatus.READY,
          uploadedById: 'usr_demo_admin',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
  [
    'fil_demo_sheet_pdf',
    {
      id: 'fil_demo_sheet_pdf',
      projectId: 'prj_demo_gearbox',
      folderId: 'fld_demo_assemblies',
      uploadedById: 'usr_demo_admin',
      name: 'sample-sheet.pdf',
      originalName: 'sample-sheet.pdf',
      mimeType: 'application/pdf',
      extension: 'pdf',
      sizeBytes: 2720,
      status: FileStatus.READY,
      currentVersion: 1,
      versions: [
        {
          id: 'ver_demo_sheet_pdf_1',
          fileId: 'fil_demo_sheet_pdf',
          versionNumber: 1,
          sizeBytes: 2720,
          checksum: null,
          status: FileStatus.READY,
          uploadedById: 'usr_demo_admin',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
  [
    'fil_demo_legacy_dwg',
    {
      id: 'fil_demo_legacy_dwg',
      projectId: 'prj_demo_gearbox',
      folderId: 'fld_demo_assemblies',
      uploadedById: 'usr_demo_admin',
      name: 'legacy-bracket.dwg',
      originalName: 'legacy-bracket.dwg',
      mimeType: 'application/acad',
      extension: 'dwg',
      sizeBytes: 48120,
      status: FileStatus.FAILED,
      currentVersion: 1,
      versions: [
        {
          id: 'ver_demo_legacy_dwg_1',
          fileId: 'fil_demo_legacy_dwg',
          versionNumber: 1,
          sizeBytes: 48120,
          checksum: null,
          status: FileStatus.FAILED,
          uploadedById: 'usr_demo_admin',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
]);

const uploadSessions = new Map<string, StoredUploadSession>();
const shareLinks = new Map<string, ShareLink>();
const activityLogs: ActivityLog[] = [];

const annotationsStore = new Map<string, Annotation>([
  [
    'ann_demo_collar',
    {
      id: 'ann_demo_collar',
      fileId: 'fil_demo_housing',
      versionId: 'ver_demo_housing_1',
      userId: 'usr_demo_admin',
      type: AnnotationType.PIN,
      label: 'Check bearing retainer chamfer',
      payload: {
        anchor: {
          kind: '3d',
          position: [28, 52, 16],
          normal: [0, 1, 0],
          cameraPose: {
            position: [120, 105, 118],
            target: [0, 36, 0],
            zoom: 1,
          },
          partId: 'part-5',
        },
      },
      createdAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
    },
  ],
  [
    'ann_demo_flange',
    {
      id: 'ann_demo_flange',
      fileId: 'fil_demo_housing',
      versionId: 'ver_demo_housing_1',
      userId: 'usr_demo_member',
      type: AnnotationType.PIN,
      label: 'Verify M8 flange bolt clearance',
      payload: {
        anchor: {
          kind: '3d',
          position: [-46, 10, 44],
          normal: [0, 1, 0],
          cameraPose: {
            position: [-135, 82, 125],
            target: [0, 24, 0],
            zoom: 1,
          },
          partId: 'part-4',
        },
      },
      createdAt: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
    },
  ],
  [
    'ann_demo_dxf_hole',
    {
      id: 'ann_demo_dxf_hole',
      fileId: 'fil_demo_plate_dxf',
      versionId: 'ver_demo_plate_dxf_1',
      userId: 'usr_demo_admin',
      type: AnnotationType.PIN,
      label: 'Verify 4x dia 8.0 bolt hole tolerance (+0.1 / -0.0)',
      payload: {
        anchor: {
          kind: '2d',
          sheet: 'dxf',
          x: 135,
          y: 85,
          view: { scale: 2.5, offsetX: 160, offsetY: 120 },
        },
        shape: { shapeType: 'pin', color: '#0b5fff' },
      },
      createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    },
  ],
]);

const commentsStore = new Map<string, Comment>([
  [
    'cmt_demo_1',
    {
      id: 'cmt_demo_1',
      fileId: 'fil_demo_housing',
      annotationId: 'ann_demo_collar',
      userId: 'usr_demo_admin',
      parentId: null,
      body: '@user@demo.local Please confirm the 1.5 mm lead-in chamfer on the bearing retainer ring before CNC release.',
      resolved: false,
      createdAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    },
  ],
  [
    'cmt_demo_2',
    {
      id: 'cmt_demo_2',
      fileId: 'fil_demo_housing',
      annotationId: 'ann_demo_collar',
      userId: 'usr_demo_member',
      parentId: 'cmt_demo_1',
      body: 'Checked against bearing spec 6206-2RS — 1.5 mm x 45 deg clears the outer race cleanly.',
      resolved: false,
      createdAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    },
  ],
  [
    'cmt_demo_3',
    {
      id: 'cmt_demo_3',
      fileId: 'fil_demo_housing',
      annotationId: 'ann_demo_flange',
      userId: 'usr_demo_member',
      parentId: null,
      body: 'Confirmed M8 socket head clearance around the mounting flange perimeter.',
      resolved: true,
      createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    },
  ],
  [
    'cmt_demo_dxf_1',
    {
      id: 'cmt_demo_dxf_1',
      fileId: 'fil_demo_plate_dxf',
      annotationId: 'ann_demo_dxf_hole',
      userId: 'usr_demo_admin',
      parentId: null,
      body: '@user@demo.local Confirm M8 clearance holes on 120x70 bolt pattern are 8.4 mm or 8.0 mm H12 before laser cutting.',
      resolved: false,
      createdAt: new Date(Date.now() - 19 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 19 * 60 * 1000).toISOString(),
    },
  ],
]);

const measurementsStore = new Map<string, Measurement>([
  [
    'msr_demo_flange_width',
    {
      id: 'msr_demo_flange_width',
      fileId: 'fil_demo_housing',
      versionId: 'ver_demo_housing_1',
      userId: 'usr_demo_admin',
      type: MeasurementType.DISTANCE,
      value: 106,
      unit: 'mm',
      points: {
        coordinates: [
          { x: -53, y: 10, z: 53 },
          { x: 53, y: 10, z: 53 },
        ],
      },
      createdAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
    },
  ],
]);

const versionFeaturesCache = new Map<string, FileFeaturesCacheData>();

function getAuthorSummary(userId: string): AuthorSummary | undefined {
  const user = users.get(userId);
  if (!user) return undefined;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
  };
}

function isAdminUserRole(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.OWNER;
}

function hydrateAnnotation(record: Annotation): Annotation {
  const linkedTopLevel = Array.from(commentsStore.values()).filter(
    (c) => c.annotationId === record.id && c.parentId === null
  );
  return {
    ...record,
    commentCount: linkedTopLevel.length,
    resolvedCommentCount: linkedTopLevel.filter((c) => c.resolved).length,
    author: getAuthorSummary(record.userId),
  };
}

function hydrateComment(record: Comment): Comment {
  return {
    ...record,
    author: getAuthorSummary(record.userId),
  };
}

function hydrateMeasurement(record: Measurement): Measurement {
  return {
    ...record,
    author: getAuthorSummary(record.userId),
  };
}

function recordActivity(params: {
  organizationId: string;
  projectId: string | null;
  fileId: string | null;
  userId: string;
  action: ActivityAction;
  metadata?: Record<string, unknown>;
}): void {
  const now = new Date().toISOString();
  activityLogs.push({
    id: `act_${crypto.randomUUID().slice(0, 8)}`,
    organizationId: params.organizationId,
    projectId: params.projectId,
    fileId: params.fileId,
    userId: params.userId,
    action: params.action,
    metadata: params.metadata ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

// ============================================================================
// Helpers
// ============================================================================

function toPublicUser(user: StoredUser): User {
  const { passwordHash: _removed, ...rest } = user;
  return rest;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function signAccessToken(user: StoredUser): string {
  const payload: AccessPayload = {
    sub: user.id,
    orgId: user.organizationId,
    email: user.email,
    role: user.role,
    type: 'access',
  };
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '15m' });
}

function issueRefreshToken(userId: string): string {
  const token = jwt.sign(
    { sub: userId, jti: crypto.randomUUID(), type: 'refresh' },
    REFRESH_SECRET,
    { expiresIn: '7d' }
  );
  const tokenHash = hashToken(token);
  refreshTokens.set(tokenHash, {
    id: crypto.randomUUID(),
    userId,
    tokenHash,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    revokedAt: null,
  });
  return token;
}

function roleToPermission(role: UserRole): SharePermission {
  if (role === UserRole.OWNER || role === UserRole.ADMIN) return SharePermission.ADMIN;
  if (role === UserRole.MEMBER) return SharePermission.EDIT;
  return SharePermission.VIEW;
}

function authenticate(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token' },
    });
    return;
  }

  try {
    const payload = jwt.verify(
      header.slice('Bearer '.length).trim(),
      ACCESS_SECRET
    ) as AccessPayload;
    if (payload.type !== 'access') {
      throw new Error('Invalid token type');
    }
    const storedUser = users.get(payload.sub);
    req.authUser = {
      id: payload.sub,
      organizationId: payload.orgId,
      email: payload.email,
      name: storedUser?.name ?? payload.email.split('@')[0] ?? 'Reviewer',
      role: payload.role,
    };
    req.effectivePermission = roleToPermission(payload.role);
    next();
  } catch {
    res.status(401).json({
      success: false,
      error: { code: 'TOKEN_EXPIRED', message: 'Access token is invalid or expired' },
    });
  }
}

/**
 * True when a share link's scope (fileId or projectId) covers the file/project
 * targeted by the request's route params. Fails closed when no target resolves.
 */
function shareLinkCoversRequest(link: ShareLink, req: Request): boolean {
  const params = (req.params ?? {}) as Record<string, string | undefined>;
  const routePath = typeof req.route?.path === 'string' ? req.route.path : req.path;
  const fileId =
    params.fileId || (routePath.includes('/files/') ? params.id : undefined) || undefined;
  const projectId =
    params.projectId || (routePath.includes('/projects/') ? params.id : undefined) || undefined;

  if (fileId) {
    if (link.fileId) return link.fileId === fileId;
    if (link.projectId) return files.get(fileId)?.projectId === link.projectId;
    return false;
  }
  if (projectId) {
    return Boolean(link.projectId) && link.projectId === projectId;
  }
  return false;
}

function requirePermission(requiredLevel: SharePermission) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    const shareToken =
      typeof req.headers['x-share-token'] === 'string'
        ? req.headers['x-share-token'].trim()
        : undefined;

    if (authHeader?.startsWith('Bearer ')) {
      authenticate(req, res, () => {
        if (
          !req.effectivePermission ||
          PERMISSION_RANK[req.effectivePermission] < PERMISSION_RANK[requiredLevel]
        ) {
          res.status(403).json({
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: `Requires ${requiredLevel} permission`,
            },
          });
          return;
        }
        next();
      });
      return;
    }

    if (shareToken) {
      const link = shareLinks.get(shareToken);
      if (
        !link ||
        link.revokedAt ||
        (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now())
      ) {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_SHARE_TOKEN',
            message: 'Share link is invalid or expired',
          },
        });
        return;
      }

      // Scope check: the link only covers its own file/project. 404 on mismatch
      // so callers cannot probe for resources outside the link's scope.
      if (!shareLinkCoversRequest(link, req)) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Resource not found' },
        });
        return;
      }

      if (PERMISSION_RANK[link.permission] < PERMISSION_RANK[requiredLevel]) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: `Share link requires ${requiredLevel} permission`,
          },
        });
        return;
      }

      req.effectivePermission = link.permission;
      next();
      return;
    }

    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
  };
}

function projectWithCounts(project: Project): Project {
  const fileCount = Array.from(files.values()).filter(
    (f) => f.projectId === project.id
  ).length;
  const folderCount = Array.from(folders.values()).filter(
    (f) => f.projectId === project.id
  ).length;
  return {
    ...project,
    _count: { files: fileCount, folders: folderCount },
  };
}

function resolveVersionForFile(file: DesignFile, rawV: unknown): FileVersion | null {
  const versions = file.versions ?? [];
  if (versions.length === 0) return null;
  if (rawV !== undefined && rawV !== null && String(rawV).trim() !== '') {
    const parsed = Number(rawV);
    if (Number.isInteger(parsed) && parsed > 0) {
      return versions.find((v) => v.versionNumber === parsed) ?? null;
    }
  }
  return versions[0];
}

function scheduleConversion(file: DesignFile, version: FileVersion): void {
  const now = new Date().toISOString();
  file.status = FileStatus.PROCESSING;
  file.updatedAt = now;
  version.status = FileStatus.PROCESSING;
  version.updatedAt = now;
  versionErrors.delete(version.id);

  setTimeout(() => {
    void (async () => {
      try {
        const ext = file.extension.toLowerCase();
        const source = versionSourceBuffers.get(version.id);

        if (is2DExtension(ext)) {
          if (ext === 'dwg') {
            versionModes.set(version.id, '2D_DXF');
            throw new Error(DWG_UNSUPPORTED_REASON);
          }
          if (ext === 'dxf') {
            versionModes.set(version.id, '2D_DXF');
            const dxfBuf =
              source?.buffer ??
              fs.readFileSync(path.resolve(process.cwd(), 'scripts/seed-models/plate-150x100.dxf'));
            const parsed = parseDxfBufferToScene(dxfBuf);
            version2DArtifacts.set(version.id, {
              mode: '2D_DXF',
              scene: parsed.scene,
              layers: parsed.layers,
              bounds: parsed.bounds,
            });
          } else if (ext === 'pdf') {
            versionModes.set(version.id, '2D_PDF');
            const pdfBuf =
              source?.buffer ??
              fs.readFileSync(path.resolve(process.cwd(), 'scripts/seed-models/sample-sheet.pdf'));
            const rasterized = await rasterizePdfBufferToPngPages(pdfBuf, 2);
            const pagesMap = new Map<number, Buffer>();
            const pageKeys: string[] = [];
            for (const p of rasterized.pages) {
              pagesMap.set(p.pageNumber, p.png);
              pageKeys.push(`${version.id}.page-${p.pageNumber}.png`);
            }
            version2DArtifacts.set(version.id, {
              mode: '2D_PDF',
              pageManifest: {
                pageCount: rasterized.pageCount,
                pageSize: rasterized.pageSize,
                pageKeys,
              },
              pages: pagesMap,
            });
          }

          const doneAt = new Date().toISOString();
          version.status = FileStatus.READY;
          version.updatedAt = doneAt;
          file.status = FileStatus.READY;
          file.updatedAt = doneAt;
          return;
        }

        versionModes.set(version.id, '3D');
        let artifact: StoredConversionArtifact;
        if (source) {
          artifact = await convertUploadedBuffer(source.buffer, source.fileName);
        } else {
          artifact = await buildCalibrationCubeGlb(file.name, 50);
        }
        versionArtifacts.set(version.id, artifact);
        const doneAt = new Date().toISOString();
        version.status = FileStatus.READY;
        version.updatedAt = doneAt;
        file.status = FileStatus.READY;
        file.updatedAt = doneAt;
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Conversion failed';
        versionErrors.set(version.id, reason);
        const failAt = new Date().toISOString();
        version.status = FileStatus.FAILED;
        version.updatedAt = failAt;
        file.status = FileStatus.FAILED;
        file.updatedAt = failAt;
      }
    })();
  }, 450);
}

// ============================================================================
// Express + Socket.IO + Vite Middleware Server
// ============================================================================

async function startServer() {
  // Pre-generate real GLB models for the seeded 3D files
  const gearboxArtifact = await buildPlanetaryGearboxGlb();
  versionArtifacts.set('ver_demo_housing_1', gearboxArtifact);

  const cubeStlPath = path.resolve(process.cwd(), 'scripts/seed-models/cube-50mm.stl');
  if (fs.existsSync(cubeStlPath)) {
    const stlBuf = fs.readFileSync(cubeStlPath);
    const cubeArtifact = await convertUploadedBuffer(stlBuf, 'cube-50mm.stl');
    versionArtifacts.set('ver_demo_cube_1', cubeArtifact);
    versionSourceBuffers.set('ver_demo_cube_1', { buffer: stlBuf, fileName: 'cube-50mm.stl' });
  } else {
    const cubeArtifact = await buildCalibrationCubeGlb('cube-50mm', 50);
    versionArtifacts.set('ver_demo_cube_1', cubeArtifact);
  }

  // Pre-convert seeded 2D drawings (DXF + PDF)
  const plateDxfPath = path.resolve(process.cwd(), 'scripts/seed-models/plate-150x100.dxf');
  if (fs.existsSync(plateDxfPath)) {
    const dxfBuf = fs.readFileSync(plateDxfPath);
    const parsedDxf = parseDxfBufferToScene(dxfBuf);
    version2DArtifacts.set('ver_demo_plate_dxf_1', {
      mode: '2D_DXF',
      scene: parsedDxf.scene,
      layers: parsedDxf.layers,
      bounds: parsedDxf.bounds,
    });
    const dxfFile = files.get('fil_demo_plate_dxf');
    if (dxfFile) {
      dxfFile.sizeBytes = dxfBuf.byteLength;
      if (dxfFile.versions?.[0]) dxfFile.versions[0].sizeBytes = dxfBuf.byteLength;
    }
  }

  const sheetPdfPath = path.resolve(process.cwd(), 'scripts/seed-models/sample-sheet.pdf');
  if (fs.existsSync(sheetPdfPath)) {
    const pdfBuf = fs.readFileSync(sheetPdfPath);
    const rasterized = await rasterizePdfBufferToPngPages(pdfBuf, 2);
    const pagesMap = new Map<number, Buffer>();
    const pageKeys: string[] = [];
    for (const p of rasterized.pages) {
      pagesMap.set(p.pageNumber, p.png);
      pageKeys.push(`ver_demo_sheet_pdf_1.page-${p.pageNumber}.png`);
    }
    version2DArtifacts.set('ver_demo_sheet_pdf_1', {
      mode: '2D_PDF',
      pageManifest: {
        pageCount: rasterized.pageCount,
        pageSize: rasterized.pageSize,
        pageKeys,
      },
      pages: pagesMap,
    });
    const pdfFile = files.get('fil_demo_sheet_pdf');
    if (pdfFile) {
      pdfFile.sizeBytes = pdfBuf.byteLength;
      if (pdfFile.versions?.[0]) pdfFile.versions[0].sizeBytes = pdfBuf.byteLength;
    }
  }

  const app = express();
  const httpServer = http.createServer(app);

  // ---- Session 5: Socket.IO real-time collaboration hub ----
  const io = new SocketIOServer(httpServer, {
    cors: { origin: true, credentials: true },
  });

  attachCollaborationHub(io, {
    verifyToken: (token) => {
      try {
        const payload = jwt.verify(token, ACCESS_SECRET) as AccessPayload;
        const user = users.get(payload.sub);
        return {
          userId: payload.sub,
          email: payload.email,
          name: user?.name,
        };
      } catch {
        return null;
      }
    },
    resolveFileMode: (fileId): ConversionMode => {
      const file = files.get(fileId);
      const ext = file?.extension?.toLowerCase();
      if (ext === 'dxf' || ext === 'dwg') return '2D_DXF';
      if (ext === 'pdf') return '2D_PDF';
      return '3D';
    },
  });

  // In-memory 30s TTL HTTP presence fallback store (B4)
  const httpPresencePings = new Map<string, { expiresAt: number; user: PresenceUser }>();

  const readOriginSocketId = (req: Request): string | undefined => {
    const val = req.header('x-socket-id');
    return val && val.trim().length > 0 ? val.trim() : undefined;
  };

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  app.get('/api/v1/health', (_req, res) => {
    res.json({
      success: true,
      data: { status: 'ok', timestamp: new Date().toISOString() },
    });
  });

  // ---- Auth routes ----
  app.get('/api/v1/auth/oauth/providers', (_req, res) => {
    res.json({
      success: true,
      data: {
        providers: [
          { name: 'google', configured: false },
          { name: 'microsoft', configured: false },
        ],
      },
    });
  });

  app.post('/api/v1/auth/register', async (req, res, next) => {
    try {
      const body = registerRequestSchema.parse(req.body);
      const email = body.email.toLowerCase();
      const existing = Array.from(users.values()).find((u) => u.email === email);
      if (existing) {
        res.status(409).json({
          success: false,
          error: {
            code: 'EMAIL_EXISTS',
            message: 'An account with this email already exists',
          },
        });
        return;
      }

      const now = new Date().toISOString();
      const orgName = body.organizationName?.trim() || `${body.name}'s Workspace`;
      const org: Organization = {
        id: `org_${crypto.randomUUID().slice(0, 8)}`,
        name: orgName,
        slug: `${orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${crypto.randomBytes(2).toString('hex')}`,
        createdAt: now,
        updatedAt: now,
      };
      orgs.set(org.id, org);

      const passwordHash = await bcrypt.hash(body.password, 10);
      const user: StoredUser = {
        id: `usr_${crypto.randomUUID().slice(0, 8)}`,
        organizationId: org.id,
        email,
        passwordHash,
        name: body.name,
        role: UserRole.OWNER,
        avatarUrl: null,
        oauthProvider: null,
        oauthSubject: null,
        createdAt: now,
        updatedAt: now,
      };
      users.set(user.id, user);

      res.status(201).json({
        success: true,
        data: {
          user: toPublicUser(user),
          organization: org,
          tokens: {
            accessToken: signAccessToken(user),
            refreshToken: issueRefreshToken(user.id),
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/auth/login', async (req, res, next) => {
    try {
      const body = loginRequestSchema.parse(req.body);
      const email = body.email.toLowerCase();
      const user = Array.from(users.values()).find((u) => u.email === email);

      if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_CREDENTIALS',
            message: 'Invalid email or password',
          },
        });
        return;
      }

      const org = orgs.get(user.organizationId)!;
      res.json({
        success: true,
        data: {
          user: toPublicUser(user),
          organization: org,
          tokens: {
            accessToken: signAccessToken(user),
            refreshToken: issueRefreshToken(user.id),
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/auth/refresh', (req, res, next) => {
    try {
      const body = refreshRequestSchema.parse(req.body);
      const tokenHash = hashToken(body.refreshToken);
      const stored = refreshTokens.get(tokenHash);

      try {
        jwt.verify(body.refreshToken, REFRESH_SECRET);
      } catch {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_REFRESH_TOKEN',
            message: 'Refresh token is invalid or expired',
          },
        });
        return;
      }

      if (!stored || stored.revokedAt || stored.expiresAt < Date.now()) {
        res.status(401).json({
          success: false,
          error: {
            code: 'REFRESH_REVOKED',
            message: 'Refresh token has been revoked or expired',
          },
        });
        return;
      }

      stored.revokedAt = Date.now();
      const user = users.get(stored.userId);
      if (!user) {
        res.status(401).json({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'User not found' },
        });
        return;
      }

      const org = orgs.get(user.organizationId)!;
      res.json({
        success: true,
        data: {
          user: toPublicUser(user),
          organization: org,
          tokens: {
            accessToken: signAccessToken(user),
            refreshToken: issueRefreshToken(user.id),
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/auth/logout', (req, res, next) => {
    try {
      const body = logoutRequestSchema.parse(req.body ?? {});
      if (body.refreshToken) {
        const stored = refreshTokens.get(hashToken(body.refreshToken));
        if (stored) stored.revokedAt = Date.now();
      }
      res.json({ success: true, data: { loggedOut: true } });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/auth/me', authenticate, (req: AuthedRequest, res) => {
    const user = users.get(req.authUser!.id);
    if (!user) {
      res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
      return;
    }
    res.json({
      success: true,
      data: {
        user: toPublicUser(user),
        organization: orgs.get(user.organizationId)!,
      },
    });
  });

  // ---- Project routes ----
  app.get('/api/v1/projects', authenticate, (req: AuthedRequest, res, next) => {
    try {
      const query = paginationQuerySchema.parse(req.query);
      const search = query.search?.toLowerCase();
      const all = Array.from(projects.values())
        .filter((p) => p.organizationId === req.authUser!.organizationId)
        .filter((p) =>
          search
            ? p.name.toLowerCase().includes(search) ||
              (p.description ?? '').toLowerCase().includes(search)
            : true
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      const start = (query.page - 1) * query.pageSize;
      const items = all.slice(start, start + query.pageSize).map(projectWithCounts);

      res.json({
        success: true,
        data: {
          items,
          total: all.length,
          page: query.page,
          pageSize: query.pageSize,
          totalPages: Math.max(1, Math.ceil(all.length / query.pageSize)),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/v1/projects',
    requirePermission(SharePermission.EDIT),
    (req: AuthedRequest, res, next) => {
      try {
        const body = createProjectRequestSchema.parse(req.body);
        const now = new Date().toISOString();
        const project: Project = {
          id: `prj_${crypto.randomUUID().slice(0, 8)}`,
          organizationId: req.authUser!.organizationId,
          createdById: req.authUser!.id,
          name: body.name,
          description: body.description ?? null,
          createdAt: now,
          updatedAt: now,
        };
        projects.set(project.id, project);
        res.status(201).json({ success: true, data: projectWithCounts(project) });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get('/api/v1/projects/:id', authenticate, (req: AuthedRequest, res) => {
    const project = projects.get(req.params.id);
    if (!project || project.organizationId !== req.authUser!.organizationId) {
      res.status(404).json({
        success: false,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
      });
      return;
    }
    res.json({ success: true, data: projectWithCounts(project) });
  });

  app.patch(
    '/api/v1/projects/:id',
    requirePermission(SharePermission.EDIT),
    (req: AuthedRequest, res, next) => {
      try {
        const body = updateProjectRequestSchema.parse(req.body);
        const project = projects.get(req.params.id);
        if (!project || project.organizationId !== req.authUser!.organizationId) {
          res.status(404).json({
            success: false,
            error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
          });
          return;
        }
        const updated: Project = {
          ...project,
          name: body.name ?? project.name,
          description: body.description !== undefined ? body.description : project.description,
          updatedAt: new Date().toISOString(),
        };
        projects.set(updated.id, updated);
        res.json({ success: true, data: projectWithCounts(updated) });
      } catch (err) {
        next(err);
      }
    }
  );

  app.delete(
    '/api/v1/projects/:id',
    requirePermission(SharePermission.ADMIN),
    (req: AuthedRequest, res) => {
      const project = projects.get(req.params.id);
      if (!project || project.organizationId !== req.authUser!.organizationId) {
        res.status(404).json({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        });
        return;
      }
      projects.delete(project.id);
      for (const [fid, f] of files) {
        if (f.projectId === project.id) files.delete(fid);
      }
      res.json({ success: true, data: { id: project.id, deleted: true } });
    }
  );

  // ---- File upload, conversion & viewer routes ----
  app.post(
    '/api/v1/files/init',
    requirePermission(SharePermission.EDIT),
    (req: AuthedRequest, res, next) => {
      try {
        const body = initFileUploadRequestSchema.parse(req.body);
        const project = projects.get(body.projectId);
        if (!project || project.organizationId !== req.authUser!.organizationId) {
          res.status(404).json({
            success: false,
            error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
          });
          return;
        }

        const now = new Date().toISOString();
        const fileId = `fil_${crypto.randomUUID().slice(0, 8)}`;
        const versionId = `ver_${crypto.randomUUID().slice(0, 8)}`;
        const uploadId = `upl_${crypto.randomUUID()}`;
        const extension =
          path.extname(body.fileName).replace('.', '').toLowerCase() || 'bin';
        const safeName = body.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storageKey = `orgs/${req.authUser!.organizationId}/projects/${project.id}/${fileId}/v1/${safeName}`;
        const totalChunks = Math.max(1, Math.ceil(body.sizeBytes / body.chunkSize));

        internalStorageKeys.set(versionId, storageKey);

        const version: FileVersion = {
          id: versionId,
          fileId,
          versionNumber: 1,
          sizeBytes: body.sizeBytes,
          checksum: null,
          status: FileStatus.UPLOADING,
          uploadedById: req.authUser!.id,
          createdAt: now,
          updatedAt: now,
        };

        const fileRecord: DesignFile = {
          id: fileId,
          projectId: project.id,
          folderId: body.folderId ?? null,
          uploadedById: req.authUser!.id,
          name: body.fileName,
          originalName: body.fileName,
          mimeType: body.mimeType,
          extension,
          sizeBytes: body.sizeBytes,
          status: FileStatus.UPLOADING,
          currentVersion: 1,
          versions: [version],
          createdAt: now,
          updatedAt: now,
        };

        files.set(fileId, fileRecord);
        uploadSessions.set(uploadId, {
          uploadId,
          fileId,
          versionId,
          storageKey,
          parts: new Map(),
        });

        const presignedUrls = Array.from({ length: totalChunks }, (_, idx) => ({
          partNumber: idx + 1,
          url: `/api/v1/files/${fileId}/chunk?uploadId=${encodeURIComponent(uploadId)}&partNumber=${idx + 1}`,
        }));

        res.status(201).json({
          success: true,
          data: {
            file: fileRecord,
            version,
            uploadId,
            chunkSize: body.chunkSize,
            totalChunks,
            presignedUrls,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // Direct presigned-style PUT endpoint: accepts raw binary with or without Content-Type,
  // validates via uploadId (no Authorization header required, matching MinIO/S3 SigV4 PUT),
  // and exposes ETag header for UploadDropzone.
  app.put(
    '/api/v1/files/:id/chunk',
    express.raw({ type: () => true, limit: '60mb' }),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = uploadChunkQuerySchema.parse(req.query);
        const session = uploadSessions.get(query.uploadId);
        if (!session || session.fileId !== req.params.id) {
          res.status(404).json({
            success: false,
            error: {
              code: 'UPLOAD_NOT_FOUND',
              message: 'Upload session not found for this file',
            },
          });
          return;
        }

        const chunkBuffer = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(typeof req.body === 'string' ? req.body : '');

        const partDir = path.join(UPLOAD_ROOT, session.uploadId);
        fs.mkdirSync(partDir, { recursive: true });
        const partPath = path.join(partDir, `part-${query.partNumber}`);
        fs.writeFileSync(partPath, chunkBuffer);

        const etag = `"${crypto.createHash('md5').update(chunkBuffer).digest('hex')}"`;
        session.parts.set(query.partNumber, {
          etag,
          size: chunkBuffer.byteLength,
          path: partPath,
        });

        res.setHeader('ETag', etag);
        res.json({
          success: true,
          data: {
            fileId: session.fileId,
            uploadId: session.uploadId,
            partNumber: query.partNumber,
            etag,
            receivedBytes: chunkBuffer.byteLength,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/v1/files/:id/complete',
    requirePermission(SharePermission.EDIT),
    (req: AuthedRequest, res, next) => {
      try {
        const body = completeFileUploadRequestSchema.parse(req.body);
        const session = uploadSessions.get(body.uploadId);
        const file = files.get(req.params.id);

        if (!session || !file || session.fileId !== file.id) {
          res.status(404).json({
            success: false,
            error: { code: 'UPLOAD_NOT_FOUND', message: 'Upload session not found' },
          });
          return;
        }

        // Assemble uploaded chunks into one source buffer
        const sortedParts = Array.from(session.parts.entries()).sort((a, b) => a[0] - b[0]);
        const buffers = sortedParts.map(([, part]) => fs.readFileSync(part.path));
        const combined = Buffer.concat(buffers);

        const version = file.versions?.[0];
        if (version) {
          version.checksum = body.checksum ?? null;
          versionSourceBuffers.set(version.id, {
            buffer: combined,
            fileName: file.name,
          });
          scheduleConversion(file, version);
        }

        uploadSessions.delete(body.uploadId);
        res.json({ success: true, data: file });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get('/api/v1/files', authenticate, (req: AuthedRequest, res, next) => {
    try {
      const query = fileListQuerySchema.parse(req.query);
      const project = projects.get(query.projectId);
      if (!project || project.organizationId !== req.authUser!.organizationId) {
        res.status(404).json({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        });
        return;
      }

      const items = Array.from(files.values())
        .filter(
          (f) =>
            f.projectId === project.id &&
            (!query.folderId || f.folderId === query.folderId)
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      res.json({ success: true, data: { items } });
    } catch (err) {
      next(err);
    }
  });

  app.get(
    '/api/v1/files/:id/status',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res) => {
      const file = files.get(req.params.id);
      if (!file) {
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
        return;
      }

      const version = resolveVersionForFile(file, req.query.v);
      if (!version) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'File version not found' },
        });
        return;
      }

      const jobStatus =
        version.status === FileStatus.READY
          ? 'DONE'
          : version.status === FileStatus.FAILED
            ? 'FAILED'
            : version.status === FileStatus.PROCESSING
              ? 'RUNNING'
              : 'QUEUED';

      const mode: ConversionMode =
        versionModes.get(version.id) ??
        (is2DExtension(file.extension)
          ? file.extension.toLowerCase() === 'pdf'
            ? '2D_PDF'
            : '2D_DXF'
          : '3D');

      res.json({
        success: true,
        data: {
          status: version.status,
          jobStatus,
          mode,
          ...(versionErrors.get(version.id)
            ? { error: versionErrors.get(version.id) }
            : {}),
        },
      });
    }
  );

  app.get(
    '/api/v1/files/:id/glb',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res) => {
      const file = files.get(req.params.id);
      if (!file) {
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
        return;
      }

      const version = resolveVersionForFile(file, req.query.v);
      if (!version) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'File version not found' },
        });
        return;
      }

      if (version.status === FileStatus.PROCESSING || version.status === FileStatus.UPLOADING) {
        res.status(202).json({
          success: true,
          data: { status: 'processing' },
        });
        return;
      }

      if (version.status === FileStatus.FAILED) {
        res.status(422).json({
          success: false,
          error: {
            code: 'CONVERSION_FAILED',
            message: versionErrors.get(version.id) ?? '3D model conversion failed',
          },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          url: `/api/v1/files/${file.id}/glb-binary?v=${version.versionNumber}`,
          expiresInSeconds: 900,
        },
      });
    }
  );

  app.get('/api/v1/files/:id/glb-binary', (req: Request, res: Response) => {
    const file = files.get(req.params.id);
    if (!file) {
      res.status(404).json({
        success: false,
        error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
      });
      return;
    }

    const version = resolveVersionForFile(file, req.query.v);
    const artifact = version ? versionArtifacts.get(version.id) : undefined;
    if (!artifact) {
      res.status(404).json({
        success: false,
        error: { code: 'GLB_NOT_READY', message: 'Converted GLB asset not found' },
      });
      return;
    }

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(Buffer.from(artifact.glbBuffer));
  });

  app.get(
    '/api/v1/files/:id/tree',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res) => {
      const file = files.get(req.params.id);
      if (!file) {
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
        return;
      }

      const version = resolveVersionForFile(file, req.query.v);
      const artifact = version ? versionArtifacts.get(version.id) : undefined;
      res.json({
        success: true,
        data: {
          partTree: artifact?.partTree ?? null,
        },
      });
    }
  );

  // ---- Session 7: Client-computed geometry feature cache (L2) ----
  app.get(
    '/api/v1/files/:id/features',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res) => {
      const file = files.get(req.params.id);
      if (!file) {
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
        return;
      }

      const versionIdParam =
        typeof req.query.versionId === 'string' && req.query.versionId.trim().length > 0
          ? req.query.versionId.trim()
          : undefined;
      const version = versionIdParam
        ? (file.versions ?? []).find((v) => v.id === versionIdParam)
        : resolveVersionForFile(file, req.query.v);

      if (!version) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'File version not found' },
        });
        return;
      }

      const cached = versionFeaturesCache.get(version.id) ?? null;
      res.json({
        success: true,
        data: {
          fileId: file.id,
          versionId: version.id,
          cached: cached !== null,
          data: cached,
        },
      });
    }
  );

  app.post(
    '/api/v1/files/:id/features',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res, next) => {
      try {
        const file = files.get(req.params.id);
        if (!file) {
          res.status(404).json({
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
          });
          return;
        }

        const versionIdParam =
          typeof req.query.versionId === 'string' && req.query.versionId.trim().length > 0
            ? req.query.versionId.trim()
            : undefined;
        const version = versionIdParam
          ? (file.versions ?? []).find((v) => v.id === versionIdParam)
          : resolveVersionForFile(file, req.query.v);

        if (!version) {
          res.status(404).json({
            success: false,
            error: { code: 'VERSION_NOT_FOUND', message: 'File version not found' },
          });
          return;
        }

        const parsed = saveFileFeaturesRequestSchema.parse(req.body);
        const payload: FileFeaturesCacheData = {
          version: parsed.version,
          extractedAt: parsed.extractedAt ?? new Date().toISOString(),
          features: parsed.features,
          partSummaries: parsed.partSummaries,
        };
        versionFeaturesCache.set(version.id, payload);

        res.status(200).json({
          success: true,
          data: {
            fileId: file.id,
            versionId: version.id,
            cached: true,
            data: payload,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ---- Session 4: 2D Scene Graph & PDF Page Endpoints ----
  app.get(
    '/api/v1/files/:id/2d/scene',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res) => {
      const file = files.get(req.params.id);
      if (!file) {
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
        return;
      }

      const version = resolveVersionForFile(file, req.query.v);
      if (!version) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'File version not found' },
        });
        return;
      }

      const mode =
        versionModes.get(version.id) ??
        (is2DExtension(file.extension)
          ? file.extension.toLowerCase() === 'pdf'
            ? '2D_PDF'
            : '2D_DXF'
          : '3D');

      if (mode === '3D' || !is2DExtension(file.extension)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NOT_2D',
            message: 'This file is a 3D model, not a 2D drawing',
          },
        });
        return;
      }

      if (
        version.status === FileStatus.PROCESSING ||
        version.status === FileStatus.UPLOADING
      ) {
        res.status(202).json({
          success: true,
          data: { status: 'processing' },
        });
        return;
      }

      if (version.status === FileStatus.FAILED) {
        res.status(422).json({
          success: false,
          error: {
            code: 'CONVERSION_FAILED',
            message: versionErrors.get(version.id) ?? '2D drawing conversion failed',
          },
        });
        return;
      }

      const artifact2d = version2DArtifacts.get(version.id);
      if (!artifact2d) {
        res.status(202).json({
          success: true,
          data: { status: 'processing' },
        });
        return;
      }

      if (artifact2d.mode === '2D_DXF') {
        res.json({
          success: true,
          data: {
            mode: '2D_DXF',
            scene: artifact2d.scene,
            layers: artifact2d.layers,
            bounds: artifact2d.bounds,
          },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          mode: '2D_PDF',
          pageManifest: artifact2d.pageManifest,
        },
      });
    }
  );

  app.get(
    '/api/v1/files/:id/2d/page/:n',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res) => {
      const file = files.get(req.params.id);
      if (!file) {
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
        return;
      }

      const pageNum = Number(req.params.n);
      if (!Number.isInteger(pageNum) || pageNum < 1) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PAGE', message: 'Page number must be a positive integer' },
        });
        return;
      }

      const version = resolveVersionForFile(file, req.query.v);
      const artifact2d = version ? version2DArtifacts.get(version.id) : undefined;
      if (!version || !artifact2d || artifact2d.mode !== '2D_PDF') {
        res.status(400).json({
          success: false,
          error: {
            code: 'NOT_PDF',
            message: 'Page raster images are only available for PDF files',
          },
        });
        return;
      }

      if (pageNum > artifact2d.pageManifest.pageCount || !artifact2d.pages.has(pageNum)) {
        res.status(404).json({
          success: false,
          error: { code: 'PAGE_NOT_FOUND', message: `PDF page ${pageNum} not found` },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          url: `/api/v1/files/${file.id}/2d/page-image/${pageNum}?v=${version.versionNumber}`,
          page: pageNum,
        },
      });
    }
  );

  app.get('/api/v1/files/:id/2d/page-image/:n', (req: Request, res: Response) => {
    const file = files.get(req.params.id);
    const pageNum = Number(req.params.n);
    const version = file ? resolveVersionForFile(file, req.query.v) : null;
    const artifact2d = version ? version2DArtifacts.get(version.id) : undefined;

    if (
      !file ||
      !version ||
      !artifact2d ||
      artifact2d.mode !== '2D_PDF' ||
      !Number.isInteger(pageNum)
    ) {
      res.status(404).json({
        success: false,
        error: { code: 'PAGE_NOT_FOUND', message: 'PDF page image not found' },
      });
      return;
    }

    const png = artifact2d.pages.get(pageNum);
    if (!png) {
      res.status(404).json({
        success: false,
        error: { code: 'PAGE_NOT_FOUND', message: 'PDF page image not found' },
      });
      return;
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(png);
  });

  app.post(
    '/api/v1/files/:id/reconvert',
    requirePermission(SharePermission.EDIT),
    (req: AuthedRequest, res) => {
      const file = files.get(req.params.id);
      if (!file) {
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
        return;
      }

      const version = resolveVersionForFile(file, req.query.v);
      if (!version) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'File version not found' },
        });
        return;
      }

      scheduleConversion(file, version);
      res.status(202).json({
        success: true,
        data: {
          status: FileStatus.PROCESSING,
          versionId: version.id,
          versionNumber: version.versionNumber,
        },
      });
    }
  );

  app.get(
    '/api/v1/files/:id',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res) => {
      const file = files.get(req.params.id);
      if (!file) {
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
        return;
      }

      if (req.authUser) {
        const project = projects.get(file.projectId);
        if (!project || project.organizationId !== req.authUser.organizationId) {
          res.status(404).json({
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
          });
          return;
        }
      }

      res.json({ success: true, data: file });
    }
  );

  app.delete(
    '/api/v1/files/:id',
    requirePermission(SharePermission.EDIT),
    (req: AuthedRequest, res) => {
      const file = files.get(req.params.id);
      if (!file) {
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
        return;
      }
      const project = projects.get(file.projectId);
      if (!project || project.organizationId !== req.authUser!.organizationId) {
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
        return;
      }
      files.delete(file.id);
      res.json({ success: true, data: { id: file.id, deleted: true } });
    }
  );

  // ---- Share routes ----
  app.post(
    '/api/v1/share',
    requirePermission(SharePermission.EDIT),
    (req: AuthedRequest, res, next) => {
      try {
        const body = createShareLinkRequestSchema.parse(req.body);
        const orgId = req.authUser?.organizationId;
        const ownsProject = (projectId: string | undefined) =>
          Boolean(projectId && orgId && projects.get(projectId)?.organizationId === orgId);
        if (
          !orgId ||
          (body.fileId && !ownsProject(files.get(body.fileId)?.projectId)) ||
          (body.projectId && !ownsProject(body.projectId))
        ) {
          res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Resource not found' },
          });
          return;
        }
        const now = new Date().toISOString();
        const token = crypto.randomBytes(18).toString('base64url');
        const expiresAt = body.expiresInHours
          ? new Date(Date.now() + body.expiresInHours * 3600 * 1000).toISOString()
          : null;

        const link: ShareLink = {
          id: `shr_${crypto.randomUUID().slice(0, 8)}`,
          token,
          fileId: body.fileId ?? null,
          projectId: body.projectId ?? null,
          createdById: req.authUser!.id,
          permission: body.permission,
          expiresAt,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        shareLinks.set(token, link);
        res.status(201).json({ success: true, data: link });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get('/api/v1/share/:token', (req, res) => {
    const link = shareLinks.get(req.params.token);
    if (!link || link.revokedAt) {
      res.status(404).json({
        success: false,
        error: { code: 'SHARE_NOT_FOUND', message: 'Share link not found or revoked' },
      });
      return;
    }

    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
      res.status(410).json({
        success: false,
        error: { code: 'SHARE_EXPIRED', message: 'Share link has expired' },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        shareLink: link,
        file: link.fileId ? (files.get(link.fileId) ?? null) : null,
        project: link.projectId ? (projects.get(link.projectId) ?? null) : null,
      },
    });
  });

  // ---- Session 3: Annotations routes ----
  app.post(
    '/api/v1/files/:fileId/annotations',
    requirePermission(SharePermission.MEASURE),
    (req: AuthedRequest, res, next) => {
      try {
        if (!req.authUser) {
          res.status(401).json({
            success: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'Authenticated user session required to create annotations',
            },
          });
          return;
        }
        const file = files.get(req.params.fileId);
        const project = file ? projects.get(file.projectId) : undefined;
        if (!file || !project || project.organizationId !== req.authUser.organizationId) {
          res.status(404).json({
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
          });
          return;
        }

        const body = createAnnotationRequestSchema.parse(req.body);
        const version = (file.versions ?? []).find((v) => v.id === body.versionId);
        if (!version) {
          res.status(404).json({
            success: false,
            error: {
              code: 'VERSION_NOT_FOUND',
              message: 'File version not found for this file',
            },
          });
          return;
        }

        const now = new Date().toISOString();
        const annotation: Annotation = {
          id: `ann_${crypto.randomUUID().slice(0, 8)}`,
          fileId: file.id,
          versionId: version.id,
          userId: req.authUser.id,
          type: body.type,
          label: body.label ?? null,
          payload: body.payload,
          createdAt: now,
          updatedAt: now,
        };
        annotationsStore.set(annotation.id, annotation);

        recordActivity({
          organizationId: req.authUser.organizationId,
          projectId: file.projectId,
          fileId: file.id,
          userId: req.authUser.id,
          action: ActivityAction.ANNOTATION_CREATED,
          metadata: {
            annotationId: annotation.id,
            versionId: version.id,
            type: annotation.type,
            label: annotation.label,
          },
        });

        const hydrated = hydrateAnnotation(annotation);
        broadcastFileDelta(
          io,
          file.id,
          REALTIME_EVENTS.ANNOTATION_CREATE,
          hydrated,
          {
            userId: req.authUser.id,
            name: req.authUser.name,
            avatarColor: computeAvatarColor(req.authUser.id),
          },
          readOriginSocketId(req)
        );

        res.status(201).json({
          success: true,
          data: hydrated,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get(
    '/api/v1/files/:fileId/annotations',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res, next) => {
      try {
        const file = files.get(req.params.fileId);
        const project = file ? projects.get(file.projectId) : undefined;
        if (
          !file ||
          (req.authUser && (!project || project.organizationId !== req.authUser.organizationId))
        ) {
          res.status(404).json({
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
          });
          return;
        }

        const query = annotationsListQuerySchema.parse(req.query);
        const items = Array.from(annotationsStore.values())
          .filter((a) => a.fileId === file.id)
          .filter((a) => (query.versionId ? a.versionId === query.versionId : true))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map(hydrateAnnotation);

        res.json({ success: true, data: items });
      } catch (err) {
        next(err);
      }
    }
  );

  app.patch('/api/v1/annotations/:id', authenticate, (req: AuthedRequest, res, next) => {
    try {
      const existing = annotationsStore.get(req.params.id);
      const file = existing ? files.get(existing.fileId) : undefined;
      const project = file ? projects.get(file.projectId) : undefined;
      if (!existing || !project || project.organizationId !== req.authUser!.organizationId) {
        res.status(404).json({
          success: false,
          error: { code: 'ANNOTATION_NOT_FOUND', message: 'Annotation not found' },
        });
        return;
      }

      if (existing.userId !== req.authUser!.id && !isAdminUserRole(req.authUser!.role)) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only the author or an administrator can modify this annotation',
          },
        });
        return;
      }

      const body = updateAnnotationRequestSchema.parse(req.body);
      const updated: Annotation = {
        ...existing,
        label: body.label !== undefined ? body.label : existing.label,
        payload: body.payload !== undefined ? body.payload : existing.payload,
        updatedAt: new Date().toISOString(),
      };
      annotationsStore.set(updated.id, updated);

      const hydrated = hydrateAnnotation(updated);
      broadcastFileDelta(
        io,
        existing.fileId,
        REALTIME_EVENTS.ANNOTATION_UPDATE,
        hydrated,
        {
          userId: req.authUser!.id,
          name: req.authUser!.name,
          avatarColor: computeAvatarColor(req.authUser!.id),
        },
        readOriginSocketId(req)
      );

      res.json({ success: true, data: hydrated });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/v1/annotations/:id', authenticate, (req: AuthedRequest, res) => {
    const existing = annotationsStore.get(req.params.id);
    const file = existing ? files.get(existing.fileId) : undefined;
    const project = file ? projects.get(file.projectId) : undefined;
    if (!existing || !project || project.organizationId !== req.authUser!.organizationId) {
      res.status(404).json({
        success: false,
        error: { code: 'ANNOTATION_NOT_FOUND', message: 'Annotation not found' },
      });
      return;
    }

    if (existing.userId !== req.authUser!.id && !isAdminUserRole(req.authUser!.role)) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Only the author or an administrator can delete this annotation',
        },
      });
      return;
    }

    annotationsStore.delete(existing.id);
    // Match Prisma onDelete: SetNull on Comment.annotation
    for (const [cid, comment] of commentsStore) {
      if (comment.annotationId === existing.id) {
        commentsStore.set(cid, { ...comment, annotationId: null });
      }
    }

    const deletePayload: EntityDeletePayload = {
      id: existing.id,
      fileId: existing.fileId,
      versionId: existing.versionId,
    };
    broadcastFileDelta(
      io,
      existing.fileId,
      REALTIME_EVENTS.ANNOTATION_DELETE,
      deletePayload,
      {
        userId: req.authUser!.id,
        name: req.authUser!.name,
        avatarColor: computeAvatarColor(req.authUser!.id),
      },
      readOriginSocketId(req)
    );

    res.json({ success: true, data: { id: existing.id, deleted: true } });
  });

  // ---- Session 3: Comments routes ----
  app.post(
    '/api/v1/files/:fileId/comments',
    requirePermission(SharePermission.COMMENT),
    (req: AuthedRequest, res, next) => {
      try {
        if (!req.authUser) {
          res.status(401).json({
            success: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'Authenticated user session required to post comments',
            },
          });
          return;
        }
        const file = files.get(req.params.fileId);
        const project = file ? projects.get(file.projectId) : undefined;
        if (!file || !project || project.organizationId !== req.authUser.organizationId) {
          res.status(404).json({
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
          });
          return;
        }

        const body = createCommentRequestSchema.parse(req.body);
        let resolvedAnnotationId: string | null = body.annotationId ?? null;

        if (body.parentId) {
          const parent = commentsStore.get(body.parentId);
          if (!parent || parent.fileId !== file.id) {
            res.status(400).json({
              success: false,
              error: {
                code: 'INVALID_PARENT_COMMENT',
                message: 'Parent comment does not exist on this file',
              },
            });
            return;
          }
          if (parent.parentId !== null) {
            res.status(400).json({
              success: false,
              error: {
                code: 'NESTING_LIMIT_EXCEEDED',
                message: 'Comments support one level of replies only',
              },
            });
            return;
          }
          if (!resolvedAnnotationId && parent.annotationId) {
            resolvedAnnotationId = parent.annotationId;
          }
        }

        if (resolvedAnnotationId) {
          const ann = annotationsStore.get(resolvedAnnotationId);
          if (!ann || ann.fileId !== file.id) {
            res.status(400).json({
              success: false,
              error: {
                code: 'INVALID_ANNOTATION',
                message: 'Referenced annotation does not belong to this file',
              },
            });
            return;
          }
        }

        const now = new Date().toISOString();
        const created: Comment = {
          id: `cmt_${crypto.randomUUID().slice(0, 8)}`,
          fileId: file.id,
          annotationId: resolvedAnnotationId,
          userId: req.authUser.id,
          parentId: body.parentId ?? null,
          body: body.body,
          resolved: false,
          createdAt: now,
          updatedAt: now,
        };
        commentsStore.set(created.id, created);

        recordActivity({
          organizationId: req.authUser.organizationId,
          projectId: file.projectId,
          fileId: file.id,
          userId: req.authUser.id,
          action: ActivityAction.COMMENT_CREATED,
          metadata: {
            commentId: created.id,
            annotationId: created.annotationId,
            parentId: created.parentId,
          },
        });

        const payload: CommentWithReplies = {
          ...hydrateComment(created),
          replies: [],
        };
        broadcastFileDelta(
          io,
          file.id,
          REALTIME_EVENTS.COMMENT_CREATE,
          payload,
          {
            userId: req.authUser.id,
            name: req.authUser.name,
            avatarColor: computeAvatarColor(req.authUser.id),
          },
          readOriginSocketId(req)
        );
        res.status(201).json({ success: true, data: payload });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get(
    '/api/v1/files/:fileId/comments',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res, next) => {
      try {
        const file = files.get(req.params.fileId);
        const project = file ? projects.get(file.projectId) : undefined;
        if (
          !file ||
          (req.authUser && (!project || project.organizationId !== req.authUser.organizationId))
        ) {
          res.status(404).json({
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
          });
          return;
        }

        const query = commentsListQuerySchema.parse(req.query);
        const allForFile = Array.from(commentsStore.values()).filter(
          (c) => c.fileId === file.id
        );

        const topLevelAll = allForFile
          .filter((c) => c.parentId === null)
          .filter((c) => (query.annotationId ? c.annotationId === query.annotationId : true))
          .filter((c) => {
            if (!query.versionId) return true;
            if (!c.annotationId) return false;
            const ann = annotationsStore.get(c.annotationId);
            return ann?.versionId === query.versionId;
          })
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        const resolvedTopLevel = topLevelAll.filter((c) => c.resolved).length;
        const totalTopLevel = topLevelAll.length;
        const unresolvedTopLevel = totalTopLevel - resolvedTopLevel;

        const filteredTopLevel =
          query.resolved === undefined
            ? topLevelAll
            : topLevelAll.filter((c) => c.resolved === query.resolved);

        const items: CommentWithReplies[] = filteredTopLevel.map((top) => {
          const replies = allForFile
            .filter((c) => c.parentId === top.id)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map(hydrateComment);
          return {
            ...hydrateComment(top),
            replies,
          };
        });

        const payload: CommentsListResponse = {
          items,
          summary: {
            totalTopLevel,
            unresolvedTopLevel,
            resolvedTopLevel,
          },
        };

        res.json({ success: true, data: payload });
      } catch (err) {
        next(err);
      }
    }
  );

  app.patch('/api/v1/comments/:id', authenticate, (req: AuthedRequest, res, next) => {
    try {
      const existing = commentsStore.get(req.params.id);
      const file = existing ? files.get(existing.fileId) : undefined;
      const project = file ? projects.get(file.projectId) : undefined;
      if (!existing || !project || project.organizationId !== req.authUser!.organizationId) {
        res.status(404).json({
          success: false,
          error: { code: 'COMMENT_NOT_FOUND', message: 'Comment not found' },
        });
        return;
      }

      if (existing.userId !== req.authUser!.id && !isAdminUserRole(req.authUser!.role)) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only the author or an administrator can modify this comment',
          },
        });
        return;
      }

      const body = updateCommentRequestSchema.parse(req.body);
      const updated: Comment = {
        ...existing,
        body: body.body !== undefined ? body.body : existing.body,
        resolved: body.resolved !== undefined ? body.resolved : existing.resolved,
        updatedAt: new Date().toISOString(),
      };
      commentsStore.set(updated.id, updated);

      const hydrated = hydrateComment(updated);
      broadcastFileDelta(
        io,
        existing.fileId,
        REALTIME_EVENTS.COMMENT_UPDATE,
        hydrated,
        {
          userId: req.authUser!.id,
          name: req.authUser!.name,
          avatarColor: computeAvatarColor(req.authUser!.id),
        },
        readOriginSocketId(req)
      );

      res.json({ success: true, data: hydrated });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/v1/comments/:id', authenticate, (req: AuthedRequest, res) => {
    const existing = commentsStore.get(req.params.id);
    const file = existing ? files.get(existing.fileId) : undefined;
    const project = file ? projects.get(file.projectId) : undefined;
    if (!existing || !project || project.organizationId !== req.authUser!.organizationId) {
      res.status(404).json({
        success: false,
        error: { code: 'COMMENT_NOT_FOUND', message: 'Comment not found' },
      });
      return;
    }

    if (existing.userId !== req.authUser!.id && !isAdminUserRole(req.authUser!.role)) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Only the author or an administrator can delete this comment',
        },
      });
      return;
    }

    commentsStore.delete(existing.id);
    // Cascade delete replies
    for (const [cid, c] of commentsStore) {
      if (c.parentId === existing.id) {
        commentsStore.delete(cid);
      }
    }

    const deletePayload: EntityDeletePayload = {
      id: existing.id,
      fileId: existing.fileId,
    };
    broadcastFileDelta(
      io,
      existing.fileId,
      REALTIME_EVENTS.COMMENT_DELETE,
      deletePayload,
      {
        userId: req.authUser!.id,
        name: req.authUser!.name,
        avatarColor: computeAvatarColor(req.authUser!.id),
      },
      readOriginSocketId(req)
    );

    res.json({ success: true, data: { id: existing.id, deleted: true } });
  });

  // ---- Session 3: Measurements routes ----
  app.post(
    '/api/v1/files/:fileId/measurements',
    requirePermission(SharePermission.MEASURE),
    (req: AuthedRequest, res, next) => {
      try {
        if (!req.authUser) {
          res.status(401).json({
            success: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'Authenticated user session required to save measurements',
            },
          });
          return;
        }
        const file = files.get(req.params.fileId);
        const project = file ? projects.get(file.projectId) : undefined;
        if (!file || !project || project.organizationId !== req.authUser.organizationId) {
          res.status(404).json({
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
          });
          return;
        }

        const body = createMeasurementRequestSchema.parse(req.body);
        const version = (file.versions ?? []).find((v) => v.id === body.versionId);
        if (!version) {
          res.status(404).json({
            success: false,
            error: {
              code: 'VERSION_NOT_FOUND',
              message: 'File version not found for this file',
            },
          });
          return;
        }

        const now = new Date().toISOString();
        const created: Measurement = {
          id: `msr_${crypto.randomUUID().slice(0, 8)}`,
          fileId: file.id,
          versionId: version.id,
          userId: req.authUser.id,
          type: body.type,
          value: body.value,
          unit: body.unit,
          points: body.points,
          createdAt: now,
          updatedAt: now,
        };
        measurementsStore.set(created.id, created);

        recordActivity({
          organizationId: req.authUser.organizationId,
          projectId: file.projectId,
          fileId: file.id,
          userId: req.authUser.id,
          action: ActivityAction.MEASUREMENT_CREATED,
          metadata: {
            measurementId: created.id,
            versionId: version.id,
            type: created.type,
            value: created.value,
            unit: created.unit,
          },
        });

        const hydrated = hydrateMeasurement(created);
        broadcastFileDelta(
          io,
          file.id,
          REALTIME_EVENTS.MEASUREMENT_CREATE,
          hydrated,
          {
            userId: req.authUser.id,
            name: req.authUser.name,
            avatarColor: computeAvatarColor(req.authUser.id),
          },
          readOriginSocketId(req)
        );

        res.status(201).json({
          success: true,
          data: hydrated,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get(
    '/api/v1/files/:fileId/measurements',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res, next) => {
      try {
        const file = files.get(req.params.fileId);
        const project = file ? projects.get(file.projectId) : undefined;
        if (
          !file ||
          (req.authUser && (!project || project.organizationId !== req.authUser.organizationId))
        ) {
          res.status(404).json({
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
          });
          return;
        }

        const query = measurementsListQuerySchema.parse(req.query);
        const items = Array.from(measurementsStore.values())
          .filter((m) => m.fileId === file.id)
          .filter((m) => (query.versionId ? m.versionId === query.versionId : true))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map(hydrateMeasurement);

        res.json({ success: true, data: items });
      } catch (err) {
        next(err);
      }
    }
  );

  app.delete('/api/v1/measurements/:id', authenticate, (req: AuthedRequest, res) => {
    const existing = measurementsStore.get(req.params.id);
    const file = existing ? files.get(existing.fileId) : undefined;
    const project = file ? projects.get(file.projectId) : undefined;
    if (!existing || !project || project.organizationId !== req.authUser!.organizationId) {
      res.status(404).json({
        success: false,
        error: { code: 'MEASUREMENT_NOT_FOUND', message: 'Measurement not found' },
      });
      return;
    }

    if (existing.userId !== req.authUser!.id && !isAdminUserRole(req.authUser!.role)) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Only the author or an administrator can delete this measurement',
        },
      });
      return;
    }

    measurementsStore.delete(existing.id);

    const deletePayload: EntityDeletePayload = {
      id: existing.id,
      fileId: existing.fileId,
      versionId: existing.versionId,
    };
    broadcastFileDelta(
      io,
      existing.fileId,
      REALTIME_EVENTS.MEASUREMENT_DELETE,
      deletePayload,
      {
        userId: req.authUser!.id,
        name: req.authUser!.name,
        avatarColor: computeAvatarColor(req.authUser!.id),
      },
      readOriginSocketId(req)
    );

    res.json({ success: true, data: { id: existing.id, deleted: true } });
  });

  app.patch('/api/v1/measurements/:id', authenticate, (req: AuthedRequest, res, next) => {
    try {
      const existing = measurementsStore.get(req.params.id);
      const file = existing ? files.get(existing.fileId) : undefined;
      const project = file ? projects.get(file.projectId) : undefined;
      if (!existing || !project || project.organizationId !== req.authUser!.organizationId) {
        res.status(404).json({
          success: false,
          error: { code: 'MEASUREMENT_NOT_FOUND', message: 'Measurement not found' },
        });
        return;
      }

      if (existing.userId !== req.authUser!.id && !isAdminUserRole(req.authUser!.role)) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only the author or an administrator can update this measurement',
          },
        });
        return;
      }

      const body = updateMeasurementRequestSchema.parse(req.body);
      const updated: Measurement = {
        ...existing,
        value: body.value !== undefined ? body.value : existing.value,
        unit: body.unit !== undefined ? body.unit : existing.unit,
        points: body.points !== undefined ? body.points : existing.points,
        updatedAt: new Date().toISOString(),
      };
      measurementsStore.set(updated.id, updated);

      res.json({ success: true, data: hydrateMeasurement(updated) });
    } catch (err) {
      next(err);
    }
  });

  // ---- Session 5: HTTP presence heartbeat fallback (B4) ----
  app.post(
    '/api/v1/files/:id/presence/ping',
    requirePermission(SharePermission.VIEW),
    (req: AuthedRequest, res) => {
      const fileId = req.params.id;
      const userId = req.authUser?.id ?? `guest_${req.ip}`;
      const key = `${fileId}::${userId}`;
      const now = Date.now();
      httpPresencePings.set(key, {
        expiresAt: now + 30_000,
        user: {
          userId,
          name: req.authUser?.name ?? 'Guest Reviewer',
          email: req.authUser?.email ?? 'guest@share.local',
          avatarColor: computeAvatarColor(userId),
          joinedAt: new Date(now).toISOString(),
        },
      });
      // Prune expired pings
      for (const [k, entry] of httpPresencePings.entries()) {
        if (entry.expiresAt < now) httpPresencePings.delete(k);
      }
      res.json({
        success: true,
        data: { fileId, ttlSeconds: 30, serverTs: now },
      });
    }
  );

  // ---- Session 5: Project Activity Feed (C7) ----
  app.get('/api/v1/projects/:id/activity', authenticate, (req: AuthedRequest, res) => {
    const project = projects.get(req.params.id);
    if (!project || project.organizationId !== req.authUser!.organizationId) {
      res.status(404).json({
        success: false,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
      });
      return;
    }

    const items: ActivityLogWithAuthor[] = activityLogs
      .filter(
        (log) =>
          log.organizationId === req.authUser!.organizationId &&
          log.projectId === project.id
      )
      .slice(-20)
      .reverse()
      .map((log) => {
        const u = users.get(log.userId);
        const f = log.fileId ? files.get(log.fileId) : undefined;
        return {
          ...log,
          author: u
            ? {
                id: u.id,
                name: u.name,
                email: u.email,
                avatarUrl: u.avatarUrl,
              }
            : undefined,
          fileName: f?.name ?? null,
        };
      });

    res.json({ success: true, data: items });
  });

  // ---- Session 6: AI Design Assistant Routes ----
  const aiInsightsStore: AIInsight[] = [];

  const sendAiNotConfigured = (res: Response): void => {
    res.status(503).json({
      success: false,
      code: 'AI_NOT_CONFIGURED',
      error: {
        code: 'AI_NOT_CONFIGURED',
        message:
          'AI Design Assistant is not configured on this server. Set GEMINI_API_KEY in the server environment to enable AI features.',
      },
    });
  };

  const enforceAiRateLimit = (
    userId: string,
    bucket: AiRateLimitBucket,
    res: Response
  ): boolean => {
    const check = checkAiRateLimit(userId, bucket);
    if (!check.allowed) {
      res.setHeader('Retry-After', String(check.retryAfterSeconds));
      res.status(429).json({
        success: false,
        code: 'AI_RATE_LIMIT',
        retryAfterSeconds: check.retryAfterSeconds,
        error: {
          code: 'AI_RATE_LIMIT',
          message: `AI rate limit exceeded. Try again in ${check.retryAfterSeconds}s.`,
          retryAfterSeconds: check.retryAfterSeconds,
        },
      });
      return false;
    }
    return true;
  };

  const handleAiRouteError = (err: unknown, res: Response): void => {
    if (err instanceof AiNotConfiguredError) {
      sendAiNotConfigured(res);
      return;
    }
    if (err instanceof AiBadResponseError) {
      res.status(502).json({
        success: false,
        code: 'AI_BAD_RESPONSE',
        error: {
          code: 'AI_BAD_RESPONSE',
          message: err.message,
        },
      });
      return;
    }
    const message = err instanceof Error ? err.message : 'AI request failed.';
    res.status(502).json({
      success: false,
      code: 'AI_UPSTREAM_ERROR',
      error: {
        code: 'AI_UPSTREAM_ERROR',
        message,
      },
    });
  };

  const resolveAiFileForUser = (
    req: AuthedRequest,
    fileId: string,
    requestedVersionId?: string
  ) => {
    const file = files.get(fileId);
    if (!file) {
      return {
        ok: false as const,
        errorStatus: 404 as const,
        code: 'FILE_NOT_FOUND',
        message: 'Design file not found',
      };
    }
    const project = projects.get(file.projectId);
    if (!project || project.organizationId !== req.authUser!.organizationId) {
      return {
        ok: false as const,
        errorStatus: 403 as const,
        code: 'FORBIDDEN',
        message: 'You do not have VIEW permission for this file',
      };
    }

    const versions = file.versions ?? [];
    const activeVersion =
      (requestedVersionId ? versions.find((v) => v.id === requestedVersionId) : undefined) ??
      versions[0];
    const versionId = activeVersion?.id ?? `${file.id}_v1`;

    const fileAnnotations = Array.from(annotationsStore.values())
      .filter((a) => a.fileId === file.id && (!activeVersion || a.versionId === versionId))
      .map((a) => {
        const linkedComments = Array.from(commentsStore.values()).filter(
          (c) => c.annotationId === a.id
        );
        return {
          ...a,
          commentCount: linkedComments.length,
          resolvedCommentCount: linkedComments.filter((c) => c.resolved).length,
          author: getAuthorSummary(a.userId),
        };
      });

    const fileComments = Array.from(commentsStore.values())
      .filter((c) => c.fileId === file.id)
      .map((c) => ({
        ...c,
        author: getAuthorSummary(c.userId),
      }));

    const fileMeasurements = Array.from(measurementsStore.values())
      .filter((m) => m.fileId === file.id && (!activeVersion || m.versionId === versionId))
      .map((m) => ({
        ...m,
        author: getAuthorSummary(m.userId),
      }));

    const artifact3D = versionArtifacts.get(versionId);
    const artifact2D = version2DArtifacts.get(versionId);

    return {
      ok: true as const,
      file,
      versionId,
      partTree: artifact3D?.partTree ?? null,
      dxf:
        artifact2D?.mode === '2D_DXF'
          ? {
              scene: artifact2D.scene,
              layers: artifact2D.layers,
              bounds: artifact2D.bounds,
            }
          : null,
      pdf: artifact2D?.mode === '2D_PDF' ? artifact2D.pageManifest : null,
      annotations: fileAnnotations,
      comments: fileComments,
      measurements: fileMeasurements,
    };
  };

  app.post('/api/v1/ai/chat', authenticate, async (req: AuthedRequest, res, next) => {
    try {
      const body = aiChatRequestSchema.parse(req.body);
      if (!enforceAiRateLimit(req.authUser!.id, 'chat', res)) return;
      if (!isAiConfigured()) {
        sendAiNotConfigured(res);
        return;
      }

      const loaded = resolveAiFileForUser(req, body.fileId, body.versionId);
      if (!loaded.ok) {
        res.status(loaded.errorStatus).json({
          success: false,
          error: { code: loaded.code, message: loaded.message },
        });
        return;
      }

      const ctx = buildAiFileContext(loaded);

      const systemInstruction = [
        'You are the Cadline Design Assistant helping mechanical and CAD engineers review a design file.',
        'You are given structured file metadata, assembly part tree (3D) or drawing layers/notes (2D), annotations numbered #1..#N, comments, and measurements.',
        'You do NOT see raw mesh triangles, B-rep solids, or raw PDF pixels—never claim to have visually inspected raw geometry.',
        'When referencing specific annotations, cite them with #1, #2, etc. matching the `ref` field in the context JSON.',
        'Be concise, technically accurate, and transparent about any missing information.',
      ].join(' ');

      const prompt = `DESIGN CONTEXT (JSON, <= 50KB):\n${ctx.serialized}\n\nUSER QUESTION:\n${body.message}`;

      try {
        const replyText = await generateText(prompt, {
          systemInstruction,
          model: AI_MODELS.flash,
          history: body.conversationHistory,
        });
        const referencedAnnotationIds = extractReferencedAnnotationIds(
          replyText,
          ctx.orderedAnnotations
        );
        const data: AiChatResponse = {
          reply: replyText,
          referencedAnnotationIds,
          contextStats: ctx.stats,
        };
        res.json({ success: true, data });
      } catch (err) {
        handleAiRouteError(err, res);
      }
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/ai/summary', authenticate, async (req: AuthedRequest, res, next) => {
    try {
      const body = aiFileTargetRequestSchema.parse(req.body);
      const query = aiSummaryQuerySchema.parse(req.query);
      if (!enforceAiRateLimit(req.authUser!.id, 'analysis', res)) return;
      if (!isAiConfigured()) {
        sendAiNotConfigured(res);
        return;
      }

      const loaded = resolveAiFileForUser(req, body.fileId, body.versionId);
      if (!loaded.ok) {
        res.status(loaded.errorStatus).json({
          success: false,
          error: { code: loaded.code, message: loaded.message },
        });
        return;
      }

      const force = Boolean(query.force);
      if (!force) {
        const cached = [...aiInsightsStore]
          .reverse()
          .find(
            (i) =>
              i.fileId === loaded.file.id &&
              i.versionId === loaded.versionId &&
              i.type === AIInsightType.SUMMARY
          );
        const latestActivity = [...activityLogs]
          .reverse()
          .find((l) => l.fileId === loaded.file.id);

        if (
          cached &&
          (!latestActivity ||
            new Date(latestActivity.createdAt).getTime() <=
              new Date(cached.createdAt).getTime())
        ) {
          const parsedCached = aiSummaryResultSchema.safeParse(cached.payload);
          if (parsedCached.success) {
            const data: AiSummaryResponse = {
              ...parsedCached.data,
              cached: true,
              insightId: cached.id,
              createdAt: cached.createdAt,
            };
            res.json({ success: true, data });
            return;
          }
        }
      }

      const ctx = buildAiFileContext(loaded);
      const systemInstruction = [
        'You summarize CAD design review threads into a concise engineering status brief.',
        'Base openCount, resolvedCount, and openIssues strictly on the provided annotations and comments.',
        'For each openIssue, use the exact annotation `id` from the context JSON.',
      ].join(' ');
      const prompt = `Summarize the current design review state for this file.\n\nDESIGN CONTEXT (JSON):\n${ctx.serialized}`;

      try {
        const result = await generateJson(
          AI_SUMMARY_RESPONSE_SCHEMA,
          aiSummaryResultSchema,
          prompt,
          {
            systemInstruction,
            model: AI_MODELS.flash,
            operation: 'summary',
          }
        );

        const now = new Date().toISOString();
        const insight: AIInsight = {
          id: `aii_${crypto.randomBytes(6).toString('hex')}`,
          fileId: loaded.file.id,
          versionId: loaded.versionId,
          userId: null,
          type: AIInsightType.SUMMARY,
          summary: result.summary,
          payload: result as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        };
        aiInsightsStore.push(insight);

        const data: AiSummaryResponse = {
          ...result,
          cached: false,
          insightId: insight.id,
          createdAt: insight.createdAt,
        };
        res.json({ success: true, data });
      } catch (err) {
        handleAiRouteError(err, res);
      }
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/ai/bom', authenticate, async (req: AuthedRequest, res, next) => {
    try {
      const body = aiFileTargetRequestSchema.parse(req.body);
      if (!enforceAiRateLimit(req.authUser!.id, 'analysis', res)) return;
      if (!isAiConfigured()) {
        sendAiNotConfigured(res);
        return;
      }

      const loaded = resolveAiFileForUser(req, body.fileId, body.versionId);
      if (!loaded.ok) {
        res.status(loaded.errorStatus).json({
          success: false,
          error: { code: loaded.code, message: loaded.message },
        });
        return;
      }

      const ctx = buildAiFileContext(loaded);
      const dxfHints = extractDxfBomHints(loaded.dxf);

      const sourceNote =
        loaded.partTree && loaded.partTree.length > 0
          ? '3D assembly partTree is available. Group identical parts where clearly repeated, assign clean part numbers if none are present (e.g. PART-001), and set sourceConfidence accordingly.'
          : dxfHints
            ? '2D DXF drawing metadata is available (title-block TEXT/MTEXT entities and layer names only). Infer BOM line items from callouts/notes and warn where quantities or materials are uncertain.'
            : 'Neither a 3D part tree nor DXF text entities are present. Return best-effort items from filename/annotations with sourceConfidence="low" and explicit warnings.';

      const systemInstruction = [
        'You extract a structured Bill of Materials (BOM) from CAD assembly metadata or 2D drawing text callouts.',
        sourceNote,
        'Never invent materials or finishes unless explicitly supported by part names, notes, or annotations; omit optional fields when unknown.',
      ].join(' ');
      const prompt = `Extract a structured Bill of Materials (BOM) for this design.\n\nDESIGN CONTEXT (JSON):\n${ctx.serialized}`;

      try {
        const result = await generateJson(
          AI_BOM_RESPONSE_SCHEMA,
          aiBomResultSchema,
          prompt,
          {
            systemInstruction,
            model: AI_MODELS.pro,
            operation: 'bom',
          }
        );

        const now = new Date().toISOString();
        const insight: AIInsight = {
          id: `aii_${crypto.randomBytes(6).toString('hex')}`,
          fileId: loaded.file.id,
          versionId: loaded.versionId,
          userId: req.authUser!.id,
          type: AIInsightType.BOM_EXTRACTION,
          summary: `Extracted ${result.items.length} BOM item(s) (${result.sourceConfidence} confidence)`,
          payload: result as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        };
        aiInsightsStore.push(insight);

        const data: AiBomResponse = {
          ...result,
          insightId: insight.id,
          createdAt: insight.createdAt,
        };
        res.json({ success: true, data });
      } catch (err) {
        handleAiRouteError(err, res);
      }
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/ai/dfm', authenticate, async (req: AuthedRequest, res, next) => {
    try {
      const body = aiFileTargetRequestSchema.parse(req.body);
      if (!enforceAiRateLimit(req.authUser!.id, 'analysis', res)) return;
      if (!isAiConfigured()) {
        sendAiNotConfigured(res);
        return;
      }

      const loaded = resolveAiFileForUser(req, body.fileId, body.versionId);
      if (!loaded.ok) {
        res.status(loaded.errorStatus).json({
          success: false,
          error: { code: loaded.code, message: loaded.message },
        });
        return;
      }

      const ctx = buildAiFileContext(loaded);
      const systemInstruction = [
        'You perform a metadata-and-review-driven Design for Manufacturability (DFM) pre-check.',
        'TRANSPARENCY RULE: You ONLY have access to file metadata, assembly part hierarchy, drawing bounds/layers, recorded measurements, and reviewer annotations/comments — you do NOT have raw 3D B-rep/mesh geometry or 2D pixel imagery.',
        'Do NOT hallucinate wall thicknesses, draft angles, or undercuts unless explicitly stated in measurements, annotations, or comments.',
        'Focus findings on: tolerance callouts, conflicting/unaddressed annotations, fastener/assembly clarity, missing material/finish specs, suspicious dimensional ratios from recorded measurements, and review completeness.',
        'When a finding relates to specific annotations, include their exact annotation IDs in `annotationRefs`.',
      ].join(' ');
      const prompt = `Run a transparent non-geometric DFM review on the available metadata, measurements, and annotations.\n\nDESIGN CONTEXT (JSON):\n${ctx.serialized}`;

      try {
        const result = await generateJson(
          AI_DFM_RESPONSE_SCHEMA,
          aiDfmResultSchema,
          prompt,
          {
            systemInstruction,
            model: AI_MODELS.pro,
            operation: 'dfm',
          }
        );

        const now = new Date().toISOString();
        const insight: AIInsight = {
          id: `aii_${crypto.randomBytes(6).toString('hex')}`,
          fileId: loaded.file.id,
          versionId: loaded.versionId,
          userId: req.authUser!.id,
          type: AIInsightType.DFM_CHECK,
          summary: `DFM pre-check found ${result.findings.length} item(s)`,
          payload: result as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        };
        aiInsightsStore.push(insight);

        const data: AiDfmResponse = {
          ...result,
          insightId: insight.id,
          createdAt: insight.createdAt,
        };
        res.json({ success: true, data });
      } catch (err) {
        handleAiRouteError(err, res);
      }
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/ai/insights', authenticate, (req: AuthedRequest, res, next) => {
    try {
      const query = aiInsightsListQuerySchema.parse(req.query);
      const loaded = resolveAiFileForUser(req, query.fileId);
      if (!loaded.ok) {
        res.status(loaded.errorStatus).json({
          success: false,
          error: { code: loaded.code, message: loaded.message },
        });
        return;
      }

      const items = aiInsightsStore
        .filter((i) => i.fileId === query.fileId)
        .slice(-50)
        .reverse();
      res.json({ success: true, data: items });
    } catch (err) {
      next(err);
    }
  });

  // ---- Error handler ----
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: err.issues
            .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
            .join('; '),
        },
      });
      return;
    }

    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message },
    });
  });

  // ---- Vite dev middleware or static dist ----
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Cadline server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
