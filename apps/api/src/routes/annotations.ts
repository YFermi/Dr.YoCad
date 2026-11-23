/**
 * Annotations REST routes.
 *
 * Real-time sync boundary (Session 5 B3):
 * REST endpoints are the sole persistence layer. After Prisma create/update/delete
 * succeeds, each handler broadcasts the resulting delta to `file:<fileId>` via
 * `fastify.io`, excluding the originating socket specified by the `x-socket-id` header.
 */
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  ActivityAction,
  annotationsListQuerySchema,
  AnnotationType,
  computeAvatarColor,
  createAnnotationRequestSchema,
  REALTIME_EVENTS,
  SharePermission,
  updateAnnotationRequestSchema,
  UserRole,
  type Annotation,
  type AnnotationPayload,
  type EntityDeletePayload,
} from '@cadline/shared';
import { prisma } from '../lib/prisma.js';
import { broadcastFileDelta } from '../lib/realtimeHub.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

function readOriginSocketId(headers: Record<string, unknown>): string | undefined {
  const val = headers['x-socket-id'];
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

const vec3JsonSchema = {
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
} as const;

const anchorPayloadJsonSchema = {
  type: 'object',
  required: ['anchor'],
  additionalProperties: true,
  properties: {
    anchor: {
      type: 'object',
      required: ['position', 'cameraPose'],
      properties: {
        position: vec3JsonSchema,
        normal: vec3JsonSchema,
        partId: { type: 'string' },
        cameraPose: {
          type: 'object',
          required: ['position', 'target', 'zoom'],
          properties: {
            position: vec3JsonSchema,
            target: vec3JsonSchema,
            zoom: { type: 'number' },
          },
        },
      },
    },
  },
} as const;

function isAdminRole(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.OWNER;
}

interface AnnotationRecordWithRelations {
  id: string;
  fileId: string;
  versionId: string;
  userId: string;
  type: string;
  label: string | null;
  payload: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
  user?: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
  };
  comments?: Array<{ resolved: boolean }>;
}

function serializeAnnotation(record: AnnotationRecordWithRelations): Annotation {
  const comments = record.comments ?? [];
  const resolvedCommentCount = comments.filter((c) => c.resolved).length;

  return {
    id: record.id,
    fileId: record.fileId,
    versionId: record.versionId,
    userId: record.userId,
    type: record.type as AnnotationType,
    label: record.label,
    payload: record.payload as unknown as AnnotationPayload,
    commentCount: comments.length,
    resolvedCommentCount,
    author: record.user
      ? {
          id: record.user.id,
          name: record.user.name,
          email: record.user.email,
          avatarUrl: record.user.avatarUrl,
        }
      : undefined,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function annotationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/files/:fileId/annotations',
    {
      preHandler: requirePermission(SharePermission.MEASURE),
      schema: {
        tags: ['Annotations'],
        summary: 'Create a 3D annotation pinned to a file version',
        params: {
          type: 'object',
          required: ['fileId'],
          properties: {
            fileId: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['versionId', 'payload'],
          properties: {
            versionId: { type: 'string', minLength: 1 },
            type: {
              type: 'string',
              enum: Object.values(AnnotationType),
            },
            label: { type: ['string', 'null'], maxLength: 240 },
            payload: anchorPayloadJsonSchema,
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authenticated user session required to create annotations',
          },
        });
      }

      const { fileId } = request.params as { fileId: string };
      const body = createAnnotationRequestSchema.parse(request.body);

      const file = await prisma.file.findUnique({
        where: { id: fileId },
        include: { project: true },
      });

      if (!file || file.project.organizationId !== request.authUser.organizationId) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
      }

      const version = await prisma.fileVersion.findFirst({
        where: { id: body.versionId, fileId: file.id },
      });

      if (!version) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'VERSION_NOT_FOUND',
            message: 'File version not found for this file',
          },
        });
      }

      const created = await prisma.annotation.create({
        data: {
          fileId: file.id,
          versionId: version.id,
          userId: request.authUser.id,
          type: body.type,
          label: body.label ?? null,
          payload: body.payload as unknown as Prisma.InputJsonValue,
        },
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
          comments: {
            select: { resolved: true },
          },
        },
      });

      await prisma.activityLog.create({
        data: {
          organizationId: request.authUser.organizationId,
          projectId: file.projectId,
          fileId: file.id,
          userId: request.authUser.id,
          action: ActivityAction.ANNOTATION_CREATED,
          metadata: {
            annotationId: created.id,
            versionId: version.id,
            type: created.type,
            label: created.label,
          },
        },
      });

      const serialized = serializeAnnotation(created);
      broadcastFileDelta(
        fastify.io,
        file.id,
        REALTIME_EVENTS.ANNOTATION_CREATE,
        serialized,
        {
          userId: request.authUser.id,
          name: request.authUser.name,
          avatarColor: computeAvatarColor(request.authUser.id),
        },
        readOriginSocketId(request.headers as Record<string, unknown>)
      );

      return reply.status(201).send({
        success: true,
        data: serialized,
      });
    }
  );

  fastify.get(
    '/files/:fileId/annotations',
    {
      preHandler: requirePermission(SharePermission.VIEW),
      schema: {
        tags: ['Annotations'],
        summary: 'List annotations for a file (optionally filtered by versionId)',
        params: {
          type: 'object',
          required: ['fileId'],
          properties: {
            fileId: { type: 'string', minLength: 1 },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            versionId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const query = annotationsListQuerySchema.parse(request.query);

      const file = await prisma.file.findUnique({
        where: { id: fileId },
        include: { project: true },
      });

      if (
        !file ||
        (request.authUser &&
          file.project.organizationId !== request.authUser.organizationId)
      ) {
        return reply.status(404).send({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
        });
      }

      const annotations = await prisma.annotation.findMany({
        where: {
          fileId: file.id,
          ...(query.versionId ? { versionId: query.versionId } : {}),
        },
        orderBy: { createdAt: 'asc' },
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
          comments: {
            where: { parentId: null },
            select: { resolved: true },
          },
        },
      });

      return reply.send({
        success: true,
        data: annotations.map(serializeAnnotation),
      });
    }
  );

  fastify.patch(
    '/annotations/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Annotations'],
        summary: 'Update annotation label or payload (author or admin only)',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          properties: {
            label: { type: ['string', 'null'], maxLength: 240 },
            payload: anchorPayloadJsonSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateAnnotationRequestSchema.parse(request.body);
      const user = request.authUser!;

      const existing = await prisma.annotation.findUnique({
        where: { id },
        include: { file: { include: { project: true } } },
      });

      if (!existing || existing.file.project.organizationId !== user.organizationId) {
        return reply.status(404).send({
          success: false,
          error: { code: 'ANNOTATION_NOT_FOUND', message: 'Annotation not found' },
        });
      }

      if (existing.userId !== user.id && !isAdminRole(user.role)) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only the author or an administrator can modify this annotation',
          },
        });
      }

      const updated = await prisma.annotation.update({
        where: { id: existing.id },
        data: {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.payload !== undefined
            ? { payload: body.payload as unknown as Prisma.InputJsonValue }
            : {}),
        },
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
          comments: {
            where: { parentId: null },
            select: { resolved: true },
          },
        },
      });

      const serialized = serializeAnnotation(updated);
      broadcastFileDelta(
        fastify.io,
        existing.fileId,
        REALTIME_EVENTS.ANNOTATION_UPDATE,
        serialized,
        {
          userId: user.id,
          name: user.name,
          avatarColor: computeAvatarColor(user.id),
        },
        readOriginSocketId(request.headers as Record<string, unknown>)
      );

      return reply.send({
        success: true,
        data: serialized,
      });
    }
  );

  fastify.delete(
    '/annotations/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Annotations'],
        summary: 'Delete an annotation (author or admin only)',
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
      const { id } = request.params as { id: string };
      const user = request.authUser!;

      const existing = await prisma.annotation.findUnique({
        where: { id },
        include: { file: { include: { project: true } } },
      });

      if (!existing || existing.file.project.organizationId !== user.organizationId) {
        return reply.status(404).send({
          success: false,
          error: { code: 'ANNOTATION_NOT_FOUND', message: 'Annotation not found' },
        });
      }

      if (existing.userId !== user.id && !isAdminRole(user.role)) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only the author or an administrator can delete this annotation',
          },
        });
      }

      await prisma.annotation.delete({ where: { id: existing.id } });

      const deletePayload: EntityDeletePayload = {
        id: existing.id,
        fileId: existing.fileId,
        versionId: existing.versionId,
      };
      broadcastFileDelta(
        fastify.io,
        existing.fileId,
        REALTIME_EVENTS.ANNOTATION_DELETE,
        deletePayload,
        {
          userId: user.id,
          name: user.name,
          avatarColor: computeAvatarColor(user.id),
        },
        readOriginSocketId(request.headers as Record<string, unknown>)
      );

      return reply.send({
        success: true,
        data: { id: existing.id, deleted: true },
      });
    }
  );
}
