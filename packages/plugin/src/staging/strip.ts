/**
 * §3.7 step 5 — strip `%%comments%%`.
 *
 * Delimiters are paired only among occurrences the parser says are *not* code.
 * That is the whole difference between this and the regex that looks like it
 * would work: with a fenced block containing a stray `%%`, naive pairing
 * matches the block's marker against the next real comment's opener and eats
 * everything in between (§11.2).
 *
 * Removal is by offset splice, so every byte outside a comment — including
 * that stray `%%` inside the fence — survives untouched.
 */

import { MarkdownIndex, applySplices } from './ast.js';
import type { Splice } from './ast.js';

export interface StripResult {
  text: string;
  removed: number;
  /** An unclosed `%%` dropped everything after it. Reported, never silent. */
  unterminated: boolean;
}

export function stripComments(text: string): StripResult {
  const index = MarkdownIndex.parse(text);
  const markers = index.matchesOutsideCode(/%%/).map((m) => m.index ?? 0);

  const splices: Splice[] = [];
  let unterminated = false;

  for (let i = 0; i < markers.length; i += 2) {
    const open = markers[i] as number;
    const close = markers[i + 1];
    if (close === undefined) {
      // Fail closed: publishing half a comment is worse than publishing too
      // little, and the caller surfaces this rather than swallowing it.
      splices.push({ start: open, end: text.length, replacement: '' });
      unterminated = true;
      break;
    }
    splices.push({ start: open, end: close + 2, replacement: '' });
  }

  const stripped = applySplices(text, splices);

  return {
    text: tidyBlankLines(stripped),
    removed: splices.length,
    unterminated,
  };
}

/**
 * A block comment on its own lines leaves an empty line behind. Collapse runs
 * of three or more newlines rather than trying to be clever about which blank
 * line "belonged" to the comment.
 */
function tidyBlankLines(text: string): string {
  return text.replace(/[ \t]*\n{3,}/g, '\n\n');
}
