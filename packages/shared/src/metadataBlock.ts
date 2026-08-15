/**
 * The staged-file metadata block (§3.3).
 *
 * Each staged file is self-describing. There is no `index.json`, which is what
 * removed the multi-device conflict entirely: two machines staging different
 * notes touch disjoint files, so git has nothing to conflict over. Two
 * machines staging the *same* note produce a normal single-file conflict with
 * readable content, which is the best available outcome.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { splitFrontmatter } from './markdown.js';
import { PUBLISHED_METADATA_KEYS } from './properties.js';
import { isShareId } from './shareId.js';
import type { StagedMetadata } from './types.js';

export class StagedFileError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
    this.name = 'StagedFileError';
  }
}

/**
 * Key order is fixed rather than object-order-dependent, so that restaging an
 * unchanged note produces byte-identical output and therefore an unchanged
 * `stagedHash`. Reconciliation skips unchanged documents on hash equality
 * (§5.6), so unstable serialisation would quietly burn the KV write quota.
 */
const KEY_ORDER: readonly (keyof StagedMetadata)[] = [
  'share_id',
  'title',
  'source_hash',
  'staged',
  'indexable',
  'download',
];

export function serializeStagedFile(metadata: StagedMetadata, body: string): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) ordered[key] = metadata[key];

  const yaml = stringifyYaml(ordered, { lineWidth: 0 }).trimEnd();
  const trimmedBody = body.replace(/^\n+/, '').replace(/\s+$/, '');
  return `---\n${yaml}\n---\n\n${trimmedBody}\n`;
}

export interface ParsedStagedFile {
  metadata: StagedMetadata;
  body: string;
}

export function parseStagedFile(raw: string, file?: string): ParsedStagedFile {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === null) {
    throw new StagedFileError('no metadata block — a staged file must begin with one', file);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch (err) {
    throw new StagedFileError(`metadata block does not parse: ${(err as Error).message}`, file);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StagedFileError('metadata block is not a mapping', file);
  }

  const record = parsed as Record<string, unknown>;

  // Allowlist enforcement at the parse boundary, not only at write time. CI
  // re-verifies what the plugin already did (§3.2) because frontmatter leakage
  // is one of the two failures with the worst consequences.
  const extras = Object.keys(record).filter((k) => !PUBLISHED_METADATA_KEYS.includes(k));
  if (extras.length > 0) {
    throw new StagedFileError(
      `metadata block carries keys outside the allowlist: ${extras.join(', ')}`,
      file,
    );
  }

  const shareId = record['share_id'];
  if (!isShareId(shareId)) {
    throw new StagedFileError(`share_id missing or malformed: ${JSON.stringify(shareId)}`, file);
  }

  const sourceHashValue = record['source_hash'];
  if (typeof sourceHashValue !== 'string' || sourceHashValue.length === 0) {
    // A hex hash can look like scientific notation to YAML: `3e91` parses as
    // a number, not a string. `serializeStagedFile` quotes those, so this only
    // arises in a hand-edited file — and "source_hash missing" would be a
    // baffling thing to read when the line is plainly there.
    throw new StagedFileError(
      sourceHashValue === undefined
        ? 'source_hash missing'
        : `source_hash must be a string, got ${typeof sourceHashValue} (${String(sourceHashValue)}). ` +
          `A hex value like 3e91 is scientific notation to YAML — quote it.`,
      file,
    );
  }

  const staged = record['staged'];
  const stagedIso =
    staged instanceof Date
      ? staged.toISOString()
      : typeof staged === 'string'
        ? staged
        : undefined;
  if (!stagedIso) throw new StagedFileError('staged timestamp missing', file);

  const title = record['title'];
  if (typeof title !== 'string' || title.trim() === '') {
    throw new StagedFileError('title missing', file);
  }

  return {
    metadata: {
      share_id: shareId,
      title,
      source_hash: sourceHashValue,
      staged: stagedIso,
      indexable: record['indexable'] === true,
      // Default true, per §4.1 — absence means "offer the download".
      download: record['download'] !== false,
    },
    body,
  };
}

/**
 * Asset references in a staged body.
 *
 * Derived by scanning rather than recorded in the metadata block, so a
 * hand-edited staged file cannot claim assets it does not use, or omit ones it
 * does. §5.3 fails the build when a referenced asset is missing from
 * `_assets/`.
 */
export function extractAssetReferences(body: string): string[] {
  const found = new Set<string>();
  // Markdown images and links pointing into the local asset directory. The
  // plugin has already rewritten Obsidian embeds into standard syntax (§3.7).
  const re = /!?\[[^\]]*\]\(\s*<?((?:\.\/)?_assets\/[^)>\s]+)>?[^)]*\)/g;
  for (const m of body.matchAll(re)) {
    const path = (m[1] ?? '').replace(/^\.\//, '');
    const base = path.slice('_assets/'.length);
    if (base) found.add(decodeURIComponent(base));
  }
  // HTML <img src="_assets/…"> survives markdown passthrough, so it counts too.
  const html = /<img[^>]+src\s*=\s*["']\s*(?:\.\/)?_assets\/([^"']+)["']/gi;
  for (const m of body.matchAll(html)) {
    const base = (m[1] ?? '').trim();
    if (base) found.add(decodeURIComponent(base));
  }
  return [...found].sort();
}
