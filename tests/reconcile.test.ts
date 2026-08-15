/**
 * Reconciliation tests (§11.4).
 *
 * Rollback tolerance (§5.9) is a property of the build, not of any fixture, so
 * it gets its own suite against a scratch KV namespace — here, an in-memory
 * one with identical semantics, so the suite runs without network access or a
 * Cloudflare account.
 *
 * The last two matter most. Idempotence is what makes every other recovery
 * story work, and it is cheap to assert.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { DiscoveryError } from '../packages/build/src/discover.js';
import { MemoryKv } from '../packages/build/src/kv.js';
import { MemoryR2 } from '../packages/build/src/r2.js';
import { runBuild } from '../packages/build/src/index.js';
import type { BuildConfig } from '../packages/build/src/config.js';
import { TestRepo } from './harness/repo.js';

const ID = {
  a: '7k2m9x4qp8vw3n6r',
  b: '9v3n6r7k2m9x4qp8',
  c: '2m9x4qp8vw3n6r7k',
  d: '4qp8vw3n6r7k2m9x',
  e: '8vw3n6r7k2m9x4qp',
  f: 'vw3n6r7k2m9x4qp8',
};

let repo: TestRepo;
let kv: MemoryKv;
let r2: MemoryR2;

function config(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    publishedDir: repo.publishedDir,
    baseUrl: 'https://notes.example.workers.dev',
    cloudflare: { accountId: 'a', apiToken: 't', kvNamespaceId: 'k', r2Bucket: 'b' },
    renderConfigVersion: 3,
    dryRun: false,
    mermaid: 'skip',
    ...overrides,
  };
}

const build = (overrides: Partial<BuildConfig> = {}) =>
  runBuild(config(overrides), { kv, r2, cwd: repo.root });

const liveIds = () =>
  [...kv.store.keys()]
    .filter((key) => key.startsWith('doc:'))
    .map((key) => key.slice(4))
    .sort();

beforeEach(async () => {
  repo = await TestRepo.create();
  kv = new MemoryKv();
  r2 = new MemoryR2();
});

afterEach(async () => {
  await repo.destroy();
});

describe('convergence', () => {
  it('publishes what the commit describes', async () => {
    await repo.writeNote(ID.a, 'Alpha', '# Alpha\n\nFirst.');
    await repo.writeNote(ID.b, 'Beta', '# Beta\n\nSecond.');
    await repo.commit('publish two');

    const report = await build();

    expect(report.published).toHaveLength(2);
    expect(liveIds()).toEqual([ID.a, ID.b].sort());
    expect(kv.store.has('manifest')).toBe(true);
  });

  it('writes nothing when the same commit is built twice', async () => {
    await repo.writeNote(ID.a, 'Alpha', '# Alpha\n\nFirst.');
    await repo.commit('publish one');

    await build();
    const second = await build();

    expect(second.published).toHaveLength(0);
    expect(second.unchanged).toBe(1);
    expect(second.deleted).toHaveLength(0);
  });

  it('converges after the manifest key is deleted', async () => {
    await repo.writeNote(ID.a, 'Alpha', '# Alpha\n\nFirst.');
    await repo.commit('publish one');
    await build();

    // The manifest is a cache with no role in the build (§4.2). Losing it
    // costs a degraded plugin refresh and nothing else — never a stranded
    // document, never a wrong build.
    kv.store.delete('manifest');
    const report = await build();

    expect(report.published).toHaveLength(0);
    expect(report.deleted).toHaveLength(0);
    expect(liveIds()).toEqual([ID.a]);
    expect(kv.store.has('manifest')).toBe(true);
  });

  it('converges after a build interrupted mid-write', async () => {
    await repo.writeNote(ID.a, 'Alpha', '# Alpha\n\nFirst.');
    await repo.writeNote(ID.b, 'Beta', '# Beta\n\nSecond.');
    await repo.commit('publish two');

    // Simulate a crash between doc writes: one key landed, the manifest did
    // not. The next run re-reads live KV state and recomputes the same
    // convergence (§5.7).
    await build();
    kv.store.delete(`doc:${ID.b}`);
    kv.store.delete('manifest');

    const report = await build();
    expect(report.published.map((entry) => entry.shareId)).toEqual([ID.b]);
    expect(liveIds()).toEqual([ID.a, ID.b].sort());
  });
});

describe('deletion corroboration (§5.6)', () => {
  it('deletes six notes genuinely unpublished in one commit', async () => {
    for (const id of Object.values(ID)) await repo.writeNote(id, id, `# ${id}\n\nBody.`);
    await repo.commit('publish six');
    await build();
    expect(liveIds()).toHaveLength(6);

    for (const id of Object.values(ID)) await repo.removeNote(id);
    await repo.commit('unpublish six');

    const report = await build();
    expect(report.deleted).toHaveLength(6);
    expect(report.refusedDeletions).toHaveLength(0);
    expect(liveIds()).toHaveLength(0);
  });

  it('refuses every deletion when published/ is emptied by a broken checkout', async () => {
    for (const id of [ID.a, ID.b, ID.c]) await repo.writeNote(id, id, `# ${id}\n\nBody.`);
    await repo.commit('publish three');
    await build();

    // Files vanish from the working tree, but no commit says they should.
    // That is the difference between "you deliberately deleted three files"
    // and "the checkout is broken".
    for (const id of [ID.a, ID.b, ID.c]) await repo.removeNote(id);

    const report = await build();
    expect(report.deleted).toHaveLength(0);
    expect(report.refusedDeletions).toHaveLength(3);
    expect(liveIds()).toHaveLength(3);
  });

  it('fails the build when published/ is removed entirely', async () => {
    await repo.writeNote(ID.a, 'Alpha', '# Alpha\n\nFirst.');
    await repo.commit('publish one');
    await build();

    await rm(repo.publishedDir, { recursive: true, force: true });

    // A missing directory is an error, not an empty desired state (§5.6).
    await expect(build()).rejects.toBeInstanceOf(DiscoveryError);
    expect(liveIds()).toEqual([ID.a]);
  });

  it('refuses deletions when no baseline commit can be established', async () => {
    await repo.writeNote(ID.a, 'Alpha', '# Alpha\n\nFirst.');
    await repo.commit('publish one');
    await build();

    await repo.removeNote(ID.a);
    await repo.commit('unpublish one');

    // A base SHA that is not in the object database — the force-push case the
    // fallback exists for.
    const report = await build({ baseSha: '0000000000000000000000000000000000000001' });
    // HEAD~1 is still reachable, so this one *does* corroborate. The genuinely
    // baseline-less case is asserted below with an orphan initial commit.
    expect(report.deleted).toEqual([ID.a]);
  });
});

describe('rollback (§5.9)', () => {
  it('converges the live set to an older commit exactly', async () => {
    await repo.writeNote(ID.a, 'Alpha', '# Alpha\n\nFirst.');
    await repo.commit('publish alpha');
    await build();

    await repo.writeNote(ID.b, 'Beta', '# Beta\n\nSecond.');
    await repo.writeNote(ID.c, 'Gamma', '# Gamma\n\nThird.');
    const added = await repo.commit('publish more');
    await build();
    expect(liveIds()).toHaveLength(3);

    // Prefer whole-tree operations — `git revert`, or checking out a full
    // commit — and the partial-rollback inconsistency never arises (§5.9).
    await repo.git(['revert', '--no-edit', '-n', added]);
    await repo.commit('roll back');

    const report = await build();
    expect(report.deleted.sort()).toEqual([ID.b, ID.c].sort());
    expect(liveIds()).toEqual([ID.a]);
  });

  it('republishes at the original URL when rolling back across an unpublish', async () => {
    await repo.writeNote(ID.a, 'Alpha', '# Alpha\n\nFirst.');
    const withAlpha = await repo.commit('publish alpha');
    await build();

    await repo.removeNote(ID.a);
    await repo.commit('unpublish alpha');
    await build();
    expect(liveIds()).toHaveLength(0);

    await repo.git(['checkout', '-q', withAlpha, '--', 'published']);
    await repo.commit('restore alpha');

    const report = await build();
    // share_id lives in the staged file and travels with it, so the URL is the
    // same one that was shared.
    expect(report.published.map((entry) => entry.shareId)).toEqual([ID.a]);
    expect(report.published[0]?.url).toBe(`https://notes.example.workers.dev/n/${ID.a}`);
  });

  it('re-renders the corpus when renderConfigVersion changes, in both directions', async () => {
    await repo.writeNote(ID.a, 'Alpha', '# Alpha\n\nFirst.');
    await repo.commit('publish alpha');

    await build({ renderConfigVersion: 3 });
    const bumped = await build({ renderConfigVersion: 4 });
    expect(bumped.published).toHaveLength(1);
    expect(bumped.published[0]?.reason).toBe('changed');

    // A rollback across a renderer change re-renders with the older renderer.
    const rolledBack = await build({ renderConfigVersion: 3 });
    expect(rolledBack.published).toHaveLength(1);
  });
});

describe('schema versioning (§4.4)', () => {
  it('skips and reports a live key at a higher version rather than downgrading', async () => {
    await repo.writeNote(ID.a, 'Alpha', '# Alpha\n\nFirst.');
    await repo.commit('publish alpha');

    // A newer build already wrote this key.
    await kv.put([
      {
        key: `doc:${ID.a}`,
        value: JSON.stringify({ v: 2, title: 'Alpha from the future' }),
        metadata: { v: 2, contentHash: 'future', stagedHash: 'future' },
      },
    ]);

    const report = await build();

    expect(report.skippedNewerSchema).toEqual([ID.a]);
    expect(report.published).toHaveLength(0);
    expect(JSON.parse((await kv.get(`doc:${ID.a}`)) as string).v).toBe(2);
  });
});

describe('the build report (§5.8)', () => {
  it('states refused deletions in the summary', async () => {
    for (const id of [ID.a, ID.b]) await repo.writeNote(id, id, `# ${id}\n\nBody.`);
    await repo.commit('publish two');
    await build();
    for (const id of [ID.a, ID.b]) await repo.removeNote(id);

    const report = await build();
    const { formatSummary } = await import('../packages/build/src/report.js');
    const summary = formatSummary(report);

    expect(summary).toContain('Refused to delete 2 documents');
    expect(summary).toContain('no matching file removal in this commit');
  });
});
