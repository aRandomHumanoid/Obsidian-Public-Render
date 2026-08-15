/**
 * The fixture corpus (§11.1), run through the staging pipeline.
 *
 * A directory of pathological notes with assertions about what may and may not
 * survive. Every row of §11.1's table that is a *staging* property lives here;
 * render-side rows live in render.test.ts and reconciliation rows in
 * reconcile.test.ts.
 */

import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseStagedFile, splitFrontmatter } from '@notes/shared';
import { PUBLISHED_METADATA_KEYS } from '@notes/shared';
import { stageNote } from '../packages/plugin/src/staging/pipeline.js';
import { CriticalAssertionError } from '@notes/shared';
import { FakeDataview, FakeVault } from './harness/vault.js';

const VAULT_DIR = fileURLToPath(new URL('../fixtures/vault', import.meta.url));

let vault: FakeVault;

async function stage(path: string, options: { acknowledged?: Set<string> } = {}) {
  const file = vault.file(path);
  const record = vault.files.get(path)!;
  const frontmatter = vault.frontmatterOf(record);

  return stageNote({
    file,
    shareId: String(frontmatter['share_id']),
    title: vault.noteTitle(file),
    indexable: frontmatter['publish_index'] === true,
    download: frontmatter['publish_download'] !== false,
    acknowledged: options.acknowledged ?? new Set<string>(),
    ctx: vault,
  });
}

beforeAll(async () => {
  vault = await FakeVault.fromDirectory(VAULT_DIR);
  vault.dataview = new FakeDataview({
    'TABLE status FROM #project': {
      markdown: '| File | status |\n| ---- | ------ |\n| Widget | active |',
      rows: 1,
    },
    'TABLE status FROM #nothing-matches-this': { markdown: '', rows: 0 },
    'this.title': { markdown: 'Dataview table', rows: 1 },
  });
});

describe('comments.md — no %% content survives staging', () => {
  it('removes inline and block comments', async () => {
    const staged = await stage('comments.md');
    const { body } = splitFrontmatter(staged.contents);

    expect(body).not.toContain('%%');
    expect(body).not.toContain('this must not survive');
    expect(body).not.toContain('A block comment spanning');
    expect(body).toContain('Visible before.');
    expect(body).toContain('Visible after.');
  });

  it('does not leak a link that only appeared inside a comment', async () => {
    const staged = await stage('comments.md');
    expect(staged.contents).not.toContain('Internal roadmap');
    expect(staged.contents).not.toContain('internal-roadmap');
    expect(staged.contents).not.toContain('Q4 acquisition targets');
  });
});

describe('comments-in-code-block.md — fenced blocks round-trip byte-identically', () => {
  it('leaves every %% inside code untouched', async () => {
    const staged = await stage('comments-in-code-block.md');

    // The Erlang block, verbatim. This is the assertion a regex-based stripper
    // fails while still passing the comment check (§11.2).
    expect(staged.contents).toContain('%% In Erlang, %% starts a comment.');
    expect(staged.contents).toContain('%% Two of them, unpaired with anything.');
    expect(staged.contents).toContain('`%%` must survive here too');
    expect(staged.contents).toContain('%% An indented code block also counts as code.');
  });

  it('still removes the real comment outside the block', async () => {
    const staged = await stage('comments-in-code-block.md');
    expect(staged.contents).not.toContain('must be removed');
    expect(staged.contents).toContain('A real comment follows, and it  without touching the block.');
  });

  it('passes its own pre-publish self-check', async () => {
    // §11.3: the plugin runs the three assertions against the bytes it is
    // about to write and refuses on failure. Reaching this line means it did.
    await expect(stage('comments-in-code-block.md')).resolves.toBeDefined();
  });
});

describe('private-frontmatter.md — only allowlisted keys survive', () => {
  it('drops every unlisted property', async () => {
    const staged = await stage('private-frontmatter.md');
    const { frontmatter } = splitFrontmatter(staged.contents);

    expect(frontmatter).not.toBeNull();
    for (const leak of ['client', 'invoice_total', 'personal_note', 'tags', 'aliases', 'created']) {
      expect(staged.contents).not.toContain(leak);
    }
    expect(staged.contents).not.toContain('Acme Corporation');
    expect(staged.contents).not.toContain('48000');
  });

  it('keeps exactly the published allowlist', async () => {
    const staged = await stage('private-frontmatter.md');
    const parsed = parseStagedFile(staged.contents);
    expect(parsed.metadata.share_id).toBe('2m9x4qp8vw3n6r7k');
    expect(Object.keys(parsed.metadata).sort()).toEqual([...PUBLISHED_METADATA_KEYS].sort());
  });
});

describe('link-to-unpublished.md — the target’s title appears nowhere', () => {
  it('removes the link and its text', async () => {
    const staged = await stage('link-to-unpublished.md');

    expect(staged.contents).not.toContain('internal-roadmap');
    expect(staged.contents).not.toContain('Q4 acquisition targets');
    expect(staged.contents).not.toContain('[[');
  });

  it('rewrites a link to a published note', async () => {
    const staged = await stage('link-to-unpublished.md');
    expect(staged.contents).toContain('](/n/2m9x4qp8vw3n6r7k)');
  });

  it('records every removal for the detail pane', async () => {
    const staged = await stage('link-to-unpublished.md');
    expect(staged.dropped.length).toBeGreaterThanOrEqual(2);
    expect(staged.dropped.every((link) => link.raw.startsWith('[['))).toBe(true);
  });
});

describe('link-with-alias.md — the alias survives only when it reveals nothing', () => {
  it('keeps an alias that differs from both filename and title', async () => {
    const staged = await stage('link-with-alias.md');
    expect(staged.contents).toContain('the thing we discussed');
  });

  it('drops an alias equal to the filename or the title, case-insensitively', async () => {
    const staged = await stage('link-with-alias.md');
    expect(staged.contents.toLowerCase()).not.toContain('q4 acquisition targets');
    expect(staged.contents).not.toContain('internal-roadmap');
  });
});

describe('transclusion-of-note-linking-private.md — composition uses staged output', () => {
  it('leaks neither the private note’s title nor its content', async () => {
    const staged = await stage('transclusion-of-note-linking-private.md');

    expect(staged.contents).toContain('Published B');
    expect(staged.contents).not.toContain('Q4 acquisition targets');
    expect(staged.contents).not.toContain('internal-roadmap');
    expect(staged.contents).not.toContain('Ambergris');
  });
});

describe('transclusion-unpublished.md — dropped entirely', () => {
  it('inlines nothing and records the drop', async () => {
    const staged = await stage('transclusion-unpublished.md');
    expect(staged.contents).not.toContain('Ambergris');
    expect(staged.contents).not.toContain('Q4 acquisition targets');
    expect(staged.dropped.some((link) => link.reason === 'unpublished')).toBe(true);
  });
});

describe('cycle-a.md — a transclusion cycle terminates', () => {
  it('finishes and reports the cycle', async () => {
    const staged = await stage('cycle-a.md');
    expect(staged.contents).toContain('Cycle B');
    expect(staged.issues.some((issue) => issue.code === 'transclusion-cycle')).toBe(true);
  });
});

describe('case-mismatch-embed.md — a validation error, not a silent 404', () => {
  it('reports the unresolved embed as an error', async () => {
    const staged = await stage('case-mismatch-embed.md');
    const error = staged.issues.find((issue) => issue.code === 'embed-unresolved');
    expect(error).toBeDefined();
    expect(error?.severity).toBe('error');
  });
});

describe('excalidraw-no-export.md — a validation error', () => {
  it('refuses an Excalidraw embed with no SVG companion', async () => {
    vault.addNote('sketch.excalidraw', '{"type":"excalidraw"}');
    const staged = await stage('excalidraw-no-export.md');
    const error = staged.issues.find((issue) => issue.code === 'excalidraw-no-export');
    expect(error).toBeDefined();
    expect(error?.severity).toBe('error');
  });

  it('accepts one when the companion exists', async () => {
    const local = await FakeVault.fromDirectory(VAULT_DIR);
    local.dataview = vault.dataview;
    local.addNote('sketch.excalidraw', '{"type":"excalidraw"}');
    local.addBinary('sketch.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'));

    const file = local.file('excalidraw-no-export.md');
    const staged = await stageNote({
      file,
      shareId: 'p8vw3n6r7k2m9x4q',
      title: 'Excalidraw without an export',
      indexable: false,
      download: true,
      acknowledged: new Set(),
      ctx: local,
    });

    expect(staged.issues.some((issue) => issue.code === 'excalidraw-no-export')).toBe(false);
    expect(staged.assets).toHaveLength(1);
    expect(staged.contents).toContain('_assets/');
  });
});

describe('dataview — materialization and the empty-result block (§9)', () => {
  it('replaces the fence with markdown', async () => {
    const staged = await stage('dataview-table.md');
    expect(staged.contents).toContain('| File | status |');
    expect(staged.contents).not.toContain('```dataview');
  });

  it('evaluates inline queries', async () => {
    const staged = await stage('dataview-table.md');
    expect(staged.contents).toContain('Inline too: Dataview table.');
  });

  it('blocks publishing on a query returning zero rows', async () => {
    const staged = await stage('dataview-empty.md');
    const blocked = staged.issues.find((issue) => issue.code === 'dataview-empty');
    expect(blocked?.severity).toBe('error');
    expect(staged.emptyQueries).toHaveLength(1);
  });

  it('proceeds once the query hash is acknowledged', async () => {
    const first = await stage('dataview-empty.md');
    const hash = first.emptyQueries[0]?.hash as string;
    const second = await stage('dataview-empty.md', { acknowledged: new Set([hash]) });
    expect(second.issues.some((issue) => issue.code === 'dataview-empty')).toBe(false);
  });

  it('treats an unready index as a hard block, never a warning', async () => {
    const local = await FakeVault.fromDirectory(VAULT_DIR);
    local.dataview = new FakeDataview({}, false);
    await expect(
      stageNote({
        file: local.file('dataview-table.md'),
        shareId: 'vw3n6r7k2m9x4qp8',
        title: 'Dataview table',
        indexable: false,
        download: true,
        acknowledged: new Set(),
        ctx: local,
      }),
    ).rejects.toThrow(/index is not ready/i);
  });
});

describe('attachment caps (§3.7 step 1)', () => {
  it('warns above the soft cap and fails above the hard cap', async () => {
    const local = await FakeVault.fromDirectory(VAULT_DIR);
    local.dataview = vault.dataview;
    local.addBinary('big.png', new Uint8Array(3 * 1024 * 1024));
    local.addNote(
      'oversized-image.md',
      '---\npublish: true\nshare_id: b2c3d4e5f6a7b8c9\ntitle: Oversized image\n---\n\n![[big.png]]\n',
    );

    const warned = await stageNote({
      file: local.file('oversized-image.md'),
      shareId: 'b2c3d4e5f6a7b8c9',
      title: 'Oversized image',
      indexable: false,
      download: true,
      acknowledged: new Set(),
      ctx: local,
    });
    expect(warned.assets).toHaveLength(1);
    expect(local.issues.some((issue) => issue.code === 'attachment-large')).toBe(true);

    local.addBinary('huge.png', new Uint8Array(11 * 1024 * 1024));
    local.addNote(
      'huge-image.md',
      '---\npublish: true\nshare_id: c3d4e5f6a7b8c9d0\ntitle: Huge image\n---\n\n![[huge.png]]\n',
    );
    await expect(
      stageNote({
        file: local.file('huge-image.md'),
        shareId: 'c3d4e5f6a7b8c9d0',
        title: 'Huge image',
        indexable: false,
        download: true,
        acknowledged: new Set(),
        ctx: local,
      }),
    ).rejects.toThrow(/hard limit/);
  });
});

describe('everything.md — kitchen sink', () => {
  it('stages, and the metadata block carries only the allowlist', async () => {
    const staged = await stage('everything.md');
    const parsed = parseStagedFile(staged.contents);

    expect(parsed.metadata.title).toBe('Everything');
    expect(parsed.metadata.indexable).toBe(true);
    expect(staged.contents).not.toContain('secret_client');
    expect(staged.contents).not.toContain('%%');
    expect(staged.contents).not.toContain('Not published.');
  });

  it('preserves the code block byte-for-byte', async () => {
    const staged = await stage('everything.md');
    expect(staged.contents).toContain('  // 16 characters of Crockford base32 — ~80 bits.');
  });

  it('materialises the block anchor a reference could point at', async () => {
    const staged = await stage('everything.md');
    expect(staged.contents).toContain('<span id="b-kitchen-sink"></span>');
    expect(staged.contents).not.toMatch(/\^kitchen-sink\s*$/m);
  });

  it('rewrites a published heading link to an anchor', async () => {
    const staged = await stage('everything.md');
    expect(staged.contents).toContain('(/n/w3n6r7k2m9x4qp8v#published-b)');
  });
});

describe('the pre-publish self-check fails closed (§11.3)', () => {
  it('refuses to write output that would leak a comment delimiter', async () => {
    const local = await FakeVault.fromDirectory(VAULT_DIR);
    // A staged body that somehow still carries `%%` must not be writable. The
    // only way to reach this state is a bug upstream, which is the point.
    const bad = '---\nshare_id: 7k2m9x4qp8vw3n6r\ntitle: x\nsource_hash: a\nstaged: 2026-01-01T00:00:00Z\nindexable: false\ndownload: true\n---\n\nleft %% over\n';
    const { enforceCriticalAssertions } = await import('@notes/shared');
    expect(() => enforceCriticalAssertions({ output: bad, sources: [] })).toThrow(
      CriticalAssertionError,
    );
    void local;
  });
});
