/**
 * Block references (§8).
 *
 * `[[Note^blockid]]` is documented as "resolved to the block if published".
 * For that to mean anything the *target* has to carry an anchor, because a
 * block id is Obsidian syntax with no rendered form — left alone it would
 * publish as the literal text `^abc123` at the end of a paragraph.
 *
 * So staging does both halves: it turns each trailing block id into an empty
 * anchor span, and `links.ts` points fragments at the same id.
 */

import { MarkdownIndex, applySplices } from './ast.js';
import type { Splice } from './ast.js';

/** Prefixed so a block id can never collide with a heading slug. */
export function blockAnchorId(blockId: string): string {
  return `b-${blockId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

const TRAILING_BLOCK_ID = /^(.*\S)[ \t]+\^([A-Za-z0-9-]+)[ \t]*$/gm;

export interface BlockAnchorResult {
  text: string;
  ids: string[];
}

export function materializeBlockAnchors(text: string): BlockAnchorResult {
  const index = MarkdownIndex.parse(text);
  const splices: Splice[] = [];
  const ids: string[] = [];

  for (const match of index.matchesOutsideCode(TRAILING_BLOCK_ID)) {
    const start = match.index ?? 0;
    const content = match[1] ?? '';
    const blockId = match[2] ?? '';
    ids.push(blockId);
    splices.push({
      start,
      end: start + (match[0] ?? '').length,
      replacement: `${content} <span id="${blockAnchorId(blockId)}"></span>`,
    });
  }

  return { text: applySplices(text, splices), ids };
}
