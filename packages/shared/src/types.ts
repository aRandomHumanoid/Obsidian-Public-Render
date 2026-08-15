import type { SCHEMA_VERSION } from './schema.js';

/**
 * The metadata block at the head of `published/<share_id>.md` (§3.3).
 *
 * There is no manifest file. Each staged file carries its own metadata, which
 * is what removed the multi-device conflict: two machines staging different
 * notes touch disjoint files, so git has nothing to conflict over.
 *
 * Everything else is derived — `stagedHash` from the file bytes, the asset list
 * by scanning image references in the body, the published set from the
 * directory listing.
 */
export interface StagedMetadata {
  share_id: string;
  title: string;
  /**
   * Hash of body + allowlisted properties, NOT raw file bytes (§3.3).
   *
   * Staging writes `publish: true` and possibly `share_id` back to the source
   * note *after* computing this, so hashing the whole file would mark every
   * note Stale the instant it was first staged. Excluding unrelated properties
   * also stops tag edits, `updated` timestamps and Obsidian's own frontmatter
   * rewrites from producing false Stale — none of which change what is
   * published.
   */
  source_hash: string;
  /** ISO 8601, UTC. */
  staged: string;
  /** Allow search engines. Default false. */
  indexable: boolean;
  /** Offer a .md download. Default true. */
  download: boolean;
}

/** A staged file, parsed. */
export interface StagedDocument {
  metadata: StagedMetadata;
  /** Body only — the metadata block removed. */
  body: string;
  /** The complete file bytes as written, which is what `stagedHash` covers. */
  raw: string;
  /** sha256 of `raw`. What the plugin verifies against `X-Staged-Hash`. */
  stagedHash: string;
  /** Asset basenames referenced by the body, e.g. `a1b2c3d4e5f6a7b8.png`. */
  assets: string[];
}

/**
 * The value stored at `doc:<share_id>` (§4.2).
 */
export interface DocRecord {
  v: typeof SCHEMA_VERSION;
  title: string;
  html: string;
  /** Metadata block stripped, asset URLs absolute. */
  md: string;
  updated: string;
  /** sha256(stagedMarkdown + renderConfigVersion) — belongs to the build. */
  contentHash: string;
  /** sha256(stagedMarkdown) — what the plugin verifies. */
  stagedHash: string;
  indexable: boolean;
  download: boolean;
}

/**
 * KV *key* metadata on `doc:<share_id>` (§4.2).
 *
 * `list` returns this without reading values, which is what lets §5.6
 * reconcile from live state in a single call. Without it, getting hashes would
 * mean either reading every document or consulting the stored manifest — and
 * the latter would quietly reintroduce the drift dependency the reconciler
 * exists to remove.
 *
 * Cloudflare caps key metadata at 1024 bytes; three short fields is nowhere
 * near it.
 */
export interface DocKeyMetadata {
  v: number;
  contentHash: string;
  stagedHash: string;
}

export interface ManifestEntry {
  contentHash: string;
  stagedHash: string;
  updated: string;
  /** Published R2 object basenames, e.g. `a1b2c3d4e5f6a7b8.webp`. */
  assets: string[];
}

/**
 * The `manifest` key (§4.2).
 *
 * A cache with no role in the build. It exists so the plugin can get live
 * state in one request via `/_manifest` instead of a HEAD per note. The build
 * writes it and never reads it. Losing or corrupting it costs a degraded
 * plugin refresh and nothing else — never a stranded document, never a wrong
 * build. It contains no vault paths.
 */
export interface Manifest {
  v: number;
  generated: string;
  renderConfigVersion: number;
  docs: Record<string, ManifestEntry>;
}

/** Statuses the publish panel derives (§3.4). */
export type NoteStatus =
  | 'live'
  | 'staged'
  | 'building'
  | 'stale'
  | 'unstaged'
  | 'removing'
  | 'orphan'
  | 'conflict'
  | 'issue';

/** A wikilink dropped during staging, surfaced in the detail pane (§3.4, §3.7). */
export interface DroppedLink {
  /** The raw link as it appeared, e.g. `[[Internal roadmap]]`. */
  raw: string;
  /** Resolved target path, when one existed. */
  target?: string;
  reason: 'unpublished' | 'unresolved' | 'alias-matches-title';
}

/** A validation failure that blocks staging (§3.7 step 1). */
export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}
