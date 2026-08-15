/**
 * File and editor context menus (§3.10).
 *
 * **Off by default and enabled in settings** — context menus are crowded, and
 * a plugin that quietly colonises them is a bad citizen.
 *
 * Items are state-dependent, because offering a publish action on something
 * already published is how people accidentally create duplicates. The labels
 * are **stage** language, matching the panel and the palette: nothing here
 * reaches the internet, and a label that implied otherwise would need
 * compensating notice copy to walk it back.
 */

import { Notice } from 'obsidian';
import type { App, Menu, TFile } from 'obsidian';
import type { NoteStatus } from '@notes/shared';
import type { Actions } from '../actions.js';
import type { PublisherSettings } from '../settings.js';
import type { ScanResult } from '../state/scan.js';
import { readFrontmatter } from '../vault/frontmatter.js';

export interface ContextMenuDeps {
  app: App;
  settings: PublisherSettings;
  actions: Actions;
  scan: () => ScanResult | null;
  reveal: (shareId: string) => void;
  review: () => Promise<void>;
}

export function buildFileMenu(menu: Menu, files: TFile[], deps: ContextMenuDeps): void {
  const notes = files.filter((file) => file.extension === 'md');
  if (notes.length === 0) return;

  if (notes.length > 1) {
    // Multi-select through the `files-menu` event. Each file runs the same
    // per-note validation from §3.7, and the result is reported as one summary
    // rather than a burst of notices. Folders are deliberately excluded (§13):
    // a single right-click that could expose dozens of notes is the worst
    // available accident in this design.
    menu.addItem((item) =>
      item
        .setTitle(`Stage ${notes.length} notes for publishing`)
        .setIcon('send')
        .onClick(() => void stageMany(notes, deps)),
    );
    return;
  }

  const file = notes[0] as TFile;
  const status = statusOf(file, deps);
  const shareId = readFrontmatter(deps.app, file, deps.settings.properties).shareId;

  for (const item of itemsFor(status)) {
    menu.addItem((menuItem) =>
      menuItem
        .setTitle(item.label)
        .setIcon(item.icon)
        .onClick(() => void run(item.id, file, shareId, deps)),
    );
  }
}

type ItemId =
  | 'stage'
  | 'restage'
  | 'unstage'
  | 'remove'
  | 'copy'
  | 'open'
  | 'reveal';

interface MenuItemSpec {
  id: ItemId;
  label: string;
  icon: string;
}

const ITEMS: Record<ItemId, MenuItemSpec> = {
  stage: { id: 'stage', label: 'Stage for publishing', icon: 'send' },
  restage: { id: 'restage', label: 'Re-stage', icon: 'refresh-cw' },
  unstage: { id: 'unstage', label: 'Unstage', icon: 'undo' },
  remove: { id: 'remove', label: 'Stage for removal', icon: 'trash-2' },
  copy: { id: 'copy', label: 'Copy public link', icon: 'copy' },
  open: { id: 'open', label: 'Open published page', icon: 'external-link' },
  reveal: { id: 'reveal', label: 'Reveal in publish manager', icon: 'list' },
};

/**
 * §3.10's table. Orphans are absent by definition — there is no note to
 * right-click — which is one more reason the panel is the primary surface and
 * the context menu a shortcut to it.
 */
function itemsFor(status: NoteStatus | null): MenuItemSpec[] {
  switch (status) {
    case null:
      return [ITEMS.stage];
    case 'staged':
      return [ITEMS.copy, ITEMS.unstage, ITEMS.reveal];
    case 'unstaged':
      return [ITEMS.restage, ITEMS.unstage, ITEMS.reveal];
    case 'live':
      return [ITEMS.copy, ITEMS.open, ITEMS.restage, ITEMS.remove];
    case 'stale':
      return [ITEMS.restage, ITEMS.copy, ITEMS.remove];
    case 'building':
      return [ITEMS.copy, ITEMS.reveal];
    case 'removing':
      return [ITEMS.reveal];
    case 'conflict':
    case 'issue':
      return [ITEMS.reveal];
    default:
      return [ITEMS.stage];
  }
}

function statusOf(file: TFile, deps: ContextMenuDeps): NoteStatus | null {
  const shareId = readFrontmatter(deps.app, file, deps.settings.properties).shareId;
  if (!shareId) return null;
  return deps.scan()?.byShareId.get(shareId)?.status ?? null;
}

async function run(
  id: ItemId,
  file: TFile,
  shareId: string | null,
  deps: ContextMenuDeps,
): Promise<void> {
  switch (id) {
    case 'stage':
    case 'restage': {
      const result = await deps.actions.stageForPublishing(file);
      // "Open review after staging from the context menu" (default off) closes
      // the gap for anyone who wants immediacy — right-click, then confirm.
      // Two clicks with the gate intact. This option exists specifically so
      // there is a supported path to fast publishing that does not require
      // weakening the review gate later (§3.10).
      if (result.ok && deps.settings.openReviewAfterContextStage) await deps.review();
      return;
    }
    case 'unstage':
      await deps.actions.unstage(file);
      return;
    case 'remove':
      if (shareId) await deps.actions.stageForRemoval(shareId);
      return;
    case 'copy':
      if (shareId) await deps.actions.copyLink(shareId);
      return;
    case 'open':
      if (shareId) deps.actions.openPublished(shareId);
      return;
    case 'reveal':
      if (shareId) deps.reveal(shareId);
      return;
  }
}

async function stageMany(files: TFile[], deps: ContextMenuDeps): Promise<void> {
  let ok = 0;
  const failed: string[] = [];

  for (const file of files) {
    const result = await deps.actions.stageForPublishing(file, { silent: true });
    if (result.ok) ok++;
    else failed.push(file.basename);
  }

  new Notice(
    failed.length === 0
      ? `Staged ${ok} note(s). ${ok} change(s) waiting.`
      : `Staged ${ok}; ${failed.length} could not be staged: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`,
    10_000,
  );
}
