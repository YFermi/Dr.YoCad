import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { STANDALONE, STANDALONE_DB_PATH } from './standalone.js';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

const log: Array<'warn' | 'error'> =
  process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'];

/**
 * STANDALONE: the SQLite client generated from prisma/schema.standalone.prisma
 * into node_modules/.prisma-standalone/client (scripts/standalone/prepare.mjs).
 * Same models as the Postgres schema, so it is typed as the regular client.
 */
function createStandaloneClient(): PrismaClient {
  const require = createRequire(import.meta.url);
  // apps/api/{src,dist}/lib -> apps/api/node_modules/.prisma-standalone/client
  const generated = require('../../node_modules/.prisma-standalone/client') as {
    PrismaClient: new (options: Record<string, unknown>) => PrismaClient;
  };
  return new generated.PrismaClient({
    log,
    // Same form as scripts/standalone/prepare.mjs (sqliteUrl) uses for db push.
    datasourceUrl: `file:${STANDALONE_DB_PATH.replace(/\\/g, '/')}`,
  });
}

export const prisma =
  globalForPrisma.prisma ??
  (STANDALONE ? createStandaloneClient() : new PrismaClient({ log }));

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
