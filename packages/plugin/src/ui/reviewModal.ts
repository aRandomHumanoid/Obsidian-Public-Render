/**
 * The review modal (§3.9).
 *
 * `git diff published/` is the review gate that justifies the entire staging
 * design (§3.3). A button that commits and pushes on one click silently
 * deletes that property, so the action is a modal, not an immediate effect.
 *
 * Nothing reaches `published/` until this modal opens. On open the plugin
 * materializes pending files into `published/`, stages them with `git add`,
 * and renders from the real `git diff --cached` — the exact bytes about to
 * become public, not a plugin-rendered approximation. Confirming commits and
 * pushes. Cancelling runs `git restore --staged`, moves the files back to
 * `.publish-pending/`, and leaves the tree as it was.
 *
 * This is also where the vocabulary switches from *stage* to *publish*. Every
 * label up to this point describes local work; the headings here describe what
 * the push will make true. Confirming this dialog is the moment content leaves
 * the machine, and the wording should make that feel like a threshold rather
 * than a formality.
 */

import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { DroppedLink } from '@notes/shared';
import { describeDrop, droppedLinksFor } from '../state/inspect.js';
import { publicUrl } from '../settings.js';
import type { PublisherSettings } from '../settings.js';
import type { GitService, GitState } from '../git/service.js';
import type { PublishStore } from '../vault/store.js';
import type { ScanResult } from '../state/scan.js';

interface ChangeItem {
  shareId: string;
  title: string;
  /**
   * Links this note dropped during staging (§3.7 step 3).
   *
   * Surfaced *here*, next to the diff, rather than in a log the user has
   * already scrolled past — which is one of the two things that make this
   * modal strictly better than the terminal equivalent (§3.9).
   */
  dropped: DroppedLink[];
}

interface ChangeGroup {
  publishing: ChangeItem[];
  updating: ChangeItem[];
  unpublishing: ChangeItem[];
  sourceNotes: string[];
}

export interface ReviewModalDeps {
  app: App;
  settings: PublisherSettings;
  store: PublishStore;
  git: GitService;
  gitState: GitState;
  scan: ScanResult;
  refresh: () => Promise<void>;
}

export class ReviewModal extends Modal {
  private materialized: string[] = [];
  private addedPaths: string[] = [];
  private confirmed = false;
  private busy = false;

  constructor(private readonly deps: ReviewModalDeps) {
    super(deps.app);
  }

  override async onOpen(): Promise<void> {
    this.modalEl.addClass('note-publisher-review');
    this.titleEl.setText('Review changes');
    this.contentEl.createEl('p', {
      cls: 'np-muted',
      text: 'Reading the staged diff…',
    });

    try {
      await this.prepare();
    } catch (err) {
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: `Could not prepare the review: ${(err as Error).message}` });
      new Setting(this.contentEl).addButton((button) =>
        button.setButtonText('Close').onClick(() => this.close()),
      );
    }
  }

  override async onClose(): Promise<void> {
    // Cancelling — including closing with Escape — must leave the tree exactly
    // as it was. This is the half of the gate that makes opening the modal
    // safe to do casually.
    if (!this.confirmed) await this.rollback();
    this.contentEl.empty();
  }

  private async prepare(): Promise<void> {
    const { store, git, scan } = this.deps;

    // Materialize: the single point at which content enters the tracked tree.
    const pendingIds = await store.listPending();
    this.materialized = pendingIds;
    await store.materialize(pendingIds);

    // Deletions: a share_id that is live or committed but has no staged file
    // any more is a removal, and `git add -A` on the directory records it.
    const publishedDir = await git.repoRelative(store.publishedDir);
    const paths = [publishedDir];

    // Source notes whose frontmatter moved with this change set. Committing
    // staged files *without* them would be a correctness bug rather than an
    // optimization: another device syncing the repo would find a staged file
    // whose share_id appears in no source note, and would correctly classify
    // it as an Orphan (§3.4, §3.9).
    const sourceNotes = await this.dirtySourceNotes();
    paths.push(...sourceNotes);

    await git.add(paths);
    this.addedPaths = paths;

    const nameStatus = await git.diffCachedNameStatus(paths);
    const groups = await this.groupChanges(nameStatus, sourceNotes, scan);
    const diff = await git.diffCached([publishedDir]);

    this.render(groups, diff);
  }

  private async dirtySourceNotes(): Promise<string[]> {
    const { scan, git } = this.deps;
    const out: string[] = [];
    const seen = new Set<string>();

    for (const entry of scan.entries) {
      const file = entry.file;
      if (!file) continue;
      const repoPath = await git.repoRelative(file.path);
      if (seen.has(repoPath)) continue;
      seen.add(repoPath);
      if (scan.git.dirty.has(repoPath)) out.push(repoPath);
    }
    return out;
  }

  private async groupChanges(
    nameStatus: { status: string; path: string }[],
    sourceNotes: string[],
    scan: ScanResult,
  ): Promise<ChangeGroup> {
    const groups: ChangeGroup = {
      publishing: [],
      updating: [],
      unpublishing: [],
      sourceNotes,
    };

    for (const change of nameStatus) {
      const basename = change.path.slice(change.path.lastIndexOf('/') + 1);
      if (!basename.endsWith('.md')) continue;
      const shareId = basename.slice(0, -3);
      const entry = scan.byShareId.get(shareId);
      const item: ChangeItem = {
        shareId,
        title: entry?.title ?? shareId,
        dropped: entry?.file
          ? await droppedLinksFor(this.deps.app, this.deps.settings, entry.file)
          : [],
      };

      if (change.status.startsWith('A')) {
        groups.publishing.push(item);
      } else if (change.status.startsWith('D')) {
        groups.unpublishing.push(item);
      } else if (change.status.startsWith('M') || change.status.startsWith('R')) {
        groups.updating.push(item);
      }
    }

    return groups;
  }

  private render(groups: ChangeGroup, diff: string): void {
    const { contentEl } = this;
    contentEl.empty();

    const total =
      groups.publishing.length + groups.updating.length + groups.unpublishing.length;

    if (total === 0) {
      contentEl.createEl('p', { text: 'Nothing to publish. Every staged file is already committed.' });
      new Setting(contentEl).addButton((button) =>
        button.setButtonText('Close').setCta().onClick(() => this.close()),
      );
      return;
    }

    if (groups.publishing.length > 0) {
      const section = this.section(contentEl, `Publishing (${groups.publishing.length})`);
      for (const item of groups.publishing) {
        const row = section.createDiv({ cls: 'np-review-row' });
        row.createDiv({ cls: 'np-review-title', text: item.title });
        row.createDiv({ cls: 'np-review-url', text: `→ ${publicUrl(this.deps.settings, item.shareId)}` });
        this.renderDropped(row, item);
      }
    }

    if (groups.updating.length > 0) {
      const section = this.section(contentEl, `Updating (${groups.updating.length})`);
      for (const item of groups.updating) {
        const row = section.createDiv({ cls: 'np-review-row' });
        row.createDiv({ cls: 'np-review-title', text: item.title });
        this.renderDropped(row, item);
      }
    }

    if (groups.unpublishing.length > 0) {
      const section = this.section(contentEl, `Unpublishing (${groups.unpublishing.length})`);
      for (const item of groups.unpublishing) {
        const row = section.createDiv({ cls: 'np-review-row' });
        row.createDiv({ cls: 'np-review-title', text: item.title });
        // Two to three minutes, dominated by CI and KV propagation rather than
        // cache (§6.2). This is content removal, not revocation.
        row.createDiv({ cls: 'np-review-url', text: '· link dies in ~3 min' });
      }
    }

    if (groups.sourceNotes.length > 0) {
      contentEl.createEl('p', {
        cls: 'np-muted',
        text: `Also committing ${groups.sourceNotes.length} source note${groups.sourceNotes.length === 1 ? '' : 's'} (frontmatter)`,
      });
    }

    const details = contentEl.createEl('details', { cls: 'np-diff' });
    details.createEl('summary', { text: 'Staged diff (git diff --cached)' });
    details.createEl('pre').createEl('code', { text: diff || '(empty)' });

    contentEl.createEl('p', {
      cls: 'np-warning',
      text: 'Confirming pushes these bytes to your repository. A published URL cannot be recalled — anyone who loads it keeps what they got.',
    });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('Commit and push')
          .setCta()
          .onClick(() => void this.commit(groups)),
      );
  }

  private renderDropped(row: HTMLElement, item: ChangeItem): void {
    if (item.dropped.length === 0) return;
    const count = item.dropped.length;
    const warning = row.createDiv({
      cls: 'np-review-warning',
      text: `⚠ ${count} link${count === 1 ? '' : 's'} to unpublished notes dropped`,
    });
    // The list, not just the count: the rule is a default, and the list is how
    // you notice when the default was wrong for a particular note (§3.4).
    warning.title = item.dropped.map((link) => `${link.raw} — ${describeDrop(link)}`).join('\n');
  }

  private section(parent: HTMLElement, heading: string): HTMLElement {
    const section = parent.createDiv({ cls: 'np-review-section' });
    section.createEl('h4', { text: heading });
    return section;
  }

  private async commit(groups: ChangeGroup): Promise<void> {
    if (this.busy) return;
    this.busy = true;

    const summary = describe(groups);
    const message = this.deps.settings.commitMessageTemplate.replace('{summary}', summary);

    try {
      await this.deps.git.commitAndPush(message, this.addedPaths, this.deps.gitState.mode);
      this.confirmed = true;
      this.close();
      new Notice(`Pushed. ${summary}. The build takes a couple of minutes.`, 8000);
      await this.deps.refresh();
    } catch (err) {
      this.busy = false;
      new Notice((err as Error).message, 15_000);
    }
  }

  /** Cancel: unstage, and return the files to pending. */
  private async rollback(): Promise<void> {
    try {
      await this.deps.git.restoreStaged(this.addedPaths);
      await this.deps.store.rollback(this.materialized);
      await this.deps.refresh();
    } catch (err) {
      new Notice(
        `Could not fully roll the review back: ${(err as Error).message}. ` +
          `Check \`git status\` before pushing.`,
        15_000,
      );
    }
  }
}

function describe(groups: ChangeGroup): string {
  const parts: string[] = [];
  if (groups.publishing.length > 0) parts.push(`${groups.publishing.length} new`);
  if (groups.updating.length > 0) parts.push(`${groups.updating.length} updated`);
  if (groups.unpublishing.length > 0) parts.push(`${groups.unpublishing.length} removed`);
  return parts.join(', ') || 'no changes';
}

/**
 * Recover from an interrupted review (§3.9).
 *
 * There is a narrow window — modal open, files materialized, not yet committed
 * — in which an auto-commit could capture unreviewed content. It is seconds
 * long, and this closes it by cleaning up any materialized-but-uncommitted
 * files on load. Worth knowing about rather than pretending away.
 */
export async function recoverInterruptedReview(
  git: GitService,
  store: PublishStore,
): Promise<string[]> {
  const publishedDir = await git.repoRelative(store.publishedDir);
  const staged = await git.diffCachedNameStatus([publishedDir]);
  const added = staged
    .filter((change) => change.status.startsWith('A') && change.path.endsWith('.md'))
    .map((change) => change.path.slice(change.path.lastIndexOf('/') + 1, -3));

  if (added.length === 0) return [];

  await git.restoreStaged([publishedDir]);
  await store.rollback(added);
  return added;
}
