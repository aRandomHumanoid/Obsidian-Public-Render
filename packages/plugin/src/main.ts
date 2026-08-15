/**
 * Note publisher — plugin entry point.
 *
 * Five ways in, all of which converge on the same code path (§3.10): ribbon,
 * status bar, command palette, file context menu, editor context menu.
 *
 * Three invariants hold at every entry point:
 *   - **Never auto-publish.** Every route to `publish: true` is an explicit
 *     user action.
 *   - **Never auto-push.** The review modal is the point (§3.9).
 *   - **One code path.** Context menu, palette and panel all call the same
 *     staging function, so validation and warnings cannot diverge between them.
 */

import { Notice, Plugin, TFile } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { Actions } from './actions.js';
import { GitService } from './git/service.js';
import type { GitState } from './git/service.js';
import { DEFAULT_SETTINGS } from './settings.js';
import type { PublisherSettings } from './settings.js';
import { emptyRemoteState, fetchRemoteState } from './state/remote.js';
import type { RemoteState } from './state/remote.js';
import { scanVault } from './state/scan.js';
import type { ScanResult } from './state/scan.js';
import { buildFileMenu } from './ui/contextMenu.js';
import { PUBLISH_VIEW_TYPE, PublishPanel } from './ui/panel.js';
import { ReviewModal, recoverInterruptedReview } from './ui/reviewModal.js';
import { PublisherSettingTab } from './ui/settingsTab.js';
import { PublishStore } from './vault/store.js';
import { readFrontmatter } from './vault/frontmatter.js';

/** After a push, poll briefly before returning to the normal cadence (§3.9). */
const POST_PUSH_POLL_MS = 15_000;
const POST_PUSH_POLL_COUNT = 12;

export default class NotePublisherPlugin extends Plugin {
  /** `Plugin` declares `settings?: unknown`, so this narrows rather than adds. */
  override settings: PublisherSettings = { ...DEFAULT_SETTINGS, properties: { ...DEFAULT_SETTINGS.properties } };
  private store!: PublishStore;
  private git!: GitService;
  private actions!: Actions;
  private lastScan: ScanResult | null = null;
  private remote: RemoteState = emptyRemoteState();
  private statusBar: HTMLElement | null = null;
  private refreshing: Promise<void> | null = null;
  private postPushPolls = 0;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.store = new PublishStore(this.app, this.settings);
    this.git = new GitService(this.app, this.settings);
    this.actions = new Actions({
      app: this.app,
      settings: this.settings,
      store: this.store,
      scan: () => this.lastScan,
      refresh: () => this.refresh(),
    });

    this.registerView(
      PUBLISH_VIEW_TYPE,
      (leaf) =>
        new PublishPanel(leaf, {
          app: this.app,
          settings: this.settings,
          actions: this.actions,
          store: this.store,
          scan: () => this.lastScan,
          refresh: () => this.refresh(),
          review: () => this.review(),
        }),
    );

    this.addSettingTab(new PublisherSettingTab(this.app, this));

    this.addRibbonIcon('send', 'Publish manager', () => void this.openPanel());
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass('mod-clickable');
    this.statusBar.onclick = () => void this.openPanel();

    this.registerCommands();
    this.registerMenus();
    this.registerEvents();

    this.app.workspace.onLayoutReady(() => {
      void this.startup();
    });
  }

  override onunload(): void {
    // Leaves are intentionally left open: Obsidian restores them, and detaching
    // here would lose the user's layout on every plugin reload.
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  private async startup(): Promise<void> {
    try {
      const recovered = await recoverInterruptedReview(this.git, this.store);
      if (recovered.length > 0) {
        new Notice(
          `Returned ${recovered.length} materialized-but-uncommitted file(s) to .publish-pending/. ` +
            `A review was interrupted; nothing was published.`,
          12_000,
        );
      }
    } catch {
      // A repo that cannot be read is reported by the panel's git banner.
    }

    await this.refresh();

    if (this.settings.refreshIntervalMinutes > 0) {
      this.registerInterval(
        window.setInterval(
          () => void this.refresh(),
          this.settings.refreshIntervalMinutes * 60_000,
        ),
      );
    }
  }

  private registerEvents(): void {
    // The frontmatter scan that drives every status already sees every note,
    // so Conflict detection is free here rather than needing a stage-time
    // check that would miss duplicates for months (§3.4).
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.scheduleRefresh()));

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        if (!this.settings.autoRestageOnSave) return;
        const frontmatter = readFrontmatter(this.app, file, this.settings.properties);
        if (!frontmatter.publish || !frontmatter.shareId) return;
        void this.actions.restage(file, { silent: true });
      }),
    );
  }

  private registerMenus(): void {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!this.settings.fileContextMenu || !(file instanceof TFile)) return;
        buildFileMenu(menu, [file], this.menuDeps());
      }),
    );

    this.registerEvent(
      this.app.workspace.on('files-menu', (menu, files) => {
        if (!this.settings.fileContextMenu) return;
        buildFileMenu(menu, files.filter((f): f is TFile => f instanceof TFile), this.menuDeps());
      }),
    );

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, _editor, view) => {
        if (!this.settings.editorContextMenu || !view.file) return;
        buildFileMenu(menu, [view.file], this.menuDeps());
      }),
    );
  }

  private menuDeps() {
    return {
      app: this.app,
      settings: this.settings,
      actions: this.actions,
      scan: () => this.lastScan,
      reveal: (shareId: string) => void this.reveal(shareId),
      review: () => this.review(),
    };
  }

  // ── commands (§3.6) ───────────────────────────────────────────────────────

  private registerCommands(): void {
    const withFile =
      (run: (file: TFile) => void | Promise<void>) =>
      (checking: boolean): boolean => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void run(file);
        return true;
      };

    this.addCommand({
      id: 'stage-current-note',
      name: 'Stage current note for publishing',
      checkCallback: withFile(async (file) => {
        const result = await this.actions.stageForPublishing(file);
        if (result.ok && result.shareId) await this.actions.copyLink(result.shareId);
      }),
    });

    this.addCommand({
      id: 'restage-current-note',
      name: 'Re-stage current note',
      checkCallback: withFile(async (file) => {
        await this.actions.restage(file);
      }),
    });

    this.addCommand({
      id: 'stage-for-removal',
      name: 'Stage current note for removal',
      checkCallback: withFile(async (file) => {
        const shareId = readFrontmatter(this.app, file, this.settings.properties).shareId;
        if (!shareId) {
          new Notice('That note has no share_id, so there is nothing to remove.');
          return;
        }
        await this.actions.stageForRemoval(shareId);
      }),
    });

    // The palette offers every command unconditionally and cannot be
    // state-filtered, which is exactly why the live-note guard lives inside
    // `Actions.unstage` rather than here (§3.6).
    this.addCommand({
      id: 'unstage-current-note',
      name: 'Unstage current note',
      checkCallback: withFile(async (file) => {
        await this.actions.unstage(file);
      }),
    });

    this.addCommand({
      id: 'copy-public-link',
      name: 'Copy public link',
      checkCallback: withFile(async (file) => {
        const shareId = readFrontmatter(this.app, file, this.settings.properties).shareId;
        if (!shareId) {
          new Notice('That note is not staged.');
          return;
        }
        await this.actions.copyLink(shareId);
      }),
    });

    this.addCommand({
      id: 'open-published-page',
      name: 'Open published page',
      checkCallback: withFile((file) => {
        const shareId = readFrontmatter(this.app, file, this.settings.properties).shareId;
        if (shareId) this.actions.openPublished(shareId);
        else new Notice('That note is not staged.');
      }),
    });

    this.addCommand({
      id: 'restage-all-stale',
      name: 'Re-stage all stale',
      callback: () => void this.actions.restageAllStale(),
    });

    this.addCommand({
      id: 'verify-all',
      name: 'Verify all',
      callback: () => void this.actions.verify(),
    });

    this.addCommand({
      id: 'review-and-push',
      name: 'Review and push',
      callback: () => void this.review(),
    });

    this.addCommand({
      id: 'open-publish-manager',
      name: 'Open publish manager',
      callback: () => void this.openPanel(),
    });

    this.addCommand({
      id: 'reveal-in-publish-manager',
      name: 'Reveal in publish manager',
      checkCallback: withFile(async (file) => {
        const shareId = readFrontmatter(this.app, file, this.settings.properties).shareId;
        if (!shareId) {
          new Notice('That note is not staged.');
          return;
        }
        await this.reveal(shareId);
      }),
    });
  }

  // ── panel plumbing ────────────────────────────────────────────────────────

  private async openPanel(): Promise<PublishPanel | null> {
    const existing = this.app.workspace.getLeavesOfType(PUBLISH_VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return existing.view as PublishPanel;
    }

    const leaf = this.leafForPlacement();
    if (!leaf) return null;
    await leaf.setViewState({ type: PUBLISH_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view as PublishPanel;
  }

  private leafForPlacement(): WorkspaceLeaf | null {
    switch (this.settings.defaultPanelPlacement) {
      case 'right':
        return this.app.workspace.getRightLeaf(false);
      case 'left':
        return this.app.workspace.getLeftLeaf(false);
      default:
        // A main-area tab. The workspace can still move it anywhere.
        return this.app.workspace.getLeaf('tab');
    }
  }

  private async reveal(shareId: string): Promise<void> {
    const panel = await this.openPanel();
    panel?.select(shareId);
  }

  private async review(): Promise<void> {
    const gitState = this.lastScan?.git ?? (await this.git.state());
    if (!gitState.ready) {
      new Notice(gitState.reason ?? 'Git is not available.', 10_000);
      return;
    }

    const scan = this.lastScan ?? (await this.buildScan(gitState));

    new ReviewModal({
      app: this.app,
      settings: this.settings,
      store: this.store,
      git: this.git,
      gitState,
      scan,
      refresh: async () => {
        // Following a push, poll on a short interval for a few minutes before
        // returning to the normal cadence (§3.9).
        this.postPushPolls = POST_PUSH_POLL_COUNT;
        await this.refresh();
        this.schedulePostPushPoll();
      },
    }).open();
  }

  private schedulePostPushPoll(): void {
    if (this.postPushPolls <= 0) return;
    this.postPushPolls--;
    window.setTimeout(() => {
      void this.refresh().then(() => this.schedulePostPushPoll());
    }, POST_PUSH_POLL_MS);
  }

  // ── refresh ───────────────────────────────────────────────────────────────

  private refreshTimer: number | null = null;

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 1500);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      const gitState = await this.git.state();
      this.lastScan = await this.buildScan(gitState);
      this.updateStatusBar();
      for (const leaf of this.app.workspace.getLeavesOfType(PUBLISH_VIEW_TYPE)) {
        (leaf.view as PublishPanel).render();
      }
    } catch (err) {
      console.error('note-publisher: refresh failed', err);
    }
  }

  private async buildScan(gitState: GitState): Promise<ScanResult> {
    const known = await this.knownShareIds();
    this.remote = await fetchRemoteState(this.settings, known);
    return scanVault({
      app: this.app,
      settings: this.settings,
      store: this.store,
      git: this.git,
      gitState,
      remote: this.remote,
    });
  }

  /** share_ids the plugin could ask the worker about, for the HEAD fallback. */
  private async knownShareIds(): Promise<string[]> {
    const ids = new Set<string>([
      ...(await this.store.listPending()),
      ...(await this.store.listPublished()),
    ]);
    for (const file of this.app.vault.getMarkdownFiles()) {
      const shareId = readFrontmatter(this.app, file, this.settings.properties).shareId;
      if (shareId) ids.add(shareId);
    }
    return [...ids];
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;
    const scan = this.lastScan;
    if (!scan) {
      this.statusBar.setText('● …');
      return;
    }
    const parts = [`● ${scan.counts.live} live`];
    if (scan.counts.staged > 0) parts.push(`${scan.counts.staged} staged`);
    if (scan.counts.building > 0) parts.push(`${scan.counts.building} building`);
    if (scan.counts.stale > 0) parts.push(`${scan.counts.stale} stale`);
    const problems = scan.counts.issue + scan.counts.conflict + scan.counts.orphan;
    if (problems > 0) parts.push(`⚠ ${problems}`);
    this.statusBar.setText(parts.join(' · '));
  }

  // ── settings ──────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PublisherSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      properties: { ...DEFAULT_SETTINGS.properties, ...stored?.properties },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    await this.refresh();
  }
}
