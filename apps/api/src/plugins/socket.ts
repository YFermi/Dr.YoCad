import type { FastifyInstance } from 'fastify';
import { Server as SocketIOServer } from 'socket.io';
import type { ConversionMode } from '@cadline/shared';
import { verifyAccessToken } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { attachCollaborationHub } from '../lib/realtimeHub.js';

declare module 'fastify' {
  interface FastifyInstance {
    io: SocketIOServer;
  }
}

/**
 * Registers Socket.IO on the underlying Fastify HTTP server.
 * Session 5 extends the Session 1 plugin into the full collaboration hub:
 *  - Deterministic avatarColor per userId
 *  - RoomState snapshot on file:join
 *  - Emitter-excluded delta broadcasts (REST persists; socket fans out)
 *  - Ephemeral 20 Hz cursor:move & 15 Hz camera:sync / viewport:sync relay with rate limiting
 *  - Follow mode with immediate pose sync, mutual-follow prevention, and leader-disconnect cleanup
 */
export function registerSocketPlugin(fastify: FastifyInstance): void {
  const io = new SocketIOServer(fastify.server, {
    cors: {
      origin: process.env.WEB_URL ?? 'http://localhost:5173',
      credentials: true,
    },
  });

  attachCollaborationHub(io, {
    verifyToken: (token) => {
      try {
        const payload = verifyAccessToken(token);
        return {
          userId: payload.sub,
          email: payload.email,
          organizationId: payload.orgId,
        };
      } catch {
        return null;
      }
    },
    authorizeJoin: async (auth, fileId) => {
      const file = await prisma.file.findUnique({
        where: { id: fileId },
        select: { projectId: true, project: { select: { organizationId: true } } },
      });
      if (!file) return false;

      // Authenticated member of the org that owns the file's project
      if (auth.organizationId && file.project.organizationId === auth.organizationId) {
        return true;
      }

      // Otherwise a live share link scoped to this file or its project
      if (!auth.shareToken) return false;
      const link = await prisma.shareLink.findUnique({ where: { token: auth.shareToken } });
      if (!link || link.revokedAt) return false;
      if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return false;
      return link.fileId === fileId || (!!link.projectId && link.projectId === file.projectId);
    },
    resolveFileMode: async (fileId): Promise<ConversionMode> => {
      const file = await prisma.file.findUnique({
        where: { id: fileId },
        select: { extension: true },
      });
      const ext = file?.extension?.toLowerCase();
      if (ext === 'dxf' || ext === 'dwg') return '2D_DXF';
      if (ext === 'pdf') return '2D_PDF';
      return '3D';
    },
    onLog: (msg, meta) => fastify.log.info(meta ?? {}, msg),
  });

  fastify.decorate('io', io);

  fastify.addHook('onClose', async () => {
    await io.close();
  });
}
