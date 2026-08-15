/**
 * The Obsidian-backed `StagingContext`.
 *
 * This is the only file in the staging pipeline that knows what an `App` is.
 * It also owns §3.7 step 1's attachment caps, because the size of a file is
 * only knowable at the point it is read.
 */

import { assetHash } from '@notes/shared';
import type { ValidationIssue } from '@notes/shared';
import type { App, TFile } from 'obsidian';
import { readFrontmatter, resolveTitle } from '../vault/frontmatter.js';
import type { PublisherSettings } from '../settings.js';
import type { StagedBody, StagingContext, DataviewBridge } from './context.js';
import { buildStagedBody } from './pipeline.js';

export class VaultStagingContext implements StagingContext {
  /** Staged basename → bytes, written to `.publish-pending/_assets/` on success. */
  readonly pendingAssets = new Map<string, Uint8Array>();
  readonly issues: ValidationIssue[] = [];

  constructor(
    private readonly app: App,
    readonly settings: PublisherSettings,
    readonly dataview: DataviewBridge | null,
  ) {}

  resolve(linkpath: string, from: string): TFile | null {
    return this.app.metadataCache.getFirstLinkpathDest(linkpath, from);
  }

  publishedShareId(file: TFile): string | null {
    if (file.extension !== 'md') return null;
    const frontmatter = readFrontmatter(this.app, file, this.settings.properties);
    return frontmatter.publish && frontmatter.shareId ? frontmatter.shareId : null;
  }

  noteTitle(file: TFile): string {
    return resolveTitle(this.app, file, this.settings.properties);
  }

  readSource(file: TFile): Promise<string> {
    // `cachedRead` is the right call for read-only access: it does not
    // interfere with an editor that has the file open.
    return this.app.vault.cachedRead(file);
  }

  acknowledgedFor(file: TFile): Set<string> {
    return readFrontmatter(this.app, file, this.settings.properties).acknowledged;
  }

  /**
   * §3.7 step 6 — hash the source bytes, copy to `_assets/<hash>.<ext>`.
   *
   * Caps are checked here rather than in a separate validation sweep because
   * this is where the bytes are: warn at 2 MB, hard-fail at 10 MB, both
   * configurable (§3.8).
   */
  async addAsset(file: TFile): Promise<string> {
    const bytes = new Uint8Array(await this.app.vault.readBinary(file));

    if (bytes.byteLength > this.settings.attachmentFailBytes) {
      throw new StagingValidationError({
        severity: 'error',
        code: 'attachment-too-large',
        message: `${file.path} is ${formatBytes(bytes.byteLength)}, over the ${formatBytes(this.settings.attachmentFailBytes)} hard limit`,
      });
    }
    if (bytes.byteLength > this.settings.attachmentWarnBytes) {
      this.warn({
        severity: 'warning',
        code: 'attachment-large',
        message: `${file.path} is ${formatBytes(bytes.byteLength)}; it will be converted to webp at build time but the repo carries the original`,
      });
    }

    const basename = `${await assetHash(bytes)}.${file.extension.toLowerCase()}`;
    this.pendingAssets.set(basename, bytes);
    return basename;
  }

  stageBody(file: TFile, chain: string[]): Promise<StagedBody> {
    return buildStagedBody(file, this, chain);
  }

  warn(issue: ValidationIssue): void {
    this.issues.push(issue);
  }
}

export class StagingValidationError extends Error {
  constructor(readonly issue: ValidationIssue) {
    super(issue.message);
    this.name = 'StagingValidationError';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
