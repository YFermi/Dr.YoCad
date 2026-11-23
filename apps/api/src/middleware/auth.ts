import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { PERMISSION_RANK, SharePermission, UserRole } from '@cadline/shared';
import { prisma } from '../lib/prisma.js';

const ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? 'dev-only-access-secret-change-me-32chars';
const REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? 'dev-only-refresh-secret-change-me-32chars';
const ACCESS_TTL = (process.env.JWT_ACCESS_TTL ?? '15m') as jwt.SignOptions['expiresIn'];
const REFRESH_TTL = (process.env.JWT_REFRESH_TTL ?? '7d') as jwt.SignOptions['expiresIn'];

export interface AccessTokenPayload {
  sub: string;
  orgId: string;
  email: string;
  role: UserRole;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  email: string;
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
    effectivePermission?: SharePermission;
  }
}

export function signAccessToken(user: {
  id: string;
  organizationId: string;
  email: string;
  role: UserRole;
}): string {
  const payload: AccessTokenPayload = {
    sub: user.id,
    orgId: user.organizationId,
    email: user.email,
    role: user.role,
    type: 'access',
  };

  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

export function signRefreshToken(userId: string): {
  token: string;
  tokenHash: string;
  expiresAt: Date;
} {
  const jti = crypto.randomUUID();
  const payload: RefreshTokenPayload = {
    sub: userId,
    jti,
    type: 'refresh',
  };

  const token = jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_TTL });
  const decoded = jwt.decode(token) as { exp?: number } | null;
  const expiresAt = decoded?.exp
    ? new Date(decoded.exp * 1000)
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  return {
    token,
    tokenHash: hashToken(token),
    expiresAt,
  };
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
  if (decoded.type !== 'access') {
    throw new Error('Invalid token type');
  }
  return decoded;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, REFRESH_SECRET) as RefreshTokenPayload;
  if (decoded.type !== 'refresh') {
    throw new Error('Invalid token type');
  }
  return decoded;
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function roleToPermission(role: UserRole): SharePermission {
  switch (role) {
    case UserRole.OWNER:
    case UserRole.ADMIN:
      return SharePermission.ADMIN;
    case UserRole.MEMBER:
      return SharePermission.EDIT;
    case UserRole.VIEWER:
    default:
      return SharePermission.VIEW;
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply | void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token' },
    });
  }

  const token = header.slice('Bearer '.length).trim();

  try {
    const payload = verifyAccessToken(token);
    request.authUser = {
      id: payload.sub,
      organizationId: payload.orgId,
      email: payload.email,
      role: payload.role,
    };
    request.effectivePermission = roleToPermission(payload.role);
  } catch {
    return reply.status(401).send({
      success: false,
      error: { code: 'TOKEN_EXPIRED', message: 'Access token is invalid or expired' },
    });
  }
}

/**
 * Verifies that the caller satisfies the required SharePermission level via
 * either an authenticated JWT user role or a valid share link token header.
 */
export function requirePermission(requiredLevel: SharePermission) {
  return async function permissionGuard(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply | void> {
    const authHeader = request.headers.authorization;
    const shareTokenHeader = request.headers['x-share-token'];
    const shareToken =
      typeof shareTokenHeader === 'string' ? shareTokenHeader.trim() : undefined;

    if (authHeader?.startsWith('Bearer ')) {
      const authResult = await authenticate(request, reply);
      if (authResult || reply.sent || !request.effectivePermission) {
        return authResult;
      }

      if (PERMISSION_RANK[request.effectivePermission] < PERMISSION_RANK[requiredLevel]) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: `Requires ${requiredLevel} permission`,
          },
        });
      }
      return;
    }

    if (shareToken) {
      const link = await prisma.shareLink.findUnique({ where: { token: shareToken } });
      if (
        !link ||
        link.revokedAt ||
        (link.expiresAt && link.expiresAt.getTime() < Date.now())
      ) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'INVALID_SHARE_TOKEN',
            message: 'Share link is invalid or expired',
          },
        });
      }

      const permission = link.permission as unknown as SharePermission;
      if (PERMISSION_RANK[permission] < PERMISSION_RANK[requiredLevel]) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: `Share link requires ${requiredLevel} permission`,
          },
        });
      }

      request.effectivePermission = permission;
      return;
    }

    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
  };
}
