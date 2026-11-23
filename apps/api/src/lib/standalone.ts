/**
 * STANDALONE mode: single-process local dev with no external services.
 *
 * Enabled only by the environment variable STANDALONE=true (set by
 * `npm run dev:standalone`). When it is not set, nothing in this module changes
 * behavior and the API runs in its normal (production) mode: Postgres, Redis,
 * S3 and strict JWT auth.
 *
 * In STANDALONE mode:
 *  - Prisma talks to SQLite at <repo>/data/cadline.db (schema.standalone.prisma)
 *  - files live on disk under <repo>/data/files (lib/localStorage.ts)
 *  - Redis is replaced by an in-memory stand-in (lib/memoryRedis.ts)
 *  - every request is authenticated as LOCAL_USER (middleware/auth.ts)
 *
 * See STANDALONE.md at the repo root.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STANDALONE = process.env.STANDALONE === 'true';

// Fail closed: STANDALONE disables authentication, so it must never run as a
// production deployment.
if (STANDALONE && process.env.NODE_ENV === 'production') {
  throw new Error(
    'STANDALONE=true disables authentication and cannot be combined with NODE_ENV=production.'
  );
}

/** Repo root: this file is apps/api/{src,dist}/lib/standalone.{ts,js}. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const STANDALONE_DATA_DIR = path.resolve(
  process.env.STANDALONE_DATA_DIR ?? path.join(REPO_ROOT, 'data')
);
export const STANDALONE_DB_PATH = path.join(STANDALONE_DATA_DIR, 'cadline.db');
export const STANDALONE_FILES_DIR = path.join(STANDALONE_DATA_DIR, 'files');

/** The fixed identity every STANDALONE request runs as (created by the boot seed). */
export const LOCAL_ORGANIZATION = {
  id: 'local-org',
  name: 'Local Workspace',
  slug: 'local',
} as const;

export const LOCAL_USER = {
  id: 'local-user',
  email: 'local@cadline.dev',
  name: 'Local Dev',
  role: 'OWNER',
  organizationId: LOCAL_ORGANIZATION.id,
} as const;
