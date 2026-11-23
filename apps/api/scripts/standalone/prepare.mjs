// STANDALONE preparation (run before the API starts in STANDALONE mode):
//
//  0. Generates the default @prisma/client if missing or stale: route code
//     imports its enums (FileStatus, UserRole, ...) even in STANDALONE mode.
//  1. Derives prisma/schema.standalone.prisma from prisma/schema.prisma: the
//     same models, with `provider = "sqlite"` and a client generated into
//     node_modules/.prisma-standalone/client. Only the generator and datasource
//     blocks differ, so the two schemas cannot drift.
//  2. Generates that client (skipped when the schema hash is unchanged).
//  3. Creates <repo>/data/cadline.db with `prisma db push` (skipped when the
//     database already matches the schema hash).
//
// Quiet on success; prints the Prisma output only when a step fails.
// Demo data is seeded by the API itself on first boot (src/lib/standaloneSeed.ts).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoDir = path.resolve(apiDir, '../..');
const dataDir = path.resolve(process.env.STANDALONE_DATA_DIR ?? path.join(repoDir, 'data'));
const dbPath = path.join(dataDir, 'cadline.db');
const sourceSchema = path.join(apiDir, 'prisma', 'schema.prisma');
const standaloneSchema = path.join(apiDir, 'prisma', 'schema.standalone.prisma');
const clientDir = path.join(apiDir, 'node_modules', '.prisma-standalone', 'client');
const prismaCli = path.join(apiDir, 'node_modules', 'prisma', 'build', 'index.js');

const HEADER = `// GENERATED from schema.prisma by apps/api/scripts/standalone/prepare.mjs.
// Do not edit: change schema.prisma; \`npm run dev:standalone\` regenerates this.
// Same models as schema.prisma, stored in SQLite for STANDALONE mode (STANDALONE.md).

generator client {
  provider = "prisma-client-js"
  output   = "../node_modules/.prisma-standalone/client"
}

datasource db {
  provider = "sqlite"
  url      = env("STANDALONE_DATABASE_URL")
}
`;

function deriveSchema() {
  const source = fs.readFileSync(sourceSchema, 'utf8').replace(/\r\n/g, '\n');
  // Drop the generator and datasource blocks; keep enums and models verbatim.
  const body = source
    .replace(/^generator\s+\w+\s*\{[^}]*\}\n*/m, '')
    .replace(/^datasource\s+\w+\s*\{[^}]*\}\n*/m, '');
  if (/^(generator|datasource)\s/m.test(body)) {
    throw new Error('schema.prisma has more than one generator/datasource block');
  }
  return `${HEADER}\n${body}`;
}

function fail(step, result) {
  console.error(`[standalone] ${step} failed:`);
  if (result.error) console.error(result.error);
  process.stderr.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exit(1);
}

function prisma(args, env = {}, schemaFile = standaloneSchema) {
  return spawnSync(process.execPath, [prismaCli, ...args, '--schema', schemaFile], {
    cwd: apiDir,
    env: { ...process.env, ...env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    encoding: 'utf8',
  });
}

// SQLite URL in the same form src/lib/prisma.ts passes as datasourceUrl.
export function sqliteUrl(file) {
  return `file:${file.replace(/\\/g, '/')}`;
}

// 0. Default client: prisma generate copies schema.prisma next to the generated
//    client, so an identical copy means it is current.
const clientPkgDir = path.dirname(
  createRequire(path.join(apiDir, 'package.json')).resolve('@prisma/client/package.json')
);
const generatedSchema = path.join(clientPkgDir, '..', '..', '.prisma', 'client', 'schema.prisma');
if (
  !fs.existsSync(generatedSchema) ||
  fs.readFileSync(generatedSchema, 'utf8') !== fs.readFileSync(sourceSchema, 'utf8')
) {
  const result = prisma(['generate', '--no-hints'], {}, sourceSchema);
  if (result.status !== 0) fail('prisma generate (default client)', result);
}

const schema = deriveSchema();
// Compare ignoring CRLF: git on Windows may check the committed file out with CRLF.
if (
  !fs.existsSync(standaloneSchema) ||
  fs.readFileSync(standaloneSchema, 'utf8').replace(/\r\n/g, '\n') !== schema
) {
  fs.writeFileSync(standaloneSchema, schema);
}

const prismaVersion = JSON.parse(
  fs.readFileSync(path.join(apiDir, 'node_modules', 'prisma', 'package.json'), 'utf8')
).version;
const hash = crypto.createHash('sha256').update(schema).update(prismaVersion).digest('hex');

const clientHashFile = path.join(clientDir, '.cadline-schema-hash');
if (!fs.existsSync(clientHashFile) || fs.readFileSync(clientHashFile, 'utf8') !== hash) {
  const result = prisma(['generate', '--no-hints']);
  if (result.status !== 0) fail('prisma generate (SQLite client)', result);
  fs.writeFileSync(clientHashFile, hash);
}

fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
const dbHashFile = path.join(dataDir, '.schema-hash');
if (!fs.existsSync(dbPath) || !fs.existsSync(dbHashFile) || fs.readFileSync(dbHashFile, 'utf8') !== hash) {
  const result = prisma(['db', 'push', '--skip-generate'], {
    STANDALONE_DATABASE_URL: sqliteUrl(dbPath),
  });
  if (result.status !== 0) {
    console.error(
      `[standalone] Could not create/update ${dbPath}. If the schema changed in a way that ` +
        'would drop data, delete the data/ folder to reset (see STANDALONE.md).'
    );
    fail('prisma db push (SQLite)', result);
  }
  fs.writeFileSync(dbHashFile, hash);
}
