/**
 * The staging pipeline, per note (§3.7).
 *
 *   1. Validate
 *   2. Materialize Dataview
 *   3. Resolve links
 *   4. Inline transclusions          ← from the target's *staged output*
 *   5. Strip
 *   6. Collect attachments
 *   7. Self-check                    ← fail closed
 *   8. Write
 *
 * Steps 2–4 are the ones CI cannot do. The rest are here because the plugin
 * already has the file open.
 */

import {
  enforceCriticalAssertions,
  serializeStagedFile,
  sourceHash,
  splitFrontmatter,
  stagedHash as computeStagedHash,
} from '@notes/shared';
import type { DroppedLink, StagedMetadata, ValidationIssue } from '@notes/shared';
import type { TFile } from 'obsidian';
import { collectMarkdownImages } from './attachments.js';
import { materializeBlockAnchors } from './blocks.js';
import { emptyStagedBody, mergeStagedBody } from './context.js';
import type { StagedBody, StagingContext } from './context.js';
import { materializeDataview } from './dataview.js';
import { resolveLinks } from './links.js';
import { stripComments } from './strip.js';
import { inlineEmbeds } from './transclusion.js';

export interface StageOutcome {
  shareId: string;
  /** Complete file contents for `.publish-pending/<share_id>.md`. */
  contents: string;
  metadata: StagedMetadata;
  stagedHash: string;
  dropped: DroppedLink[];
  issues: ValidationIssue[];
  emptyQueries: { query: string; hash: string }[];
  assets: string[];
}

export interface StageInput {
  file: TFile;
  shareId: string;
  title: string;
  indexable: boolean;
  download: boolean;
  /** Hashes from `publish_ack`, suppressing the empty-query prompt (§9). */
  acknowledged: Set<string>;
  ctx: StagingContext;
}

export async function stageNote(input: StageInput): Promise<StageOutcome> {
  const body = await buildStagedBody(
    input.file,
    input.ctx,
    [input.file.path],
    input.acknowledged,
  );

  const source = await input.ctx.readSource(input.file);
  const { body: rawBody } = splitFrontmatter(source);

  // `source_hash` covers body + allowlisted properties, NOT raw file bytes
  // (§3.3). Staging writes `publish: true` and possibly `share_id` back to the
  // source note *after* this point, so hashing the file would mark every note
  // Stale the instant it was first staged.
  const computedSourceHash = await sourceHash(rawBody, {
    title: input.title,
    indexable: input.indexable,
    download: input.download,
  });

  const metadata: StagedMetadata = {
    share_id: input.shareId,
    title: input.title,
    source_hash: computedSourceHash,
    staged: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    indexable: input.indexable,
    download: input.download,
  };

  const contents = serializeStagedFile(metadata, body.text);

  // ── 7. Self-check ─────────────────────────────────────────────────────────
  // Run the three critical assertions against the output about to be written
  // (§11.3) and fail closed. Tests catch regressions in fixtures; this catches
  // them in real notes.
  enforceCriticalAssertions({ output: contents, sources: body.sources });

  return {
    shareId: input.shareId,
    contents,
    metadata,
    stagedHash: await computeStagedHash(contents),
    dropped: body.dropped,
    issues: body.issues,
    emptyQueries: body.emptyQueries,
    assets: [...new Set(body.assets)],
  };
}

/**
 * Produce one note's staged body.
 *
 * Called recursively by the transclusion step, which is what makes step 4's
 * confidentiality property hold: a transcluded note's content arrives here
 * having already been through the drop rule.
 */
export async function buildStagedBody(
  file: TFile,
  ctx: StagingContext,
  chain: string[],
  /**
   * `publish_ack` hashes for *this* note. Supplied by the caller for the host
   * note — where the user may have just clicked "publish anyway" — and read
   * from frontmatter for transclusion targets, which have their own.
   */
  acknowledgedOverride?: Set<string>,
): Promise<StagedBody> {
  const source = await ctx.readSource(file);
  const { body: rawBody } = splitFrontmatter(source);

  // Every step resolves relative to *this* note, not the one the user invoked
  // staging on. That distinction is what makes transclusion correct: a
  // relative link inside a transcluded note means what it meant in that note.
  const from = file.path;
  const result = emptyStagedBody(rawBody, source);

  // ── 2. Materialize Dataview ───────────────────────────────────────────────
  const acknowledged = acknowledgedOverride ?? ctx.acknowledgedFor?.(file) ?? new Set<string>();
  const materialized = await materializeDataview(result.text, ctx, from, acknowledged);
  result.text = materialized.text;
  result.issues.push(...materialized.issues);
  result.emptyQueries.push(...materialized.emptyQueries);
  if (materialized.issues.some((i) => i.severity === 'error')) return result;

  // Block anchors before links, so `[[Note^id]]` has something to point at.
  result.text = materializeBlockAnchors(result.text).text;

  // ── 3. Resolve links ──────────────────────────────────────────────────────
  const linked = resolveLinks(result.text, ctx, from);
  result.text = linked.text;
  result.dropped.push(...linked.dropped);

  // ── 4. Inline transclusions ───────────────────────────────────────────────
  const embedded = await inlineEmbeds(result.text, ctx, from, chain);
  result.text = embedded.text;
  mergeStagedBody(result, embedded.merged);

  // Backstop: re-run steps 3 and 5 over the merged result (§3.7). Cheap, and
  // it catches anything a partially-staged or hand-edited target smuggles in.
  const rechecked = resolveLinks(result.text, ctx, from);
  if (rechecked.dropped.length > 0) {
    result.dropped.push(...rechecked.dropped);
    result.text = rechecked.text;
  }

  // ── 5. Strip ──────────────────────────────────────────────────────────────
  const stripped = stripComments(result.text);
  result.text = stripped.text;
  // Both of these mean the delimiters did not pair the way the author wrote
  // them, and a mis-pair publishes the *interior* of a real comment while no
  // `%%` survives for the §11.2 check to catch. Error, not warning: the write
  // gate blocks on error alone, and this is the failure that cannot be walked
  // back once a link has been shared.
  if (stripped.unterminated) {
    result.issues.push({
      severity: 'error',
      code: 'unterminated-comment',
      message:
        `${file.path}: an unterminated %% would drop everything after it. Close the ` +
        `comment, or remove the stray delimiter.`,
    });
  }
  for (const pair of stripped.ambiguous) {
    result.issues.push({
      severity: 'error',
      code: 'ambiguous-comment',
      message:
        `${file.path}: line ${pair.line} — a %% opens mid-line and closes only after a ` +
        `blank line, so the delimiters cannot be paired reliably. Put the opening %% on ` +
        `its own line, close it within the same paragraph, or remove the stray ` +
        `delimiter: ${pair.context}`,
    });
  }

  // ── 6. Collect attachments ────────────────────────────────────────────────
  const attachments = await collectMarkdownImages(result.text, ctx, from);
  result.text = attachments.text;
  result.assets.push(...attachments.assets);

  result.text = result.text.trim();
  return result;
}
