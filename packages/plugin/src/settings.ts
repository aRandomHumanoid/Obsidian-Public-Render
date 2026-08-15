/**
 * Settings (§3.8).
 */

import { DEFAULT_PROPERTY_NAMES } from '@notes/shared';
import type { PropertyNames } from '@notes/shared';

export type GitMode = 'auto' | 'obsidian-git' | 'system' | 'disabled';
export type PanelPlacement = 'tab' | 'right' | 'left';

export interface PublisherSettings {
  /** e.g. `https://notes.<sub>.workers.dev` (§7.4). */
  baseUrl: string;
  /** Optional (§3.5). Read-only, cannot write, cannot reach the vault. */
  manifestToken: string;
  /** All source-frontmatter keys, configurable to avoid collisions. */
  properties: PropertyNames;
  /** Tracked staging folder. Default `published/`. */
  stagingFolder: string;
  dataview: boolean;
  attachmentWarnBytes: number;
  attachmentFailBytes: number;
  /** Default **off**: restaging on every save means publishing half-finished edits. */
  autoRestageOnSave: boolean;
  refreshIntervalMinutes: number;
  gitMode: GitMode;
  commitMessageTemplate: string;
  /** Default **off** — a plugin that quietly colonises context menus is a bad citizen. */
  fileContextMenu: boolean;
  editorContextMenu: boolean;
  openReviewAfterContextStage: boolean;
  defaultPanelPlacement: PanelPlacement;
  transclusionDepth: number;
}

/**
 * The pending directory is **not** a setting.
 *
 * It is gitignored, and the gitignore entry is what makes it impossible for
 * auto-commit tooling to publish unreviewed content (§3.3). A configurable
 * path is a path that can be pointed somewhere the `.gitignore` does not
 * cover, which turns a structural guarantee back into a convention.
 */
export const PENDING_DIR = '.publish-pending';
export const ASSET_DIR = '_assets';

export const DEFAULT_SETTINGS: PublisherSettings = {
  baseUrl: '',
  manifestToken: '',
  properties: { ...DEFAULT_PROPERTY_NAMES },
  stagingFolder: 'published',
  dataview: true,
  attachmentWarnBytes: 2 * 1024 * 1024,
  attachmentFailBytes: 10 * 1024 * 1024,
  autoRestageOnSave: false,
  refreshIntervalMinutes: 0,
  gitMode: 'auto',
  commitMessageTemplate: 'publish: {summary}',
  fileContextMenu: false,
  editorContextMenu: false,
  openReviewAfterContextStage: false,
  defaultPanelPlacement: 'tab',
  transclusionDepth: 4,
};

export function publicUrl(settings: PublisherSettings, shareId: string): string {
  const base = settings.baseUrl.replace(/\/+$/, '');
  return `${base}/n/${shareId}`;
}
