import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { PERMISSION_RANK, SharePermission, UserRole } from '@cadline/shared';
import { resolveJwtSecret } from '../lib/jwtSecrets.js';
import { prisma } from '../lib/prisma.js';

const ACCESS_SECRET = resolveJwtSecret('JWT_ACCESS_SECRET');
const REFRESH_SECRET = resolveJwtSecret('JWT_REFRESH_SECRET');
const ACCESS_TTL = (process.env.JWT_ACCESS_TTL ?? '15m') as jwt.SignOptions['expiresIn'];
const REFRESH_TTL = (process.env.JWT_REFRESH_TTL ?? '7d') as jwt.SignOptions['expiresIn'];

export interface AccessTokenPayload {
  sub: string;
  orgId: string;
  email: string;
  /** Display name; optional so tokens issued before it was added still verify. */
  name?: string;
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
  name: string;
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
  name: string;
  role: UserRole;
}): string {
  const payload: AccessTokenPayload = {
    sub: user.id,
    orgId: user.organizationId,
    email: user.email,
    name: user.name,
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

/**
 * Short-lived signed URLs for binary assets (converted GLB, PDF page PNGs).
 * Browsers load these through <img src> / GLTFLoader, which cannot attach an
 * Authorization header, so the URL itself carries an HMAC over
 * (kind, fileId, versionId, extra, exp). Domain-separated from JWT signing.
 */
export function signAssetParams(
  kind: 'glb' | 'page',
  fileId: string,
  versionId: string,
  extra: string,
  ttlSeconds: number
): { exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { exp, sig: assetSignature(kind, fileId, versionId, extra, exp) };
}

export function verifyAssetParams(
  kind: 'glb' | 'page',
  fileId: string,
  versionId: string,
  extra: string,
  exp: number,
  sig: string
): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(assetSignature(kind, fileId, versionId, extra, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function assetSignature(
  kind: string,
  fileId: string,
  versionId: string,
  extra: string,
  exp: number
): string {
  return crypto
    .createHmac('sha256', ACCESS_SECRET)
    .update(`cadline-asset-v1|${kind}|${fileId}|${versionId}|${extra}|${exp}`)
    .digest('base64url');
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
      name: payload.name ?? payload.email.split('@')[0] ?? 'Reviewer',
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
 * Resolves the file / project a request targets from its route params.
 * File routes use `/files/:id/...` or `/files/:fileId/...`; project routes use
 * `/projects/:id/...`.
 */
function resolveShareTarget(request: FastifyRequest): {
  fileId?: string;
  projectId?: string;
} {
  const params = (request.params ?? {}) as Record<string, unknown>;
  const routeUrl = request.routeOptions?.url ?? request.url;
  const pick = (key: string): string | undefined =>
    typeof params[key] === 'string' && params[key] ? (params[key] as string) : undefined;

  const fileId = pick('fileId') ?? (routeUrl.includes('/files/') ? pick('id') : undefined);
  const projectId =
    pick('projectId') ?? (routeUrl.includes('/projects/') ? pick('id') : undefined);
  return { fileId, projectId };
}

/**
 * True when the share link's scope (fileId or projectId) covers the requested
 * resource. Fails closed: requests whose target cannot be resolved are denied.
 */
async function shareLinkCoversRequest(
  link: { fileId: string | null; projectId: string | null },
  request: FastifyRequest
): Promise<boolean> {
  const target = resolveShareTarget(request);

  if (target.fileId) {
    if (link.fileId) return link.fileId === target.fileId;
    if (link.projectId) {
      const file = await prisma.file.findUnique({
        where: { id: target.fileId },
        select: { projectId: true },
      });
      return file?.projectId === link.projectId;
    }
    return false;
  }

  if (target.projectId) {
    return Boolean(link.projectId) && link.projectId === target.projectId;
  }

  return false;
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
      // authenticate() only returns a value after sending a 401, so reply.sent covers it.
      if (reply.sent || !request.effectivePermission) {
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

      // Scope check: a share link only grants access to the file or project it
      // was created for. Mismatches return 404 so callers cannot probe for the
      // existence of resources outside the link's scope.
      if (!(await shareLinkCoversRequest(link, request))) {
        return reply.status(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Resource not found' },
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
