/**
 * Assets (§5.5).
 *
 * For each raster file in `_assets/`: convert to webp, cap width at 1600px,
 * hash the result, skip upload if the key already exists in R2. Build a
 * source-hash → published-URL map for the run.
 *
 * Note the hash changes at conversion: a staged asset is
 * `_assets/<hash-of-png>.png` and the published object is
 * `assets/<hash-of-webp>.webp` (§4.3). This module owns that mapping and
 * rewrites references in both outputs.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { assetHash, codeRegions, isInsideRegions } from '@notes/shared';
import { isSvg, sanitizeSvg } from './svg.js';
import type { R2Client } from './r2.js';

const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.tif', '.tiff', '.bmp']);

const MAX_WIDTH = 1600;

export interface AssetResult {
  /** Staged basename (`a1b2….png`) → published basename (`c3d4….webp`). */
  map: Map<string, string>;
  uploaded: string[];
  skipped: string[];
  warnings: string[];
}

export class AssetError extends Error {}

export async function processAssets(
  assetDir: string,
  assetFiles: string[],
  r2: R2Client,
  options: { dryRun: boolean },
): Promise<AssetResult> {
  const map = new Map<string, string>();
  const uploaded: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  for (const name of assetFiles) {
    const extension = path.extname(name).toLowerCase();
    const bytes = new Uint8Array(await readFile(path.join(assetDir, name)));

    let published: { basename: string; bytes: Uint8Array; contentType: string };

    if (extension === '.svg' || isSvg(bytes)) {
      const source = new TextDecoder().decode(bytes);
      const { svg, removed } = sanitizeSvg(source);
      if (removed.length > 0) {
        warnings.push(`${name}: SVG sanitizer removed ${removed.join(', ')}`);
      }
      const clean = new TextEncoder().encode(svg);
      published = {
        basename: `${await assetHash(clean)}.svg`,
        bytes: clean,
        contentType: 'image/svg+xml',
      };
    } else if (RASTER_EXTENSIONS.has(extension)) {
      const converted = await toWebp(bytes, name, extension);
      published = {
        basename: `${await assetHash(converted)}.webp`,
        bytes: converted,
        contentType: 'image/webp',
      };
    } else {
      throw new AssetError(
        `${name}: unsupported attachment type "${extension}". Supported: ${[...RASTER_EXTENSIONS, '.svg'].join(', ')}`,
      );
    }

    map.set(name, published.basename);

    const key = `assets/${published.basename}`;
    if (options.dryRun) {
      skipped.push(published.basename);
      continue;
    }
    if (await r2.exists(key)) {
      // Content-addressed on the converted bytes, so identical images dedupe.
      skipped.push(published.basename);
      continue;
    }
    await r2.put(key, published.bytes, published.contentType);
    uploaded.push(published.basename);
  }

  return { map, uploaded, skipped, warnings };
}

/**
 * Convert to webp, and **strip metadata explicitly**.
 *
 * sharp discards EXIF by default, but the correct posture is to state it,
 * because someone will eventually add `.keepMetadata()` to preserve a colour
 * profile and start silently publishing GPS coordinates from phone photos.
 * A comment alone would not survive that edit, so the intent is enforced: the
 * converted bytes are re-read and the build fails if any metadata block
 * reappears. The `geotagged-image.md` fixture asserts this (§11.1).
 *
 * `.rotate()` is not cosmetic. It bakes in the EXIF orientation *before* the
 * metadata carrying it is dropped; without it, stripping EXIF silently
 * sideways-rotates every phone photo.
 */
async function toWebp(bytes: Uint8Array, name: string, extension: string): Promise<Uint8Array> {
  const animated = extension === '.gif' || extension === '.webp';

  let pipeline = sharp(bytes, { failOn: 'none', animated });
  if (!animated) pipeline = pipeline.rotate();

  const converted = await pipeline
    .resize({ width: MAX_WIDTH, withoutEnlargement: true, fit: 'inside' })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

  const check = await sharp(converted, { failOn: 'none' }).metadata();
  const leaked = (['exif', 'iptc', 'xmp'] as const).filter((field) => check[field] !== undefined);
  if (leaked.length > 0) {
    throw new AssetError(
      `${name}: converted image still carries ${leaked.join(', ')} metadata. ` +
        `Something has re-enabled metadata passthrough — see §5.5. Publishing was refused.`,
    );
  }

  return new Uint8Array(converted);
}

export interface RewriteResult {
  text: string;
  /** References that had no entry in the map — a discovery bug if non-empty. */
  missing: string[];
}

/**
 * Rewrite `_assets/<staged>` references to their published URLs.
 *
 * Region-aware: a path inside a fenced block or a code span is documentation,
 * not a reference, and rewriting it would break the byte-identical
 * round-trip that §11.2's second assertion requires.
 *
 * `prefix` is `/a/` for the rendered HTML and the absolute
 * `https://<host>/a/` for the download copy, so the markdown file renders
 * correctly in any viewer rather than showing broken images (§5.5).
 */
export function rewriteAssetRefs(
  body: string,
  map: Map<string, string>,
  prefix: string,
): RewriteResult {
  const regions = codeRegions(body);
  const missing = new Set<string>();
  const pattern = /(?:\.\/)?_assets\/([A-Za-z0-9._%-]+)/g;

  let out = '';
  let last = 0;

  for (const match of body.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (isInsideRegions(index, regions)) continue;

    const staged = decodeURIComponent(match[1] ?? '');
    const published = map.get(staged);
    if (!published) {
      missing.add(staged);
      continue;
    }

    out += body.slice(last, index) + prefix + published;
    last = index + match[0].length;
  }

  out += body.slice(last);
  return { text: out, missing: [...missing] };
}
