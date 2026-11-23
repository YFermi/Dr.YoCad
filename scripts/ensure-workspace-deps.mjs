import fs from 'node:fs';
import { execSync } from 'node:child_process';

const requiredWorkspacePackages = [
  'apps/api/node_modules/@gltf-transform/core',
  'apps/web/node_modules/three',
  'apps/web/node_modules/three-mesh-bvh',
];

const missing = requiredWorkspacePackages.filter((pkgPath) => !fs.existsSync(pkgPath));

if (missing.length > 0) {
  console.log('[cadline] Workspace dependencies missing; running pnpm install...');
  execSync('corepack pnpm install --no-frozen-lockfile', { stdio: 'inherit' });
}
