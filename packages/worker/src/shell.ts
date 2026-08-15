/**
 * The page shell (§7.2).
 *
 * One inlined stylesheet. No external requests, no fonts, no analytics, no
 * JavaScript. Everything the reader needs arrives in a single response, which
 * is what makes `default-src 'none'` with no `script-src` possible (§7.3).
 *
 * Math is MathML, not KaTeX's HTML output, for the same reason: KaTeX's HTML
 * mode needs a stylesheet and six font files, and every one of those is an
 * external request this page is not permitted to make. Inlining the CSS
 * without the fonts renders math in a fallback face, which looks wrong.
 * Browsers render MathML natively with no CSS at all (§5.4).
 */

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #6b7280;
  --rule: #e5e7eb;
  --accent: #2563eb;
  --code-bg: #f6f8fa;
  --quote-bg: #f9fafb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181d;
    --fg: #e6e6e6;
    --muted: #9ca3af;
    --rule: #2c2f36;
    --accent: #7aa2f7;
    --code-bg: #1d2027;
    --quote-bg: #1a1d23;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 17px;
  line-height: 1.65;
}
.wrap { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
header.doc { border-bottom: 1px solid var(--rule); padding-bottom: 1rem; margin-bottom: 2rem; }
header.doc h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 .4rem; letter-spacing: -0.01em; }
header.doc .meta { color: var(--muted); font-size: .85rem; }
article > *:first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 2rem 0 .75rem; letter-spacing: -0.01em; }
h2 { font-size: 1.4rem; }
h3 { font-size: 1.15rem; }
h4, h5, h6 { font-size: 1rem; }
p, ul, ol, blockquote, table, pre, figure { margin: 0 0 1.1rem; }
a { color: var(--accent); text-underline-offset: .15em; }
img, svg, video { max-width: 100%; height: auto; }
figure { margin-inline: 0; }
figcaption { color: var(--muted); font-size: .85rem; text-align: center; }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2.5rem 0; }
blockquote {
  margin-inline: 0; padding: .1rem 1rem; border-left: 3px solid var(--rule);
  background: var(--quote-bg); color: var(--muted);
}
code, kbd, samp {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: .875em;
}
:not(pre) > code {
  background: var(--code-bg); padding: .15em .35em; border-radius: 4px;
  border: 1px solid var(--rule);
}
pre {
  background: var(--code-bg); border: 1px solid var(--rule); border-radius: 8px;
  padding: .9rem 1rem; overflow-x: auto; line-height: 1.5;
}
pre code { background: none; border: 0; padding: 0; }
/* shiki runs with defaultColor:false and emits both themes as custom
   properties on each token, so one rendered document serves both colour
   schemes without any JavaScript to switch them. */
pre.shiki { background-color: var(--shiki-light-bg, var(--code-bg)); }
.shiki, .shiki span { color: var(--shiki-light); }
@media (prefers-color-scheme: dark) {
  pre.shiki { background-color: var(--shiki-dark-bg, var(--code-bg)); }
  .shiki, .shiki span { color: var(--shiki-dark); }
}
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--rule); padding: .45rem .7rem; text-align: left; }
th { background: var(--code-bg); font-weight: 600; }
ul, ol { padding-left: 1.4rem; }
li { margin: .25rem 0; }
li > input[type=checkbox] { margin-right: .4rem; }
sup a, .footnotes { font-size: .85em; }
.footnotes { border-top: 1px solid var(--rule); margin-top: 3rem; padding-top: .5rem; color: var(--muted); }
mark { background: #fde68a; color: #1a1a1a; padding: 0 .15em; border-radius: 2px; }
@media (prefers-color-scheme: dark) { mark { background: #7c6f2e; color: #f5f5f5; } }
math { font-size: 1.05em; }
.callout {
  border: 1px solid var(--rule); border-left: 3px solid var(--accent);
  border-radius: 6px; padding: .75rem 1rem; margin: 0 0 1.1rem; background: var(--quote-bg);
}
.callout > .callout-title { font-weight: 600; margin-bottom: .3rem; }
.callout > *:last-child { margin-bottom: 0; }
.callout[data-callout="warning"], .callout[data-callout="caution"] { border-left-color: #d97706; }
.callout[data-callout="danger"], .callout[data-callout="error"], .callout[data-callout="bug"] { border-left-color: #dc2626; }
.callout[data-callout="tip"], .callout[data-callout="success"], .callout[data-callout="done"] { border-left-color: #059669; }
.callout[data-callout="question"], .callout[data-callout="help"] { border-left-color: #7c3aed; }
.mermaid { text-align: center; }
footer.doc {
  border-top: 1px solid var(--rule); margin-top: 3.5rem; padding-top: 1rem;
  color: var(--muted); font-size: .85rem;
  display: flex; gap: 1rem; flex-wrap: wrap; justify-content: space-between;
}
.placeholder { text-align: center; padding: 6rem 1rem; color: var(--muted); }
`.trim();

export interface ShellInput {
  title: string;
  html: string;
  updated: string;
  /** Download path, or null when `download` is false. */
  downloadHref: string | null;
  siteName: string;
}

export function renderPage(input: ShellInput): string {
  const updated = formatDate(input.updated);
  const download = input.downloadHref
    ? `<a href="${escapeAttr(input.downloadHref)}" download>Download markdown</a>`
    : '<span></span>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(input.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
<header class="doc">
<h1>${escapeText(input.title)}</h1>
<p class="meta"><time datetime="${escapeAttr(input.updated)}">Updated ${escapeText(updated)}</time></p>
</header>
<article>
${input.html}
</article>
<footer class="doc">
${download}
<span>${escapeText(input.siteName)}</span>
</footer>
</div>
</body>
</html>
`;
}

/** The root route: a static placeholder. No index, no listing (§7.1). */
export function renderRoot(siteName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(siteName)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap"><p class="placeholder">Nothing to see here.</p></div>
</body>
</html>
`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 10);
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}
