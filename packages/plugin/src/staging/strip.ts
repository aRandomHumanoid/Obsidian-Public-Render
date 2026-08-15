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
 *
 * ## Why pairing is also *validated*
 *
 * Excluding code is necessary but not sufficient. Any `%%` the author did not
 * intend as a delimiter — `50%%` written as a doubled percent sign, a `%%` in
 * a `$…$` math span, a stray marker left by an edit — shifts every pairing
 * after it by one. The damage is not that too much is removed; it is that the
 * *interior of a real comment* ends up outside the removed span and gets
 * published, while the check in `@notes/shared` sees nothing wrong because no
 * `%%` survives — only the private text between them does.
 *
 * So each pair is checked against the two shapes Obsidian actually documents:
 *
 *   - an **inline** comment, `%%…%%`, which lives inside one block; or
 *   - a **block** comment, whose opening `%%` is alone on its line.
 *
 * A pair that is neither — an opener sharing its line with other text, closing
 * only after a blank line — is exactly the shape a mis-pair takes, and is
 * indistinguishable from one. It is reported as ambiguous and the caller
 * refuses to write (§3.7 step 7). That is the fail-closed direction: a note
 * that has to be rewritten is recoverable, a published comment is not.
 */

import { MarkdownIndex, applySplices } from './ast.js';
import type { Splice } from './ast.js';

export interface AmbiguousComment {
  /** 1-based line of the opening delimiter, for a message a human must act on. */
  line: number;
  /** The line's text, trimmed, so the report points somewhere. */
  context: string;
}

export interface StripResult {
  text: string;
  removed: number;
  /** An unclosed `%%` dropped everything after it. Reported, never silent. */
  unterminated: boolean;
  /**
   * Pairs whose shape means the pairing cannot be trusted. Non-empty means the
   * output may carry comment *content*, so the caller must not write it.
   */
  ambiguous: AmbiguousComment[];
}

export function stripComments(text: string): StripResult {
  const index = MarkdownIndex.parse(text);
  const markers = index.matchesOutsideCode(/%%/).map((m) => m.index ?? 0);

  const splices: Splice[] = [];
  const ambiguous: AmbiguousComment[] = [];
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
    if (!isPlausiblePair(text, open, close)) {
      ambiguous.push(describe(text, open));
    }
    splices.push({ start: open, end: close + 2, replacement: '' });
  }

  const stripped = applySplices(text, splices);

  return {
    text: tidyBlankLines(stripped),
    removed: splices.length,
    unterminated,
    ambiguous,
  };
}

/**
 * A pair is trustworthy when it is one of the two shapes Obsidian documents:
 * a block comment, whose opener is alone on its line and may therefore span
 * anything; or an inline comment, which must close before the block does.
 */
function isPlausiblePair(text: string, open: number, close: number): boolean {
  if (isAloneOnLine(text, open)) return true;
  // No blank line between the two means they are still in the same block.
  return !/\n[ \t]*\r?\n/.test(text.slice(open + 2, close));
}

function isAloneOnLine(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const newline = text.indexOf('\n', at);
  const lineEnd = newline === -1 ? text.length : newline;
  return text.slice(lineStart, at).trim() === '' && text.slice(at + 2, lineEnd).trim() === '';
}

function describe(text: string, at: number): AmbiguousComment {
  const before = text.slice(0, at);
  const lineStart = before.lastIndexOf('\n') + 1;
  const newline = text.indexOf('\n', at);
  return {
    line: before.split('\n').length,
    context: text.slice(lineStart, newline === -1 ? text.length : newline).trim(),
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
