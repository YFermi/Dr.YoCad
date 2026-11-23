/**
 * Comments REST routes.
 *
 * Real-time sync boundary (Session 5 B3):
 * REST endpoints are the sole persistence layer. After Prisma create/update/delete
 * succeeds, each handler broadcasts the resulting delta to `file:<fileId>` via
 * `fastify.io`, excluding the originating socket specified by the `x-socket-id` header.
 */
import type { FastifyInstance } from 'fastify';
import {
  ActivityAction,
  commentsListQuerySchema,
  computeAvatarColor,
  createCommentRequestSchema,
  REALTIME_EVENTS,
  SharePermission,
  updateCommentRequestSchema,
  UserRole,
  type Comment,
  type CommentsListResponse,
  type CommentWithReplies,
  type EntityDeletePayload,
} from '@cadline/shared';
import { prisma } from '../lib/prisma.js';
import { broadcastFileDelta } from '../lib/realtimeHub.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

function readOriginSocketId(headers: Record<string, unknown>): string | undefined {
  const val = headers['x-socket-id'];
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function isAdminRole(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.OWNER;
}

interface CommentRecordWithAuthor {
  id: string;
  fileId: string;
  annotationId: string | null;
  userId: string;
  parentId: string | null;
  body: string;
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
  user?: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
  };
}

function serializeComment(record: CommentRecordWithAuthor): Comment {
  return {
    id: record.id,
    fileId: record.fileId,
    annotationId: record.annotationId,
    userId: record.userId,
    parentId: record.parentId,
    body: record.body,
    resolved: record.resolved,
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

export async function commentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/files/:fileId/comments',
    {
      preHandler: requirePermission(SharePermission.COMMENT),
      schema: {
        tags: ['Comments'],
        summary: 'Create a top-level comment or one-level threaded reply on a file',
        params: {
          type: 'object',
          required: ['fileId'],
          properties: {
            fileId: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['body'],
          properties: {
            body: { type: 'string', minLength: 1, maxLength: 5000 },
            annotationId: { type: ['string', 'null'] },
            parentId: { type: ['string', 'null'] },
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
            message: 'Authenticated user session required to post comments',
          },
        });
      }

      const { fileId } = request.params as { fileId: string };
      const body = createCommentRequestSchema.parse(request.body);

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

      let resolvedAnnotationId: string | null = body.annotationId ?? null;

      if (body.parentId) {
        const parent = await prisma.comment.findUnique({
          where: { id: body.parentId },
        });

        if (!parent || parent.fileId !== file.id) {
          return reply.status(400).send({
            success: false,
            error: {
              code: 'INVALID_PARENT_COMMENT',
              message: 'Parent comment does not exist on this file',
            },
          });
        }

        if (parent.parentId !== null) {
          return reply.status(400).send({
            success: false,
            error: {
              code: 'NESTING_LIMIT_EXCEEDED',
              message: 'Comments support one level of replies only',
            },
          });
        }

        if (!resolvedAnnotationId && parent.annotationId) {
          resolvedAnnotationId = parent.annotationId;
        }
      }

      if (resolvedAnnotationId) {
        const annotation = await prisma.annotation.findFirst({
          where: { id: resolvedAnnotationId, fileId: file.id },
        });
        if (!annotation) {
          return reply.status(400).send({
            success: false,
            error: {
              code: 'INVALID_ANNOTATION',
              message: 'Referenced annotation does not belong to this file',
            },
          });
        }
      }

      const created = await prisma.comment.create({
        data: {
          fileId: file.id,
          annotationId: resolvedAnnotationId,
          parentId: body.parentId ?? null,
          userId: request.authUser.id,
          body: body.body,
        },
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
        },
      });

      await prisma.activityLog.create({
        data: {
          organizationId: request.authUser.organizationId,
          projectId: file.projectId,
          fileId: file.id,
          userId: request.authUser.id,
          action: ActivityAction.COMMENT_CREATED,
          metadata: {
            commentId: created.id,
            annotationId: created.annotationId,
            parentId: created.parentId,
          },
        },
      });

      const serialized: CommentWithReplies = {
        ...serializeComment(created),
        replies: [],
      };

      broadcastFileDelta(
        fastify.io,
        file.id,
        REALTIME_EVENTS.COMMENT_CREATE,
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
    '/files/:fileId/comments',
    {
      preHandler: requirePermission(SharePermission.VIEW),
      schema: {
        tags: ['Comments'],
        summary: 'List top-level comments with one-level replies and count summary',
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
            annotationId: { type: 'string', minLength: 1 },
            resolved: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      const query = commentsListQuerySchema.parse(request.query);

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

      const allTopLevel = await prisma.comment.findMany({
        where: {
          fileId: file.id,
          parentId: null,
          ...(query.annotationId ? { annotationId: query.annotationId } : {}),
          ...(query.versionId ? { annotation: { versionId: query.versionId } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
          replies: {
            orderBy: { createdAt: 'asc' },
            include: {
              user: {
                select: { id: true, name: true, email: true, avatarUrl: true },
              },
            },
          },
        },
      });

      const resolvedTopLevel = allTopLevel.filter((c) => c.resolved).length;
      const totalTopLevel = allTopLevel.length;
      const unresolvedTopLevel = totalTopLevel - resolvedTopLevel;

      const filtered =
        query.resolved === undefined
          ? allTopLevel
          : allTopLevel.filter((c) => c.resolved === query.resolved);

      const items: CommentWithReplies[] = filtered.map((record) => ({
        ...serializeComment(record),
        replies: record.replies.map(serializeComment),
      }));

      const payload: CommentsListResponse = {
        items,
        summary: {
          totalTopLevel,
          unresolvedTopLevel,
          resolvedTopLevel,
        },
      };

      return reply.send({
        success: true,
        data: payload,
      });
    }
  );

  fastify.patch(
    '/comments/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Comments'],
        summary: 'Edit comment body or toggle resolved state (author or admin only)',
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
            body: { type: 'string', minLength: 1, maxLength: 5000 },
            resolved: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateCommentRequestSchema.parse(request.body);
      const user = request.authUser!;

      const existing = await prisma.comment.findUnique({
        where: { id },
        include: { file: { include: { project: true } } },
      });

      if (!existing || existing.file.project.organizationId !== user.organizationId) {
        return reply.status(404).send({
          success: false,
          error: { code: 'COMMENT_NOT_FOUND', message: 'Comment not found' },
        });
      }

      if (existing.userId !== user.id && !isAdminRole(user.role)) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only the author or an administrator can modify this comment',
          },
        });
      }

      const updated = await prisma.comment.update({
        where: { id: existing.id },
        data: {
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.resolved !== undefined ? { resolved: body.resolved } : {}),
        },
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
        },
      });

      const serialized = serializeComment(updated);
      broadcastFileDelta(
        fastify.io,
        existing.fileId,
        REALTIME_EVENTS.COMMENT_UPDATE,
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
    '/comments/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Comments'],
        summary: 'Delete a comment and cascade delete replies (author or admin only)',
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

      const existing = await prisma.comment.findUnique({
        where: { id },
        include: { file: { include: { project: true } } },
      });

      if (!existing || existing.file.project.organizationId !== user.organizationId) {
        return reply.status(404).send({
          success: false,
          error: { code: 'COMMENT_NOT_FOUND', message: 'Comment not found' },
        });
      }

      if (existing.userId !== user.id && !isAdminRole(user.role)) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only the author or an administrator can delete this comment',
          },
        });
      }

      await prisma.comment.delete({ where: { id: existing.id } });

      const deletePayload: EntityDeletePayload = {
        id: existing.id,
        fileId: existing.fileId,
      };
      broadcastFileDelta(
        fastify.io,
        existing.fileId,
        REALTIME_EVENTS.COMMENT_DELETE,
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
