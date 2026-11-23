import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  completeFileUploadRequestSchema,
  computeAvatarColor,
  file2DPageParamsSchema,
  fileListQuerySchema,
  fileParamsSchema,
  FileStatus,
  fileVersionQuerySchema,
  initFileUploadRequestSchema,
  saveFileFeaturesRequestSchema,
  SharePermission,
  signedAssetQuerySchema,
  uploadChunkQuerySchema,
  type ConversionJobStatus,
  type ConversionMode,
  type DxfBounds,
  type DxfLayerManifestItem,
  type DxfSceneGraph,
  type FileFeaturesCacheData,
  type PartNode,
  type PdfPageManifest,
} from '@cadline/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import {
  completeMultipartUpload,
  deleteStorageObject,
  downloadObjectBuffer,
  getObjectStream,
  getPresignedPartUrl,
  initMultipartUpload,
  uploadMultipartChunk,
} from '../lib/storage.js';
import { is2DExtension } from '../lib/converter.js';
import {
  authenticate,
  requirePermission,
  signAssetParams,
  verifyAssetParams,
} from '../middleware/auth.js';

interface RawFileVersion {
  id: string;
  fileId: string;
  versionNumber: number;
  storageKey: string;
  sizeBytes: number;
  checksum: string | null;
  status: string;
  uploadedById: string;
  createdAt: Date;
  updatedAt: Date;
}

interface RawFile {
  id: string;
  projectId: string;
  folderId: string | null;
  uploadedById: string;
  name: string;
  originalName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  status: string;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
  versions?: RawFileVersion[];
}

/** Server-side-only projection retaining internalStorageKey without exposing it to clients. */
export function toInternalVersionRecord(v: RawFileVersion) {
  return {
    id: v.id,
    fileId: v.fileId,
    versionNumber: v.versionNumber,
    internalStorageKey: v.storageKey,
    sizeBytes: v.sizeBytes,
    checksum: v.checksum,
    status: v.status as FileStatus,
    uploadedById: v.uploadedById,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

function serializeVersion(v: RawFileVersion) {
  const { internalStorageKey: _omitted, ...publicVersion } =
    toInternalVersionRecord(v);
  return publicVersion;
}

function serializeFile(file: RawFile) {
  return {
    id: file.id,
    projectId: file.projectId,
    folderId: file.folderId,
    uploadedById: file.uploadedById,
    name: file.name,
    originalName: file.originalName,
    mimeType: file.mimeType,
    extension: file.extension,
    sizeBytes: file.sizeBytes,
    status: file.status as FileStatus,
    currentVersion: file.currentVersion,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    versions: file.versions?.map(serializeVersion),
  };
}

async function resolveFileVersionWithJob(
  fileId: string,
  organizationId: string | undefined,
  query: { v?: number; versionId?: string }
) {
  const file = await prisma.file.findFirst({
    where: {
      id: fileId,
      ...(organizationId ? { project: { organizationId } } : {}),
    },
    include: {
      versions: {
        where: query.versionId
          ? { id: query.versionId }
          : query.v
            ? { versionNumber: query.v }
            : undefined,
        orderBy: { versionNumber: 'desc' },
        take: 1,
        include: {
          conversionJob: true,
        },
      },
    },
  });

  if (!file) return null;
  const version = file.versions[0] ?? null;
  return { file, version };
}

const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
} as const;

const ASSET_URL_TTL_SECONDS = 900;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by signedAssetGuard when the request carried a valid asset signature. */
    signedAssetVersionId?: string;
  }
}

/**
 * preHandler for binary asset routes: a request carrying `exp` + `sig` must be a
 * valid signed link (see signAssetParams); anything else goes through the
 * normal JWT / share-token permission check.
 */
function signedAssetGuard(kind: 'glb' | 'page') {
  const viaPermission = requirePermission(SharePermission.VIEW);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const query = signedAssetQuerySchema.parse(request.query ?? {});
    if (query.sig === undefined && query.exp === undefined) {
      return viaPermission(request, reply);
    }
    const params = request.params as { id: string; n?: string };
    const extra = kind === 'page' ? String(params.n ?? '') : '';
    if (
      !query.sig ||
      query.exp === undefined ||
      !query.versionId ||
      !verifyAssetParams(kind, params.id, query.versionId, extra, query.exp, query.sig)
    ) {
      return reply.status(403).send({
        success: false,
        error: { code: 'ASSET_LINK_INVALID', message: 'Asset link is invalid or expired' },
      });
    }
    request.signedAssetVersionId = query.versionId;
  };
}

/** Resolves the version for an asset request (signed link pins the exact version). */
async function resolveAssetVersion(request: FastifyRequest, fileId: string) {
  if (request.signedAssetVersionId) {
    const version = await prisma.fileVersion.findFirst({
      where: { id: request.signedAssetVersionId, fileId },
      include: { conversionJob: true },
    });
    return version ? { fileId, version } : null;
  }
  const query = signedAssetQuerySchema.parse(request.query ?? {});
  const resolved = await resolveFileVersionWithJob(fileId, request.authUser?.organizationId, {
    v: query.v,
    versionId: query.versionId,
  });
  return resolved?.version ? { fileId, version: resolved.version } : null;
}

function signedAssetPath(
  kind: 'glb' | 'page',
  fileId: string,
  versionId: string,
  page?: number
): string {
  const { exp, sig } = signAssetParams(
    kind,
    fileId,
    versionId,
    kind === 'page' ? String(page) : '',
    ASSET_URL_TTL_SECONDS
  );
  const base =
    kind === 'glb'
      ? `/api/v1/files/${fileId}/glb-binary`
      : `/api/v1/files/${fileId}/2d/page-image/${page}`;
  return `${base}?versionId=${encodeURIComponent(versionId)}&exp=${exp}&sig=${sig}`;
}

export async function fileRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/init',
    { preHandler: [authenticate, requirePermission(SharePermission.EDIT)] },
    async (request, reply) => {
      const body = initFileUploadRequestSchema.parse(request.body);
      const authUser = request.authUser!;

      const project = await prisma.project.findFirst({
        where: {
          id: body.projectId,
          organizationId: authUser.organizationId,
        },
      });

      if (!project) {
        return reply.status(404).send({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        });
      }

      const extension =
        path.extname(body.fileName).replace('.', '').toLowerCase() || 'bin';
      const totalChunks = Math.max(1, Math.ceil(body.sizeBytes / body.chunkSize));

      const fileRecord = await prisma.file.create({
        data: {
          projectId: project.id,
          folderId: body.folderId ?? null,
          uploadedById: authUser.id,
          name: body.fileName,
          originalName: body.fileName,
          mimeType: body.mimeType,
          extension,
          sizeBytes: body.sizeBytes,
          status: 'UPLOADING',
          currentVersion: 1,
        },
      });

      const safeFileName = body.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const internalStorageKey = `orgs/${authUser.organizationId}/projects/${project.id}/${fileRecord.id}/v1/${safeFileName}`;
      const uploadId = await initMultipartUpload(internalStorageKey, body.mimeType);

      const version = await prisma.fileVersion.create({
        data: {
          fileId: fileRecord.id,
          versionNumber: 1,
          storageKey: internalStorageKey,
          s3UploadId: uploadId,
          sizeBytes: body.sizeBytes,
          status: 'UPLOADING',
          uploadedById: authUser.id,
        },
      });

      const presignedUrls = await Promise.all(
        Array.from({ length: totalChunks }, async (_, index) => {
          const partNumber = index + 1;
          const url = await getPresignedPartUrl(
            internalStorageKey,
            uploadId,
            partNumber
          );
          return { partNumber, url };
        })
      );

      await prisma.activityLog.create({
        data: {
          organizationId: authUser.organizationId,
          projectId: project.id,
          fileId: fileRecord.id,
          userId: authUser.id,
          action: 'FILE_UPLOAD_INITIATED',
          metadata: {
            fileName: fileRecord.name,
            sizeBytes: fileRecord.sizeBytes,
            totalChunks,
          },
        },
      });

      return reply.status(201).send({
        success: true,
        data: {
          file: serializeFile({ ...fileRecord, versions: [version] }),
          version: serializeVersion(version),
          uploadId,
          chunkSize: body.chunkSize,
          totalChunks,
          presignedUrls,
        },
      });
    }
  );

  fastify.put(
    '/:id/chunk',
    { preHandler: [authenticate, requirePermission(SharePermission.EDIT)] },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const query = uploadChunkQuerySchema.parse(request.query);
      const authUser = request.authUser!;

      const file = await prisma.file.findFirst({
        where: {
          id: params.id,
          project: { organizationId: authUser.organizationId },
        },
        include: {
          versions: {
            where: { s3UploadId: query.uploadId },
            take: 1,
          },
        },
      });

      const version = file?.versions[0];
      if (!file || !version) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'UPLOAD_NOT_FOUND',
            message: 'Upload session not found for this file',
          },
        });
      }

      let chunkBuffer: Buffer;
      if (request.isMultipart()) {
        const part = await request.file();
        if (!part) {
          return reply.status(400).send({
            success: false,
            error: {
              code: 'MISSING_CHUNK',
              message: 'Multipart file chunk is required',
            },
          });
        }
        chunkBuffer = await part.toBuffer();
      } else if (Buffer.isBuffer(request.body)) {
        chunkBuffer = request.body;
      } else {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_CHUNK_PAYLOAD',
            message:
              'Chunk must be sent as multipart/form-data or application/octet-stream',
          },
        });
      }

      const internalVersion = toInternalVersionRecord(version);
      const etag = await uploadMultipartChunk(
        internalVersion.internalStorageKey,
        query.uploadId,
        query.partNumber,
        chunkBuffer
      );

      return reply.send({
        success: true,
        data: {
          fileId: file.id,
          uploadId: query.uploadId,
          partNumber: query.partNumber,
          etag,
          receivedBytes: chunkBuffer.byteLength,
        },
      });
    }
  );

  fastify.post(
    '/:id/complete',
    { preHandler: [authenticate, requirePermission(SharePermission.EDIT)] },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const body = completeFileUploadRequestSchema.parse(request.body);
      const authUser = request.authUser!;

      const file = await prisma.file.findFirst({
        where: {
          id: params.id,
          project: { organizationId: authUser.organizationId },
        },
        include: {
          versions: {
            where: { s3UploadId: body.uploadId },
            take: 1,
          },
        },
      });

      const version = file?.versions[0];
      if (!file || !version) {
        return reply.status(404).send({
          success: false,
          error: { code: 'UPLOAD_NOT_FOUND', message: 'Upload session not found' },
        });
      }

      const internalVersion = toInternalVersionRecord(version);
      await completeMultipartUpload(
        internalVersion.internalStorageKey,
        body.uploadId,
        body.parts
      );

      const [, updatedFile] = await prisma.$transaction([
        prisma.fileVersion.update({
          where: { id: version.id },
          data: {
            status: 'PROCESSING',
            checksum: body.checksum ?? null,
          },
        }),
        prisma.file.update({
          where: { id: file.id },
          data: {
            status: 'PROCESSING',
            currentVersion: version.versionNumber,
          },
          include: {
            versions: {
              orderBy: { versionNumber: 'desc' },
            },
          },
        }),
        prisma.conversionJob.upsert({
          where: { fileVersionId: version.id },
          update: {
            status: 'QUEUED',
            error: null,
          },
          create: {
            fileVersionId: version.id,
            status: 'QUEUED',
          },
        }),
      ]);

      await prisma.activityLog.create({
        data: {
          organizationId: authUser.organizationId,
          projectId: file.projectId,
          fileId: file.id,
          userId: authUser.id,
          action: 'FILE_UPLOAD_COMPLETED',
          metadata: {
            versionNumber: version.versionNumber,
            partsCount: body.parts.length,
          },
        },
      });

      return reply.send({
        success: true,
        data: serializeFile(updatedFile),
      });
    }
  );

  fastify.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const query = fileListQuerySchema.parse(request.query);
    const authUser = request.authUser!;

    const project = await prisma.project.findFirst({
      where: {
        id: query.projectId,
        organizationId: authUser.organizationId,
      },
    });

    if (!project) {
      return reply.status(404).send({
        success: false,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
      });
    }

    const files = await prisma.file.findMany({
      where: {
        projectId: project.id,
        ...(query.folderId ? { folderId: query.folderId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
        },
      },
    });

    return reply.send({
      success: true,
      data: {
        items: files.map(serializeFile),
      },
    });
  });

  fastify.get(
    '/:id/status',
    { preHandler: [requirePermission(SharePermission.VIEW)] },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const query = fileVersionQuerySchema.parse(request.query ?? {});
      const resolved = await resolveFileVersionWithJob(
        params.id,
        request.authUser?.organizationId,
        query
      );

      if (!resolved || !resolved.version) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File or version not found' },
        });
      }

      const job = resolved.version.conversionJob;
      return reply.send({
        success: true,
        data: {
          status: resolved.version.status as FileStatus,
          jobStatus: (job?.status ?? null) as ConversionJobStatus | null,
          mode: (job?.mode ?? (is2DExtension(resolved.file.extension) ? (resolved.file.extension === 'pdf' ? '2D_PDF' : '2D_DXF') : '3D')) as ConversionMode,
          ...(job?.error ? { error: job.error } : {}),
        },
      });
    }
  );

  fastify.get(
    '/:id/glb',
    { preHandler: [requirePermission(SharePermission.VIEW)] },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const query = fileVersionQuerySchema.parse(request.query ?? {});
      const resolved = await resolveFileVersionWithJob(
        params.id,
        request.authUser?.organizationId,
        query
      );

      if (!resolved || !resolved.version) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File or version not found' },
        });
      }

      const { version } = resolved;
      const job = version.conversionJob;

      if (version.status === 'PROCESSING' || version.status === 'UPLOADING') {
        return reply.status(202).send({
          success: true,
          data: { status: 'processing' },
        });
      }

      if (version.status === 'FAILED' || !job?.glbStorageKey) {
        return reply.status(422).send({
          success: false,
          error: {
            code: 'CONVERSION_FAILED',
            message: job?.error ?? '3D model conversion failed',
          },
        });
      }

      // Same-origin signed path instead of a presigned S3 URL: works for clients that
      // also send Authorization (S3 rejects double auth), needs no bucket CORS, and
      // lets GLTFLoader fetch without headers.
      return reply.send({
        success: true,
        data: {
          url: signedAssetPath('glb', resolved.file.id, version.id),
          expiresInSeconds: ASSET_URL_TTL_SECONDS,
        },
      });
    }
  );

  fastify.get(
    '/:id/glb-binary',
    { preHandler: [signedAssetGuard('glb')] },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const resolved = await resolveAssetVersion(request, params.id);
      const glbKey = resolved?.version.conversionJob?.glbStorageKey;
      if (!resolved || resolved.version.status !== 'READY' || !glbKey) {
        return reply.status(404).send({
          success: false,
          error: { code: 'GLB_NOT_READY', message: 'Converted GLB asset not found' },
        });
      }

      const object = await getObjectStream(glbKey);
      reply.header('Content-Type', 'model/gltf-binary');
      reply.header('Cache-Control', 'private, max-age=300');
      if (object.contentLength !== undefined) {
        reply.header('Content-Length', String(object.contentLength));
      }
      return reply.send(object.body);
    }
  );

  fastify.get(
    '/:id/tree',
    { preHandler: [requirePermission(SharePermission.VIEW)] },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const query = fileVersionQuerySchema.parse(request.query ?? {});
      const resolved = await resolveFileVersionWithJob(
        params.id,
        request.authUser?.organizationId,
        query
      );

      if (!resolved || !resolved.version) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File or version not found' },
        });
      }

      const rawTree = resolved.version.conversionJob?.partTree;
      const partTree: PartNode[] = Array.isArray(rawTree)
        ? (rawTree as unknown as PartNode[])
        : [];

      return reply.send({
        success: true,
        data: { partTree },
      });
    }
  );

  // ---- Session 7: Client-computed geometry feature cache (L2) ----
  fastify.get(
    '/:id/features',
    { preHandler: [requirePermission(SharePermission.VIEW)] },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const query = fileVersionQuerySchema.parse(request.query ?? {});
      const resolved = await resolveFileVersionWithJob(
        params.id,
        request.authUser?.organizationId,
        query
      );

      if (!resolved || !resolved.version) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File or version not found' },
        });
      }

      const cached =
        (resolved.version.conversionJob?.featuresJson as unknown as FileFeaturesCacheData | null) ??
        null;

      return reply.send({
        success: true,
        data: {
          fileId: resolved.file.id,
          versionId: resolved.version.id,
          cached: cached !== null,
          data: cached,
        },
      });
    }
  );

  fastify.post(
    '/:id/features',
    { preHandler: [requirePermission(SharePermission.VIEW)] },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const query = fileVersionQuerySchema.parse(request.query ?? {});
      const body = saveFileFeaturesRequestSchema.parse(request.body);

      const resolved = await resolveFileVersionWithJob(
        params.id,
        request.authUser?.organizationId,
        query
      );

      if (!resolved || !resolved.version) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File or version not found' },
        });
      }

      const payload: FileFeaturesCacheData = {
        version: body.version,
        extractedAt: body.extractedAt ?? new Date().toISOString(),
        features: body.features,
        partSummaries: body.partSummaries,
      };

      await prisma.conversionJob.upsert({
        where: { fileVersionId: resolved.version.id },
        update: {
          featuresJson: payload as unknown as Prisma.InputJsonValue,
        },
        create: {
          fileVersionId: resolved.version.id,
          status: 'DONE',
          mode: '3D',
          featuresJson: payload as unknown as Prisma.InputJsonValue,
        },
      });

      return reply.status(200).send({
        success: true,
        data: {
          fileId: resolved.file.id,
          versionId: resolved.version.id,
          cached: true,
          data: payload,
        },
      });
    }
  );

  fastify.get(
    '/:id/2d/scene',
    {
      preHandler: [requirePermission(SharePermission.VIEW)],
      schema: {
        tags: ['Files', '2D Viewer'],
        summary: 'Fetch converted 2D DXF scene graph or PDF page manifest',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          properties: {
            v: { type: 'integer', minimum: 1 },
            versionId: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', additionalProperties: true },
            },
          },
          202: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: { status: { type: 'string' } },
              },
            },
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
          404: ERROR_RESPONSE_SCHEMA,
          422: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const query = fileVersionQuerySchema.parse(request.query ?? {});
      const resolved = await resolveFileVersionWithJob(
        params.id,
        request.authUser?.organizationId,
        query
      );

      if (!resolved || !resolved.version) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File or version not found' },
        });
      }

      const { file, version } = resolved;
      const job = version.conversionJob;
      const effectiveMode =
        job?.mode ?? (is2DExtension(file.extension) ? (file.extension.toLowerCase() === 'pdf' ? '2D_PDF' : '2D_DXF') : '3D');

      if (effectiveMode === '3D' || !is2DExtension(file.extension)) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'NOT_2D',
            message: 'This file is a 3D model, not a 2D drawing',
          },
        });
      }

      if (
        version.status === 'PROCESSING' ||
        version.status === 'UPLOADING' ||
        job?.status === 'QUEUED' ||
        job?.status === 'RUNNING'
      ) {
        return reply.status(202).send({
          success: true,
          data: { status: 'processing' },
        });
      }

      if (version.status === 'FAILED' || job?.status === 'FAILED') {
        return reply.status(422).send({
          success: false,
          error: {
            code: 'CONVERSION_FAILED',
            message: job?.error ?? '2D drawing conversion failed',
          },
        });
      }

      if (effectiveMode === '2D_DXF') {
        if (!job?.sceneKey) {
          return reply.status(202).send({
            success: true,
            data: { status: 'processing' },
          });
        }
        const rawScene = await downloadObjectBuffer(job.sceneKey);
        const scene = JSON.parse(rawScene.toString('utf8')) as DxfSceneGraph;
        const layers = (job.layerManifest ?? []) as unknown as DxfLayerManifestItem[];
        const bounds = (job.bounds ?? {
          minX: 0,
          minY: 0,
          maxX: 297,
          maxY: 210,
          units: 'mm',
        }) as unknown as DxfBounds;

        return reply.send({
          success: true,
          data: {
            mode: '2D_DXF',
            scene,
            layers,
            bounds,
          },
        });
      }

      if (effectiveMode === '2D_PDF') {
        const pageManifest = job?.pageManifest as unknown as PdfPageManifest | null;
        if (!pageManifest) {
          return reply.status(202).send({
            success: true,
            data: { status: 'processing' },
          });
        }

        return reply.send({
          success: true,
          data: {
            mode: '2D_PDF',
            pageManifest,
          },
        });
      }

      return reply.status(400).send({
        success: false,
        error: { code: 'NOT_2D', message: 'Unsupported 2D mode' },
      });
    }
  );

  fastify.get(
    '/:id/2d/page/:n',
    {
      preHandler: [requirePermission(SharePermission.VIEW)],
      schema: {
        tags: ['Files', '2D Viewer'],
        summary: 'Get 15-minute presigned PNG URL for a rasterized PDF page',
        params: {
          type: 'object',
          required: ['id', 'n'],
          properties: {
            id: { type: 'string' },
            n: { type: 'integer', minimum: 1 },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            v: { type: 'integer', minimum: 1 },
            versionId: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  page: { type: 'integer' },
                },
              },
            },
          },
          400: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const params = file2DPageParamsSchema.parse(request.params);
      const query = fileVersionQuerySchema.parse(request.query ?? {});
      const resolved = await resolveFileVersionWithJob(
        params.id,
        request.authUser?.organizationId,
        query
      );

      if (!resolved || !resolved.version) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File or version not found' },
        });
      }

      const job = resolved.version.conversionJob;
      if (!job || job.mode !== '2D_PDF') {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'NOT_PDF',
            message: 'Page raster images are only available for PDF files',
          },
        });
      }

      const manifest = job.pageManifest as unknown as PdfPageManifest | null;
      if (!manifest || params.n < 1 || params.n > manifest.pageCount) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'PAGE_NOT_FOUND',
            message: `PDF page ${params.n} is out of range`,
          },
        });
      }

      const pageKey = manifest.pageKeys[params.n - 1];
      if (!pageKey) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'PAGE_NOT_FOUND',
            message: `PDF page ${params.n} asset missing`,
          },
        });
      }

      // Same-origin signed path (see /:id/glb): <img src> cannot send auth headers
      // and must not depend on bucket CORS.
      return reply.send({
        success: true,
        data: {
          url: signedAssetPath('page', resolved.file.id, resolved.version.id, params.n),
          page: params.n,
        },
      });
    }
  );

  fastify.get(
    '/:id/2d/page-image/:n',
    { preHandler: [signedAssetGuard('page')] },
    async (request, reply) => {
      const params = file2DPageParamsSchema.parse(request.params);
      const resolved = await resolveAssetVersion(request, params.id);
      const job = resolved?.version.conversionJob;
      const manifest = (job?.mode === '2D_PDF' ? job.pageManifest : null) as unknown as
        | PdfPageManifest
        | null;
      const pageKey = manifest?.pageKeys?.[params.n - 1];
      if (!resolved || !pageKey) {
        return reply.status(404).send({
          success: false,
          error: { code: 'PAGE_NOT_FOUND', message: 'PDF page image not found' },
        });
      }

      const object = await getObjectStream(pageKey);
      reply.header('Content-Type', 'image/png');
      reply.header('Cache-Control', 'private, max-age=300');
      if (object.contentLength !== undefined) {
        reply.header('Content-Length', String(object.contentLength));
      }
      return reply.send(object.body);
    }
  );

  fastify.post(
    '/:id/reconvert',
    { preHandler: [authenticate, requirePermission(SharePermission.EDIT)] },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const query = fileVersionQuerySchema.parse(request.query ?? {});
      const resolved = await resolveFileVersionWithJob(
        params.id,
        request.authUser?.organizationId,
        query
      );

      if (!resolved || !resolved.version) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File or version not found' },
        });
      }

      const { file, version } = resolved;

      await prisma.$transaction([
        prisma.fileVersion.update({
          where: { id: version.id },
          data: { status: 'PROCESSING' },
        }),
        prisma.file.update({
          where: { id: file.id },
          data: { status: 'PROCESSING' },
        }),
        prisma.conversionJob.upsert({
          where: { fileVersionId: version.id },
          update: {
            status: 'QUEUED',
            error: null,
          },
          create: {
            fileVersionId: version.id,
            status: 'QUEUED',
          },
        }),
      ]);

      return reply.status(202).send({
        success: true,
        data: {
          status: FileStatus.PROCESSING,
          jobStatus: 'QUEUED',
        },
      });
    }
  );

  fastify.get(
    '/:id',
    { preHandler: [requirePermission(SharePermission.VIEW)] },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const authUser = request.authUser;

      const file = await prisma.file.findFirst({
        where: {
          id: params.id,
          ...(authUser
            ? { project: { organizationId: authUser.organizationId } }
            : {}),
        },
        include: {
          versions: {
            orderBy: { versionNumber: 'desc' },
          },
        },
      });

      if (!file) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
      }

      return reply.send({
        success: true,
        data: serializeFile(file),
      });
    }
  );

  fastify.delete(
    '/:id',
    { preHandler: [authenticate, requirePermission(SharePermission.EDIT)] },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const authUser = request.authUser!;

      const file = await prisma.file.findFirst({
        where: {
          id: params.id,
          project: { organizationId: authUser.organizationId },
        },
        include: {
          versions: {
            include: { conversionJob: true },
          },
        },
      });

      if (!file) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
      }

      const keysToDelete: string[] = [];
      for (const version of file.versions) {
        keysToDelete.push(toInternalVersionRecord(version).internalStorageKey);
        if (version.conversionJob?.glbStorageKey) {
          keysToDelete.push(version.conversionJob.glbStorageKey);
        }
        if (version.conversionJob?.sceneKey) {
          keysToDelete.push(version.conversionJob.sceneKey);
        }
        const manifest = version.conversionJob?.pageManifest as unknown as PdfPageManifest | null;
        if (manifest?.pageKeys) {
          keysToDelete.push(...manifest.pageKeys);
        }
      }

      await Promise.allSettled(
        keysToDelete.map((key) => deleteStorageObject(key))
      );

      await prisma.file.delete({ where: { id: file.id } });

      await prisma.activityLog.create({
        data: {
          organizationId: authUser.organizationId,
          projectId: file.projectId,
          userId: authUser.id,
          action: 'FILE_DELETED',
          metadata: { fileName: file.name },
        },
      });

      return reply.send({
        success: true,
        data: { id: file.id, deleted: true },
      });
    }
  );

  // HTTP presence heartbeat fallback for networks/proxies blocking WebSockets (30s Redis TTL)
  fastify.post(
    '/:id/presence/ping',
    {
      preHandler: [requirePermission(SharePermission.VIEW)],
      schema: {
        tags: ['Files', 'Realtime'],
        summary: 'HTTP presence heartbeat fallback when WebSockets are unavailable',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const authUser = request.authUser;
      const userId = authUser?.id ?? `guest_${request.ip}`;
      const presenceRecord = {
        userId,
        name: authUser?.name ?? 'Guest Reviewer',
        email: authUser?.email ?? 'guest@share.local',
        avatarColor: computeAvatarColor(userId),
        joinedAt: new Date().toISOString(),
      };

      const redisKey = `cadline:presence:http:${params.id}:${userId}`;
      try {
        await redis.set(redisKey, JSON.stringify(presenceRecord), 'EX', 30);
      } catch {
        // Non-fatal fallback if Redis is momentarily unavailable
      }

      return reply.send({
        success: true,
        data: {
          fileId: params.id,
          ttlSeconds: 30,
          serverTs: Date.now(),
        },
      });
    }
  );
}
