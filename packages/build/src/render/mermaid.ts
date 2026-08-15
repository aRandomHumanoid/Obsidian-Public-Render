/**
 * ```mermaid → inline SVG (§8).
 *
 * Rendering mermaid needs a browser, which is why `@mermaid-js/mermaid-cli` is
 * an *optional* dependency: a vault with no diagrams should not pay for a
 * Chromium download. The cost of that choice is that a mermaid fence in a
 * corpus without the renderer installed must **fail the build** rather than
 * pass through silently — publishing a diagram as unexplained code is exactly
 * the kind of quiet wrong output §11.3 exists to prevent. `MERMAID=skip`
 * downgrades it deliberately, and says so in the job summary.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { sanitizeSvg } from '../svg.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/** htmlLabels off is load-bearing: it is what keeps `<foreignObject>` — which
 *  the SVG sanitizer drops — out of the output in the first place. */
const MERMAID_CONFIG = {
  theme: 'neutral',
  securityLevel: 'strict',
  htmlLabels: false,
  flowchart: { htmlLabels: false, useMaxWidth: true },
  sequence: { useMaxWidth: true },
  class: { htmlLabels: false },
};

const PUPPETEER_CONFIG = {
  // GitHub-hosted runners have no user namespace for Chromium's sandbox.
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
};

export class MermaidUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `a \`\`\`mermaid fence needs @mermaid-js/mermaid-cli, which is not available (${cause}).\n` +
        `  Install it:   npm install -D @mermaid-js/mermaid-cli -w @notes/build\n` +
        `  Or degrade:   MERMAID=skip  (fences render as plain code, reported in the summary)`,
    );
    this.name = 'MermaidUnavailableError';
  }
}

let mmdcPath: string | null | undefined;

function findMmdc(): string | null {
  if (mmdcPath !== undefined) return mmdcPath;
  try {
    const pkg = require.resolve('@mermaid-js/mermaid-cli/package.json');
    mmdcPath = path.join(path.dirname(pkg), 'src', 'cli.js');
  } catch {
    mmdcPath = null;
  }
  return mmdcPath;
}

export function isMermaidAvailable(): boolean {
  return findMmdc() !== null;
}

const cache = new Map<string, string>();

/** Render one diagram to sanitized SVG. Identical diagrams render once. */
export async function renderMermaid(source: string): Promise<string> {
  const cached = cache.get(source);
  if (cached) return cached;

  const cli = findMmdc();
  if (!cli) throw new MermaidUnavailableError('module not installed');

  const dir = await mkdtemp(path.join(tmpdir(), 'notes-mermaid-'));
  try {
    const input = path.join(dir, 'diagram.mmd');
    const output = path.join(dir, 'diagram.svg');
    const configFile = path.join(dir, 'config.json');
    const puppeteerFile = path.join(dir, 'puppeteer.json');

    await writeFile(input, source, 'utf8');
    await writeFile(configFile, JSON.stringify(MERMAID_CONFIG), 'utf8');
    await writeFile(puppeteerFile, JSON.stringify(PUPPETEER_CONFIG), 'utf8');

    await execFileAsync(
      process.execPath,
      [cli, '-i', input, '-o', output, '-c', configFile, '-p', puppeteerFile, '-b', 'transparent', '-q'],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
    );

    const raw = await readFile(output, 'utf8');
    // The same sanitizer that guards Excalidraw exports. mermaid output is not
    // attacker-controlled, but it is machine-generated from note content, and
    // running it through the one hardened path is cheaper than reasoning about
    // whether it needs to be.
    const { svg } = sanitizeSvg(raw);
    cache.set(source, svg);
    return svg;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MermaidUnavailableError('mmdc could not be executed');
    }
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
