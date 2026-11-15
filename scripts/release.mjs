// Cuts a release:
//   npm run release -- patch | minor | major | 1.2.3   [--push]
//
// 1. checks the working tree is clean and you are on main;
// 2. moves the "Не выпущено" section of CHANGELOG.md under the new version;
// 3. bumps package.json, commits "release: vX.Y.Z" and tags vX.Y.Z;
// 4. you push (GitHub Desktop: "Push origin" sends the commit and the tag together;
//    or pass --push to push from this terminal). GitHub Actions then builds the
//    installer and publishes the release; installed apps offer a one-click update.

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
if (git('tag', '--list', `v${next}`)) fail(`тег v${next} уже существует`);

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
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: root,
  stdio: 'ignore',
  shell: process.platform === 'win32',
});

git('add', 'CHANGELOG.md', 'package.json', 'package-lock.json');
git('commit', '-m', `release: v${next}`);
git('tag', '-a', `v${next}`, '-m', `v${next}`);
console.log(`✔ версия ${next}: коммит и тег v${next} созданы`);

if (push) {
  git('push', 'origin', 'main', '--follow-tags');
  console.log('✔ отправлено на GitHub — сборка релиза запустится автоматически (вкладка Actions)');
} else {
  console.log('Чтобы опубликовать: GitHub Desktop → «Push origin» (коммит и тег уйдут вместе)');
  console.log('или из терминала: git push origin main --follow-tags');
}
