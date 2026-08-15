/**
 * Render (§5.4).
 *
 * ```
 * remark-parse
 *   → remark-gfm
 *   → remark-math
 *   → [custom] strip %% comments %%      ← defence in depth; plugin already did this
 *   → [custom] callouts
 *   → remark-rehype
 *   → rehype-katex
 *   → rehype-shiki
 *   → [custom] mermaid → inline SVG
 *   → rehype-sanitize
 *   → rehype-stringify
 * ```
 *
 * Wikilinks, embeds and transclusions are absent from the input by this point
 * — the plugin resolved them into ordinary markdown (§3.1). CI never sees a
 * `[[…]]`, and if it does, that is a bug upstream rather than something to
 * handle here.
 *
 * Two orderings differ from the sketch above, both for cause: mermaid runs
 * *before* shiki so the highlighter is never handed a language it does not
 * know, and the style allowlist runs *after* sanitize so it has the last word
 * on attribute values.
 */

import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeShiki from '@shikijs/rehype';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import type { Processor } from 'unified';
import { assertNoCommentsInHtml, assertRenderedCodeBlocks } from '@notes/shared';
import type { AssertionFailure } from '@notes/shared';
import { rehypeHighlights, rehypeMermaid, rehypeStyleAllowlist } from './hast.js';
import { remarkCallouts, remarkStripComments } from './mdast.js';
import { buildSanitizeSchema } from './sanitize.js';

export interface RenderOptions {
  mermaid: 'error' | 'skip';
}

export interface RenderResult {
  html: string;
  warnings: string[];
}

let processor: Processor | null = null;
let processorMode: string | null = null;

function getProcessor(options: RenderOptions): Processor {
  const mode = options.mermaid;
  if (processor && processorMode === mode) return processor;

  processorMode = mode;
  processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkStripComments)
    .use(remarkCallouts)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    // Heading ids, so `[[Note#Heading]]` has something to point at. The plugin
    // slugs fragments with the same `github-slugger` this uses (§8).
    .use(rehypeSlug)
    .use(rehypeMermaid, { mode })
    .use(rehypeHighlights)
    .use(rehypeKatex, {
      // MathML rather than KaTeX's HTML output. HTML mode needs katex.css and
      // six woff2 files; the page is permitted zero external requests (§7.3),
      // and inlining the CSS without the fonts renders math in a fallback face
      // that looks broken. Browsers render MathML natively with no CSS at all.
      output: 'mathml',
      // `throwOnError` is not offered: rehype-katex renders a parse failure
      // inline in `errorColor` rather than failing the build, which is the
      // right trade for one bad formula in one note.
      strict: false,
      trust: false,
    })
    .use(rehypeShiki, {
      themes: { light: 'github-light', dark: 'github-dark' },
      // Emit CSS variables rather than baked colours, so one render serves
      // both colour schemes. The shell's stylesheet resolves them.
      defaultColor: false,
      // `fallbackLanguage` is ignored when `lazy` is on, and an unknown
      // language must not fail a whole build over syntax colouring.
      fallbackLanguage: 'text',
    })
    .use(rehypeSanitize, buildSanitizeSchema())
    .use(rehypeStyleAllowlist)
    .use(rehypeStringify, { allowDangerousHtml: false }) as unknown as Processor;

  return processor;
}

export class RenderError extends Error {
  constructor(
    message: string,
    readonly failures: AssertionFailure[] = [],
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

/**
 * Render one staged body to HTML.
 *
 * Two of the three critical assertions run here as well as in the plugin
 * (§11.2). The duplication is deliberate: these are the failures that cannot
 * be walked back once a link has been shared, and CI is the last place they
 * can still be caught.
 */
export async function renderMarkdown(body: string, options: RenderOptions): Promise<RenderResult> {
  const file = await getProcessor(options).process(body);
  const html = String(file);

  const warnings = [...((file.data['warnings'] as string[] | undefined) ?? [])];
  if (file.data['unterminatedComment']) {
    warnings.push('an unterminated %% comment dropped everything after it');
  }

  const failures = [
    ...assertNoCommentsInHtml(html),
    // CI cannot compare against vault sources — it never sees the vault. What
    // it can check is the other half of the same property: every fenced block
    // in the staged markdown must survive rendering byte-identically.
    ...assertRenderedCodeBlocks(body, html),
  ];
  if (failures.length > 0) {
    throw new RenderError(
      `render produced output that fails the critical assertions:\n${failures
        .map((f) => `  · ${f.message}${f.detail ? `\n      ${f.detail}` : ''}`)
        .join('\n')}`,
      failures,
    );
  }

  return { html, warnings };
}
