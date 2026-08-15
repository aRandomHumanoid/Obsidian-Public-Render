/**
 * The contract layer: share ids, the two hashes, the metadata block, the
 * code-aware scanner, and the three critical assertions themselves (§11.2).
 */

import { describe, expect, it } from 'vitest';
import {
  SHARE_ID_PATTERN,
  assertCodeBlocksRoundTrip,
  assertFrontmatterAllowlist,
  assertNoComments,
  blockCodeRegions,
  codeRegions,
  contentHash,
  extractAssetReferences,
  extractFencedBlocks,
  findOutsideCode,
  generateShareId,
  isShareId,
  normalizeShareId,
  parseStagedFile,
  serializeStagedFile,
  sourceHash,
  splitFrontmatter,
  stagedHash,
  timingSafeEqual,
} from '@notes/shared';
import { StagedFileError } from '../packages/shared/src/metadataBlock.js';

describe('share_id (§4.1)', () => {
  it('mints 16 Crockford base32 characters', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateShareId();
      expect(id).toHaveLength(16);
      expect(SHARE_ID_PATTERN.test(id)).toBe(true);
      expect(id).not.toMatch(/[ilou]/);
    }
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 2000 }, generateShareId));
    expect(ids.size).toBe(2000);
  });

  it('rejects anything off the alphabet or the wrong length', () => {
    expect(isShareId('7k2m9x4qp8vw3n6r')).toBe(true);
    expect(isShareId('7k2m9x4qp8vw3n6')).toBe(false);
    expect(isShareId('7k2m9x4qp8vw3n6rr')).toBe(false);
    expect(isShareId('7k2m9x4qp8vw3n6I')).toBe(false);
    expect(isShareId('../../../etc/pass')).toBe(false);
    expect(isShareId(42)).toBe(false);
  });

  it('normalises the characters Crockford treats as aliases', () => {
    expect(normalizeShareId('7K2M9X4QP8VW3N6R')).toBe('7k2m9x4qp8vw3n6r');
    expect(normalizeShareId('IL0O-1234-5678-9abc')).toBe('1100123456789abc');
  });
});

describe('the two hashes (§4.2)', () => {
  it('contentHash folds in renderConfigVersion; stagedHash does not', async () => {
    const markdown = '# Title\n\nBody.';
    expect(await contentHash(markdown, 3)).not.toBe(await contentHash(markdown, 4));
    expect(await stagedHash(markdown)).toBe(await stagedHash(markdown));
    expect(await stagedHash(markdown)).not.toBe(await contentHash(markdown, 3));
  });

  it('does not collide when a version digit could be absorbed by the body', async () => {
    // `stagedMarkdown + renderConfigVersion` taken literally would make these
    // equal; the separator is why they are not.
    expect(await contentHash('body1', 1)).not.toBe(await contentHash('body', 11));
  });

  it('sourceHash ignores everything that does not change published output', async () => {
    const body = '# Title\n\nBody.';
    const base = await sourceHash(body, { title: 'Title', indexable: false, download: true });

    // Property insertion order must not matter.
    expect(await sourceHash(body, { download: true, indexable: false, title: 'Title' })).toBe(base);
    // Line endings and trailing whitespace must not matter.
    expect(
      await sourceHash('# Title\r\n\r\nBody.   \r\n', { title: 'Title', indexable: false, download: true }),
    ).toBe(base);
    // A property that does change output must.
    expect(await sourceHash(body, { title: 'Other', indexable: false, download: true })).not.toBe(base);
  });

  it('compares tokens without leaking length through an early return', () => {
    expect(timingSafeEqual('correct-horse', 'correct-horse')).toBe(true);
    expect(timingSafeEqual('correct-horse', 'correct-hors')).toBe(false);
    expect(timingSafeEqual('', 'x')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('the metadata block (§3.3)', () => {
  const metadata = {
    share_id: '7k2m9x4qp8vw3n6r',
    title: 'Widget design',
    source_hash: '3e91',
    staged: '2026-08-02T14:03:11Z',
    indexable: false,
    download: true,
  };

  it('round-trips', () => {
    const file = serializeStagedFile(metadata, '# Widget design\n\nBody.');
    const parsed = parseStagedFile(file);
    expect(parsed.metadata).toEqual(metadata);
    expect(parsed.body.trim()).toBe('# Widget design\n\nBody.');
  });

  it('serialises deterministically, so an unchanged note produces an unchanged hash', () => {
    const a = serializeStagedFile(metadata, 'Body.');
    const b = serializeStagedFile({ ...metadata }, 'Body.');
    expect(a).toBe(b);
  });

  it('quotes a title that would otherwise break the YAML', () => {
    const file = serializeStagedFile({ ...metadata, title: 'A: title, with #hash' }, 'x');
    expect(parseStagedFile(file).metadata.title).toBe('A: title, with #hash');
  });

  it('refuses a block carrying keys off the allowlist', () => {
    const file = serializeStagedFile(metadata, 'x').replace(
      'title: Widget design',
      'title: Widget design\nclient: Acme',
    );
    expect(() => parseStagedFile(file, 'x.md')).toThrow(StagedFileError);
    expect(() => parseStagedFile(file, 'x.md')).toThrow(/outside the allowlist/);
  });

  it('refuses a malformed or missing share_id', () => {
    const file = serializeStagedFile(metadata, 'x').replace('7k2m9x4qp8vw3n6r', 'nope');
    expect(() => parseStagedFile(file)).toThrow(/share_id/);
  });

  it('refuses a file with no metadata block at all', () => {
    expect(() => parseStagedFile('# Just a heading\n')).toThrow(/no metadata block/);
  });

  it('defaults download to true and indexable to false when absent (§4.1)', () => {
    const file = [
      '---',
      'share_id: 7k2m9x4qp8vw3n6r',
      'title: x',
      'source_hash: a',
      'staged: 2026-08-02T14:03:11Z',
      '---',
      '',
      'Body.',
    ].join('\n');
    const parsed = parseStagedFile(file);
    expect(parsed.metadata.download).toBe(true);
    expect(parsed.metadata.indexable).toBe(false);
  });

  it('derives the asset list by scanning rather than trusting a declaration', () => {
    const body = [
      '![a](_assets/a1b2c3d4e5f6a7b8.png)',
      '<img src="_assets/b2c3d4e5f6a7b8c9.webp">',
      '[not an image](_assets/c3d4e5f6a7b8c9d0.svg)',
      '![external](https://example.com/x.png)',
    ].join('\n\n');

    expect(extractAssetReferences(body)).toEqual([
      'a1b2c3d4e5f6a7b8.png',
      'b2c3d4e5f6a7b8c9.webp',
      'c3d4e5f6a7b8c9d0.svg',
    ]);
  });
});

describe('the code-aware scanner', () => {
  it('finds fenced, indented and inline code', () => {
    const markdown = [
      'Text with `a span`.',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '    indented code',
      '',
      'More text.',
    ].join('\n');

    const regions = codeRegions(markdown);
    expect(regions.length).toBeGreaterThanOrEqual(3);
    expect(findOutsideCode(markdown, /const/)).toHaveLength(0);
    expect(findOutsideCode(markdown, /More/)).toHaveLength(1);
  });

  it('handles a fence containing what looks like a closing fence', () => {
    const markdown = '````\n```\nstill inside\n```\n````\n\nOutside.';
    const blocks = extractFencedBlocks(markdown);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toContain('still inside');
  });

  it('treats an unclosed fence as running to the end, which is the safe direction', () => {
    const markdown = 'Before.\n\n```\n%% never closed';
    expect(findOutsideCode(markdown, /%%/)).toHaveLength(0);
    expect(blockCodeRegions(markdown).at(-1)?.end).toBe(markdown.length);
  });

  it('splits frontmatter only at the very start of a document', () => {
    expect(splitFrontmatter('---\na: 1\n---\nBody').frontmatter).toBe('a: 1');
    expect(splitFrontmatter('Text\n\n---\na: 1\n---\n').frontmatter).toBeNull();
    expect(splitFrontmatter('---\nunterminated\n').frontmatter).toBeNull();
  });
});

describe('the three critical assertions (§11.2)', () => {
  it('flags a comment delimiter outside code', () => {
    expect(assertNoComments('Text %% leak %% text')).toHaveLength(2);
  });

  it('does not flag one inside code, which the second assertion requires to survive', () => {
    expect(assertNoComments('```\n%% erlang %%\n```')).toHaveLength(0);
    expect(assertNoComments('An inline `%%` span')).toHaveLength(0);
  });

  it('flags a fenced block that does not match any source byte-for-byte', () => {
    const source = '```js\nconst x = 1;\n```';
    expect(assertCodeBlocksRoundTrip([source], source)).toHaveLength(0);
    expect(assertCodeBlocksRoundTrip([source], '```js\nconst x = 2;\n```')).toHaveLength(1);
  });

  it('accepts a block that came from a transclusion target', () => {
    const host = 'No code here.';
    const target = '```py\nprint(1)\n```';
    expect(assertCodeBlocksRoundTrip([host, target], `Text\n\n${target}`)).toHaveLength(0);
  });

  it('flags a frontmatter key off the allowlist', () => {
    const output = '---\nshare_id: 7k2m9x4qp8vw3n6r\nclient: Acme\n---\n\nBody.';
    const failures = assertFrontmatterAllowlist(output);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('client');
  });
});
