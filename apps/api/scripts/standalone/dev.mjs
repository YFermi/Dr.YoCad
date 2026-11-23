// `npm run dev:standalone` (API half): STANDALONE=true, prepares the SQLite
// client + database (prepare.mjs), then runs the API in tsx watch mode.
// No Docker, Postgres, Redis or S3, and no .env file needed.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

process.env.STANDALONE = 'true';
process.env.NODE_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'warn';
// Auth is bypassed in STANDALONE, but the JWT module still wants signing keys;
// per-process random ones avoid the "ephemeral secret" warning noise.
process.env.JWT_ACCESS_SECRET ??= crypto.randomBytes(32).toString('hex');
process.env.JWT_REFRESH_SECRET ??= crypto.randomBytes(32).toString('hex');

await import('./prepare.mjs');

const tsxCli = createRequire(path.join(apiDir, 'package.json')).resolve('tsx/cli');
const child = spawn(
  process.execPath,
  [tsxCli, 'watch', '--clear-screen=false', '--import', './scripts/load-env.mjs', 'src/server.ts'],
  { cwd: apiDir, stdio: 'inherit', env: process.env }
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
