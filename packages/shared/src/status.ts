/**
 * Status derivation (§3.4).
 *
 * All nine statuses come from three hashes — source, staged, remote — plus a
 * frontmatter scan and, for the Staged/Building split, local git state. No
 * local state file is required, so the panel is correct immediately after a
 * fresh install or a sync from another machine.
 *
 * This lives in `shared` rather than the plugin so it can be tested without
 * an Obsidian runtime, and so the rules exist in exactly one place.
 */

import type { NoteStatus, ValidationIssue } from './types.js';

export interface StatusInput {
  shareId: string;

  /**
   * How many source notes in the vault carry this share_id. Two or more is a
   * Conflict, detected on scan rather than on stage — "Make a copy" is one
   * click and copies frontmatter with it, and validating uniqueness only at
   * stage time would let the duplicate sit undetected for months.
   */
  sourceNotes: number;

  /** `publish: true` on the source note. */
  publishFlag: boolean;

  /** Hash of the source note's body + allowlisted properties, right now. */
  currentSourceHash?: string;

  /** `source_hash` recorded in the staged file when it was written. */
  stagedSourceHash?: string;

  /** sha256 of `.publish-pending/<id>.md`, if one exists. */
  pendingHash?: string;

  /** sha256 of `published/<id>.md` in the working tree, if one exists. */
  publishedHash?: string;

  /**
   * Whether `published/<id>.md` as it currently stands has reached upstream.
   * This is the entire reason the panel can separate Staged from Building.
   */
  pushed: boolean;

  /** `stagedHash` the worker reports for this id, if remote state is known. */
  remoteHash?: string;

  /**
   * Whether remote state was successfully read at all. Without it a pushed
   * note reports Building rather than falsely reporting Live.
   */
  remoteKnown: boolean;

  issues?: ValidationIssue[];
}

export interface StatusResult {
  status: NoteStatus;
  /** Present and current in KV. */
  live: boolean;
  /** The staged bytes have reached upstream. */
  pushed: boolean;
  /** Source has moved on since it was staged. */
  stale: boolean;
  /** Local work exists that has not been materialised into `published/`. */
  hasPending: boolean;
  /** One line explaining the status, for the detail pane. */
  explanation: string;
}

export function deriveStatus(input: StatusInput): StatusResult | null {
  const issues = input.issues ?? [];
  const hasPending = input.pendingHash !== undefined;
  const localHash = input.pendingHash ?? input.publishedHash;
  const live = input.remoteKnown && input.remoteHash !== undefined;
  const stale =
    input.currentSourceHash !== undefined &&
    input.stagedSourceHash !== undefined &&
    input.currentSourceHash !== input.stagedSourceHash;

  const base = { live, pushed: input.pushed, stale, hasPending };

  if (issues.some((i) => i.severity === 'error')) {
    return {
      ...base,
      status: 'issue',
      explanation: issues.find((i) => i.severity === 'error')?.message ?? 'validation failed',
    };
  }

  if (input.sourceNotes > 1) {
    return {
      ...base,
      status: 'conflict',
      explanation: `${input.sourceNotes} notes claim this share_id — clear the id from the copy`,
    };
  }

  if (input.sourceNotes === 0) {
    // Two flavours, and only one of them needs the manifest (§3.4). A staged
    // file no note claims is visible from disk alone, and is the dangerous
    // one: CI will keep republishing it forever and no note will ever remind
    // you it exists.
    if (localHash !== undefined) {
      return {
        ...base,
        status: 'orphan',
        explanation: 'a staged file exists but no note carries this share_id',
      };
    }
    if (live) {
      return {
        ...base,
        status: 'orphan',
        explanation: 'live in KV with no staged file and no source note — KV and the repo have diverged',
      };
    }
    return null;
  }

  if (localHash === undefined) {
    if (input.publishFlag) {
      return {
        ...base,
        status: 'unstaged',
        explanation: 'marked for publishing but nothing is staged — re-stage it',
      };
    }
    if (live) {
      return {
        ...base,
        status: 'removing',
        explanation: 'staged file deleted; the next build takes the page down',
      };
    }
    return null;
  }

  if (stale) {
    return {
      ...base,
      status: 'stale',
      explanation: 'the note has been edited since it was staged',
    };
  }

  if (live && input.remoteHash === localHash) {
    return { ...base, status: 'live', explanation: 'published and current' };
  }

  // Pending work that has not been materialised into `published/` yet, or a
  // published file that differs from what is upstream, is Staged: the next
  // action is yours.
  const materialized = !hasPending || input.pendingHash === input.publishedHash;
  if (!materialized || !input.pushed) {
    return { ...base, status: 'staged', explanation: 'staged locally — press Push' };
  }

  return {
    ...base,
    status: 'building',
    explanation: input.remoteKnown
      ? 'pushed; waiting on CI, or the build failed'
      : 'pushed; remote state unknown from here',
  };
}

/** Display order for the panel's groups, most-actionable first. */
export const STATUS_ORDER: readonly NoteStatus[] = [
  'issue',
  'conflict',
  'orphan',
  'unstaged',
  'stale',
  'staged',
  'building',
  'removing',
  'live',
];

export const STATUS_LABELS: Record<NoteStatus, string> = {
  issue: 'Issues',
  conflict: 'Conflicts',
  orphan: 'Orphans',
  unstaged: 'Unstaged',
  stale: 'Stale',
  staged: 'Staged',
  building: 'Building',
  removing: 'Removing',
  live: 'Live',
};
