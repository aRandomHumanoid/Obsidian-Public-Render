/**
 * Plugin-side behaviour: the status table (§3.4), the Unstage guard (§3.6),
 * and menu availability (§3.10).
 */

import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { deriveStatus, serializeStagedFile, sourceHash, stagedHash } from '@notes/shared';
import type { StatusInput } from '@notes/shared';
import { Actions } from '../packages/plugin/src/actions.js';
import { DEFAULT_SETTINGS } from '../packages/plugin/src/settings.js';
import type { PublisherSettings } from '../packages/plugin/src/settings.js';
import { PublishStore } from '../packages/plugin/src/vault/store.js';
import {
  POST_PUSH_BACKOFF_MS,
  hasInFlightWork,
  nextPollDelay,
  pollWindowMs,
} from '../packages/plugin/src/state/postPushPoll.js';
import { actionsFor } from '../packages/plugin/src/ui/panel.js';
import type { NoteEntry, ScanResult } from '../packages/plugin/src/state/scan.js';
import { Notice } from './harness/obsidian.js';
import { FakeApp } from './harness/app.js';

const ID = '7k2m9x4qp8vw3n6r';

function status(overrides: Partial<StatusInput> = {}) {
  return deriveStatus({
    shareId: ID,
    sourceNotes: 1,
    publishFlag: true,
    pushed: false,
    remoteKnown: true,
    ...overrides,
  });
}

describe('status derivation (§3.4)', () => {
  it('Live: local stagedHash equals remote stagedHash', () => {
    expect(
      status({ publishedHash: 'aaa', remoteHash: 'aaa', pushed: true })?.status,
    ).toBe('live');
  });

  it('Staged: a pending file that has not been materialized and pushed', () => {
    expect(status({ pendingHash: 'aaa' })?.status).toBe('staged');
  });

  it('Building: pushed, remote hash still absent', () => {
    expect(status({ publishedHash: 'aaa', pushed: true })?.status).toBe('building');
  });

  it('Stale: the source has moved on since it was staged', () => {
    expect(
      status({
        publishedHash: 'aaa',
        remoteHash: 'aaa',
        pushed: true,
        currentSourceHash: 'new',
        stagedSourceHash: 'old',
      })?.status,
    ).toBe('stale');
  });

  it('Unstaged: publish: true with a share_id but nothing staged', () => {
    expect(status({ publishFlag: true })?.status).toBe('unstaged');
  });

  it('Removing: the staged file is gone but KV still has it', () => {
    expect(status({ publishFlag: false, remoteHash: 'aaa' })?.status).toBe('removing');
  });

  it('Orphan (common flavour): a staged file no note claims', () => {
    const result = status({ sourceNotes: 0, publishedHash: 'aaa' });
    expect(result?.status).toBe('orphan');
    expect(result?.explanation).toContain('no note carries this share_id');
  });

  it('Orphan (rare flavour): live in KV with nothing local, needs the manifest', () => {
    const result = status({ sourceNotes: 0, remoteHash: 'aaa' });
    expect(result?.status).toBe('orphan');
    expect(result?.explanation).toContain('diverged');
  });

  it('Conflict: two notes claim one share_id', () => {
    expect(status({ sourceNotes: 2, publishedHash: 'aaa' })?.status).toBe('conflict');
  });

  it('Issue: a validation failure outranks everything', () => {
    expect(
      status({
        publishedHash: 'aaa',
        remoteHash: 'aaa',
        issues: [{ severity: 'error', code: 'x', message: 'broken' }],
      })?.status,
    ).toBe('issue');
  });

  it('reports Building rather than Live when remote state is unknown', () => {
    const result = status({ publishedHash: 'aaa', pushed: true, remoteKnown: false });
    expect(result?.status).toBe('building');
    expect(result?.live).toBe(false);
  });

  it('shows nothing for a note with no share_id anywhere', () => {
    expect(status({ sourceNotes: 0 })).toBeNull();
  });
});

describe('Unstage refuses on a live note (§3.6, §11.4)', () => {
  let app: FakeApp;
  let store: PublishStore;
  let actions: Actions;
  let scan: ScanResult | null;
  let settings: PublisherSettings;

  async function seed(options: { live: boolean; pushed: boolean }) {
    app = new FakeApp();
    settings = { ...DEFAULT_SETTINGS, properties: { ...DEFAULT_SETTINGS.properties } };
    store = new PublishStore(app.asApp(), settings);

    const note = app.addNote(
      'Projects/Widget.md',
      `---\npublish: true\nshare_id: ${ID}\n---\n\n# Widget design\n\nBody.\n`,
    );

    const body = '# Widget design\n\nBody.';
    const contents = serializeStagedFile(
      {
        share_id: ID,
        title: 'Widget design',
        source_hash: await sourceHash(body, { title: 'Widget design' }),
        staged: '2026-08-02T14:03:11Z',
        indexable: false,
        download: true,
      },
      body,
    );
    await store.ensureDirs();
    await app.adapter.write(store.publishedPath(ID), contents);

    const entry: NoteEntry = {
      shareId: ID,
      title: 'Widget design',
      file: note,
      status: options.live ? 'live' : 'staged',
      detail: {
        status: options.live ? 'live' : 'staged',
        live: options.live,
        pushed: options.pushed,
        stale: false,
        hasPending: false,
        explanation: '',
      },
      url: `https://notes.example.workers.dev/n/${ID}`,
      stagedAt: '2026-08-02T14:03:11Z',
      claimants: [note],
      localHash: await stagedHash(contents),
      assets: [],
    };

    scan = {
      entries: [entry],
      byShareId: new Map([[ID, entry]]),
      counts: {} as ScanResult['counts'],
      remote: { hashes: new Map(), complete: true, fetchedAt: Date.now() },
      git: {} as ScanResult['git'],
      scannedAt: Date.now(),
    };

    actions = new Actions({
      app: app.asApp(),
      settings,
      store,
      scan: () => scan,
      refresh: async () => {},
    });

    return note;
  }

  beforeEach(() => {
    Notice.shown.length = 0;
  });

  it('refuses, points at Stage for removal, and leaves the staged file intact', async () => {
    const note = await seed({ live: true, pushed: true });

    const result = await actions.unstage(note);

    expect(result).toBe(false);
    expect(await store.readPublished(ID)).not.toBeNull();
    expect(app.contentsOf('Projects/Widget.md')).toContain(`share_id: ${ID}`);
    expect(Notice.shown.join(' ')).toContain('Stage for removal');
  });

  it('refuses on a pushed note even when remote state is unknown', async () => {
    const note = await seed({ live: false, pushed: true });
    expect(await actions.unstage(note)).toBe(false);
    expect(await store.readPublished(ID)).not.toBeNull();
  });

  it('allows unstaging work that never left the machine', async () => {
    const note = await seed({ live: false, pushed: false });

    expect(await actions.unstage(note)).toBe(true);
    expect(await store.readPublished(ID)).toBeNull();
    // The frontmatter the plugin added is reverted; the note itself is not.
    expect(app.contentsOf('Projects/Widget.md')).not.toContain('share_id');
    expect(app.contentsOf('Projects/Widget.md')).toContain('# Widget design');
  });

  it('Stage for removal works on a live note, and records the intent', async () => {
    await seed({ live: true, pushed: true });

    await actions.stageForRemoval(ID);

    expect(await store.readPublished(ID)).toBeNull();
    expect(app.contentsOf('Projects/Widget.md')).toContain('publish: false');
    // `publish: false` rather than deleting the property, because it keeps
    // share_id in the note — re-staging later restores the same URL (§3.6).
    expect(app.contentsOf('Projects/Widget.md')).toContain(`share_id: ${ID}`);
  });

  it('Stage for removal repairs an orphan, with no source note to write to', async () => {
    await seed({ live: true, pushed: true });
    scan = null;

    await actions.stageForRemoval(ID);

    expect(await store.readPublished(ID)).toBeNull();
    expect(Notice.shown.join(' ')).toContain('gone for good');
  });
});

describe('action availability is state-dependent (§3.10)', () => {
  const entry = (status: NoteEntry['status']): NoteEntry =>
    ({
      shareId: ID,
      title: 'x',
      file: null,
      status,
      detail: { status, live: false, pushed: false, stale: false, hasPending: false, explanation: '' },
      url: '',
      stagedAt: null,
      claimants: [],
      localHash: null,
      assets: [],
    }) as NoteEntry;

  it('offers Unstage on a staged note and Stage for removal on a live one, never both', () => {
    const staged = actionsFor(entry('staged')).map((a) => a.label);
    const live = actionsFor(entry('live')).map((a) => a.label);

    expect(staged).toContain('Unstage');
    expect(staged).not.toContain('Stage for removal');
    expect(live).toContain('Stage for removal');
    expect(live).not.toContain('Unstage');
  });

  it('marks orphan removal as permanent', () => {
    const labels = actionsFor(entry('orphan')).map((a) => a.label);
    expect(labels.some((label) => label.includes('permanent'))).toBe(true);
  });
});

/**
 * BRAT installs a beta plugin by reading `manifest.json` from the *repository
 * root* and then downloading the release assets. This is a monorepo, so the
 * real manifest lives in `packages/plugin/` and the root copy is generated
 * (scripts/sync-plugin-manifest.mjs). A stale copy is the failure worth
 * guarding: BRAT would install an older version than the release contains and
 * say nothing.
 */
describe('the root manifest BRAT reads stays in step with the plugin', () => {
  const readJson = async (relative: string) =>
    JSON.parse(await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));

  it('matches packages/plugin/manifest.json field for field', async () => {
    const source = await readJson('../packages/plugin/manifest.json');
    const root = await readJson('../manifest.json');
    expect(root).toEqual(source);
  });

  it('records this version in versions.json, for older Obsidian installs', async () => {
    const source = await readJson('../packages/plugin/manifest.json');
    const versions = await readJson('../versions.json');
    expect(versions[source.version]).toBe(source.minAppVersion);
  });

  it('ships the three files a release must carry as assets', async () => {
    for (const asset of ['main.js', 'manifest.json', 'styles.css']) {
      const path = fileURLToPath(new URL(`../packages/plugin/${asset}`, import.meta.url));
      expect((await stat(path)).size, `${asset} is empty or missing`).toBeGreaterThan(0);
    }
  });
});

/**
 * After a push the panel polls until CI answers (§3.9). The previous schedule
 * was twelve fixed 15s polls — three minutes, unconditional — which expires
 * before a realistic queue plus build, and with `refreshIntervalMinutes`
 * defaulting to 0 nothing refreshed afterwards. The panel then held a stale
 * view until reopened.
 */
describe('post-push polling waits long enough, and stops when it should', () => {
  it('covers a realistic queue plus build, not the old three minutes', () => {
    const minutes = pollWindowMs() / 60_000;
    expect(minutes).toBeGreaterThan(8);
    // A measured build is ~1 minute; the old window was 3. Anything under ~8
    // is back to giving up before a queued build lands.
    expect(minutes).toBeLessThanOrEqual(15);
  });

  it('checks quickly at first, then backs off', () => {
    expect(POST_PUSH_BACKOFF_MS[0]).toBeLessThanOrEqual(5_000);
    for (let i = 1; i < POST_PUSH_BACKOFF_MS.length; i++) {
      expect(POST_PUSH_BACKOFF_MS[i]!).toBeGreaterThanOrEqual(POST_PUSH_BACKOFF_MS[i - 1]!);
    }
  });

  it('runs out rather than polling forever', () => {
    expect(nextPollDelay(0)).not.toBeNull();
    expect(nextPollDelay(POST_PUSH_BACKOFF_MS.length - 1)).not.toBeNull();
    expect(nextPollDelay(POST_PUSH_BACKOFF_MS.length)).toBeNull();
  });

  it('keeps polling while a note is building', () => {
    expect(hasInFlightWork(['live', 'building'])).toBe(true);
  });

  it('keeps polling while a removal is outstanding', () => {
    // The regression that motivated this: a removal has to make the entry
    // *disappear*, so stopping early leaves the panel showing a note that KV
    // has already dropped — and nothing on screen suggests it stopped looking.
    expect(hasInFlightWork(['removing'])).toBe(true);
  });

  it('stops once everything has settled', () => {
    expect(hasInFlightWork([])).toBe(false);
    expect(hasInFlightWork(['live', 'live'])).toBe(false);
    // Staged work is waiting on the *user*, not on CI, so it must not keep the
    // poll alive — that would poll forever on any vault with a staged note.
    expect(hasInFlightWork(['staged', 'stale', 'unstaged'])).toBe(false);
  });
});
