/**
 * Reconcile (§5.6).
 *
 * The build is a **reconciler, not a differ**. Desired state is `published/`
 * at the commit being built. Actual state is read from KV directly —
 * `list({ prefix: 'doc:' })`, whose returned key metadata carries
 * `contentHash`, `stagedHash` and `v` — rather than remembered from a stored
 * manifest. Converge one to the other.
 *
 *     desired = { share_id → contentHash }   from published/ at this commit
 *     actual  = { share_id → contentHash }   from KV.list metadata, values never read
 *
 *     write  = desired − actual, plus any share_id whose contentHash differs
 *     delete = actual − desired
 *     skip   = everything else, plus anything whose live `v` exceeds this build's
 *
 * This distinction is what makes the system tolerant of history rewriting
 * (§5.9). A stored manifest is a *memory* of what a previous build did, and
 * memories drift — they can be deleted, restored from a different environment,
 * or written by a build that then crashed. Enumerating KV asks the only
 * question that matters: what is actually being served right now?
 */

import { SCHEMA_VERSION, contentHash } from '@notes/shared';
import type { DocKeyMetadata, StagedDocument } from '@notes/shared';
import type { KvListed } from './kv.js';
import type { RemovalBaseline } from './git.js';

export const DOC_PREFIX = 'doc:';

export interface PlannedWrite {
  document: StagedDocument;
  contentHash: string;
  reason: 'new' | 'changed';
}

export interface RefusedDeletion {
  shareId: string;
  reason: string;
}

export interface ReconcilePlan {
  writes: PlannedWrite[];
  deletes: string[];
  refusedDeletions: RefusedDeletion[];
  /** Live keys at a schema version this build must not overwrite (§4.4). */
  skippedNewerSchema: string[];
  /** share_ids already current — the hash-skip that keeps KV writes cheap. */
  unchanged: string[];
}

export function actualFromList(listed: KvListed[]): Map<string, DocKeyMetadata | undefined> {
  const out = new Map<string, DocKeyMetadata | undefined>();
  for (const key of listed) {
    if (!key.name.startsWith(DOC_PREFIX)) continue;
    out.set(key.name.slice(DOC_PREFIX.length), key.metadata);
  }
  return out;
}

export interface ReconcileInput {
  documents: StagedDocument[];
  actual: Map<string, DocKeyMetadata | undefined>;
  renderConfigVersion: number;
  removals: RemovalBaseline;
}

export async function reconcile(input: ReconcileInput): Promise<ReconcilePlan> {
  const plan: ReconcilePlan = {
    writes: [],
    deletes: [],
    refusedDeletions: [],
    skippedNewerSchema: [],
    unchanged: [],
  };

  const desired = new Set<string>();

  for (const document of input.documents) {
    const id = document.metadata.share_id;
    desired.add(id);

    const hash = await contentHash(document.raw, input.renderConfigVersion);
    const live = input.actual.get(id);

    if (live === undefined && !input.actual.has(id)) {
      plan.writes.push({ document, contentHash: hash, reason: 'new' });
      continue;
    }

    // Writers never downgrade (§4.4). If a live key's metadata carries a `v`
    // higher than this build writes, skip and report rather than overwriting.
    // A rollback across a schema bump degrades to "no change", not corruption.
    if (live && live.v > SCHEMA_VERSION) {
      plan.skippedNewerSchema.push(id);
      continue;
    }

    // A key with no metadata predates the metadata contract, so its hash is
    // unknowable without reading the value. Rewrite it — that is cheaper than
    // reading, and it repairs the key on the way past.
    if (!live || live.contentHash !== hash) {
      plan.writes.push({ document, contentHash: hash, reason: live ? 'changed' : 'new' });
      continue;
    }

    plan.unchanged.push(id);
  }

  for (const [id] of input.actual) {
    if (desired.has(id)) continue;

    if (input.removals.removed === null) {
      plan.refusedDeletions.push({ shareId: id, reason: input.removals.reason });
      continue;
    }
    if (!input.removals.removed.has(id)) {
      plan.refusedDeletions.push({
        shareId: id,
        reason: 'no matching file removal in this commit',
      });
      continue;
    }
    plan.deletes.push(id);
  }

  plan.deletes.sort();
  plan.refusedDeletions.sort((a, b) => (a.shareId < b.shareId ? -1 : 1));
  return plan;
}
