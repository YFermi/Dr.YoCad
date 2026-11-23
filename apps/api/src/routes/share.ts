import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  createShareLinkRequestSchema,
  FileStatus,
  SharePermission,
  shareTokenParamsSchema,
} from '@cadline/shared';
import { prisma } from '../lib/prisma.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

export async function shareRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/',
    { preHandler: [authenticate, requirePermission(SharePermission.EDIT)] },
    async (request, reply) => {
      const body = createShareLinkRequestSchema.parse(request.body);
      const authUser = request.authUser!;

      if (body.fileId) {
        const file = await prisma.file.findFirst({
          where: {
            id: body.fileId,
            project: { organizationId: authUser.organizationId },
          },
        });

        if (!file) {
          return reply.status(404).send({
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
          });
        }
      }

      if (body.projectId) {
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
      }

      const token = crypto.randomBytes(24).toString('base64url');
      const expiresAt = body.expiresInHours
        ? new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000)
        : null;

      const shareLink = await prisma.shareLink.create({
        data: {
          token,
          fileId: body.fileId ?? null,
          projectId: body.projectId ?? null,
          createdById: authUser.id,
          permission: body.permission,
          expiresAt,
        },
      });

      await prisma.activityLog.create({
        data: {
          organizationId: authUser.organizationId,
          projectId: shareLink.projectId,
          fileId: shareLink.fileId,
          userId: authUser.id,
          action: 'SHARE_LINK_CREATED',
          metadata: { permission: shareLink.permission, expiresAt: shareLink.expiresAt },
        },
      });

      return reply.status(201).send({
        success: true,
        data: {
          id: shareLink.id,
          token: shareLink.token,
          fileId: shareLink.fileId,
          projectId: shareLink.projectId,
          createdById: shareLink.createdById,
          permission: shareLink.permission as SharePermission,
          expiresAt: shareLink.expiresAt?.toISOString() ?? null,
          revokedAt: shareLink.revokedAt?.toISOString() ?? null,
          createdAt: shareLink.createdAt.toISOString(),
          updatedAt: shareLink.updatedAt.toISOString(),
        },
      });
    }
  );

  fastify.get('/:token', async (request, reply) => {
    const params = shareTokenParamsSchema.parse(request.params);

    const shareLink = await prisma.shareLink.findUnique({
      where: { token: params.token },
      include: {
        file: {
          include: {
            versions: {
              orderBy: { versionNumber: 'desc' },
            },
          },
        },
        project: true,
      },
    });

    if (!shareLink || shareLink.revokedAt) {
      return reply.status(404).send({
        success: false,
        error: { code: 'SHARE_NOT_FOUND', message: 'Share link not found or revoked' },
      });
    }

    if (shareLink.expiresAt && shareLink.expiresAt.getTime() < Date.now()) {
      return reply.status(410).send({
        success: false,
        error: { code: 'SHARE_EXPIRED', message: 'Share link has expired' },
      });
    }

    return reply.send({
      success: true,
      data: {
        shareLink: {
          id: shareLink.id,
          token: shareLink.token,
          fileId: shareLink.fileId,
          projectId: shareLink.projectId,
          createdById: shareLink.createdById,
          permission: shareLink.permission as SharePermission,
          expiresAt: shareLink.expiresAt?.toISOString() ?? null,
          revokedAt: null, // revoked links return 404 above
          createdAt: shareLink.createdAt.toISOString(),
          updatedAt: shareLink.updatedAt.toISOString(),
        },
        file: shareLink.file
          ? {
              id: shareLink.file.id,
              projectId: shareLink.file.projectId,
              folderId: shareLink.file.folderId,
              uploadedById: shareLink.file.uploadedById,
              name: shareLink.file.name,
              originalName: shareLink.file.originalName,
              mimeType: shareLink.file.mimeType,
              extension: shareLink.file.extension,
              sizeBytes: shareLink.file.sizeBytes,
              status: shareLink.file.status as FileStatus,
              currentVersion: shareLink.file.currentVersion,
              createdAt: shareLink.file.createdAt.toISOString(),
              updatedAt: shareLink.file.updatedAt.toISOString(),
              versions: shareLink.file.versions.map((v) => ({
                id: v.id,
                fileId: v.fileId,
                versionNumber: v.versionNumber,
                sizeBytes: v.sizeBytes,
                checksum: v.checksum,
                status: v.status as FileStatus,
                uploadedById: v.uploadedById,
                createdAt: v.createdAt.toISOString(),
                updatedAt: v.updatedAt.toISOString(),
              })),
            }
          : null,
        project: shareLink.project
          ? {
              id: shareLink.project.id,
              organizationId: shareLink.project.organizationId,
              createdById: shareLink.project.createdById,
              name: shareLink.project.name,
              description: shareLink.project.description,
              createdAt: shareLink.project.createdAt.toISOString(),
              updatedAt: shareLink.project.updatedAt.toISOString(),
            }
          : null,
      },
    });
  });
}
