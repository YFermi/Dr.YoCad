// Preloaded with `node --import ./scripts/load-env.mjs` (also works through tsx) so
// `pnpm --filter api dev`, `prisma migrate deploy` and `seed` see the same variables.
//
// Precedence (first wins): real environment > apps/api/.env > <repo>/.env >
// <repo>/.env.example (development only). The .env.example fallback is skipped
// entirely when NODE_ENV=production and never supplies JWT_*_SECRET values, so
// the server still refuses to start in production without real secrets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(apiDir, '../..');

function applyFile(file, skip = () => false) {
  if (!fs.existsSync(file)) return;
  const parsed = dotenv.parse(fs.readFileSync(file));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined && !skip(key)) process.env[key] = value;
  }
}

applyFile(path.join(apiDir, '.env'));
applyFile(path.join(repoDir, '.env'));
if (process.env.NODE_ENV !== 'production') {
  applyFile(path.join(repoDir, '.env.example'), (key) => /^JWT_.*_SECRET$/.test(key));
}
