/**
 * Render pipeline tests (§5.4), including the CI half of §11.2's second
 * assertion and the sanitization schema that is the last thing standing
 * between rendered output and the reader.
 */

import { describe, expect, it } from 'vitest';
import { assertRenderedCodeBlocks } from '@notes/shared';
import { renderMarkdown } from '../packages/build/src/render/index.js';
import { isMermaidAvailable } from '../packages/build/src/render/mermaid.js';

const render = (markdown: string) => renderMarkdown(markdown, { mermaid: 'skip' });

describe('code', () => {
  it('round-trips a fenced block byte-identically through rendering', async () => {
    const markdown = [
      '```erlang',
      '%% In Erlang, %% starts a comment.',
      'main() ->',
      '    io:format("~p~n", [ok]).',
      '```',
    ].join('\n');

    const { html } = await render(markdown);
    expect(assertRenderedCodeBlocks(markdown, html)).toEqual([]);
    expect(html).toContain('%% In Erlang, %% starts a comment.');
  });

  it('highlights with shiki and emits both colour schemes as custom properties', async () => {
    const { html } = await render('```ts\nconst x: number = 1;\n```');
    expect(html).toContain('shiki');
    expect(html).toContain('--shiki-light');
    expect(html).toContain('--shiki-dark');
  });

  it('falls back rather than failing on an unknown language', async () => {
    const { html } = await render('```not-a-real-language\nplain text\n```');
    expect(html).toContain('plain text');
  });
});

describe('comments — defence in depth (§3.2)', () => {
  it('strips a comment CI sees even though the plugin should have', async () => {
    const { html } = await render('Before %%secret%% after.');
    expect(html).not.toContain('secret');
    expect(html).not.toContain('%%');
  });

  it('leaves a %% inside a fence alone', async () => {
    const markdown = '```\n%% not a comment %%\n```';
    const { html } = await render(markdown);
    expect(html).toContain('%% not a comment %%');
  });

  it('reports an unterminated comment rather than swallowing it silently', async () => {
    const { warnings } = await render('Visible %% and then nothing closes it.');
    expect(warnings.join(' ')).toContain('unterminated');
  });
});

describe('Obsidian syntax handled by CI (§8)', () => {
  it('renders callouts as a div with data-callout', async () => {
    const { html } = await render('> [!warning] Careful\n> Body line.');
    expect(html).toContain('data-callout="warning"');
    expect(html).toContain('callout-title');
    expect(html).toContain('Careful');
    expect(html).toContain('Body line.');
  });

  it('titles an untitled callout with its type', async () => {
    const { html } = await render('> [!note]\n> Just a body.');
    expect(html).toContain('data-callout="note"');
    expect(html).toContain('Note');
  });

  it('leaves an ordinary blockquote alone', async () => {
    const { html } = await render('> Just a quote.');
    expect(html).toContain('<blockquote>');
    expect(html).not.toContain('callout');
  });

  it('renders ==highlight== as <mark>', async () => {
    const { html } = await render('Some ==highlighted== text.');
    expect(html).toContain('<mark>highlighted</mark>');
  });

  it('does not treat == inside code as a highlight', async () => {
    const { html } = await render('`a == b` and ```\nx == y\n```');
    expect(html).not.toContain('<mark>');
  });

  it('renders math as MathML, so the page needs no fonts or stylesheet', async () => {
    const { html } = await render('Inline $e^{i\\pi}+1=0$ and $$\\int_0^1 x\\,dx$$');
    expect(html).toContain('<math');
    expect(html).not.toContain('katex-html');
  });

  it('gives headings ids for [[Note#Heading]] to point at', async () => {
    const { html } = await render('## Published B\n\nBody.');
    expect(html).toContain('id="published-b"');
  });

  it('renders gfm tables, task lists and footnotes', async () => {
    const { html } = await render(
      '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\nRef[^1]\n\n[^1]: Note.',
    );
    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('data-footnotes');
  });
});

describe('sanitization (§5.4)', () => {
  it('strips script and event handlers from raw HTML', async () => {
    const { html } = await render(
      'Text\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n<div onclick="alert(3)">hi</div>',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('alert(');
  });

  it('keeps a width attribute on an image embed', async () => {
    const { html } = await render('<img src="/a/a1b2c3d4e5f6a7b8.webp" alt="x" width="300">');
    expect(html).toContain('width="300"');
    expect(html).toContain('/a/a1b2c3d4e5f6a7b8.webp');
  });

  it('drops a javascript: link', async () => {
    const { html } = await render('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('drops style declarations outside the allowlist', async () => {
    const { html } = await render(
      '<span style="color:#ff0000;behavior:url(evil.htc);position:fixed">x</span>',
    );
    expect(html).toContain('color:#ff0000');
    expect(html).not.toContain('behavior');
    expect(html).not.toContain('position:fixed');
  });

  it('preserves the block anchor a transclusion target emitted', async () => {
    const { html } = await render('A paragraph. <span id="b-kitchen-sink"></span>');
    expect(html).toContain('id="b-kitchen-sink"');
  });
});

describe('mermaid (§8)', () => {
  it('degrades visibly rather than silently when the renderer is unavailable', async () => {
    const { html, warnings } = await renderMarkdown('```mermaid\ngraph TD\n A-->B\n```', {
      mermaid: 'skip',
    });
    // In skip mode the fence stays a code block, and the summary says so.
    expect(html).toContain('graph TD');
    if (!isMermaidAvailable()) {
      expect(warnings.join(' ')).toContain('mermaid');
    }
  });

  it.skipIf(!isMermaidAvailable() || process.env['MERMAID_E2E'] !== '1')(
    'renders a diagram to sanitized inline SVG',
    async () => {
      const { html } = await renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```', {
        mermaid: 'error',
      });
      expect(html).toContain('<svg');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('foreignObject');
    },
    180_000,
  );
});
