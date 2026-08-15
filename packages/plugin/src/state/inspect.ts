/**
 * Detail-pane facts that are cheap to recompute and not worth storing.
 *
 * §3.4 is explicit that no local state file is required — the panel must be
 * correct immediately after a fresh install or a sync from another machine.
 * Dropped links are the one thing the panel shows that is not derivable from
 * the three hashes, so rather than persisting them at stage time (which would
 * reintroduce exactly the state file the design removed), they are recomputed
 * for the one note being inspected.
 */

import { splitFrontmatter } from '@notes/shared';
import type { DroppedLink } from '@notes/shared';
import type { App, TFile } from 'obsidian';
import { resolveLinks } from '../staging/links.js';
import { VaultStagingContext } from '../staging/vaultContext.js';
import type { PublisherSettings } from '../settings.js';

export async function droppedLinksFor(
  app: App,
  settings: PublisherSettings,
  file: TFile,
): Promise<DroppedLink[]> {
  const source = await app.vault.cachedRead(file);
  const { body } = splitFrontmatter(source);
  // Dataview is deliberately not run here: this is an inspection, and
  // materializing a query has side effects worth reserving for staging.
  const ctx = new VaultStagingContext(app, settings, null);
  return resolveLinks(body, ctx, file.path).dropped;
}

export function describeDrop(link: DroppedLink): string {
  switch (link.reason) {
    case 'unpublished':
      return 'target is not published';
    case 'alias-matches-title':
      return 'alias matched the target’s title, so it would have leaked it';
    case 'unresolved':
      return 'target does not resolve';
  }
}
