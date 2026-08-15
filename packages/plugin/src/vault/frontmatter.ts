/**
 * Reading and writing the source note's frontmatter (§4.1).
 *
 * The vault is the source of truth. The plugin manages these keys;
 * hand-editing is supported. Neither CI nor the worker ever writes to the
 * vault — the plugin is the only writer.
 */

import { isShareId, normalizeShareId } from '@notes/shared';
import type { PropertyNames } from '@notes/shared';
import type { App, TFile } from 'obsidian';

export interface NoteFrontmatter {
  publish: boolean;
  shareId: string | null;
  title: string | null;
  indexable: boolean;
  download: boolean;
  /** `publish_ack` values, as a set of query hashes (§9). */
  acknowledged: Set<string>;
}

export function readFrontmatter(
  app: App,
  file: TFile,
  names: PropertyNames,
): NoteFrontmatter {
  const cache = app.metadataCache.getFileCache(file);
  const raw = (cache?.frontmatter ?? {}) as Record<string, unknown>;

  const rawShareId = raw[names.shareId];
  const shareId =
    typeof rawShareId === 'string' && isShareId(normalizeShareId(rawShareId))
      ? normalizeShareId(rawShareId)
      : null;

  const ack = raw[names.ack];
  const acknowledged = new Set<string>(
    Array.isArray(ack) ? ack.map(String) : typeof ack === 'string' ? [ack] : [],
  );

  return {
    publish: raw[names.publish] === true,
    shareId,
    title: typeof raw[names.title] === 'string' ? (raw[names.title] as string) : null,
    // Defaults from §4.1: do not index, do offer the download.
    indexable: raw[names.index] === true,
    download: raw[names.download] !== false,
    acknowledged,
  };
}

/**
 * The display title: the `title` property, then the first H1, then the
 * filename (§4.1).
 */
export function resolveTitle(app: App, file: TFile, names: PropertyNames): string {
  const cache = app.metadataCache.getFileCache(file);
  const explicit = (cache?.frontmatter as Record<string, unknown> | undefined)?.[names.title];
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();

  const h1 = cache?.headings?.find((heading) => heading.level === 1);
  if (h1?.heading.trim()) return h1.heading.trim();

  return file.basename;
}

export interface FrontmatterPatch {
  publish?: boolean;
  shareId?: string;
  /** Append a `publish_ack` hash. */
  acknowledge?: string[];
  /** Remove the plugin's keys entirely (Unstage). */
  clear?: boolean;
}

/**
 * Apply a patch through `processFrontMatter`, which is the only supported way
 * to edit frontmatter without reformatting the rest of the note.
 *
 * `publish: false` rather than deleting the property, because it keeps
 * `share_id` in the note — staging it for publishing again later restores the
 * **same URL**. CI treats `false` and absent identically (§3.6).
 */
export async function patchFrontmatter(
  app: App,
  file: TFile,
  names: PropertyNames,
  patch: FrontmatterPatch,
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    if (patch.clear) {
      delete frontmatter[names.publish];
      delete frontmatter[names.shareId];
      delete frontmatter[names.ack];
      return;
    }
    if (patch.shareId !== undefined) frontmatter[names.shareId] = patch.shareId;
    if (patch.publish !== undefined) frontmatter[names.publish] = patch.publish;
    if (patch.acknowledge && patch.acknowledge.length > 0) {
      const existing = frontmatter[names.ack];
      const current = Array.isArray(existing)
        ? existing.map(String)
        : typeof existing === 'string'
          ? [existing]
          : [];
      frontmatter[names.ack] = [...new Set([...current, ...patch.acknowledge])];
    }
  });
}
