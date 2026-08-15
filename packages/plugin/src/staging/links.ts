/**
 * §3.7 step 3 — resolve wikilinks.
 *
 *   - Published target → `/n/<id>`
 *   - Unpublished target with an alias that **differs from both the target's
 *     filename and its title** → keep the alias as plain text
 *   - Otherwise → remove the link and its text entirely
 *   - Every removal is recorded and surfaced in the GUI (§3.4)
 *
 * The alias condition exists because Obsidian frequently writes aliases
 * identical to the target's title, and keeping those would leak exactly what
 * the rule is meant to protect.
 *
 * Degraded-link warnings appear in the detail pane as the actual list of
 * dropped links, not just a count. That matters more than the dropping rule
 * itself — the rule is a default, the list is how you notice when the default
 * was wrong for a particular note.
 */

import GithubSlugger from 'github-slugger';
import type { DroppedLink } from '@notes/shared';
import { MarkdownIndex, applySplices } from './ast.js';
import type { Splice } from './ast.js';
import type { StagingContext } from './context.js';
import { blockAnchorId } from './blocks.js';

/** `[[target#heading|alias]]`, but never `![[…]]` — embeds are step 4. */
const WIKILINK = /(!?)\[\[([^\[\]]+?)\]\]/g;

export interface ParsedWikilink {
  embed: boolean;
  /** The path portion, before any `#` or `|`. */
  target: string;
  /** `#Heading`, `#^blockid`, or undefined. */
  subpath?: string;
  alias?: string;
}

export function parseWikilink(embed: boolean, inner: string): ParsedWikilink {
  const pipe = inner.indexOf('|');
  const head = pipe === -1 ? inner : inner.slice(0, pipe);
  const alias = pipe === -1 ? undefined : inner.slice(pipe + 1);

  const hash = head.indexOf('#');
  const target = (hash === -1 ? head : head.slice(0, hash)).trim();
  const subpath = hash === -1 ? undefined : head.slice(hash);

  return { embed, target, subpath, alias: alias?.trim() };
}

export interface LinkResult {
  text: string;
  dropped: DroppedLink[];
}

export function resolveLinks(
  text: string,
  ctx: StagingContext,
  sourcePath: string,
): LinkResult {
  const index = MarkdownIndex.parse(text);
  const splices: Splice[] = [];
  const dropped: DroppedLink[] = [];

  for (const match of index.matchesOutsideCode(WIKILINK)) {
    const start = match.index ?? 0;
    // Embeds belong to step 4; leave them for the transclusion pass.
    if (match[1] === '!') continue;

    const link = parseWikilink(false, match[2] ?? '');
    const raw = match[0];
    const end = start + raw.length;

    const target = ctx.resolve(link.target, sourcePath);

    if (!target) {
      // An unresolvable link points at nothing, so it leaks nothing — but it
      // would render as literal `[[…]]` text, which is worse than absent.
      dropped.push({ raw, reason: 'unresolved' });
      splices.push({ start, end, replacement: link.alias ?? '' });
      continue;
    }

    const shareId = ctx.publishedShareId(target);
    if (shareId) {
      const label = link.alias ?? ctx.noteTitle(target);
      const fragment = link.subpath ? anchorFor(link.subpath) : '';
      splices.push({
        start,
        end,
        replacement: `[${escapeLinkText(label)}](/n/${shareId}${fragment})`,
      });
      continue;
    }

    // Unpublished. The alias survives only if it reveals nothing the rule is
    // there to hide.
    const filename = target.basename;
    const title = ctx.noteTitle(target);
    const aliasIsSafe =
      link.alias !== undefined &&
      normalize(link.alias) !== normalize(filename) &&
      normalize(link.alias) !== normalize(title);

    if (aliasIsSafe) {
      splices.push({ start, end, replacement: link.alias as string });
      dropped.push({ raw, target: target.path, reason: 'unpublished' });
      continue;
    }

    dropped.push({
      raw,
      target: target.path,
      reason: link.alias === undefined ? 'unpublished' : 'alias-matches-title',
    });
    splices.push({ start, end, replacement: '' });
  }

  return { text: applySplices(text, splices), dropped };
}

/**
 * `#Heading` becomes a GitHub-style slug, matching what `rehype-slug` will
 * generate for the same heading at render time (§5.4). `#^blockid` becomes the
 * anchor the target's own staging emitted for that block (§8).
 */
export function anchorFor(subpath: string): string {
  const value = subpath.slice(1);
  if (value.startsWith('^')) return `#${blockAnchorId(value.slice(1))}`;
  const slugger = new GithubSlugger();
  return `#${slugger.slug(value)}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** Markdown link text may not contain unescaped brackets. */
function escapeLinkText(text: string): string {
  return text.replace(/([\[\]])/g, '\\$1');
}
