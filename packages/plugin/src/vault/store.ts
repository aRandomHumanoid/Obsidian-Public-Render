/**
 * Reading and writing the two staging directories (§3.3).
 *
 * ```
 * .publish-pending/          ← gitignored. Plugin writes here. Never committed.
 * published/                 ← tracked. Only the review modal writes here (§3.9).
 * ```
 *
 * **Why not stage directly into `published/`.** The vault repo is a backup
 * repo, and Obsidian Git commits on a timer. If staged files landed in the
 * tracked tree, auto-commit would sweep them up within minutes and push them —
 * the workflow's path filter would match, the build would run, and the note
 * would go live **without the review modal ever opening**. The gate that
 * justifies this entire architecture would be defeated by the sync tooling the
 * design assumes you already have.
 *
 * A gitignored pending directory makes that impossible rather than unlikely.
 *
 * Everything goes through the vault *adapter* rather than the `TFile` API:
 * `.publish-pending/` is a dotfolder Obsidian does not index, so it has no
 * `TFile`s at all, and using one path for both directories means the
 * materialize/rollback pair cannot drift.
 */

import type { App } from 'obsidian';
import { ASSET_DIR, PENDING_DIR } from '../settings.js';
import type { PublisherSettings } from '../settings.js';

export class PublishStore {
  constructor(
    private readonly app: App,
    private readonly settings: PublisherSettings,
  ) {}

  private get adapter() {
    return this.app.vault.adapter;
  }

  get pendingDir(): string {
    return PENDING_DIR;
  }

  get publishedDir(): string {
    return this.settings.stagingFolder.replace(/\/+$/, '');
  }

  pendingPath(shareId: string): string {
    return `${this.pendingDir}/${shareId}.md`;
  }

  publishedPath(shareId: string): string {
    return `${this.publishedDir}/${shareId}.md`;
  }

  pendingAssetPath(name: string): string {
    return `${this.pendingDir}/${ASSET_DIR}/${name}`;
  }

  publishedAssetPath(name: string): string {
    return `${this.publishedDir}/${ASSET_DIR}/${name}`;
  }

  async ensureDirs(): Promise<void> {
    for (const dir of [
      this.pendingDir,
      `${this.pendingDir}/${ASSET_DIR}`,
      this.publishedDir,
      `${this.publishedDir}/${ASSET_DIR}`,
    ]) {
      if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    }
  }

  // ── pending ───────────────────────────────────────────────────────────────

  async writePending(shareId: string, contents: string): Promise<void> {
    await this.ensureDirs();
    await this.adapter.write(this.pendingPath(shareId), contents);
  }

  async readPending(shareId: string): Promise<string | null> {
    const path = this.pendingPath(shareId);
    return (await this.adapter.exists(path)) ? this.adapter.read(path) : null;
  }

  async deletePending(shareId: string): Promise<void> {
    const path = this.pendingPath(shareId);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  listPending(): Promise<string[]> {
    return this.listShareIds(this.pendingDir);
  }

  async writePendingAsset(name: string, bytes: Uint8Array): Promise<void> {
    await this.ensureDirs();
    const path = this.pendingAssetPath(name);
    if (await this.adapter.exists(path)) return;
    await this.adapter.writeBinary(path, toArrayBuffer(bytes));
  }

  listPendingAssets(): Promise<string[]> {
    return this.listFiles(`${this.pendingDir}/${ASSET_DIR}`);
  }

  // ── published ─────────────────────────────────────────────────────────────

  async readPublished(shareId: string): Promise<string | null> {
    const path = this.publishedPath(shareId);
    return (await this.adapter.exists(path)) ? this.adapter.read(path) : null;
  }

  async deletePublished(shareId: string): Promise<void> {
    const path = this.publishedPath(shareId);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  listPublished(): Promise<string[]> {
    return this.listShareIds(this.publishedDir);
  }

  listPublishedAssets(): Promise<string[]> {
    return this.listFiles(`${this.publishedDir}/${ASSET_DIR}`);
  }

  /**
   * Move pending files into the tracked tree. Called only when the review
   * modal opens (§3.9) — this is the single place content enters `published/`,
   * and therefore the single place it can begin its journey to the internet.
   *
   * Returns every path touched, so the caller can `git add` exactly those and
   * nothing else.
   */
  async materialize(shareIds: string[]): Promise<string[]> {
    await this.ensureDirs();
    const touched: string[] = [];

    for (const shareId of shareIds) {
      const contents = await this.readPending(shareId);
      if (contents === null) continue;
      await this.adapter.write(this.publishedPath(shareId), contents);
      await this.adapter.remove(this.pendingPath(shareId));
      touched.push(this.publishedPath(shareId));
    }

    for (const name of await this.listPendingAssets()) {
      const target = this.publishedAssetPath(name);
      if (!(await this.adapter.exists(target))) {
        const bytes = await this.adapter.readBinary(this.pendingAssetPath(name));
        await this.adapter.writeBinary(target, bytes);
        touched.push(target);
      }
      await this.adapter.remove(this.pendingAssetPath(name));
    }

    return touched;
  }

  /**
   * Undo a materialize. Cancelling the review modal returns the files to
   * pending and leaves the tree as it was (§3.9).
   */
  async rollback(shareIds: string[]): Promise<void> {
    for (const shareId of shareIds) {
      const contents = await this.readPublished(shareId);
      if (contents === null) continue;
      await this.writePending(shareId, contents);
      await this.deletePublished(shareId);
    }
  }

  /**
   * Delete anything in `.publish-pending/_assets/` no longer referenced by a
   * pending file (§3.3). R2 objects are never deleted (§13); this is only the
   * local staging area.
   */
  async prunePendingAssets(referenced: Set<string>): Promise<string[]> {
    const removed: string[] = [];
    for (const name of await this.listPendingAssets()) {
      if (referenced.has(name)) continue;
      await this.adapter.remove(this.pendingAssetPath(name));
      removed.push(name);
    }
    return removed;
  }

  private async listShareIds(dir: string): Promise<string[]> {
    const files = await this.listFiles(dir);
    return files.filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).sort();
  }

  private async listFiles(dir: string): Promise<string[]> {
    if (!(await this.adapter.exists(dir))) return [];
    const listing = await this.adapter.list(dir);
    return listing.files.map((path) => path.slice(path.lastIndexOf('/') + 1)).sort();
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
