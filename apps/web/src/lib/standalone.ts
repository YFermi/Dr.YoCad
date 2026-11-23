import { UserRole, type Organization, type User } from '@cadline/shared';

/**
 * STANDALONE build flag (VITE_STANDALONE=true, set by `vite --mode standalone`
 * through apps/web/.env.standalone). When true the app never logs in: the auth
 * store starts with this fixed local user, and the API (also STANDALONE)
 * treats every request as that user. See STANDALONE.md.
 */
export const STANDALONE = import.meta.env.VITE_STANDALONE === 'true';

const EPOCH = '1970-01-01T00:00:00.000Z';

export const LOCAL_ORGANIZATION: Organization = {
  id: 'local-org',
  name: 'Local Workspace',
  slug: 'local',
  createdAt: EPOCH,
  updatedAt: EPOCH,
};

export const LOCAL_USER: User = {
  id: 'local-user',
  email: 'local@cadline.dev',
  name: 'Local Dev',
  role: UserRole.OWNER,
  organizationId: LOCAL_ORGANIZATION.id,
  avatarUrl: null,
  oauthProvider: null,
  oauthSubject: null,
  createdAt: EPOCH,
  updatedAt: EPOCH,
};

/**
 * Placeholder bearer value. The STANDALONE API ignores it; it exists so code
 * that gates on "has a token" (socket identity, presence ping fallback) treats
 * the local user as signed in. It is not a JWT and grants nothing in full mode.
 */
export const STANDALONE_ACCESS_TOKEN = 'standalone-local-user';
