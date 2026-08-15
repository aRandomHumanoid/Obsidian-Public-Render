/**
 * Discover (§5.3).
 *
 * Fail on: duplicate `share_id` across files, a referenced asset missing from
 * `_assets/`, a metadata block that does not parse. No vault scanning, no link
 * resolution, no manifest cross-check — there is no manifest file to disagree
 * with.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeStagedFile } from '@notes/shared';
import { DiscoveryError, discover } from '../packages/build/src/discover.js';

const ID = '7k2m9x4qp8vw3n6r';
const OTHER = '9v3n6r7k2m9x4qp8';

let dir: string;

const staged = (shareId: string, body: string, title = 'A note') =>
  serializeStagedFile(
    {
      share_id: shareId,
      title,
      source_hash: 'abc',
      staged: '2026-08-02T14:03:11Z',
      indexable: false,
      download: true,
    },
    body,
  );

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notes-discover-'));
  await mkdir(path.join(dir, 'published', '_assets'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const published = () => path.join(dir, 'published');

describe('discover', () => {
  it('reads the corpus and derives each document’s assets', async () => {
    await writeFile(
      path.join(published(), `${ID}.md`),
      staged(ID, '# A note\n\n![x](_assets/a1b2c3d4e5f6a7b8.png)'),
    );
    await writeFile(path.join(published(), '_assets', 'a1b2c3d4e5f6a7b8.png'), 'bytes');

    const result = await discover(published());

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.assets).toEqual(['a1b2c3d4e5f6a7b8.png']);
    expect(result.documents[0]?.stagedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails on a referenced asset that is not in the corpus', async () => {
    await writeFile(
      path.join(published(), `${ID}.md`),
      staged(ID, '![x](_assets/missing.png)'),
    );

    await expect(discover(published())).rejects.toThrow(DiscoveryError);
    await expect(discover(published())).rejects.toThrow(/not in the corpus/);
  });

  it('fails on a metadata block that does not parse', async () => {
    await writeFile(path.join(published(), `${ID}.md`), '---\nnot: [valid\n---\n\nBody.');
    await expect(discover(published())).rejects.toThrow(/does not parse|not a mapping/);
  });

  it('fails when the file name and the metadata disagree about the share_id', async () => {
    // The panel reads the filename and the reconciler reads the metadata; a
    // mismatch means they would disagree about which page a file controls.
    await writeFile(path.join(published(), `${OTHER}.md`), staged(ID, 'Body.'));
    await expect(discover(published())).rejects.toThrow(/expected file name/);
  });

  it('fails on a duplicate share_id', async () => {
    // Two files cannot both be `<id>.md`, so a duplicate reaches discovery only
    // via a name mismatch — which is caught first, and says so.
    await writeFile(path.join(published(), `${ID}.md`), staged(ID, 'One.'));
    await writeFile(path.join(published(), `${OTHER}.md`), staged(ID, 'Two.'));
    await expect(discover(published())).rejects.toThrow(DiscoveryError);
  });

  it('accepts an existing-but-empty corpus as "nothing should be published"', async () => {
    const result = await discover(published());
    expect(result.documents).toHaveLength(0);
  });

  it('rejects a missing directory as an error, not an empty desired state', async () => {
    await rm(published(), { recursive: true, force: true });
    await expect(discover(published())).rejects.toThrow(/is missing/);
  });
});
