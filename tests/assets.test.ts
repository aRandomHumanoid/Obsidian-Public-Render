/**
 * Asset tests (§5.5, §4.3, §11.1).
 *
 * The two rows of the fixture table that need real bytes: `geotagged-image.md`
 * ("no EXIF or GPS data in the published asset") and `malicious.svg` ("script,
 * event handlers and foreignObject removed at build time").
 */

import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processAssets, rewriteAssetRefs } from '../packages/build/src/assets.js';
import { isSvg, sanitizeSvg } from '../packages/build/src/svg.js';
import { MemoryR2 } from '../packages/build/src/r2.js';

const MALICIOUS_SVG = fileURLToPath(new URL('../fixtures/vault/malicious.svg', import.meta.url));

let dir: string;
let r2: MemoryR2;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notes-assets-'));
  r2 = new MemoryR2();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('malicious.svg — sanitized at build time (§5.5)', () => {
  it('removes script, event handlers, foreignObject and external references', async () => {
    const source = await readFile(MALICIOUS_SVG, 'utf8');
    const { svg, removed } = sanitizeSvg(source);

    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toMatch(/onload|onclick|onerror/i);
    expect(svg).not.toContain('javascript:');
    expect(svg).not.toContain('attacker.example');
    expect(svg).not.toContain('@import');
    expect(removed.length).toBeGreaterThan(0);
  });

  it('keeps the legitimate drawing', async () => {
    const source = await readFile(MALICIOUS_SVG, 'utf8');
    const { svg } = sanitizeSvg(source);

    expect(svg).toContain('<svg');
    expect(svg).toContain('Legitimate label');
    expect(svg).toContain('<rect');
  });

  it('keeps local fragment references, which mermaid arrowheads need', () => {
    const { svg } = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow"/></defs>' +
        '<path d="M0 0" marker-end="url(#arrow)"/><use href="#arrow"/></svg>',
    );
    expect(svg).toContain('id="arrow"');
    expect(svg).toContain('#arrow');
  });

  it('recognises SVG bytes regardless of the extension', async () => {
    expect(isSvg(new TextEncoder().encode('<svg xmlns="x"/>'))).toBe(true);
    expect(isSvg(new TextEncoder().encode('<?xml version="1.0"?><svg/>'))).toBe(true);
    expect(isSvg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });
});

describe('raster conversion (§5.5)', () => {
  it('converts to webp, caps the width and content-addresses the result', async () => {
    const png = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: '#3366cc' },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(dir, 'a1b2c3d4e5f6a7b8.png'), png);

    const result = await processAssets(dir, ['a1b2c3d4e5f6a7b8.png'], r2, { dryRun: false });
    const published = result.map.get('a1b2c3d4e5f6a7b8.png');

    expect(published).toMatch(/^[0-9a-f]{16}\.webp$/);
    // The hash changes at conversion, which is the mapping §4.3 describes.
    expect(published).not.toContain('a1b2c3d4e5f6a7b8');

    const stored = r2.store.get(`assets/${published}`);
    expect(stored?.contentType).toBe('image/webp');
    const meta = await sharp(stored!.bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1600);
  });

  it('strips EXIF and GPS, and refuses to publish if any survives', async () => {
    const geotagged = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#888888' },
    })
      .withExif({
        IFD0: { Make: 'TestPhone', Model: 'TestModel' },
        GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'W' },
      })
      .jpeg()
      .toBuffer();

    // The fixture really does carry EXIF before conversion.
    expect((await sharp(geotagged).metadata()).exif).toBeDefined();

    await writeFile(path.join(dir, 'b2c3d4e5f6a7b8c9.jpg'), geotagged);
    const result = await processAssets(dir, ['b2c3d4e5f6a7b8c9.jpg'], r2, { dryRun: false });
    const published = result.map.get('b2c3d4e5f6a7b8c9.jpg') as string;

    const after = await sharp(r2.store.get(`assets/${published}`)!.bytes).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
  });

  it('dedupes identical images and skips an upload that already exists', async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(dir, 'aaaaaaaaaaaaaaaa.png'), png);
    await writeFile(path.join(dir, 'bbbbbbbbbbbbbbbb.png'), png);

    const result = await processAssets(
      dir,
      ['aaaaaaaaaaaaaaaa.png', 'bbbbbbbbbbbbbbbb.png'],
      r2,
      { dryRun: false },
    );

    expect(result.map.get('aaaaaaaaaaaaaaaa.png')).toBe(result.map.get('bbbbbbbbbbbbbbbb.png'));
    expect(result.uploaded).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
  });

  it('refuses an unsupported attachment type rather than publishing a broken link', async () => {
    await writeFile(path.join(dir, 'notes.pdf'), 'not an image');
    await expect(processAssets(dir, ['notes.pdf'], r2, { dryRun: false })).rejects.toThrow(
      /unsupported attachment type/,
    );
  });
});

describe('reference rewriting (§5.5)', () => {
  const map = new Map([['a1b2c3d4e5f6a7b8.png', 'c3d4e5f6a7b8c9d0.webp']]);

  it('uses a relative path for HTML and an absolute one for the download copy', () => {
    const body = '![alt](_assets/a1b2c3d4e5f6a7b8.png)';

    expect(rewriteAssetRefs(body, map, '/a/').text).toBe('![alt](/a/c3d4e5f6a7b8c9d0.webp)');
    expect(rewriteAssetRefs(body, map, 'https://x.workers.dev/a/').text).toBe(
      '![alt](https://x.workers.dev/a/c3d4e5f6a7b8c9d0.webp)',
    );
  });

  it('leaves references inside code alone', () => {
    const body = [
      'Real: ![x](_assets/a1b2c3d4e5f6a7b8.png)',
      '',
      '```',
      'Documentation: _assets/a1b2c3d4e5f6a7b8.png',
      '```',
      '',
      'And a span: `_assets/a1b2c3d4e5f6a7b8.png`',
    ].join('\n');

    const { text } = rewriteAssetRefs(body, map, '/a/');
    expect(text).toContain('Real: ![x](/a/c3d4e5f6a7b8c9d0.webp)');
    expect(text).toContain('Documentation: _assets/a1b2c3d4e5f6a7b8.png');
    expect(text).toContain('`_assets/a1b2c3d4e5f6a7b8.png`');
  });

  it('reports a reference with no mapping rather than dropping it', () => {
    const { missing } = rewriteAssetRefs('![x](_assets/unknown.png)', map, '/a/');
    expect(missing).toEqual(['unknown.png']);
  });

  it('rewrites an HTML img embed with a width', () => {
    const { text } = rewriteAssetRefs(
      '<img src="_assets/a1b2c3d4e5f6a7b8.png" alt="x" width="300">',
      map,
      '/a/',
    );
    expect(text).toContain('src="/a/c3d4e5f6a7b8c9d0.webp"');
  });
});
