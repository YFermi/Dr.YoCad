import type { FastifyInstance } from 'fastify';
import {
  ActivityAction,
  createProjectRequestSchema,
  paginationQuerySchema,
  projectParamsSchema,
  SharePermission,
  updateProjectRequestSchema,
  type ActivityLogWithAuthor,
} from '@cadline/shared';
import { prisma } from '../lib/prisma.js';
import { STANDALONE } from '../lib/standalone.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

function serializeProject(project: {
  id: string;
  organizationId: string;
  createdById: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { files: number; folders: number };
}) {
  return {
    id: project.id,
    organizationId: project.organizationId,
    createdById: project.createdById,
    name: project.name,
    description: project.description,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    _count: project._count,
  };
}

export async function projectRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const query = paginationQuerySchema.parse(request.query);
    const authUser = request.authUser!;

    const where = {
      organizationId: authUser.organizationId,
      ...(query.search
        ? {
            // SQLite (STANDALONE) has no `mode` filter; its LIKE is already
            // case-insensitive for ASCII.
            OR: STANDALONE
              ? [
                  { name: { contains: query.search } },
                  { description: { contains: query.search } },
                ]
              : [
                  { name: { contains: query.search, mode: 'insensitive' as const } },
                  { description: { contains: query.search, mode: 'insensitive' as const } },
                ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          _count: {
            select: { files: true, folders: true },
          },
        },
      }),
    ]);

    return reply.send({
      success: true,
      data: {
        items: items.map(serializeProject),
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    });
  });

  fastify.post(
    '/',
    { preHandler: [authenticate, requirePermission(SharePermission.EDIT)] },
    async (request, reply) => {
      const body = createProjectRequestSchema.parse(request.body);
      const authUser = request.authUser!;

      const project = await prisma.project.create({
        data: {
          organizationId: authUser.organizationId,
          createdById: authUser.id,
          name: body.name,
          description: body.description ?? null,
        },
        include: {
          _count: {
            select: { files: true, folders: true },
          },
        },
      });

      await prisma.activityLog.create({
        data: {
          organizationId: authUser.organizationId,
          projectId: project.id,
          userId: authUser.id,
          action: 'PROJECT_CREATED',
          metadata: { name: project.name },
        },
      });

      return reply.status(201).send({
        success: true,
        data: serializeProject(project),
      });
    }
  );

  fastify.get('/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const params = projectParamsSchema.parse(request.params);
    const authUser = request.authUser!;

    const project = await prisma.project.findFirst({
      where: {
        id: params.id,
        organizationId: authUser.organizationId,
      },
      include: {
        _count: {
          select: { files: true, folders: true },
        },
      },
    });

    if (!project) {
      return reply.status(404).send({
        success: false,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
      });
    }

    return reply.send({
      success: true,
      data: serializeProject(project),
    });
  });

  fastify.patch(
    '/:id',
    { preHandler: [authenticate, requirePermission(SharePermission.EDIT)] },
    async (request, reply) => {
      const params = projectParamsSchema.parse(request.params);
      const body = updateProjectRequestSchema.parse(request.body);
      const authUser = request.authUser!;

      const existing = await prisma.project.findFirst({
        where: {
          id: params.id,
          organizationId: authUser.organizationId,
        },
      });

      if (!existing) {
        return reply.status(404).send({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        });
      }

      const updated = await prisma.project.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
        },
        include: {
          _count: {
            select: { files: true, folders: true },
          },
        },
      });

      await prisma.activityLog.create({
        data: {
          organizationId: authUser.organizationId,
          projectId: updated.id,
          userId: authUser.id,
          action: 'PROJECT_UPDATED',
          metadata: { name: updated.name },
        },
      });

      return reply.send({
        success: true,
        data: serializeProject(updated),
      });
    }
  );

  fastify.delete(
    '/:id',
    { preHandler: [authenticate, requirePermission(SharePermission.ADMIN)] },
    async (request, reply) => {
      const params = projectParamsSchema.parse(request.params);
      const authUser = request.authUser!;

      const existing = await prisma.project.findFirst({
        where: {
          id: params.id,
          organizationId: authUser.organizationId,
        },
      });

      if (!existing) {
        return reply.status(404).send({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        });
      }

      await prisma.project.delete({ where: { id: existing.id } });

      return reply.send({
        success: true,
        data: { id: existing.id, deleted: true },
      });
    }
  );

  fastify.get(
    '/:id/activity',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Projects', 'Activity'],
        summary: 'Fetch the 20 most recent project activity events',
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
      const params = projectParamsSchema.parse(request.params);
      const authUser = request.authUser!;

      const project = await prisma.project.findFirst({
        where: {
          id: params.id,
          organizationId: authUser.organizationId,
        },
        select: { id: true },
      });

      if (!project) {
        return reply.status(404).send({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        });
      }

      const logs = await prisma.activityLog.findMany({
        where: {
          organizationId: authUser.organizationId,
          projectId: project.id,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
          file: {
            select: { name: true },
          },
        },
      });

      const items: ActivityLogWithAuthor[] = logs.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        projectId: row.projectId,
        fileId: row.fileId,
        userId: row.userId,
        action: row.action as ActivityAction,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
        author: row.user
          ? {
              id: row.user.id,
              name: row.user.name,
              email: row.user.email,
              avatarUrl: row.user.avatarUrl,
            }
          : undefined,
        fileName: row.file?.name ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));

      return reply.send({
        success: true,
        data: items,
      });
    }
  );
}
