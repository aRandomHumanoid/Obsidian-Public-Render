/**
 * hast-level transforms: `==highlights==`, mermaid embedding, and the style
 * attribute allowlist (§5.4).
 *
 * Highlights are done here rather than in mdast because `==x==` is not
 * standard markdown and adding a micromark extension for it costs more than a
 * text-node split — provided the split is structure-aware, which is why it
 * skips `code`, `pre`, `svg` and rendered math rather than running over the
 * whole document.
 */

import { fromHtml } from 'hast-util-from-html';
import type { Element, ElementContent, Parent, Root, RootContent, Text } from 'hast';
import type { VFile } from 'vfile';
import { MermaidUnavailableError, renderMermaid } from './mermaid.js';

const SKIP_ELEMENTS = new Set(['code', 'pre', 'svg', 'math', 'script', 'style']);

function isSkipped(node: Element): boolean {
  if (SKIP_ELEMENTS.has(node.tagName)) return true;
  const className = node.properties?.['className'];
  if (Array.isArray(className) && className.some((c) => String(c).startsWith('math'))) return true;
  return false;
}

/** `==highlight==` → `<mark>`. */
export function rehypeHighlights() {
  return (tree: Root) => {
    transform(tree);
  };

  function transform(parent: Parent): void {
    const out: ElementContent[] = [];
    let changed = false;

    for (const child of parent.children as ElementContent[]) {
      if (child.type === 'element') {
        if (!isSkipped(child)) transform(child);
        out.push(child);
        continue;
      }
      if (child.type !== 'text' || !child.value.includes('==')) {
        out.push(child);
        continue;
      }
      const split = splitHighlights(child);
      if (split.length === 1 && split[0] === child) {
        out.push(child);
        continue;
      }
      changed = true;
      out.push(...split);
    }

    if (changed) parent.children = out as RootContent[];
  }
}

const HIGHLIGHT = /==([^=\n](?:[^\n]*?[^=\n])?)==/g;

function splitHighlights(node: Text): ElementContent[] {
  const out: ElementContent[] = [];
  let last = 0;
  for (const match of node.value.matchAll(HIGHLIGHT)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ type: 'text', value: node.value.slice(last, index) });
    out.push({
      type: 'element',
      tagName: 'mark',
      properties: {},
      children: [{ type: 'text', value: match[1] ?? '' }],
    });
    last = index + match[0].length;
  }
  if (out.length === 0) return [node];
  if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) });
  return out;
}

export interface MermaidOptions {
  mode: 'error' | 'skip';
}

/**
 * Replace `<pre><code class="language-mermaid">` with the rendered diagram.
 *
 * Runs before shiki, so the highlighter never sees a language it does not
 * know, and before sanitize, so the resulting SVG is checked by the same
 * schema as everything else — two passes over the same bytes, since the SVG
 * sanitizer has already seen them.
 */
export function rehypeMermaid(options: MermaidOptions) {
  return async (tree: Root, file: VFile) => {
    const jobs: { parent: Parent; index: number; source: string }[] = [];

    collect(tree);

    for (const job of jobs) {
      let replacement: ElementContent;
      try {
        const svg = await renderMermaid(job.source);
        const parsed = fromHtml(svg, { fragment: true });
        const root = parsed.children.find(
          (c): c is Element => c.type === 'element' && c.tagName === 'svg',
        );
        replacement = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['mermaid'] },
          children: root ? [root] : [],
        };
      } catch (err) {
        if (err instanceof MermaidUnavailableError && options.mode === 'skip') {
          const warnings = (file.data['warnings'] as string[] | undefined) ?? [];
          warnings.push('mermaid renderer unavailable — diagrams rendered as plain code');
          file.data['warnings'] = warnings;
          continue;
        }
        throw err;
      }
      job.parent.children[job.index] = replacement as RootContent;
    }

    function collect(parent: Parent): void {
      parent.children.forEach((child, index) => {
        if (child.type !== 'element') return;
        if (child.tagName === 'pre') {
          const code = child.children.find(
            (c): c is Element => c.type === 'element' && c.tagName === 'code',
          );
          if (code && hasClass(code, 'language-mermaid')) {
            jobs.push({ parent, index, source: textOf(code) });
            return;
          }
        }
        collect(child);
      });
    }
  };
}

function hasClass(node: Element, name: string): boolean {
  const className = node.properties?.['className'];
  return Array.isArray(className) && className.some((c) => String(c) === name);
}

function textOf(node: Parent): string {
  let out = '';
  for (const child of node.children) {
    if (child.type === 'text') out += child.value;
    else if ('children' in child) out += textOf(child as Parent);
  }
  return out;
}

/**
 * Validate `style` attribute values.
 *
 * shiki emits colours as inline style attributes, and the page CSP permits
 * them (`style-src 'unsafe-inline'` covers style attributes). Allowing the
 * attribute through sanitization without checking its *value* would leave a
 * CSS injection channel open for no reason, so the value must parse as a list
 * of declarations drawn from a small allowlist. Anything else is dropped
 * whole rather than repaired.
 */
const ALLOWED_STYLE_PROPERTIES = new Set([
  'color',
  'background-color',
  'font-style',
  'font-weight',
  'text-decoration',
  'opacity',
  '--shiki-light',
  '--shiki-dark',
  '--shiki-light-bg',
  '--shiki-dark-bg',
]);

const SAFE_VALUE = /^[#a-zA-Z0-9(),.%\s/_-]+$/;

export function rehypeStyleAllowlist() {
  return (tree: Root) => {
    walk(tree);
  };

  function walk(parent: Parent): void {
    for (const child of parent.children) {
      if (child.type !== 'element') continue;
      const style = child.properties?.['style'];
      if (typeof style === 'string') {
        const cleaned = filterStyle(style);
        if (cleaned) child.properties!['style'] = cleaned;
        else delete child.properties!['style'];
      }
      walk(child);
    }
  }
}

function filterStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!ALLOWED_STYLE_PROPERTIES.has(property)) continue;
    if (!SAFE_VALUE.test(value)) continue;
    kept.push(`${property}:${value}`);
  }
  return kept.join(';');
}
