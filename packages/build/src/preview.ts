#!/usr/bin/env node
/**
 * Render one staged file to a complete page, locally. No infrastructure (M0).
 *
 * Useful well past M0: it is the fastest way to see what a renderer change
 * actually does before bumping `renderConfigVersion` and rewriting the corpus
 * (§4.2), and it goes through the same pipeline and the same page shell the
 * worker uses, so what it shows is what would be served.
 *
 *   node packages/build/dist/preview.js published/<id>.md out.html
 */

import { readFile, writeFile } from 'node:fs/promises';
import { parseStagedFile, splitFrontmatter } from '@notes/shared';
import { renderPage } from '@notes/worker/shell.js';
import { renderMarkdown } from './render/index.js';

async function main(): Promise<void> {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error('usage: preview <staged-file.md> [out.html]');
    process.exitCode = 2;
    return;
  }

  const raw = await readFile(input, 'utf8');

  // Accept a plain markdown file too, so this is useful before anything has
  // been staged at all.
  let title = input.replace(/^.*\//, '').replace(/\.md$/, '');
  let body = raw;
  let shareId = 'preview';
  let download = true;

  if (splitFrontmatter(raw).frontmatter !== null) {
    try {
      const parsed = parseStagedFile(raw, input);
      title = parsed.metadata.title;
      body = parsed.body;
      shareId = parsed.metadata.share_id;
      download = parsed.metadata.download;
    } catch {
      body = splitFrontmatter(raw).body;
    }
  }

  const { html, warnings } = await renderMarkdown(body, {
    mermaid: process.env['MERMAID'] === 'skip' ? 'skip' : 'error',
  });
  for (const warning of warnings) console.warn(`warning: ${warning}`);

  const page = renderPage({
    title,
    html,
    updated: new Date().toISOString(),
    downloadHref: download ? `/n/${shareId}.md` : null,
    siteName: process.env['SITE_NAME'] ?? 'Notes',
  });

  if (output) {
    await writeFile(output, page, 'utf8');
    console.log(`wrote ${output} (${page.length} bytes)`);
  } else {
    process.stdout.write(page);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
