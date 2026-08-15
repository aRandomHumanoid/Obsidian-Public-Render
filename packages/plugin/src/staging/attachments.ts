/**
 * §3.7 step 6 — collect attachments referenced with standard markdown syntax.
 *
 * Obsidian embeds (`![[image.png]]`) are handled during the transclusion pass,
 * because that is where an embed's target is resolved. This covers the other
 * spelling: `![alt](path/to/image.png)`, which Obsidian also honours and which
 * arrives from pasted content and from notes written outside Obsidian.
 *
 * Anything that does not resolve to a vault file is left exactly as written —
 * an external `https://` image is the author's choice, not something staging
 * should quietly rehost.
 */

import { MarkdownIndex, applySplices } from './ast.js';
import type { Splice } from './ast.js';
import type { StagingContext } from './context.js';

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;

export interface AttachmentResult {
  text: string;
  assets: string[];
}

export async function collectMarkdownImages(
  text: string,
  ctx: StagingContext,
  sourcePath: string,
): Promise<AttachmentResult> {
  const index = MarkdownIndex.parse(text);
  const splices: Splice[] = [];
  const assets: string[] = [];

  for (const match of index.matchesOutsideCode(MARKDOWN_IMAGE)) {
    const start = match.index ?? 0;
    const alt = match[1] ?? '';
    const href = match[2] ?? '';

    // Already staged, or not ours to touch.
    if (href.startsWith('_assets/') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) {
      continue;
    }

    const target = ctx.resolve(decodeURIComponent(href), sourcePath);
    if (!target || target.extension.toLowerCase() === 'md') continue;

    const basename = await ctx.addAsset(target);
    assets.push(basename);
    splices.push({
      start,
      end: start + (match[0] ?? '').length,
      replacement: `![${alt}](_assets/${basename})`,
    });
  }

  return { text: applySplices(text, splices), assets };
}
