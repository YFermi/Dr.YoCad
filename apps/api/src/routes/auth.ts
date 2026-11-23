import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import {
  loginRequestSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  UserRole,
} from '@cadline/shared';
import { prisma } from '../lib/prisma.js';
import { oauthProviders } from '../lib/oauth.js';
import {
  authenticate,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../middleware/auth.js';

function slugifyOrg(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base || 'workspace'}-${suffix}`;
}

function serializeUser(user: {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  oauthProvider: string | null;
  oauthSubject: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: user.id,
    organizationId: user.organizationId,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    avatarUrl: user.avatarUrl,
    oauthProvider: user.oauthProvider,
    oauthSubject: user.oauthSubject,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function serializeOrg(org: {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  };
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/oauth/providers', async (_request, reply) => {
    return reply.send({
      success: true,
      data: {
        providers: Object.values(oauthProviders).map((provider) => ({
          name: provider.name,
          configured: provider.isConfigured(),
        })),
      },
    });
  });

  fastify.post(
    '/register',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '15 minutes',
        },
      },
    },
    async (request, reply) => {
    const body = registerRequestSchema.parse(request.body);
    const normalizedEmail = body.email.toLowerCase();

    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      return reply.status(409).send({
        success: false,
        error: {
          code: 'EMAIL_EXISTS',
          message: 'An account with this email already exists',
        },
      });
    }

    const passwordHash = await bcrypt.hash(body.password, 12);
    const orgName = body.organizationName?.trim() || `${body.name}'s Workspace`;

    const organization = await prisma.organization.create({
      data: {
        name: orgName,
        slug: slugifyOrg(orgName),
      },
    });

    const user = await prisma.user.create({
      data: {
        organizationId: organization.id,
        email: normalizedEmail,
        passwordHash,
        name: body.name,
        role: UserRole.OWNER,
      },
    });

    const accessToken = signAccessToken({
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      role: user.role as UserRole,
    });
    const refresh = signRefreshToken(user.id);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      },
    });

    await prisma.activityLog.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        action: 'USER_REGISTERED',
        metadata: { email: user.email },
      },
    });

    return reply.status(201).send({
      success: true,
      data: {
        user: serializeUser(user),
        organization: serializeOrg(organization),
        tokens: {
          accessToken,
          refreshToken: refresh.token,
        },
      },
    });
  });

  fastify.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
        },
      },
    },
    async (request, reply) => {
    const body = loginRequestSchema.parse(request.body);
    const normalizedEmail = body.email.toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { organization: true },
    });

    if (!user || !user.passwordHash) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
    }

    const isValid = await bcrypt.compare(body.password, user.passwordHash);
    if (!isValid) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
    }

    const accessToken = signAccessToken({
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      role: user.role as UserRole,
    });
    const refresh = signRefreshToken(user.id);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      },
    });

    return reply.send({
      success: true,
      data: {
        user: serializeUser(user),
        organization: serializeOrg(user.organization),
        tokens: {
          accessToken,
          refreshToken: refresh.token,
        },
      },
    });
  });

  fastify.post('/refresh', async (request, reply) => {
    const body = refreshRequestSchema.parse(request.body);

    let decoded;
    try {
      decoded = verifyRefreshToken(body.refreshToken);
    } catch {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'INVALID_REFRESH_TOKEN',
          message: 'Refresh token is invalid or expired',
        },
      });
    }

    const tokenHash = hashToken(body.refreshToken);
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: { organization: true },
        },
      },
    });

    if (
      !stored ||
      stored.userId !== decoded.sub ||
      stored.revokedAt ||
      stored.expiresAt.getTime() < Date.now()
    ) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'REFRESH_REVOKED',
          message: 'Refresh token has been revoked or expired',
        },
      });
    }

    // Rotate refresh token
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const nextRefresh = signRefreshToken(stored.user.id);
    await prisma.refreshToken.create({
      data: {
        userId: stored.user.id,
        tokenHash: nextRefresh.tokenHash,
        expiresAt: nextRefresh.expiresAt,
      },
    });

    const accessToken = signAccessToken({
      id: stored.user.id,
      organizationId: stored.user.organizationId,
      email: stored.user.email,
      role: stored.user.role as UserRole,
    });

    return reply.send({
      success: true,
      data: {
        user: serializeUser(stored.user),
        organization: serializeOrg(stored.user.organization),
        tokens: {
          accessToken,
          refreshToken: nextRefresh.token,
        },
      },
    });
  });

  fastify.post('/logout', async (request, reply) => {
    const body = logoutRequestSchema.parse(request.body ?? {});

    if (body.refreshToken) {
      const tokenHash = hashToken(body.refreshToken);
      await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return reply.send({
      success: true,
      data: { loggedOut: true },
    });
  });

  fastify.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
    const authUser = request.authUser!;
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      include: { organization: true },
    });

    if (!user) {
      return reply.status(404).send({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }

    return reply.send({
      success: true,
      data: {
        user: serializeUser(user),
        organization: serializeOrg(user.organization),
      },
    });
  });
}
