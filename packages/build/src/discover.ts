/**
 * Discover (§5.3).
 *
 * Glob `published/*.md`, parse each file's metadata block, derive the asset
 * list per document by scanning image references.
 *
 * No vault scanning, no link resolution, no manifest cross-check — there is no
 * manifest file to disagree with. The corpus on disk at this commit *is* the
 * desired state.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractAssetReferences, parseStagedFile, stagedHash } from '@notes/shared';
import type { StagedDocument } from '@notes/shared';

export const ASSET_DIR = '_assets';

export class DiscoveryError extends Error {
  constructor(
    summary: string,
    readonly failures: string[] = [],
  ) {
    // The failures go in the message, not only in the field. A build that
    // stops with "discover failed on 1 problem" and nothing else has told you
    // that something is wrong and nothing about what — and this is the error
    // most likely to be read out of a log by someone who did not write it.
    super(failures.length > 0 ? `${summary}:\n${failures.map((f) => `  · ${f}`).join('\n')}` : summary);
    this.name = 'DiscoveryError';
  }
}

export interface DiscoveryResult {
  documents: StagedDocument[];
  /** Basenames present in `_assets/`, e.g. `a1b2c3d4e5f6a7b8.png`. */
  assetFiles: string[];
  publishedDir: string;
  assetDir: string;
}

export async function discover(publishedDir: string): Promise<DiscoveryResult> {
  const dir = path.resolve(publishedDir);

  // A missing `published/` directory is an error, not an empty desired state
  // (§5.6). Only an existing-but-empty directory means "nothing should be
  // published" — the distinction between a deliberate empty corpus and a
  // broken checkout is the whole point.
  let stats;
  try {
    stats = await stat(dir);
  } catch {
    throw new DiscoveryError(
      `published/ is missing at ${dir}. This is an error, not an empty desired state — ` +
        `an empty corpus is an existing directory with no files in it. Most likely the ` +
        `checkout is broken, or this commit predates the pipeline (§5.6).`,
    );
  }
  if (!stats.isDirectory()) {
    throw new DiscoveryError(`${dir} exists but is not a directory`);
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const markdown = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();

  const assetDir = path.join(dir, ASSET_DIR);
  const assetFiles = await listAssets(assetDir);
  const assetSet = new Set(assetFiles);

  const failures: string[] = [];
  const documents: StagedDocument[] = [];
  const seen = new Map<string, string>();

  for (const name of markdown) {
    const file = path.join(dir, name);
    const raw = await readFile(file, 'utf8');

    let parsed;
    try {
      parsed = parseStagedFile(raw, name);
    } catch (err) {
      failures.push((err as Error).message);
      continue;
    }

    const { metadata, body } = parsed;

    // The corpus is flat and share_id-named (§3.3). A mismatch means the
    // panel (which reads the filename) and the reconciler (which reads the
    // metadata) would disagree about which page a file controls.
    const expected = `${metadata.share_id}.md`;
    if (name !== expected) {
      failures.push(`${name}: metadata block claims share_id ${metadata.share_id}, expected file name ${expected}`);
      continue;
    }

    const previous = seen.get(metadata.share_id);
    if (previous) {
      failures.push(`duplicate share_id ${metadata.share_id} in ${previous} and ${name}`);
      continue;
    }
    seen.set(metadata.share_id, name);

    const assets = extractAssetReferences(body);
    for (const asset of assets) {
      if (!assetSet.has(asset)) {
        failures.push(`${name}: references ${ASSET_DIR}/${asset}, which is not in the corpus`);
      }
    }

    documents.push({
      metadata,
      body,
      raw,
      stagedHash: await stagedHash(raw),
      assets,
    });
  }

  if (failures.length > 0) {
    throw new DiscoveryError(
      `discover failed on ${failures.length} problem${failures.length === 1 ? '' : 's'}`,
      failures,
    );
  }

  return { documents, assetFiles, publishedDir: dir, assetDir };
}

async function listAssets(assetDir: string): Promise<string[]> {
  try {
    const entries = await readdir(assetDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    // No assets is normal.
    return [];
  }
}
