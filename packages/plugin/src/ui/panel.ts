/**
 * The publish panel (§3.4).
 *
 * Everything the plugin surfaces lives in one place: a single registered view
 * type, `publish-manager`, which is the index, the detail inspector and the
 * action surface.
 *
 * **Placement is the workspace's decision, not the plugin's.** It opens as a
 * main-area tab — the content is dense enough that a 300px sidebar makes it
 * unusable — and the user can drag it to a sidebar or pop it out. Obsidian
 * handles detachable leaves for free; hard-coding placement only takes options
 * away.
 *
 * Below a width threshold the detail pane collapses and selecting a row pushes
 * it in with a back control, so the same view degrades cleanly into a sidebar
 * without a second implementation.
 */

import { ItemView, Menu, Notice, setIcon } from 'obsidian';
import type { App, WorkspaceLeaf } from 'obsidian';
import { STATUS_LABELS, STATUS_ORDER } from '@notes/shared';
import type { NoteStatus } from '@notes/shared';
import type { NoteEntry, ScanResult } from '../state/scan.js';
import { describeDrop, droppedLinksFor } from '../state/inspect.js';
import type { Actions } from '../actions.js';
import type { PublisherSettings } from '../settings.js';
import type { PublishStore } from '../vault/store.js';

export const PUBLISH_VIEW_TYPE = 'publish-manager';

/** Below this the detail pane becomes a pushed-in page rather than a column. */
const NARROW_PX = 620;

const STATUS_GLYPH: Record<NoteStatus, string> = {
  live: '●',
  staged: '○',
  building: '◔',
  stale: '◐',
  unstaged: '◌',
  removing: '⊖',
  orphan: '⚑',
  conflict: '⚠',
  issue: '▲',
};

export interface PanelDeps {
  app: App;
  settings: PublisherSettings;
  actions: Actions;
  store: PublishStore;
  scan: () => ScanResult | null;
  refresh: () => Promise<void>;
  review: () => Promise<void>;
}

export class PublishPanel extends ItemView {
  private selected: string | null = null;
  private filter = '';
  private showingDetail = false;
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private observer: ResizeObserver | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: PanelDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return PUBLISH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Publish manager';
  }

  override getIcon(): string {
    return 'send';
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('note-publisher-panel');

    this.headerEl = root.createDiv({ cls: 'np-header' });
    const body = root.createDiv({ cls: 'np-body' });
    this.listEl = body.createDiv({ cls: 'np-list' });
    this.detailEl = body.createDiv({ cls: 'np-detail' });

    this.observer = new ResizeObserver(() => this.applyWidthClass());
    this.observer.observe(root);

    this.render();
    await this.deps.refresh();
  }

  override async onClose(): Promise<void> {
    this.observer?.disconnect();
    this.observer = null;
  }

  select(shareId: string | null): void {
    this.selected = shareId;
    this.showingDetail = shareId !== null;
    this.render();
  }

  render(): void {
    const scan = this.deps.scan();
    this.applyWidthClass();
    this.renderHeader(scan);
    this.renderList(scan);
    void this.renderDetail(scan);
  }

  private applyWidthClass(): void {
    const narrow = this.contentEl.clientWidth > 0 && this.contentEl.clientWidth < NARROW_PX;
    this.contentEl.toggleClass('np-narrow', narrow);
    this.contentEl.toggleClass('np-showing-detail', narrow && this.showingDetail);
  }

  // ── header ────────────────────────────────────────────────────────────────

  private renderHeader(scan: ScanResult | null): void {
    const header = this.headerEl;
    header.empty();

    header.createEl('h3', { text: 'Publish manager', cls: 'np-header-title' });

    const right = header.createDiv({ cls: 'np-header-actions' });

    const refreshed = right.createSpan({ cls: 'np-muted' });
    refreshed.setText(scan ? `⟳ ${relativeTime(scan.scannedAt)}` : '⟳ never');
    refreshed.onclick = () => void this.deps.refresh();

    if (scan && !scan.remote.complete && scan.remote.error) {
      const warn = right.createSpan({ cls: 'np-warning-inline' });
      warn.setText('remote partial');
      warn.title = scan.remote.error;
    }

    const pending = scan
      ? scan.entries.filter((entry) => entry.status === 'staged' || entry.status === 'removing').length
      : 0;

    const push = right.createEl('button', {
      cls: 'mod-cta np-push',
      text: pending > 0 ? `↑ Push (${pending})` : '↑ Push',
    });
    push.disabled = !scan?.git.ready || pending === 0;
    if (scan && !scan.git.ready && scan.git.reason) push.title = scan.git.reason;
    push.onclick = () => void this.deps.review();

    if (scan && !scan.git.ready && scan.git.reason) {
      header.createDiv({ cls: 'np-banner', text: scan.git.reason });
    }
    if (scan?.git.root && !scan.git.pendingIgnored) {
      // The gitignore entry is what makes it impossible for auto-commit tooling
      // to publish unreviewed content (§3.3). Missing, the central guarantee is
      // silently absent.
      header.createDiv({
        cls: 'np-banner np-banner-danger',
        text:
          '.publish-pending/ is NOT gitignored. Auto-commit tooling can publish unreviewed ' +
          'notes. Add `.publish-pending/` to your .gitignore before staging anything else.',
      });
    }
  }

  // ── master list ───────────────────────────────────────────────────────────

  private renderList(scan: ScanResult | null): void {
    const list = this.listEl;
    list.empty();

    const search = list.createEl('input', {
      cls: 'np-filter',
      attr: { type: 'search', placeholder: 'Filter…' },
    });
    search.value = this.filter;
    search.oninput = () => {
      this.filter = search.value;
      this.renderList(this.deps.scan());
    };

    if (!scan) {
      list.createDiv({ cls: 'np-muted np-empty', text: 'Scanning…' });
      return;
    }

    const needle = this.filter.trim().toLowerCase();
    const visible = scan.entries.filter(
      (entry) => !needle || entry.title.toLowerCase().includes(needle) || entry.shareId.includes(needle),
    );

    if (visible.length === 0) {
      list.createDiv({
        cls: 'np-muted np-empty',
        text: needle ? 'Nothing matches that filter.' : 'Nothing is staged yet.',
      });
      return;
    }

    for (const status of STATUS_ORDER) {
      const group = visible.filter((entry) => entry.status === status);
      if (group.length === 0) continue;

      list.createDiv({
        cls: `np-group np-group-${status}`,
        text: `${STATUS_LABELS[status].toUpperCase()} (${group.length})`,
      });

      for (const entry of group) {
        const row = list.createDiv({ cls: 'np-row' });
        row.toggleClass('is-selected', entry.shareId === this.selected);
        row.createSpan({ cls: `np-glyph np-glyph-${status}`, text: STATUS_GLYPH[status] });
        row.createSpan({ cls: 'np-row-title', text: entry.title });
        row.onclick = () => this.select(entry.shareId);
        row.oncontextmenu = (event) => this.rowMenu(event, entry);
      }
    }
  }

  private rowMenu(event: MouseEvent, entry: NoteEntry): void {
    event.preventDefault();
    const menu = new Menu();
    buildEntryMenu(menu, entry, this.deps);
    menu.showAtMouseEvent(event);
  }

  // ── detail ────────────────────────────────────────────────────────────────

  private async renderDetail(scan: ScanResult | null): Promise<void> {
    const detail = this.detailEl;
    detail.empty();

    const entry = scan && this.selected ? scan.byShareId.get(this.selected) : null;
    if (!entry) {
      detail.createDiv({ cls: 'np-muted np-empty', text: 'Select a note.' });
      return;
    }

    if (this.contentEl.hasClass('np-narrow')) {
      const back = detail.createEl('button', { cls: 'np-back', text: '← Back' });
      back.onclick = () => this.select(null);
    }

    detail.createEl('h3', { text: entry.title, cls: 'np-detail-title' });

    const urlRow = detail.createDiv({ cls: 'np-url-row' });
    urlRow.createSpan({ cls: 'np-url', text: entry.url.replace(/^https?:\/\//, '') });
    const copy = urlRow.createEl('button', { cls: 'np-icon-button', attr: { 'aria-label': 'Copy link' } });
    setIcon(copy, 'copy');
    copy.onclick = () => void this.deps.actions.copyLink(entry.shareId);

    const facts = detail.createDiv({ cls: 'np-facts' });
    this.fact(facts, 'Status', `${STATUS_LABELS[entry.status]} · ${entry.detail.explanation}`);
    if (entry.file) {
      const value = this.fact(facts, 'Source', entry.file.path);
      value.addClass('np-link');
      value.onclick = () => {
        void this.app.workspace.getLeaf(false).openFile(entry.file!);
      };
    }
    if (entry.stagedAt) this.fact(facts, 'Staged', relativeTime(Date.parse(entry.stagedAt)));
    if (entry.assets.length > 0) this.fact(facts, 'Assets', `${entry.assets.length} file(s)`);
    if (entry.claimants.length > 1) {
      this.fact(facts, 'Claimed by', entry.claimants.map((file) => file.path).join(', '));
    }

    // Degraded-link warnings appear as the actual list of dropped links, not
    // just a count (§3.4). This matters more than the dropping rule itself —
    // the rule is a default, the list is how you notice when the default was
    // wrong for a particular note.
    if (entry.file) {
      const dropped = await droppedLinksFor(this.app, this.deps.settings, entry.file);
      if (dropped.length > 0) {
        const box = detail.createDiv({ cls: 'np-dropped' });
        box.createDiv({
          cls: 'np-dropped-head',
          text: `⚠ ${dropped.length} link${dropped.length === 1 ? '' : 's'} dropped during staging`,
        });
        for (const link of dropped) {
          box.createDiv({ cls: 'np-dropped-item', text: `${link.raw} — ${describeDrop(link)}` });
        }
      }
    }

    // The one way a published page goes wrong without its own note changing:
    // unpublish A, and every note linking to A keeps a `/n/<A>` link that now
    // 404s. Stale cannot see it, because Stale compares this note's own source
    // hash and removing a different note does not touch that — so without this
    // the page stays broken with nothing on screen saying so.
    if (entry.danglingLinks.length > 0) {
      const count = entry.danglingLinks.length;
      const box = detail.createDiv({ cls: 'np-dangling' });
      box.createDiv({
        cls: 'np-dangling-head',
        text:
          `⚠ ${count} link${count === 1 ? '' : 's'} to ${count === 1 ? 'a page' : 'pages'} that ` +
          `${count === 1 ? 'is' : 'are'} no longer published`,
      });
      box.createDiv({
        cls: 'np-dangling-note',
        text: 'The live page still points at these. Re-stage and push to drop them.',
      });
      for (const id of entry.danglingLinks) {
        box.createDiv({ cls: 'np-dangling-item', text: `/n/${id} — 404` });
      }
    }

    const contents =
      (await this.deps.store.readPending(entry.shareId)) ??
      (await this.deps.store.readPublished(entry.shareId));
    if (contents) {
      const details = detail.createEl('details', { cls: 'np-diff' });
      details.createEl('summary', { text: 'Staged markdown' });
      details.createEl('pre').createEl('code', { text: contents });
    }

    this.renderActions(detail, entry);
  }

  private fact(parent: HTMLElement, label: string, value: string): HTMLElement {
    const row = parent.createDiv({ cls: 'np-fact' });
    row.createSpan({ cls: 'np-fact-label', text: label });
    return row.createSpan({ cls: 'np-fact-value', text: value });
  }

  /**
   * Detail-pane actions are state-dependent and use the same labels as the
   * context menu (§3.4, §3.10). A Staged note offers **Unstage**; a Live note
   * offers **Stage for removal** instead, because those are different
   * operations on different things.
   */
  private renderActions(parent: HTMLElement, entry: NoteEntry): void {
    const bar = parent.createDiv({ cls: 'np-actions' });

    const button = (label: string, handler: () => void, cta = false) => {
      const el = bar.createEl('button', { text: label });
      if (cta) el.addClass('mod-cta');
      el.onclick = handler;
      return el;
    };

    for (const action of actionsFor(entry)) {
      button(action.label, () => void action.run(this.deps), action.primary);
    }
  }
}

// ── the one place action availability is decided ─────────────────────────────

export interface EntryAction {
  label: string;
  primary?: boolean;
  run: (deps: PanelDeps) => Promise<void> | void;
}

/**
 * State-dependent items, because offering a publish action on something
 * already published is how people accidentally create duplicates (§3.10).
 *
 * This governs *presentation only*. Every guard that matters lives in
 * `Actions`, because the command palette cannot be state-filtered (§3.6).
 */
export function actionsFor(entry: NoteEntry): EntryAction[] {
  const copy: EntryAction = {
    label: 'Copy public link',
    run: (deps) => deps.actions.copyLink(entry.shareId),
  };
  const open: EntryAction = {
    label: 'Open published page',
    run: (deps) => deps.actions.openPublished(entry.shareId),
  };
  const openNote: EntryAction = {
    label: 'Open note',
    run: async (deps) => {
      if (entry.file) await deps.app.workspace.getLeaf(false).openFile(entry.file);
    },
  };
  const restage: EntryAction = {
    label: 'Re-stage',
    primary: true,
    run: async (deps) => {
      if (entry.file) await deps.actions.restage(entry.file);
    },
  };
  const unstage: EntryAction = {
    label: 'Unstage',
    run: async (deps) => {
      if (entry.file) await deps.actions.unstage(entry.file);
    },
  };
  const remove: EntryAction = {
    label: 'Stage for removal',
    run: (deps) => deps.actions.stageForRemoval(entry.shareId),
  };

  switch (entry.status) {
    case 'staged':
      return [restage, unstage, openNote];
    case 'building':
      return [copy, openNote];
    case 'stale':
      return [restage, copy, remove];
    case 'unstaged':
      return [restage, unstage, openNote];
    case 'live':
      return [copy, open, restage, remove];
    case 'removing':
      return [openNote];
    case 'orphan':
      // No note to right-click, which is one more reason the panel is the
      // primary surface (§3.10).
      return [
        open,
        {
          label: 'Stage for removal (permanent)',
          run: (deps) => deps.actions.stageForRemoval(entry.shareId),
        },
      ];
    case 'conflict':
      return [openNote];
    case 'issue':
      return [restage, openNote];
  }
}

export function buildEntryMenu(menu: Menu, entry: NoteEntry, deps: PanelDeps): void {
  for (const action of actionsFor(entry)) {
    menu.addItem((item) => item.setTitle(action.label).onClick(() => void action.run(deps)));
  }
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle('Copy share_id')
      .onClick(() => void navigator.clipboard.writeText(entry.shareId).then(() => new Notice('Copied'))),
  );
}

function relativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp === 0) return 'never';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
