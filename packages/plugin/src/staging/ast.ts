/**
 * The parsed view of a note, used by every step of the staging pipeline that
 * has to know where code is.
 *
 * §3.7 step 5 requires comment removal to operate on the parsed AST, never on
 * raw text: a regex mis-pairs delimiters when a fenced code block contains a
 * stray `%%`, silently swallowing everything between two unrelated markers
 * (§11.2). The same requirement applies, less dramatically, to link
 * resolution and asset rewriting — a `[[wikilink]]` inside a code fence is
 * documentation about wikilinks, not a link.
 *
 * The AST is used to *locate*, never to re-serialise. Round-tripping markdown
 * through mdast normalises emphasis markers, list bullets and table padding,
 * which would churn every staged file and defeat the hash-skipping that keeps
 * KV writes cheap (§5.6). So every transform here splices the original string
 * by offset, and everything not deliberately changed is preserved byte for
 * byte.
 *
 * Note this parser is *not* the one the §11.2 assertions use. The self-check
 * in `@notes/shared` computes code regions with its own scanner, on purpose: a
 * bug in the stripper must not be able to hide inside the check that is
 * supposed to catch it.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes, Parent } from 'mdast';

export interface Range {
  start: number;
  end: number;
}

export interface CodeNode extends Range {
  kind: 'fenced' | 'inline' | 'other';
  /** Info string on a fenced block, lowercased. */
  lang: string | null;
  value: string;
}

export class MarkdownIndex {
  private constructor(
    readonly text: string,
    readonly codeNodes: CodeNode[],
  ) {}

  get codeRanges(): Range[] {
    return this.codeNodes;
  }

  static parse(text: string): MarkdownIndex {
    const tree = fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });

    const nodes: CodeNode[] = [];
    collectCode(tree, nodes);
    nodes.sort((a, b) => a.start - b.start);
    return new MarkdownIndex(text, nodes);
  }

  /** Fenced blocks with the given info string, in document order. */
  fenced(lang: string): CodeNode[] {
    return this.codeNodes.filter((n) => n.kind === 'fenced' && n.lang === lang);
  }

  /** Code spans whose content starts with a marker, e.g. `` `= expr` ``. */
  inlineStartingWith(marker: string): CodeNode[] {
    return this.codeNodes.filter((n) => n.kind === 'inline' && n.value.startsWith(marker));
  }

  /** True when the offset falls inside a fenced block, indented block or code span. */
  isCode(offset: number): boolean {
    for (const range of this.codeRanges) {
      if (offset < range.start) return false;
      if (offset < range.end) return true;
    }
    return false;
  }

  /** Every match of `pattern` that is not inside code, in document order. */
  matchesOutsideCode(pattern: RegExp): RegExpMatchArray[] {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    return [...this.text.matchAll(re)].filter((m) => !this.isCode(m.index ?? 0));
  }
}

const CODE_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'yaml']);

function collectCode(node: Nodes, out: CodeNode[]): void {
  if (CODE_TYPES.has(node.type) && node.position) {
    const withLang = node as { lang?: string | null; value?: string };
    out.push({
      start: node.position.start.offset ?? 0,
      end: node.position.end.offset ?? 0,
      kind: node.type === 'code' ? 'fenced' : node.type === 'inlineCode' ? 'inline' : 'other',
      lang: withLang.lang ? withLang.lang.toLowerCase() : null,
      value: withLang.value ?? '',
    });
    return;
  }
  if ('children' in node && Array.isArray((node as Parent).children)) {
    for (const child of (node as Parent).children) collectCode(child as Nodes, out);
  }
}

export interface Splice {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Apply non-overlapping splices to a string, right to left, so earlier offsets
 * stay valid. Overlapping splices are a bug in the caller and throw rather
 * than silently producing corrupt output.
 */
export function applySplices(text: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1] as Splice;
    const current = sorted[i] as Splice;
    if (current.start < previous.end) {
      throw new Error(
        `overlapping splices at ${previous.start}-${previous.end} and ${current.start}-${current.end}`,
      );
    }
  }

  let out = '';
  let last = 0;
  for (const splice of sorted) {
    out += text.slice(last, splice.start) + splice.replacement;
    last = splice.end;
  }
  return out + text.slice(last);
}
