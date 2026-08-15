/**
 * Generate the repo-root `manifest.json` and `versions.json` from the plugin's
 * own manifest.
 *
 * BRAT and Obsidian's own installer both look for `manifest.json` at the
 * *repository root*, which a monorepo does not naturally have — the real one
 * lives in `packages/plugin/`. Copying it by hand is the obvious approach and
 * the wrong one: the copy goes stale at the first version bump, and the
 * symptom is BRAT silently installing an older version than the release
 * contains, which is exactly the kind of drift nobody notices until someone
 * reports a bug that was fixed weeks ago.
 *
 * So the root file is generated, never edited, and `plugin.test.ts` asserts
 * the two agree. Running this is part of `npm run build`.
 *
 * `versions.json` maps plugin version → the minimum Obsidian version it needs,
 * so the installer can pick a compatible release for an older app. Existing
 * entries are preserved: it is a history, not a snapshot.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const sourcePath = new URL('packages/plugin/manifest.json', root);
const rootManifestPath = new URL('manifest.json', root);
const versionsPath = new URL('versions.json', root);

const manifest = JSON.parse(await readFile(sourcePath, 'utf8'));

for (const required of ['id', 'name', 'version', 'minAppVersion']) {
  if (!manifest[required]) {
    throw new Error(`packages/plugin/manifest.json is missing "${required}"`);
  }
}

// Key order is fixed so a rebuild of an unchanged manifest produces a
// byte-identical file and therefore an empty diff.
const KEY_ORDER = [
  'id',
  'name',
  'version',
  'minAppVersion',
  'description',
  'author',
  'authorUrl',
  'fundingUrl',
  'isDesktopOnly',
];

const ordered = {};
for (const key of KEY_ORDER) {
  if (manifest[key] !== undefined) ordered[key] = manifest[key];
}
for (const key of Object.keys(manifest)) {
  if (!(key in ordered)) ordered[key] = manifest[key];
}

await writeFile(rootManifestPath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');

let versions = {};
try {
  versions = JSON.parse(await readFile(versionsPath, 'utf8'));
} catch {
  // First run: there is no history yet.
}
versions[manifest.version] = manifest.minAppVersion;

const sorted = Object.fromEntries(
  Object.entries(versions).sort(([a], [b]) => compareSemver(a, b)),
);
await writeFile(versionsPath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');

/** Numeric-segment comparison, so 1.10.0 sorts after 1.9.0 rather than before. */
function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

console.log(
  `${fileURLToPath(rootManifestPath)}: ${manifest.id} ${manifest.version} (min app ${manifest.minAppVersion})`,
);