/**
 * Code-aware markdown scanning.
 *
 * This exists to serve §11.2's two assertions, which are in deliberate
 * tension: no `%%` sequence may survive into a published artifact, *and*
 * fenced code blocks must round-trip byte-identically. A regex that strips
 * `%%…%%` from raw text satisfies the first while violating the second — and
 * worse, mis-pairs delimiters across unrelated markers, silently swallowing
 * real content in between. Every check here is therefore structure-aware:
 * "outside code" is computed, never assumed.
 *
 * The staging pipeline itself strips comments on the remark AST (§3.7 step 5).
 * This module is the independent verifier, so it is written from scratch
 * rather than sharing that machinery — a bug in the stripper should not be
 * able to hide in the check that is supposed to catch it.
 */

export interface Region {
  start: number;
  end: number;
}

export interface FencedBlock {
  /** The complete block, opening and closing fence lines included. */
  raw: string;
  /** Content between the fences. */
  content: string;
  /** The info string on the opening fence, trimmed. */
  info: string;
  start: number;
  end: number;
}

export interface FrontmatterSplit {
  /** Raw YAML between the delimiters, or null if the document has none. */
  frontmatter: string | null;
  /** Everything after the closing delimiter. */
  body: string;
  /** Offset in the original string where `body` begins. */
  bodyOffset: number;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * The closing delimiter of a frontmatter block, which YAML and Obsidian both
 * require at **column 0**.
 *
 * Matching a *trimmed* line here would be a confidentiality bug, not a
 * looseness: a block scalar's continuation lines are necessarily indented, so
 *
 *     ---
 *     description: |
 *       intro
 *       ---          ← indented, and part of the scalar
 *     client: Acme
 *     ---
 *
 * would close on the inner line, and every property after it — `client` —
 * would become the first line of the *body* and publish as ordinary text. The
 * allowlist cannot catch that: by then the offending keys are not frontmatter
 * at all, and both the plugin's self-check and CI's re-verification inspect
 * only the first block, which is the clean generated metadata (§3.2, §4.1).
 *
 * Trailing whitespace is still tolerated, because YAML permits it and an
 * editor may leave it behind.
 */
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/;

/**
 * Split a leading YAML frontmatter block off a document.
 *
 * Only recognises a block that starts at byte 0, which is what both Obsidian
 * and the staged-file format require.
 */
export function splitFrontmatter(md: string): FrontmatterSplit {
  if (!md.startsWith('---')) return { frontmatter: null, body: md, bodyOffset: 0 };

  const firstLineEnd = md.indexOf('\n');
  if (firstLineEnd === -1) return { frontmatter: null, body: md, bodyOffset: 0 };
  if (md.slice(0, firstLineEnd).trim() !== '---') {
    return { frontmatter: null, body: md, bodyOffset: 0 };
  }

  const lines = md.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (FRONTMATTER_CLOSE.test(line)) {
      const frontmatter = lines.slice(1, i).join('\n');
      const consumed = lines.slice(0, i + 1).join('\n').length + 1;
      return {
        frontmatter,
        body: md.slice(Math.min(consumed, md.length)),
        bodyOffset: Math.min(consumed, md.length),
      };
    }
  }

  // An unterminated block is not frontmatter; treat the whole thing as body.
  return { frontmatter: null, body: md, bodyOffset: 0 };
}

interface LineSpan {
  text: string;
  start: number;
  end: number;
}

function splitLines(md: string): LineSpan[] {
  const out: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i <= md.length; i++) {
    if (i === md.length || md[i] === '\n') {
      out.push({ text: md.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  return out;
}

/**
 * Regions occupied by block-level code: fenced blocks and indented blocks.
 *
 * Indented-code detection follows CommonMark closely enough for this purpose:
 * a 4-space or tab indent only opens a code block when it does not continue a
 * paragraph. Getting this wrong in the permissive direction would let a `%%`
 * leak past the check, so the rule errs toward treating text as *not* code.
 */
export function blockCodeRegions(md: string): Region[] {
  const regions: Region[] = [];
  const lines = splitLines(md);

  let fence: { char: string; len: number; start: number } | null = null;
  let indented: { start: number; end: number } | null = null;
  let prevBlank = true;

  const flushIndented = () => {
    if (indented) {
      regions.push({ start: indented.start, end: indented.end });
      indented = null;
    }
  };

  for (const line of lines) {
    const blank = line.text.trim() === '';

    if (fence) {
      const close = line.text.match(FENCE_OPEN);
      const isClose =
        close &&
        (close[2] ?? '')[0] === fence.char &&
        (close[2] ?? '').length >= fence.len &&
        (close[3] ?? '').trim() === '';
      if (isClose) {
        regions.push({ start: fence.start, end: line.end });
        fence = null;
      }
      continue;
    }

    const open = line.text.match(FENCE_OPEN);
    if (open) {
      const marker = open[2] ?? '';
      const info = open[3] ?? '';
      // A backtick fence's info string may not contain a backtick.
      if (!(marker[0] === '`' && info.includes('`'))) {
        flushIndented();
        fence = { char: marker[0] as string, len: marker.length, start: line.start };
        prevBlank = false;
        continue;
      }
    }

    const isIndented = /^(?: {4}|\t)/.test(line.text) && line.text.trim() !== '';
    if (isIndented && (prevBlank || indented)) {
      indented = indented ? { start: indented.start, end: line.end } : { start: line.start, end: line.end };
    } else if (blank && indented) {
      // A blank line inside an indented block does not terminate it; it is
      // only trailing blanks that get trimmed off, which we approximate by
      // extending and letting the next non-indented line close it.
      indented = { start: indented.start, end: indented.end };
    } else if (!isIndented && !blank) {
      flushIndented();
    }

    prevBlank = blank;
  }

  // An unclosed fence runs to end of document — still code.
  if (fence) regions.push({ start: fence.start, end: md.length });
  flushIndented();

  return mergeRegions(regions);
}

function mergeRegions(regions: Region[]): Region[] {
  if (regions.length === 0) return [];
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const out: Region[] = [sorted[0] as Region];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i] as Region;
    const last = out[out.length - 1] as Region;
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

/**
 * Every region of the document that is code: block-level plus inline spans.
 *
 * Inline spans are found only in the gaps between block-code regions, and
 * follow the CommonMark rule that a run of N backticks closes on the next run
 * of exactly N.
 */
export function codeRegions(md: string): Region[] {
  const blocks = blockCodeRegions(md);
  const regions: Region[] = [...blocks];

  const inBlock = (i: number) => blocks.some((r) => i >= r.start && i < r.end);

  let i = 0;
  while (i < md.length) {
    if (md[i] !== '`' || inBlock(i)) {
      i++;
      continue;
    }
    let runStart = i;
    while (i < md.length && md[i] === '`') i++;
    const runLen = i - runStart;

    // Look for a closing run of exactly runLen.
    let j = i;
    let closed = -1;
    while (j < md.length) {
      if (md[j] === '`' && !inBlock(j)) {
        let k = j;
        while (k < md.length && md[k] === '`') k++;
        if (k - j === runLen) {
          closed = k;
          break;
        }
        j = k;
        continue;
      }
      j++;
    }
    if (closed !== -1) {
      regions.push({ start: runStart, end: closed });
      i = closed;
    }
    // Unmatched run: not a code span, carry on from after it.
  }

  return mergeRegions(regions);
}

export function isInsideRegions(index: number, regions: Region[]): boolean {
  return regions.some((r) => index >= r.start && index < r.end);
}

/** All fenced code blocks in a document, in order. */
export function extractFencedBlocks(md: string): FencedBlock[] {
  const out: FencedBlock[] = [];
  const lines = splitLines(md);
  let open: { char: string; len: number; start: number; info: string; contentStart: number } | null = null;

  for (const line of lines) {
    const m = line.text.match(FENCE_OPEN);
    if (open) {
      const isClose =
        m && (m[2] ?? '')[0] === open.char && (m[2] ?? '').length >= open.len && (m[3] ?? '').trim() === '';
      if (isClose) {
        out.push({
          raw: md.slice(open.start, line.end),
          content: md.slice(open.contentStart, Math.max(open.contentStart, line.start - 1)),
          info: open.info,
          start: open.start,
          end: line.end,
        });
        open = null;
      }
      continue;
    }
    if (m) {
      const marker = m[2] ?? '';
      const info = (m[3] ?? '').trim();
      if (marker[0] === '`' && info.includes('`')) continue;
      open = {
        char: marker[0] as string,
        len: marker.length,
        start: line.start,
        info,
        contentStart: Math.min(line.end + 1, md.length),
      };
    }
  }

  if (open) {
    out.push({
      raw: md.slice(open.start),
      content: md.slice(open.contentStart),
      info: open.info,
      start: open.start,
      end: md.length,
    });
  }

  return out;
}

export interface OutsideCodeMatch {
  index: number;
  text: string;
  /** 1-based line number, for messages a human has to act on. */
  line: number;
  /** The surrounding line, trimmed, so the report points somewhere. */
  context: string;
}

/**
 * Find every occurrence of a pattern that is *not* inside code.
 *
 * The pattern is applied to the whole document and matches are filtered by
 * position, rather than the document being chopped up first — chopping loses
 * the offsets that make the resulting message useful.
 */
export function findOutsideCode(md: string, pattern: RegExp): OutsideCodeMatch[] {
  const regions = codeRegions(md);
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const out: OutsideCodeMatch[] = [];

  for (const m of md.matchAll(re)) {
    const index = m.index ?? 0;
    if (isInsideRegions(index, regions)) continue;
    const before = md.slice(0, index);
    const line = before.split('\n').length;
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineEnd = md.indexOf('\n', index);
    out.push({
      index,
      text: m[0],
      line,
      context: md.slice(lineStart, lineEnd === -1 ? md.length : lineEnd).trim(),
    });
  }

  return out;
}

/**
 * Normalise line endings and trailing whitespace, for hashing and comparison.
 *
 * Trailing blank lines are dropped entirely rather than collapsed to one. An
 * editor that adds or removes a final newline must not mark a note Stale —
 * `source_hash` exists to answer "would this publish differently?", and that
 * answer is no.
 */
export function normalizeText(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/, '');
}
