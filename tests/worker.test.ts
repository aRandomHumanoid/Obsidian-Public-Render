/**
 * Worker tests (§11.5).
 *
 * Route-level tests asserting that unknown IDs, deleted IDs and
 * unauthenticated `/_manifest` requests produce byte-identical responses, and
 * that no route reflects input into a path.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@notes/shared';
import type { DocKeyMetadata, DocRecord } from '@notes/shared';
import worker from '../packages/worker/src/index.js';
import type { Env } from '../packages/worker/src/index.js';

const ID = '7k2m9x4qp8vw3n6r';
const OTHER = '9v3n6r7k2m9x4qp8';

class FakeKV {
  readonly store = new Map<string, { value: string; metadata?: DocKeyMetadata }>();

  async get(key: string, type?: string): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  }

  async list(options: { prefix?: string; limit?: number }): Promise<{
    keys: { name: string; metadata?: DocKeyMetadata }[];
    list_complete: boolean;
  }> {
    const keys = [...this.store.entries()]
      .filter(([name]) => !options.prefix || name.startsWith(options.prefix))
      .slice(0, options.limit ?? 1000)
      .map(([name, entry]) => ({ name, metadata: entry.metadata }));
    return { keys, list_complete: true };
  }
}

class FakeR2 {
  readonly store = new Map<string, Uint8Array>();

  async get(key: string): Promise<{ body: Uint8Array; httpEtag: string; size: number } | null> {
    const bytes = this.store.get(key);
    if (!bytes) return null;
    return { body: bytes, httpEtag: `"${key}"`, size: bytes.byteLength };
  }
}

let kv: FakeKV;
let r2: FakeR2;
let env: Env;

function doc(overrides: Partial<DocRecord> = {}): DocRecord {
  return {
    v: SCHEMA_VERSION,
    title: 'Widget design',
    html: '<p>Body.</p>',
    md: '# Widget design\n\nBody.\n',
    updated: '2026-08-02T14:03:11Z',
    contentHash: '9f2c',
    stagedHash: '7a41',
    indexable: false,
    download: true,
    ...overrides,
  };
}

function put(id: string, record: DocRecord): void {
  kv.store.set(`doc:${id}`, {
    value: JSON.stringify(record),
    metadata: { v: record.v, contentHash: record.contentHash, stagedHash: record.stagedHash },
  });
}

const fetch_ = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://notes.example.workers.dev${path}`, init), env);

async function describeResponse(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: [...response.headers.entries()].sort(),
  };
}

beforeEach(() => {
  kv = new FakeKV();
  r2 = new FakeR2();
  env = {
    NOTES: kv as unknown as KVNamespace,
    ASSETS: r2 as unknown as R2Bucket,
    SITE_NAME: 'Notes',
  } as Env;
});

describe('GET /n/:id', () => {
  it('serves a published document', async () => {
    put(ID, doc());
    const response = await fetch_(`/n/${ID}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('Widget design');
    expect(body).toContain('<p>Body.</p>');
  });

  it('emits X-Staged-Hash, never X-Content-Hash', async () => {
    put(ID, doc());
    const response = await fetch_(`/n/${ID}`);

    expect(response.headers.get('X-Staged-Hash')).toBe('7a41');
    expect(response.headers.get('X-Content-Hash')).toBeNull();
  });

  it('forbids all script and sets a five-minute browser cache (§7.3)', async () => {
    put(ID, doc());
    const response = await fetch_(`/n/${ID}`);
    const csp = response.headers.get('Content-Security-Policy') ?? '';

    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('marks pages noindex unless opted in', async () => {
    put(ID, doc());
    put(OTHER, doc({ indexable: true }));

    expect((await fetch_(`/n/${ID}`)).headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect((await fetch_(`/n/${OTHER}`)).headers.get('X-Robots-Tag')).toBe('index, follow');
  });

  it('ships no JavaScript at all', async () => {
    put(ID, doc());
    const body = await (await fetch_(`/n/${ID}`)).text();
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/\son[a-z]+=/i);
  });
});

describe('HEAD /n/:id — the no-token fallback (§3.5)', () => {
  it('answers from key metadata with no body', async () => {
    put(ID, doc());
    const response = await fetch_(`/n/${ID}`, { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Staged-Hash')).toBe('7a41');
    expect(await response.text()).toBe('');
  });

  it('404s for an id that is not live', async () => {
    expect((await fetch_(`/n/${ID}`, { method: 'HEAD' })).status).toBe(404);
  });
});

describe('GET /n/:id.md', () => {
  it('returns the markdown as an attachment', async () => {
    put(ID, doc());
    const response = await fetch_(`/n/${ID}.md`);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    expect(await response.text()).toContain('# Widget design');
  });

  it('404s when download is false', async () => {
    put(ID, doc({ download: false }));
    expect((await fetch_(`/n/${ID}.md`)).status).toBe(404);
  });

  it('does not let a title inject a header', async () => {
    put(ID, doc({ title: 'Evil"\r\nX-Injected: yes' }));
    const disposition = (await fetch_(`/n/${ID}.md`)).headers.get('Content-Disposition') ?? '';

    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
    expect((await fetch_(`/n/${ID}.md`)).headers.get('X-Injected')).toBeNull();
  });
});

describe('byte-identical 404s (§7.1)', () => {
  it('cannot distinguish unknown, deleted and unauthenticated', async () => {
    put(OTHER, doc());
    env.MANIFEST_TOKEN = 'correct-horse';

    const unknown = await describeResponse(await fetch_('/n/aaaaaaaaaaaaaaaa'));
    const malformed = await describeResponse(await fetch_('/n/not-a-share-id'));
    const unrouted = await describeResponse(await fetch_('/no/such/route'));
    const unauthenticated = await describeResponse(await fetch_('/_manifest'));
    const badToken = await describeResponse(
      await fetch_('/_manifest', { headers: { Authorization: 'Bearer wrong' } }),
    );

    for (const other of [malformed, unrouted, unauthenticated, badToken]) {
      expect(other).toEqual(unknown);
    }
  });

  it('returns the same 404 for a document at an unknown schema version (§4.4)', async () => {
    kv.store.set(`doc:${ID}`, {
      value: JSON.stringify({ ...doc(), v: 99 }),
      metadata: { v: 99, contentHash: 'x', stagedHash: 'y' },
    });

    const future = await describeResponse(await fetch_(`/n/${ID}`));
    const unknown = await describeResponse(await fetch_('/n/aaaaaaaaaaaaaaaa'));
    expect(future).toEqual(unknown);
  });

  it('404s a POST rather than answering it', async () => {
    put(ID, doc());
    expect((await fetch_(`/n/${ID}`, { method: 'POST' })).status).toBe(404);
  });
});

describe('GET /_manifest', () => {
  it('returns the manifest for a correct token', async () => {
    env.MANIFEST_TOKEN = 'correct-horse';
    kv.store.set('manifest', { value: JSON.stringify({ v: 1, docs: {} }) });

    const response = await fetch_('/_manifest', {
      headers: { Authorization: 'Bearer correct-horse' },
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({ v: 1, docs: {} });
  });

  it('404s when no token is configured at all', async () => {
    kv.store.set('manifest', { value: '{}' });
    const response = await fetch_('/_manifest', { headers: { Authorization: 'Bearer anything' } });
    expect(response.status).toBe(404);
  });
});

describe('GET /a/:key — no route reflects input into a path', () => {
  it('serves a validated asset key', async () => {
    r2.store.set('assets/a1b2c3d4e5f6a7b8.webp', new Uint8Array([1, 2, 3]));
    const response = await fetch_('/a/a1b2c3d4e5f6a7b8.webp');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('rejects traversal and anything off the allowlist', async () => {
    r2.store.set('assets/a1b2c3d4e5f6a7b8.webp', new Uint8Array([1]));

    for (const key of [
      '..%2F..%2Fmanifest',
      'a1b2c3d4e5f6a7b8.html',
      'a1b2c3d4e5f6a7b8',
      'A1B2C3D4E5F6A7B8.webp',
      'a1b2c3d4e5f6a7b8.webp.exe',
      '../manifest',
    ]) {
      expect((await fetch_(`/a/${key}`)).status).toBe(404);
    }
  });

  it('serves SVG with an explicit type and a sandbox, never sniffed', async () => {
    r2.store.set('assets/a1b2c3d4e5f6a7b8.svg', new TextEncoder().encode('<svg/>'));
    const response = await fetch_('/a/a1b2c3d4e5f6a7b8.svg');

    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  });
});

describe('GET /', () => {
  it('is a static placeholder with no index and no listing', async () => {
    put(ID, doc());
    const body = await (await fetch_('/')).text();

    expect(body).not.toContain(ID);
    expect(body).not.toContain('Widget design');
  });
});
