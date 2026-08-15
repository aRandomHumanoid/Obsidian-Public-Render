/**
 * The three assertions that matter most (§11.2).
 *
 *   1. No `%%` sequence survives into any published artifact.
 *   2. Fenced code blocks round-trip byte-identically.
 *   3. No frontmatter key outside the allowlist survives.
 *
 * The second exists because the first is satisfiable by a broken
 * implementation. A regex that strips `%%…%%` from raw text passes the comment
 * assertion while corrupting any code block containing a stray `%%` — and
 * worse, mis-pairs delimiters across unrelated markers, silently swallowing
 * real content in between. Asserting comment removal alone rewards exactly the
 * implementation you do not want. Together they force AST-level handling.
 *
 * These run in three places: the plugin's test suite, the plugin's pre-write
 * self-check (§11.3), and CI against the staged corpus. The duplication is
 * deliberate — these are the failures that cannot be walked back once a link
 * has been shared.
 */

import { extractFencedBlocks, findOutsideCode, splitFrontmatter } from './markdown.js';
import { PUBLISHED_METADATA_KEYS } from './properties.js';
import { parse as parseYaml } from 'yaml';

export type AssertionCode =
  | 'comment-leak'
  | 'code-block-mutated'
  | 'code-block-lost-in-render'
  | 'frontmatter-leak';

export interface AssertionFailure {
  code: AssertionCode;
  message: string;
  detail?: string;
}

/**
 * (1) No `%%` outside code.
 *
 * Note the qualifier. A bare "the string `%%` appears nowhere" check would
 * contradict assertion 2, which requires a `%%` inside a fenced block to
 * survive byte-identically — see the `comments-in-code-block.md` fixture. The
 * two are only compatible if "outside code" is computed structurally, which is
 * exactly the discipline these assertions exist to force.
 */
export function assertNoComments(output: string): AssertionFailure[] {
  const hits = findOutsideCode(output, /%%/);
  return hits.map((hit) => ({
    code: 'comment-leak' as const,
    message: `a %% comment delimiter survived at line ${hit.line}`,
    detail: hit.context,
  }));
}

/**
 * (1, CI form) No `%%` outside code, checked against *rendered HTML*.
 *
 * `assertNoComments` reads markdown, where "code" means fences and backtick
 * spans. After rendering, code is `<pre>` and `<code>` elements instead, and
 * running the markdown scanner over HTML would flag every `%%` a code block
 * legitimately contains — which is exactly what §11.2's second assertion
 * requires to survive. Two shapes of the same property, so they get two
 * checks rather than one that is wrong for half its callers.
 */
export function assertNoCommentsInHtml(html: string): AssertionFailure[] {
  const masked = html
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, (block) => ' '.repeat(block.length))
    .replace(/<code\b[\s\S]*?<\/code>/gi, (block) => ' '.repeat(block.length))
    .replace(/<style\b[\s\S]*?<\/style>/gi, (block) => ' '.repeat(block.length));

  const failures: AssertionFailure[] = [];
  for (const match of masked.matchAll(/%%/g)) {
    const index = match.index ?? 0;
    failures.push({
      code: 'comment-leak',
      message: 'a %% comment delimiter survived into the rendered HTML',
      detail: truncate(html.slice(Math.max(0, index - 60), index + 60)),
    });
  }
  return failures;
}

/**
 * (2) Every fenced code block in the output appears byte-identically in one of
 * the documents it could have come from.
 *
 * `sources` is the host note plus every note transcluded into it, because
 * §3.7 step 4 composes from transclusion targets' staged output — a block can
 * legitimately arrive from a different file than the one being staged.
 */
export function assertCodeBlocksRoundTrip(sources: string[], output: string): AssertionFailure[] {
  const known = new Set<string>();
  for (const source of sources) {
    for (const block of extractFencedBlocks(source)) {
      known.add(fingerprint(block.info, block.content));
    }
  }

  const failures: AssertionFailure[] = [];
  for (const block of extractFencedBlocks(output)) {
    // Dataview fences are replaced by their markdown output (§9), so a fence
    // in the output is never a materialised query — it is either verbatim from
    // a source or it has been mutated.
    if (known.has(fingerprint(block.info, block.content))) continue;
    failures.push({
      code: 'code-block-mutated',
      message: `a fenced code block in the output matches no source block byte-for-byte`,
      detail: truncate(block.raw),
    });
  }
  return failures;
}

/**
 * (3) The output's metadata block carries only allowlisted keys.
 *
 * Allowlist, not denylist — a denylist leaks the first personal property you
 * forget to add to it.
 */
export function assertFrontmatterAllowlist(output: string): AssertionFailure[] {
  const { frontmatter } = splitFrontmatter(output);
  if (frontmatter === null) return [];

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch (err) {
    return [
      {
        code: 'frontmatter-leak',
        message: `metadata block does not parse, so its keys cannot be verified: ${(err as Error).message}`,
      },
    ];
  }
  // An empty block (`---\n---`) parses to null and carries nothing to leak.
  if (parsed === null) return [];

  // Anything that is not a key-value map fails *closed*. Returning no failures
  // here would mean a metadata block that parsed to a string, a number or a
  // list passed the one assertion whose job is catching non-allowlisted content
  // in a published artifact — and it would pass silently, which is the worst
  // shape for a check that exists because the failure cannot be walked back
  // once a link has been shared.
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [
      {
        code: 'frontmatter-leak',
        message: 'metadata block is not a key-value map, so its keys cannot be verified',
      },
    ];
  }

  const extras = Object.keys(parsed as Record<string, unknown>).filter(
    (key) => !PUBLISHED_METADATA_KEYS.includes(key),
  );
  return extras.map((key) => ({
    code: 'frontmatter-leak' as const,
    message: `frontmatter key "${key}" is not on the published allowlist`,
  }));
}

/**
 * (2, CI form) Fenced code blocks survive *rendering* unchanged.
 *
 * The plugin can compare staged output against vault sources. CI cannot — it
 * never sees the vault. What CI can check is the other half of the same
 * property: every fenced block in the staged markdown must appear verbatim as
 * the text content of a `<pre><code>` in the rendered HTML. A comment stripper
 * or sanitiser that eats code survives the plugin-side check and dies here.
 */
export function assertRenderedCodeBlocks(stagedMarkdown: string, html: string): AssertionFailure[] {
  const rendered = extractPreCodeText(html);
  const failures: AssertionFailure[] = [];

  for (const block of extractFencedBlocks(stagedMarkdown)) {
    // Mermaid fences become inline SVG by design (§8), so they are not
    // expected to survive as code.
    if (/^mermaid\b/i.test(block.info)) continue;
    const want = block.content.replace(/\n$/, '');
    if (want.trim() === '') continue;
    if (!rendered.some((text) => text.replace(/\n$/, '') === want)) {
      failures.push({
        code: 'code-block-lost-in-render',
        message: 'a fenced code block did not survive rendering byte-identically',
        detail: truncate(block.raw),
      });
    }
  }
  return failures;
}

export interface CriticalAssertionInput {
  /** The artifact about to be written, or just read back. */
  output: string;
  /**
   * Documents the output could have drawn code blocks from. Omit to skip
   * assertion 2 — callers that cannot supply sources (CI) should run
   * `assertRenderedCodeBlocks` instead.
   */
  sources?: string[];
}

export function runCriticalAssertions(input: CriticalAssertionInput): AssertionFailure[] {
  const failures = [...assertNoComments(input.output), ...assertFrontmatterAllowlist(input.output)];
  if (input.sources) {
    failures.push(...assertCodeBlocksRoundTrip(input.sources, input.output));
  }
  return failures;
}

/**
 * Throwing form, for the pre-publish self-check (§11.3). Fail closed: the
 * plugin refuses to write rather than publishing something it cannot vouch
 * for.
 */
export class CriticalAssertionError extends Error {
  constructor(readonly failures: AssertionFailure[]) {
    super(
      `pre-publish self-check failed:\n${failures.map((f) => `  · ${f.message}${f.detail ? `\n      ${f.detail}` : ''}`).join('\n')}`,
    );
    this.name = 'CriticalAssertionError';
  }
}

export function enforceCriticalAssertions(input: CriticalAssertionInput): void {
  const failures = runCriticalAssertions(input);
  if (failures.length > 0) throw new CriticalAssertionError(failures);
}

function fingerprint(info: string, content: string): string {
  return `${info}\x00${content.replace(/\n$/, '')}`;
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Text content of every `<pre><code>` in a rendered document. */
function extractPreCodeText(html: string): string[] {
  const out: string[] = [];
  const re = /<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;
  for (const m of html.matchAll(re)) {
    out.push(decodeEntities(stripTags(m[1] ?? '')));
  }
  return out;
}

/**
 * Strip tags without a DOM. Shiki wraps every token in a `<span>`, so the text
 * content of a highlighted block is only recoverable by removing them.
 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
