/**
 * §3.7 step 4 — inline transclusions, and resolve attachment embeds.
 *
 * **Inline the target's staged output, not its source.** This ordering is
 * load-bearing. Step 3 has already run over the *host* note, so it never sees
 * material that arrives by transclusion. If A transcludes published note B,
 * and B links to unpublished note C, inlining B's raw source would carry C's
 * title — or with a nested embed, C's content — straight into A's published
 * page without ever passing the drop rule. Composing from staged output means
 * B's own staging already handled C.
 *
 * The caller re-runs steps 3 and 5 over the merged result as a backstop
 * (see pipeline.ts). Cheap, and it catches anything a partially-staged or
 * hand-edited target smuggles in.
 */

import type { TFile } from 'obsidian';
import { MarkdownIndex, applySplices } from './ast.js';
import type { Splice } from './ast.js';
import { blockAnchorId } from './blocks.js';
import { parseWikilink } from './links.js';
import { mergeStagedBody } from './context.js';
import type { StagedBody, StagingContext } from './context.js';

const EMBED = /!\[\[([^\[\]]+?)\]\]/g;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'svg']);

export interface EmbedResult {
  text: string;
  merged: StagedBody;
}

export async function inlineEmbeds(
  text: string,
  ctx: StagingContext,
  sourcePath: string,
  chain: string[],
): Promise<EmbedResult> {
  const index = MarkdownIndex.parse(text);
  const splices: Splice[] = [];
  const merged: StagedBody = {
    text: '',
    dropped: [],
    sources: [],
    issues: [],
    assets: [],
    emptyQueries: [],
  };

  for (const match of index.matchesOutsideCode(EMBED)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const end = start + raw.length;
    const link = parseWikilink(true, match[1] ?? '');

    const target = ctx.resolve(link.target, sourcePath);
    if (!target) {
      merged.issues.push({
        severity: 'error',
        code: 'embed-unresolved',
        // A case-mismatched embed is a validation error, not a silent 404
        // (§11.1) — Obsidian resolves case-insensitively on some filesystems
        // and not on others, so this is exactly the kind of thing that works
        // on your machine and breaks in CI.
        message: `embed target ${link.target} does not resolve from ${sourcePath}`,
      });
      splices.push({ start, end, replacement: '' });
      continue;
    }

    const extension = target.extension.toLowerCase();

    if (extension === 'excalidraw' || target.name.endsWith('.excalidraw.md')) {
      const companion = findExcalidrawExport(ctx, sourcePath, target);
      if (!companion) {
        merged.issues.push({
          severity: 'error',
          code: 'excalidraw-no-export',
          message:
            `${target.path} has no exported SVG companion. Enable Excalidraw's auto-export ` +
            `and re-save the drawing, or remove the embed.`,
        });
        splices.push({ start, end, replacement: '' });
        continue;
      }
      const basename = await ctx.addAsset(companion);
      merged.assets.push(basename);
      splices.push({ start, end, replacement: imageMarkdown(basename, target.basename, link.alias) });
      continue;
    }

    if (IMAGE_EXTENSIONS.has(extension)) {
      const basename = await ctx.addAsset(target);
      merged.assets.push(basename);
      splices.push({ start, end, replacement: imageMarkdown(basename, target.basename, link.alias) });
      continue;
    }

    if (extension !== 'md') {
      merged.issues.push({
        severity: 'error',
        code: 'embed-unsupported',
        message: `embeds of .${extension} files are not supported (${target.path})`,
      });
      splices.push({ start, end, replacement: '' });
      continue;
    }

    // ── a note embed: transclusion ─────────────────────────────────────────
    if (chain.includes(target.path)) {
      merged.issues.push({
        severity: 'warning',
        code: 'transclusion-cycle',
        message: `transclusion cycle at ${target.path}; the embed was dropped to terminate it`,
      });
      splices.push({ start, end, replacement: '' });
      continue;
    }

    if (chain.length >= ctx.settings.transclusionDepth) {
      merged.issues.push({
        severity: 'warning',
        code: 'transclusion-depth',
        message: `transclusion depth cap (${ctx.settings.transclusionDepth}) reached at ${target.path}`,
      });
      splices.push({ start, end, replacement: '' });
      continue;
    }

    if (!ctx.publishedShareId(target)) {
      // Dropped entirely, exactly like a link to an unpublished note. An
      // embed carries the target's *content*, so there is no alias-shaped
      // partial disclosure to consider here.
      merged.dropped.push({ raw, target: target.path, reason: 'unpublished' });
      splices.push({ start, end, replacement: '' });
      continue;
    }

    const staged = await ctx.stageBody(target, [...chain, target.path]);
    mergeStagedBody(merged, staged);

    const section = link.subpath ? extractSection(staged.text, link.subpath) : staged.text;
    if (section === null) {
      merged.issues.push({
        severity: 'error',
        code: 'embed-section-missing',
        message: `${target.path} has no section matching ${link.subpath}`,
      });
      splices.push({ start, end, replacement: '' });
      continue;
    }

    splices.push({ start, end, replacement: `\n\n${section.trim()}\n\n` });
  }

  return { text: applySplices(text, splices), merged };
}

function imageMarkdown(basename: string, alt: string, sizeHint?: string): string {
  const width = sizeHint && /^\d+$/.test(sizeHint) ? Number(sizeHint) : null;
  const src = `_assets/${basename}`;
  if (width === null) return `![${escapeAlt(alt)}](${src})`;
  // `![[image.png|300]]` — width preserved as an attribute (§8). Raw HTML is
  // fine here: CI parses it with rehype-raw and then sanitizes it.
  return `<img src="${src}" alt="${escapeAttr(alt)}" width="${width}">`;
}

function escapeAlt(text: string): string {
  return text.replace(/([\[\]])/g, '\\$1');
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Excalidraw embeds require the plugin's auto-exported SVG companion (§8).
 * Three naming conventions are in the wild, so all three are tried before
 * failing.
 */
function findExcalidrawExport(
  ctx: StagingContext,
  sourcePath: string,
  drawing: TFile,
): TFile | null {
  const stem = drawing.name.replace(/\.excalidraw(\.md)?$/i, '').replace(/\.md$/i, '');
  const folder = drawing.parent?.path ?? '';
  const candidates = [
    `${folder}/${stem}.svg`,
    `${folder}/${stem}.excalidraw.svg`,
    `${folder}/${stem}.excalidraw.dark.svg`,
  ].map((path) => path.replace(/^\//, ''));

  for (const candidate of candidates) {
    const file = ctx.resolve(candidate, sourcePath);
    if (file) return file;
  }
  return null;
}

/**
 * Pull one section out of a target's staged output.
 *
 * `#Heading` takes everything from that heading up to the next heading at the
 * same level or higher. `#^blockid` takes the block carrying the anchor that
 * `blocks.ts` already materialised.
 */
export function extractSection(markdown: string, subpath: string): string | null {
  const value = subpath.slice(1);
  if (value.startsWith('^')) return extractBlock(markdown, value.slice(1));
  return extractHeading(markdown, value);
}

function extractHeading(markdown: string, heading: string): string | null {
  const index = MarkdownIndex.parse(markdown);
  const headings = index.matchesOutsideCode(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm);

  const wanted = heading.trim().toLowerCase();
  for (let i = 0; i < headings.length; i++) {
    const match = headings[i] as RegExpMatchArray;
    const level = (match[1] ?? '').length;
    const text = (match[2] ?? '').trim().toLowerCase();
    if (text !== wanted) continue;

    const start = match.index ?? 0;
    let end = markdown.length;
    for (let j = i + 1; j < headings.length; j++) {
      const next = headings[j] as RegExpMatchArray;
      if ((next[1] ?? '').length <= level) {
        end = next.index ?? markdown.length;
        break;
      }
    }
    return markdown.slice(start, end);
  }
  return null;
}

function extractBlock(markdown: string, blockId: string): string | null {
  const anchor = `<span id="${blockAnchorId(blockId)}"></span>`;
  const at = markdown.indexOf(anchor);
  if (at === -1) return null;

  const before = markdown.lastIndexOf('\n\n', at);
  const after = markdown.indexOf('\n\n', at);
  return markdown.slice(before === -1 ? 0 : before + 2, after === -1 ? markdown.length : after);
}
