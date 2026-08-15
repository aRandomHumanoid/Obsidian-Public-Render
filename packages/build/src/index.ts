/**
 * The build (§5).
 *
 *   discover → render → reconcile → write
 *
 * Publish order matters, because a crashed run must be safely resumable
 * (§5.7):
 *
 *   1. Upload new assets to R2
 *   2. Write changed `doc:` keys
 *   3. Delete removed `doc:` keys
 *   4. Write the manifest
 *
 * If the job dies partway, nothing is corrupted: the next run re-reads live KV
 * state and recomputes the same convergence. Under a manifest-as-authority
 * model, ordering was load-bearing and a crash between deletion and manifest
 * write could strand documents permanently. Reconciling from ground truth
 * makes every step individually idempotent — the manifest write is bookkeeping
 * rather than a commit point.
 */

import { SCHEMA_VERSION } from '@notes/shared';
import type { DocKeyMetadata, DocRecord, Manifest, ManifestEntry } from '@notes/shared';
import { processAssets, rewriteAssetRefs } from './assets.js';
import type { BuildConfig } from './config.js';
import { discover } from './discover.js';
import { findRemovedShareIds } from './git.js';
import { DOC_PREFIX, actualFromList, reconcile } from './reconcile.js';
import type { KvClient, KvWrite } from './kv.js';
import type { R2Client } from './r2.js';
import { renderMarkdown } from './render/index.js';
import type { BuildReport, PublishedEntry } from './report.js';

export interface BuildDeps {
  kv: KvClient;
  r2: R2Client;
  cwd?: string;
}

export async function runBuild(config: BuildConfig, deps: BuildDeps): Promise<BuildReport> {
  const cwd = deps.cwd ?? process.cwd();
  const warnings: string[] = [];

  // ── discover ──────────────────────────────────────────────────────────────
  const corpus = await discover(config.publishedDir);

  // ── actual state, from KV itself ──────────────────────────────────────────
  // One `list` call. Values are never read: the hashes ride in key metadata,
  // which is exactly why that metadata exists (§4.2).
  const actual = actualFromList(await deps.kv.list(DOC_PREFIX));

  // ── deletion baseline ─────────────────────────────────────────────────────
  const removals = await findRemovedShareIds({
    cwd,
    publishedDir: corpus.publishedDir,
    baseSha: config.baseSha,
    headSha: config.headSha,
  });

  // ── reconcile ─────────────────────────────────────────────────────────────
  const plan = await reconcile({
    documents: corpus.documents,
    actual,
    renderConfigVersion: config.renderConfigVersion,
    removals,
  });

  // ── assets ────────────────────────────────────────────────────────────────
  // Every asset in the corpus is converted, not only those belonging to
  // documents being rewritten: the staged→published hash mapping changes at
  // conversion (§4.3), so a complete map is the only way to describe the
  // full live set in the manifest. Uploads are still skipped when the key
  // already exists, so the cost is CPU, not quota.
  const assets = await processAssets(corpus.assetDir, corpus.assetFiles, deps.r2, {
    dryRun: config.dryRun,
  });
  warnings.push(...assets.warnings);

  // ── render the documents that need writing ────────────────────────────────
  const docWrites: KvWrite[] = [];
  const published: PublishedEntry[] = [];

  for (const write of plan.writes) {
    const { document } = write;
    const id = document.metadata.share_id;

    const forHtml = rewriteAssetRefs(document.body, assets.map, '/a/');
    const forDownload = rewriteAssetRefs(document.body, assets.map, `${config.baseUrl}/a/`);
    if (forHtml.missing.length > 0) {
      throw new Error(
        `${id}: references assets with no published mapping: ${forHtml.missing.join(', ')}`,
      );
    }

    const rendered = await renderMarkdown(forHtml.text, { mermaid: config.mermaid });
    warnings.push(...rendered.warnings.map((w) => `${document.metadata.title}: ${w}`));

    const record: DocRecord = {
      v: SCHEMA_VERSION,
      title: document.metadata.title,
      html: rendered.html,
      md: withTitleHeading(forDownload.text, document.metadata.title),
      // The staged timestamp, not build time. A rebuild — a renderConfigVersion
      // bump, a rollback, a re-run after a crash — must not change what the
      // page says about when the content last changed, and this keeps the
      // whole record a pure function of the staged file.
      updated: document.metadata.staged,
      contentHash: write.contentHash,
      stagedHash: document.stagedHash,
      indexable: document.metadata.indexable,
      download: document.metadata.download,
    };

    const metadata: DocKeyMetadata = {
      v: SCHEMA_VERSION,
      contentHash: write.contentHash,
      stagedHash: document.stagedHash,
    };

    docWrites.push({ key: `${DOC_PREFIX}${id}`, value: JSON.stringify(record), metadata });
    published.push({
      shareId: id,
      title: document.metadata.title,
      url: `${config.baseUrl}/n/${id}`,
      reason: write.reason,
    });
  }

  // ── manifest ──────────────────────────────────────────────────────────────
  const manifest = buildManifest(config, corpus.documents, plan, actual, assets.map);

  // ── write, in the resumable order ─────────────────────────────────────────
  if (!config.dryRun) {
    // 1. assets are already uploaded above, before anything references them.
    // 2. changed docs
    if (docWrites.length > 0) await deps.kv.put(docWrites);
    // 3. removed docs
    if (plan.deletes.length > 0) {
      await deps.kv.delete(plan.deletes.map((id) => `${DOC_PREFIX}${id}`));
    }
    // 4. the manifest, last — a cache, not a commit point
    await deps.kv.put([{ key: 'manifest', value: JSON.stringify(manifest) }]);
  }

  return {
    published,
    deleted: plan.deletes,
    refusedDeletions: plan.refusedDeletions,
    unchanged: plan.unchanged.length,
    skippedNewerSchema: plan.skippedNewerSchema,
    assetsUploaded: assets.uploaded,
    assetsSkipped: assets.skipped.length,
    warnings,
    baseline: removals.reason,
    dryRun: config.dryRun,
  };
}

/**
 * The download copy has its metadata block stripped, which would otherwise
 * take the title with it. Restore it as an H1 unless the body already opens
 * with one — a downloaded file with no title is a worse artifact than a
 * duplicated heading.
 */
function withTitleHeading(body: string, title: string): string {
  const firstHeading = /^#\s+(.+)$/m.exec(body.trimStart().split('\n\n')[0] ?? '');
  if (firstHeading && firstHeading[1]?.trim() === title.trim()) return body.trimStart();
  if (/^#\s+/.test(body.trimStart())) return body.trimStart();
  return `# ${title}\n\n${body.trimStart()}`;
}

function buildManifest(
  config: BuildConfig,
  documents: { metadata: { share_id: string; staged: string }; body: string; stagedHash: string; assets: string[] }[],
  plan: Awaited<ReturnType<typeof reconcile>>,
  actual: Map<string, DocKeyMetadata | undefined>,
  assetMap: Map<string, string>,
): Manifest {
  const written = new Map(plan.writes.map((w) => [w.document.metadata.share_id, w.contentHash]));
  const skipped = new Set(plan.skippedNewerSchema);
  const docs: Record<string, ManifestEntry> = {};

  for (const document of documents) {
    const id = document.metadata.share_id;
    const live = actual.get(id);

    // A document this build declined to overwrite is still live at its own
    // version; describe what is actually being served, not what we would have
    // written.
    const contentHash = skipped.has(id)
      ? (live?.contentHash ?? '')
      : (written.get(id) ?? live?.contentHash ?? '');
    const stagedHash = skipped.has(id) ? (live?.stagedHash ?? '') : document.stagedHash;

    docs[id] = {
      contentHash,
      stagedHash,
      updated: document.metadata.staged,
      assets: document.assets.map((name) => assetMap.get(name) ?? name),
    };
  }

  return {
    v: SCHEMA_VERSION,
    generated: new Date().toISOString(),
    renderConfigVersion: config.renderConfigVersion,
    docs,
  };
}

export { discover } from './discover.js';
export { reconcile, actualFromList, DOC_PREFIX } from './reconcile.js';
export { findRemovedShareIds } from './git.js';
export { renderMarkdown } from './render/index.js';
export { processAssets, rewriteAssetRefs } from './assets.js';
export { sanitizeSvg, isSvg } from './svg.js';
export { CloudflareKv, MemoryKv } from './kv.js';
export { CloudflareR2, MemoryR2 } from './r2.js';
export { formatSummary, writeSummary } from './report.js';
export { loadConfig, RENDER_CONFIG_VERSION } from './config.js';
export type { BuildConfig } from './config.js';
export type { BuildReport } from './report.js';
export type { ReconcilePlan } from './reconcile.js';
