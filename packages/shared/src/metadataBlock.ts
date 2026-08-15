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

/**
 * Why a document's leading frontmatter block cannot be parsed, or `null` when
 * there is none or it is fine.
 *
 * `splitFrontmatter` finds the block boundary by scanning for a column-0
 * delimiter, which is what YAML and Obsidian both require but is still a scan
 * rather than a parse. One shape defeats it: a `---` at column 0 inside a
 * multi-line *quoted* scalar. YAML forbids that — the parser rejects the whole
 * block — so it can only occur in frontmatter that is already malformed, but
 * the consequence if it does is severe. The split lands mid-block and every
 * property after it becomes body text, which publishes.
 *
 * The tell is that the *truncated* half does not parse either: cutting
 * `desc: "line` off from its closing quote leaves invalid YAML. So a caller
 * that is about to treat everything after the split as publishable body can
 * ask this first and refuse, rather than trusting a boundary it derived from a
 * scan. Callers that only read an artifact they generated themselves do not
 * need it — the boundary there is one they wrote.
 */
export function frontmatterParseError(md: string): string | null {
  const { frontmatter } = splitFrontmatter(md);

  // A document that *opens* a block but has no closing delimiter at column 0
  // is not "no frontmatter" — it is a block whose end we could not find, and
  // `splitFrontmatter` hands the whole thing back as body, so every key in it
  // publishes. Requiring the delimiter at column 0 (see markdown.ts) made this
  // reachable in one more way than before: a block closed only by an *indented*
  // `---` used to split there and now does not. Both shapes end up here.
  if (frontmatter === null) {
    return opensFrontmatter(md)
      ? 'the document opens a frontmatter block that is never closed by `---` at the start of a line'
      : null;
  }

  if (frontmatter.trim() === '') return null;
  try {
    parseYaml(frontmatter);
    return null;
  } catch (err) {
    return (err as Error).message.split('\n')[0] ?? 'invalid YAML';
  }
}

/**
 * Whether a document opens a frontmatter block, by the same test
 * `splitFrontmatter` uses to decide there is one to look for.
 */
function opensFrontmatter(md: string): boolean {
  if (!md.startsWith('---')) return false;
  const firstLineEnd = md.indexOf('\n');
  if (firstLineEnd === -1) return false;
  return md.slice(0, firstLineEnd).trim() === '---';
}

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
/**
 * `share_id`s this staged body links to, via the `/n/<id>` form that §3.7
 * step 3 rewrites published wikilinks into.
 *
 * Exists to catch the one way a published page goes wrong without its own note
 * changing: unpublish A, and every note linking to A keeps a `/n/<A>` link that
 * now 404s. Stale cannot see it — Stale compares a note's *own* source hash,
 * and removing a different note does not touch that — so nothing prompts the
 * re-stage that would fix it. §1 ranks seeing exactly what is public second,
 * and this is a case where you could not.
 *
 * Deliberately scans the staged artifact rather than vault sources: the
 * question is what the *published page* points at, which is only answerable
 * from what was published. Anchors and the `.md` download suffix are stripped
 * so `/n/<id>#heading` and `/n/<id>.md` both count as the same target.
 */
export function extractNoteLinks(body: string): string[] {
  const found = new Set<string>();
  // Markdown links, HTML hrefs, and bare occurrences alike — a published link
  // is `/n/<id>` however it is spelled, and over-collecting here only risks a
  // false "dangling" report, which is visible and harmless, where
  // under-collecting silently misses a dead link.
  for (const m of body.matchAll(/\/n\/([0-9a-hjkmnp-tv-z]{16})/g)) {
    const id = m[1];
    if (id) found.add(id);
  }
  return [...found].sort();
}

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
