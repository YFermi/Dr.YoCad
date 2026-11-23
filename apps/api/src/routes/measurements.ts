/**
 * Measurements REST routes.
 *
 * Real-time sync boundary (Session 5 B3):
 * REST endpoints are the sole persistence layer. After Prisma create/delete
 * succeeds, each handler broadcasts the resulting delta to `file:<fileId>` via
 * `fastify.io`, excluding the originating socket specified by the `x-socket-id` header.
 */
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  ActivityAction,
  computeAvatarColor,
  createMeasurementRequestSchema,
  measurementsListQuerySchema,
  MeasurementType,
  REALTIME_EVENTS,
  SharePermission,
  updateMeasurementRequestSchema,
  UserRole,
  type EntityDeletePayload,
  type Measurement,
  type MeasurementPointsPayload,
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

interface MeasurementRecordWithAuthor {
  id: string;
  fileId: string;
  versionId: string;
  userId: string;
  type: string;
  value: number;
  unit: string;
  points: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
  user?: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
  };
}

function serializeMeasurement(record: MeasurementRecordWithAuthor): Measurement {
  return {
    id: record.id,
    fileId: record.fileId,
    versionId: record.versionId,
    userId: record.userId,
    type: record.type as MeasurementType,
    value: record.value,
    unit: record.unit,
    points: record.points as unknown as MeasurementPointsPayload,
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

export async function measurementRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/files/:fileId/measurements',
    {
      preHandler: requirePermission(SharePermission.MEASURE),
      schema: {
        tags: ['Measurements'],
        summary: 'Persist a 3D measurement on a file version',
        params: {
          type: 'object',
          required: ['fileId'],
          properties: {
            fileId: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['versionId', 'type', 'value', 'unit', 'points'],
          properties: {
            versionId: { type: 'string', minLength: 1 },
            type: { type: 'string', enum: Object.values(MeasurementType) },
            value: { type: 'number', minimum: 0 },
            unit: { type: 'string', minLength: 1, maxLength: 16 },
            points: {
              type: 'object',
              additionalProperties: true,
            },
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
            message: 'Authenticated user session required to save measurements',
          },
        });
      }

      const { fileId } = request.params as { fileId: string };
      const body = createMeasurementRequestSchema.parse(request.body);

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

      const created = await prisma.measurement.create({
        data: {
          fileId: file.id,
          versionId: version.id,
          userId: request.authUser.id,
          type: body.type,
          value: body.value,
          unit: body.unit,
          points: body.points as unknown as Prisma.InputJsonValue,
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
          action: ActivityAction.MEASUREMENT_CREATED,
          metadata: {
            measurementId: created.id,
            versionId: version.id,
            type: created.type,
            value: created.value,
            unit: created.unit,
          },
        },
      });

      const serialized = serializeMeasurement(created);
      broadcastFileDelta(
        fastify.io,
        file.id,
        REALTIME_EVENTS.MEASUREMENT_CREATE,
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
    '/files/:fileId/measurements',
    {
      preHandler: requirePermission(SharePermission.VIEW),
      schema: {
        tags: ['Measurements'],
        summary: 'List saved measurements for a file (optionally filtered by versionId)',
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
      const query = measurementsListQuerySchema.parse(request.query);

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

      const measurements = await prisma.measurement.findMany({
        where: {
          fileId: file.id,
          ...(query.versionId ? { versionId: query.versionId } : {}),
        },
        orderBy: { createdAt: 'asc' },
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
        },
      });

      return reply.send({
        success: true,
        data: measurements.map(serializeMeasurement),
      });
    }
  );

  fastify.delete(
    '/measurements/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Measurements'],
        summary: 'Delete a saved measurement (author or admin only)',
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

      const existing = await prisma.measurement.findUnique({
        where: { id },
        include: { file: { include: { project: true } } },
      });

      if (!existing || existing.file.project.organizationId !== user.organizationId) {
        return reply.status(404).send({
          success: false,
          error: { code: 'MEASUREMENT_NOT_FOUND', message: 'Measurement not found' },
        });
      }

      if (existing.userId !== user.id && !isAdminRole(user.role)) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only the author or an administrator can delete this measurement',
          },
        });
      }

      await prisma.measurement.delete({ where: { id: existing.id } });

      const deletePayload: EntityDeletePayload = {
        id: existing.id,
        fileId: existing.fileId,
        versionId: existing.versionId,
      };
      broadcastFileDelta(
        fastify.io,
        existing.fileId,
        REALTIME_EVENTS.MEASUREMENT_DELETE,
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

  fastify.patch(
    '/measurements/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Measurements'],
        summary: 'Update a saved measurement label, unit, or value (author or admin only)',
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
      const body = updateMeasurementRequestSchema.parse(request.body);

      const existing = await prisma.measurement.findUnique({
        where: { id },
        include: { file: { include: { project: true } } },
      });

      if (!existing || existing.file.project.organizationId !== user.organizationId) {
        return reply.status(404).send({
          success: false,
          error: { code: 'MEASUREMENT_NOT_FOUND', message: 'Measurement not found' },
        });
      }

      if (existing.userId !== user.id && !isAdminRole(user.role)) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only the author or an administrator can update this measurement',
          },
        });
      }

      const updated = await prisma.measurement.update({
        where: { id: existing.id },
        data: {
          ...(body.value !== undefined ? { value: body.value } : {}),
          ...(body.unit !== undefined ? { unit: body.unit } : {}),
          ...(body.points !== undefined
            ? { points: body.points as unknown as Prisma.InputJsonValue }
            : {}),
        },
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
        },
      });

      return reply.send({
        success: true,
        data: serializeMeasurement(updated),
      });
    }
  );
}
