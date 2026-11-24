import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  AIInsightType,
  aiBomResultSchema,
  aiChatRequestSchema,
  aiDfmResultSchema,
  aiFileTargetRequestSchema,
  aiInsightsListQuerySchema,
  aiSummaryQuerySchema,
  aiSummaryResultSchema,
  AnnotationType,
  MeasurementType,
  SharePermission,
  type AiBomResponse,
  type AiChatResponse,
  type AiDfmResponse,
  type AIInsight,
  type AiSummaryResponse,
  type Annotation,
  type AnnotationPayload,
  type Comment,
  type DxfBounds,
  type DxfLayerManifestItem,
  type DxfSceneGraph,
  type Measurement,
  type MeasurementPointsPayload,
  type PartNode,
  type PdfPageManifest,
} from '@cadline/shared';
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
} from '../lib/ai.js';
import {
  buildAiFileContext,
  extractDxfBomHints,
  extractReferencedAnnotationIds,
} from '../lib/aiContext.js';
import { checkAiRateLimit, type AiRateLimitBucket } from '../lib/aiRateLimit.js';
import { prisma } from '../lib/prisma.js';
import { downloadObjectBuffer } from '../lib/storage.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

function sendAiNotConfigured(reply: FastifyReply) {
  return reply.status(503).send({
    success: false,
    code: 'AI_NOT_CONFIGURED',
    error: {
      code: 'AI_NOT_CONFIGURED',
      message:
        'AI Design Assistant is not configured on this server. Set GEMINI_API_KEY in the server environment to enable AI features.',
    },
  });
}

function sendAiRateLimited(reply: FastifyReply, retryAfterSeconds: number) {
  reply.header('Retry-After', String(retryAfterSeconds));
  return reply.status(429).send({
    success: false,
    code: 'AI_RATE_LIMIT',
    retryAfterSeconds,
    error: {
      code: 'AI_RATE_LIMIT',
      message: `AI rate limit exceeded. Try again in ${retryAfterSeconds}s.`,
      retryAfterSeconds,
    },
  });
}

function handleAiError(error: unknown, reply: FastifyReply) {
  if (error instanceof AiNotConfiguredError) {
    return sendAiNotConfigured(reply);
  }
  if (error instanceof AiBadResponseError) {
    return reply.status(502).send({
      success: false,
      code: 'AI_BAD_RESPONSE',
      error: {
        code: 'AI_BAD_RESPONSE',
        message: error.message,
      },
    });
  }
  const message =
    error instanceof Error ? error.message : 'AI request failed unexpectedly.';
  return reply.status(502).send({
    success: false,
    code: 'AI_UPSTREAM_ERROR',
    error: {
      code: 'AI_UPSTREAM_ERROR',
      message,
    },
  });
}

async function readJsonArtifact<T>(key: string | null | undefined): Promise<T | null> {
  if (!key) return null;
  try {
    const buf = await downloadObjectBuffer(key);
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    return null;
  }
}

async function loadFileContextFromDb(
  fileId: string,
  organizationId: string,
  requestedVersionId?: string
) {
  // Scoped to the caller's org: AI context must never include another tenant's file.
  const file = await prisma.file.findFirst({
    where: { id: fileId, project: { organizationId } },
    include: {
      versions: {
        orderBy: { versionNumber: 'desc' },
        include: { conversionJob: true },
      },
    },
  });
  if (!file) return null;

  const activeVersion =
    (requestedVersionId
      ? file.versions.find((v) => v.id === requestedVersionId)
      : undefined) ?? file.versions[0];

  const versionId = activeVersion?.id;

  const [annotationRows, commentRows, measurementRows] = await Promise.all([
    prisma.annotation.findMany({
      where: { fileId, ...(versionId ? { versionId } : {}) },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
        comments: { select: { resolved: true } },
      },
    }),
    prisma.comment.findMany({
      where: { fileId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    }),
    prisma.measurement.findMany({
      where: { fileId, ...(versionId ? { versionId } : {}) },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    }),
  ]);

  const annotations: Annotation[] = annotationRows.map((a) => ({
    id: a.id,
    fileId: a.fileId,
    versionId: a.versionId,
    userId: a.userId,
    type: a.type as AnnotationType,
    label: a.label,
    payload: a.payload as unknown as AnnotationPayload,
    commentCount: a.comments.length,
    resolvedCommentCount: a.comments.filter((c) => c.resolved).length,
    author: a.user,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }));

  const comments: Comment[] = commentRows.map((c) => ({
    id: c.id,
    fileId: c.fileId,
    annotationId: c.annotationId,
    userId: c.userId,
    parentId: c.parentId,
    body: c.body,
    resolved: c.resolved,
    author: c.user,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }));

  const measurements: Measurement[] = measurementRows.map((m) => ({
    id: m.id,
    fileId: m.fileId,
    versionId: m.versionId,
    userId: m.userId,
    type: m.type as MeasurementType,
    value: m.value,
    unit: m.unit,
    points: m.points as unknown as MeasurementPointsPayload,
    author: m.user,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }));

  // Conversion artifacts live on the version's ConversionJob (see workers/conversionWorker.ts):
  // partTree / layerManifest / bounds / pageManifest in the DB, the DXF scene JSON in S3 at sceneKey.
  const job = activeVersion?.conversionJob ?? null;
  const ext = file.extension.toLowerCase();

  let partTree: PartNode[] | null = null;
  let dxf: {
    scene: DxfSceneGraph;
    layers: DxfLayerManifestItem[];
    bounds: DxfBounds;
  } | null = null;
  let pdf: PdfPageManifest | null = null;

  if (ext === 'dxf') {
    const scene = await readJsonArtifact<DxfSceneGraph>(job?.sceneKey);
    const layers = (job?.layerManifest ?? null) as unknown as DxfLayerManifestItem[] | null;
    const bounds = (job?.bounds ?? null) as unknown as DxfBounds | null;
    if (scene && layers && bounds) {
      dxf = { scene, layers, bounds };
    }
  } else if (ext === 'pdf') {
    pdf = (job?.pageManifest ?? null) as unknown as PdfPageManifest | null;
  } else {
    partTree = Array.isArray(job?.partTree) ? (job!.partTree as unknown as PartNode[]) : null;
  }

  return {
    file: {
      id: file.id,
      name: file.name,
      originalName: file.originalName,
      extension: file.extension,
      sizeBytes: Number(file.sizeBytes),
      status: file.status,
      currentVersion: file.currentVersion,
    },
    versionId: versionId ?? activeVersion?.id ?? '',
    partTree,
    dxf,
    pdf,
    annotations,
    comments,
    measurements,
  };
}

function serializeInsight(row: {
  id: string;
  fileId: string;
  versionId: string;
  userId: string | null;
  type: string;
  summary: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): AIInsight {
  return {
    id: row.id,
    fileId: row.fileId,
    versionId: row.versionId,
    userId: row.userId,
    type: row.type as AIInsightType,
    summary: row.summary,
    payload:
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function aiRoutes(fastify: FastifyInstance): Promise<void> {
  const enforceRateLimit = (
    userId: string,
    bucket: AiRateLimitBucket,
    reply: FastifyReply
  ): boolean => {
    const check = checkAiRateLimit(userId, bucket);
    if (!check.allowed) {
      sendAiRateLimited(reply, check.retryAfterSeconds);
      return false;
    }
    return true;
  };

  // POST /api/v1/ai/chat
  fastify.post(
    '/chat',
    {
      preHandler: [authenticate, requirePermission(SharePermission.VIEW)],
    },
    async (request, reply) => {
      const body = aiChatRequestSchema.parse(request.body);
      if (!enforceRateLimit(request.authUser!.id, 'chat', reply)) return;
      if (!isAiConfigured()) return sendAiNotConfigured(reply);

      const loaded = await loadFileContextFromDb(body.fileId, request.authUser!.organizationId, body.versionId);
      if (!loaded) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'Design file not found' },
        });
      }

      const ctx = buildAiFileContext(loaded);

      const systemInstruction = [
        'You are the Dr.Yo CAD Design Assistant helping mechanical and CAD engineers review a design file.',
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

        return reply.send({ success: true, data });
      } catch (error) {
        return handleAiError(error, reply);
      }
    }
  );

  // POST /api/v1/ai/summary?force=true
  fastify.post(
    '/summary',
    {
      preHandler: [authenticate, requirePermission(SharePermission.VIEW)],
    },
    async (request, reply) => {
      const body = aiFileTargetRequestSchema.parse(request.body);
      const query = aiSummaryQuerySchema.parse(request.query);
      if (!enforceRateLimit(request.authUser!.id, 'analysis', reply)) return;
      if (!isAiConfigured()) return sendAiNotConfigured(reply);

      const loaded = await loadFileContextFromDb(body.fileId, request.authUser!.organizationId, body.versionId);
      if (!loaded) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'Design file not found' },
        });
      }

      const force = Boolean(query.force);

      if (!force) {
        const [cached, latestActivity] = await Promise.all([
          prisma.aIInsight.findFirst({
            where: {
              fileId: loaded.file.id,
              versionId: loaded.versionId,
              type: 'SUMMARY',
            },
            orderBy: { createdAt: 'desc' },
          }),
          prisma.activityLog.findFirst({
            where: { fileId: loaded.file.id },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          }),
        ]);

        if (
          cached &&
          (!latestActivity || latestActivity.createdAt.getTime() <= cached.createdAt.getTime())
        ) {
          const parsedCached = aiSummaryResultSchema.safeParse(cached.payload);
          if (parsedCached.success) {
            const data: AiSummaryResponse = {
              ...parsedCached.data,
              cached: true,
              insightId: cached.id,
              createdAt: cached.createdAt.toISOString(),
            };
            return reply.send({ success: true, data });
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

        const saved = await prisma.aIInsight.create({
          data: {
            fileId: loaded.file.id,
            versionId: loaded.versionId,
            userId: null,
            type: 'SUMMARY',
            summary: result.summary,
            payload: result as unknown as Prisma.InputJsonValue,
          },
        });

        const data: AiSummaryResponse = {
          ...result,
          cached: false,
          insightId: saved.id,
          createdAt: saved.createdAt.toISOString(),
        };

        return reply.send({ success: true, data });
      } catch (error) {
        return handleAiError(error, reply);
      }
    }
  );

  // POST /api/v1/ai/bom
  fastify.post(
    '/bom',
    {
      preHandler: [authenticate, requirePermission(SharePermission.VIEW)],
    },
    async (request, reply) => {
      const body = aiFileTargetRequestSchema.parse(request.body);
      if (!enforceRateLimit(request.authUser!.id, 'analysis', reply)) return;
      if (!isAiConfigured()) return sendAiNotConfigured(reply);

      const loaded = await loadFileContextFromDb(body.fileId, request.authUser!.organizationId, body.versionId);
      if (!loaded) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'Design file not found' },
        });
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

        const saved = await prisma.aIInsight.create({
          data: {
            fileId: loaded.file.id,
            versionId: loaded.versionId,
            userId: request.authUser!.id,
            type: 'BOM_EXTRACTION',
            summary: `Extracted ${result.items.length} BOM item(s) (${result.sourceConfidence} confidence)`,
            payload: result as unknown as Prisma.InputJsonValue,
          },
        });

        const data: AiBomResponse = {
          ...result,
          insightId: saved.id,
          createdAt: saved.createdAt.toISOString(),
        };

        return reply.send({ success: true, data });
      } catch (error) {
        return handleAiError(error, reply);
      }
    }
  );

  // POST /api/v1/ai/dfm
  fastify.post(
    '/dfm',
    {
      preHandler: [authenticate, requirePermission(SharePermission.VIEW)],
    },
    async (request, reply) => {
      const body = aiFileTargetRequestSchema.parse(request.body);
      if (!enforceRateLimit(request.authUser!.id, 'analysis', reply)) return;
      if (!isAiConfigured()) return sendAiNotConfigured(reply);

      const loaded = await loadFileContextFromDb(body.fileId, request.authUser!.organizationId, body.versionId);
      if (!loaded) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'Design file not found' },
        });
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

        const saved = await prisma.aIInsight.create({
          data: {
            fileId: loaded.file.id,
            versionId: loaded.versionId,
            userId: request.authUser!.id,
            type: 'DFM_CHECK',
            summary: `DFM pre-check found ${result.findings.length} item(s)`,
            payload: result as unknown as Prisma.InputJsonValue,
          },
        });

        const data: AiDfmResponse = {
          ...result,
          insightId: saved.id,
          createdAt: saved.createdAt.toISOString(),
        };

        return reply.send({ success: true, data });
      } catch (error) {
        return handleAiError(error, reply);
      }
    }
  );

  // GET /api/v1/ai/insights?fileId=
  fastify.get(
    '/insights',
    {
      preHandler: [authenticate, requirePermission(SharePermission.VIEW)],
    },
    async (request, reply) => {
      const query = aiInsightsListQuerySchema.parse(request.query);
      const rows = await prisma.aIInsight.findMany({
        where: {
          fileId: query.fileId,
          file: { project: { organizationId: request.authUser!.organizationId } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      return reply.send({
        success: true,
        data: rows.map(serializeInsight),
      });
    }
  );
}
