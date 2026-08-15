/**
 * Every action the plugin can take, in one place.
 *
 * §3.10's third invariant: **one code path**. Context menu, command palette
 * and panel all call these functions, so validation and warnings cannot
 * diverge between them — and neither can guards. That is not a tidiness
 * preference: the command palette offers every command unconditionally and
 * cannot be state-filtered, so a guard that lives in menu-construction code is
 * a guard the palette does not have (§3.6).
 *
 * Vocabulary: everything here is **stage** language, because staging is what
 * these actions do. Nothing reaches the internet until push. The review modal
 * and the build use **publish** language, because at that point it is true
 * (§3.10).
 */

import { Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { generateShareId } from '@notes/shared';
import type { ValidationIssue } from '@notes/shared';
import { createDataviewBridge } from './staging/dataview.js';
import { stageNote } from './staging/pipeline.js';
import { StagingValidationError, VaultStagingContext } from './staging/vaultContext.js';
import { patchFrontmatter, readFrontmatter, resolveTitle } from './vault/frontmatter.js';
import { publicUrl } from './settings.js';
import type { PublisherSettings } from './settings.js';
import type { PublishStore } from './vault/store.js';
import type { NoteEntry, ScanResult } from './state/scan.js';
import { verifyAll } from './state/remote.js';

export interface ActionDeps {
  app: App;
  settings: PublisherSettings;
  store: PublishStore;
  /** The most recent scan, for guards that need to know what is live. */
  scan: () => ScanResult | null;
  refresh: () => Promise<void>;
}

export interface StageResult {
  ok: boolean;
  shareId?: string;
  issues: ValidationIssue[];
  dropped: number;
  emptyQueries: { query: string; hash: string }[];
}

export class Actions {
  constructor(private readonly deps: ActionDeps) {}

  private get app() {
    return this.deps.app;
  }

  private get settings() {
    return this.deps.settings;
  }

  private get store() {
    return this.deps.store;
  }

  // ── staging ───────────────────────────────────────────────────────────────

  /**
   * Stage a note for publishing.
   *
   * Generate `share_id` if absent → validate → stage → set `publish: true` →
   * copy link (§3.6). Nothing here reaches the internet; §3.9 does that.
   */
  async stageForPublishing(
    file: TFile,
    options: { acknowledgeEmptyQueries?: boolean; silent?: boolean } = {},
  ): Promise<StageResult> {
    const names = this.settings.properties;
    const existing = readFrontmatter(this.app, file, names);
    const shareId = existing.shareId ?? generateShareId();

    // Uniqueness is checked across the vault as a whole rather than merely
    // against other staged notes (§3.7 step 1) — "Make a copy" duplicates
    // frontmatter, and the duplicate may never have been staged.
    const conflict = this.findConflict(shareId, file);
    if (conflict) {
      return this.fail(options, {
        severity: 'error',
        code: 'share-id-conflict',
        message: `${conflict.path} already claims share_id ${shareId}. Clear the id from the copy first.`,
      });
    }

    if (options.acknowledgeEmptyQueries) {
      // Re-run the pipeline once to learn which queries to acknowledge, then
      // record them so the prompt stays suppressed until the query changes.
      const probe = await this.runPipeline(file, shareId, new Set());
      if (probe.emptyQueries.length > 0) {
        await patchFrontmatter(this.app, file, names, {
          acknowledge: probe.emptyQueries.map((q) => q.hash),
        });
      }
    }

    let outcome;
    try {
      outcome = await this.runPipeline(file, shareId);
    } catch (err) {
      if (err instanceof StagingValidationError) return this.fail(options, err.issue);
      return this.fail(options, {
        severity: 'error',
        code: 'stage-failed',
        message: (err as Error).message,
      });
    }

    const errors = outcome.issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      if (!options.silent) new Notice(`Cannot stage "${file.basename}": ${errors[0]?.message}`, 8000);
      return {
        ok: false,
        issues: outcome.issues,
        dropped: outcome.dropped.length,
        emptyQueries: outcome.emptyQueries,
      };
    }

    // ── 8. Write ──────────────────────────────────────────────────────────
    await this.store.writePending(shareId, outcome.contents);
    await this.writeAssets();

    // Asset cleanup: delete anything in `.publish-pending/_assets/` no longer
    // referenced by a pending file (§3.3).
    await this.prunePendingAssets();

    // Frontmatter is written *after* the staged file, because `source_hash`
    // covers the body as it was before these keys existed (§3.3).
    await patchFrontmatter(this.app, file, names, { publish: true, shareId });

    await this.deps.refresh();

    if (!options.silent) {
      const suffix = outcome.dropped.length > 0 ? ` · ${outcome.dropped.length} link(s) dropped` : '';
      new Notice(`Staged. ${this.pendingCount()} change(s) waiting.${suffix}`);
    }

    return {
      ok: true,
      shareId,
      issues: outcome.issues,
      dropped: outcome.dropped.length,
      emptyQueries: outcome.emptyQueries,
    };
  }

  /** Rebuild the staged copy from current source (§3.6). */
  restage(file: TFile, options: { silent?: boolean } = {}): Promise<StageResult> {
    return this.stageForPublishing(file, options);
  }

  /**
   * Stage for removal (§3.6).
   *
   * Keys off the **staged file** rather than the source note, which is what
   * lets one command repair an Orphan with no special case: reconciliation
   * deletes any KV key whose staged file is absent (§5.6), and frontmatter is
   * never consulted. Deleting the staged file is therefore both necessary and
   * sufficient; the `publish: false` write is bookkeeping that stops the note
   * being re-staged later by a bulk command.
   */
  async stageForRemoval(shareId: string): Promise<void> {
    const entry = this.deps.scan()?.byShareId.get(shareId) ?? null;

    await this.store.deletePending(shareId);
    await this.store.deletePublished(shareId);
    await this.prunePendingAssets();

    const note = entry?.file;
    if (note) {
      await patchFrontmatter(this.app, note, this.settings.properties, { publish: false });
    }

    await this.deps.refresh();

    new Notice(
      note
        ? 'Staged for removal. Push to take the page down.'
        : 'Orphan staged for removal. Push to take the page down — this share_id is gone for good.',
      8000,
    );
  }

  /**
   * Unstage (§3.6).
   *
   * **Refuses on a live note, and the guard is behavioural, not visual.**
   * Unstage deletes the staged file, and §5.6 reconciliation deletes any KV
   * key whose staged file is absent — so unstaging something already published
   * would take the page down, silently, without the `publish: false` write and
   * without the permanence warning Stage for removal carries.
   *
   * Hiding the action in the panel is not sufficient, because the command
   * palette offers every command unconditionally. The refusal therefore lives
   * here, in the shared implementation.
   */
  async unstage(file: TFile): Promise<boolean> {
    const names = this.settings.properties;
    const frontmatter = readFrontmatter(this.app, file, names);
    if (!frontmatter.shareId) {
      new Notice('That note is not staged.');
      return false;
    }

    const entry = this.deps.scan()?.byShareId.get(frontmatter.shareId) ?? null;
    if (entry && this.isLiveOrCommitted(entry)) {
      new Notice(
        'That page is live. Unstage only discards local work — use "Stage for removal" to ' +
          'take a published page down, which records the removal and warns about permanence.',
        10_000,
      );
      return false;
    }

    await this.store.deletePending(frontmatter.shareId);
    await this.store.deletePublished(frontmatter.shareId);
    await this.prunePendingAssets();
    await patchFrontmatter(this.app, file, names, { clear: true });
    await this.deps.refresh();

    new Notice('Unstaged. The note is unchanged apart from the properties the plugin added.');
    return true;
  }

  /**
   * The asymmetry is deliberate: Stage for removal on a note that was never
   * live is harmless and behaves as Unstage, so it needs no guard. Only the
   * reverse direction destroys something (§3.6).
   */
  private isLiveOrCommitted(entry: NoteEntry): boolean {
    if (entry.detail.live) return true;
    // Remote state may be unknown. A staged file that has already been pushed
    // is on its way to being live, so refuse rather than guess.
    return entry.detail.pushed;
  }

  // ── bulk ──────────────────────────────────────────────────────────────────

  async restageAllStale(): Promise<void> {
    const scan = this.deps.scan();
    if (!scan) return;

    const stale = scan.entries.filter((entry) => entry.status === 'stale' && entry.file);
    if (stale.length === 0) {
      new Notice('Nothing is stale.');
      return;
    }

    let ok = 0;
    const failures: string[] = [];
    for (const entry of stale) {
      const result = await this.stageForPublishing(entry.file as TFile, { silent: true });
      if (result.ok) ok++;
      else failures.push(entry.title);
    }

    // One summary rather than a burst of notices (§3.10).
    new Notice(
      failures.length === 0
        ? `Re-staged ${ok} note(s).`
        : `Re-staged ${ok}, failed ${failures.length}: ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? '…' : ''}`,
      8000,
    );
  }

  /** Verify all (§3.6) — the only check that observes rather than infers. */
  async verify(): Promise<void> {
    const scan = this.deps.scan();
    if (!scan) return;

    const expected = new Map<string, string>();
    for (const entry of scan.entries) {
      if (entry.detail.live && entry.localHash) expected.set(entry.shareId, entry.localHash);
    }
    if (expected.size === 0) {
      new Notice('Nothing is live to verify.');
      return;
    }

    new Notice(`Verifying ${expected.size} live page(s)…`);
    const results = await verifyAll(this.settings, expected);
    const bad = results.filter((result) => !result.ok);

    if (bad.length === 0) {
      new Notice(`All ${results.length} live pages match what is staged.`);
      return;
    }
    new Notice(
      `${bad.length} of ${results.length} pages do not match:\n` +
        bad.slice(0, 5).map((result) => `· ${result.shareId}: ${result.detail}`).join('\n'),
      15_000,
    );
  }

  // ── links ─────────────────────────────────────────────────────────────────

  async copyLink(shareId: string): Promise<void> {
    const url = publicUrl(this.settings, shareId);
    await navigator.clipboard.writeText(url);
    new Notice(`Copied ${url}`);
  }

  openPublished(shareId: string): void {
    window.open(publicUrl(this.settings, shareId), '_blank');
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private lastAssets = new Map<string, Uint8Array>();

  private async runPipeline(file: TFile, shareId: string, acknowledged?: Set<string>) {
    const names = this.settings.properties;
    const frontmatter = readFrontmatter(this.app, file, names);
    const ctx = new VaultStagingContext(this.app, this.settings, createDataviewBridge(this.app));

    const outcome = await stageNote({
      file,
      shareId,
      title: resolveTitle(this.app, file, names),
      indexable: frontmatter.indexable,
      download: frontmatter.download,
      acknowledged: acknowledged ?? frontmatter.acknowledged,
      ctx,
    });

    this.lastAssets = ctx.pendingAssets;
    outcome.issues.push(...ctx.issues);
    return outcome;
  }

  private async writeAssets(): Promise<void> {
    for (const [name, bytes] of this.lastAssets) {
      await this.store.writePendingAsset(name, bytes);
    }
    this.lastAssets = new Map();
  }

  /**
   * Delete pending assets nothing references any more (§3.3). Only the pending
   * directory is pruned: R2 objects are never deleted (§13), and materialized
   * assets belong to git.
   */
  private async prunePendingAssets(): Promise<void> {
    const referenced = new Set<string>();
    for (const id of await this.store.listPending()) {
      const contents = await this.store.readPending(id);
      if (!contents) continue;
      for (const match of contents.matchAll(/_assets\/([A-Za-z0-9._-]+)/g)) {
        if (match[1]) referenced.add(match[1]);
      }
    }
    await this.store.prunePendingAssets(referenced);
  }

  private findConflict(shareId: string, file: TFile): TFile | null {
    const names = this.settings.properties;
    for (const candidate of this.app.vault.getMarkdownFiles()) {
      if (candidate.path === file.path) continue;
      if (candidate.path.startsWith(`${this.store.publishedDir}/`)) continue;
      if (readFrontmatter(this.app, candidate, names).shareId === shareId) return candidate;
    }
    return null;
  }

  private pendingCount(): number {
    const scan = this.deps.scan();
    if (!scan) return 0;
    return scan.entries.filter((entry) => entry.status === 'staged' || entry.status === 'removing')
      .length;
  }

  private fail(options: { silent?: boolean }, issue: ValidationIssue): StageResult {
    if (!options.silent) new Notice(issue.message, 8000);
    return { ok: false, issues: [issue], dropped: 0, emptyQueries: [] };
  }
}
