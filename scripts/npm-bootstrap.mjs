// Root `postinstall`. Lets `npm install` set up this pnpm workspace with no
// global pnpm: npm does not understand pnpm-workspace.yaml or `workspace:*`, so
// we hand off to the pnpm version pinned in package.json#packageManager, run
// through npx (ships with npm). Under pnpm itself this is a no-op.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const userAgent = process.env.npm_config_user_agent ?? '';
if (userAgent.startsWith('pnpm/')) process.exit(0);

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { packageManager } = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager ?? '')) {
  console.error(`[bootstrap] package.json#packageManager must be pnpm@x.y.z, got ${packageManager}`);
  process.exit(1);
}

// npm prunes pnpm's hoisted root links (tsx, concurrently) as extraneous before
// this script runs. Dropping pnpm's up-to-date marker makes it re-link them
// (fast: the store and node_modules/.pnpm are already in place).
fs.rmSync(path.join(repoDir, 'node_modules', '.pnpm-workspace-state-v1.json'), { force: true });

console.log(`[bootstrap] npm install -> ${packageManager} install (workspace dependencies)`);
const result = spawnSync('npx', ['--yes', packageManager, 'install'], {
  cwd: repoDir,
  stdio: 'inherit',
  // npx is a .cmd shim on Windows; arguments are fixed strings, no user input.
  shell: process.platform === 'win32',
  env: { ...process.env, npm_config_user_agent: '' },
});
process.exit(result.status ?? 1);
