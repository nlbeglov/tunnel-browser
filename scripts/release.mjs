// Cuts a release:
//   npm run release -- patch | minor | major | 1.2.3   [--push]
//
// 1. checks the working tree is clean and you are on main;
// 2. moves the "Не выпущено" section of CHANGELOG.md under the new version;
// 3. bumps package.json and commits "release: vX.Y.Z";
// 4. you push the commit (GitHub Desktop: "Push origin"; or pass --push to push from this
//    terminal). GitHub Actions sees a version with no release yet, runs the tests, tags
//    the commit vX.Y.Z, builds the installer and publishes the release.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

const bump = process.argv[2];
const push = process.argv.includes('--push');
if (!bump) fail('укажите: patch, minor, major или номер версии (например 1.2.0)');

if (git('status', '--porcelain')) fail('есть незакоммиченные изменения — сначала закоммитьте их');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') fail(`релизы выпускаются из main, а вы в ${branch}`);

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [ma, mi, pa] = pkg.version.split('.').map(Number);
const next =
  bump === 'major' ? `${ma + 1}.0.0` : bump === 'minor' ? `${ma}.${mi + 1}.0` : bump === 'patch' ? `${ma}.${mi}.${pa + 1}` : bump;
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`некорректная версия: ${next}`);
try {
  git('fetch', '--tags', '--quiet', 'origin');
} catch {
  /* offline: rely on local tags */
}
if (git('tag', '--list', `v${next}`)) fail(`версия ${next} уже выпущена (есть тег v${next})`);

const clPath = join(root, 'CHANGELOG.md');
const changelog = readFileSync(clPath, 'utf8');
const marker = '## [Не выпущено]';
const at = changelog.indexOf(marker);
if (at < 0) fail(`в CHANGELOG.md нет раздела «${marker}»`);
const after = changelog.slice(at + marker.length);
const nextSection = after.search(/\n## \[/);
const unreleased = (nextSection < 0 ? after : after.slice(0, nextSection)).trim();
if (!unreleased) fail('раздел «Не выпущено» пуст — опишите, что изменилось в этой версии');

const today = new Date().toISOString().slice(0, 10);
const updated =
  changelog.slice(0, at) + `${marker}\n\n## [${next}] — ${today}\n\n${unreleased}\n` + (nextSection < 0 ? '' : after.slice(nextSection));
writeFileSync(clPath, updated);
pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
// Only the version fields change in the lockfile. Regenerating it with
// `npm install --package-lock-only` dropped other platforms' optional packages
// (npm bug), and `npm ci` on GitHub then refused the out-of-sync lockfile.
const lockPath = join(root, 'package-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
lock.version = next;
lock.packages[''].version = next;
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

git('add', 'CHANGELOG.md', 'package.json', 'package-lock.json');
git('commit', '-m', `release: v${next}`);
console.log(`✔ версия ${next}: коммит «release: v${next}» создан`);

if (push) {
  git('push', 'origin', 'main');
  console.log('✔ отправлено на GitHub — релиз соберётся автоматически (вкладка Actions → Release)');
} else {
  console.log('Чтобы выпустить: GitHub Desktop → «Push origin».');
  console.log('GitHub Actions прогонит тесты, поставит тег и опубликует релиз (вкладка Actions → Release).');
}
