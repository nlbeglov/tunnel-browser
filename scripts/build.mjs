// Bundles main, preload and renderer with esbuild into out/.
//   node scripts/build.mjs           production bundle
//   node scripts/build.mjs --smoke   also includes the end-to-end self-test (never shipped)

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');
const smoke = process.argv.includes('--smoke');

/** owner/repo for update checks and version history: CI env, package.json, or git remote. */
function detectRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const fromPkg = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const candidates = [fromPkg];
  try {
    candidates.push(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  } catch {
    /* no remote yet */
  }
  for (const c of candidates) {
    const m = c && /github\.com[:/]([^/\s]+)\/([^/\s]+?)(\.git)?\s*$/.exec(c.trim());
    if (m) return `${m[1]}/${m[2]}`;
  }
  return '';
}

const repo = detectRepo();
rmSync(out, { recursive: true, force: true });

const common = {
  bundle: true,
  sourcemap: smoke ? 'inline' : false,
  minify: !smoke,
  logLevel: 'warning',
  legalComments: 'none',
  define: {
    __APP_REPO__: JSON.stringify(repo),
    __SMOKE__: JSON.stringify(smoke),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
};

await Promise.all([
  build({
    ...common,
    entryPoints: [join(root, 'src/main/index.ts')],
    outfile: join(out, 'main/index.js'),
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron', 'electron-updater'],
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src/preload/index.ts')],
    outfile: join(out, 'preload/index.js'),
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src/renderer/main.tsx')],
    outfile: join(out, 'renderer/app.js'),
    platform: 'browser',
    target: 'chrome130',
    format: 'iife',
    jsx: 'automatic',
  }),
]);

mkdirSync(join(out, 'renderer'), { recursive: true });
copyFileSync(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html'));
copyFileSync(join(root, 'src/renderer/styles.css'), join(out, 'renderer/styles.css'));
console.log(`Сборка готова${smoke ? ' (с самопроверкой)' : ''}. Репозиторий для обновлений: ${repo || 'не задан'}`);
