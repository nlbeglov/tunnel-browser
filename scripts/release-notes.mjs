// Extracts the CHANGELOG.md section of one version into build/release-notes.md, which
// electron-builder puts into the GitHub release and the update info the app shows.
//   node scripts/release-notes.mjs [version]     (default: package.json version)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function sectionFor(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const notes = sectionFor(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (!notes) {
    console.error(`В CHANGELOG.md нет раздела для версии ${version}`);
    process.exit(1);
  }
  writeFileSync(join(root, 'build', 'release-notes.md'), `${notes}\n`);
  console.log(`build/release-notes.md для ${version}:\n\n${notes}`);
}
