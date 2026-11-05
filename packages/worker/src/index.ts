/**
 * The public-facing worker (§7).
 *
 * It holds no GitHub credentials and has no network path to the repo. Its
 * bindings — one KV namespace, one R2 bucket — are the complete universe of
 * data it can reach, and that universe contains only things a build already
 * decided to publish.
 *
 * Invariant: the worker can only serve bytes that a build already decided to
 * publish. Every change here should be reviewed against that sentence.
 */

import { timingSafeEqual } from '@notes/shared/hash.js';
import { SHARE_ID_PATTERN } from '@notes/shared/shareId.js';
import { WORKER_MAX_SCHEMA_VERSION } from '@notes/shared/schema.js';
import type { DocKeyMetadata, DocRecord } from '@notes/shared/types.js';
import { renderPage, renderRoot } from './shell.js';

export interface Env {
  NOTES: KVNamespace;
  ASSETS: R2Bucket;
  /** Optional (§3.5). Unset means /_manifest 404s like any unknown route. */
  MANIFEST_TOKEN?: string;
  SITE_NAME?: string;
}

const NOTE_ROUTE = /^\/n\/([^/]+?)(\.md)?$/;
const ASSET_ROUTE = /^\/a\/([^/]+)$/;

/**
 * §7.1: `:key` is validated before use. This is the one route where input is
 * concatenated into a storage key rather than used as a flat lookup, so it
 * gets an explicit rule rather than relying on R2 to reject nonsense.
 */
const ASSET_KEY_PATTERN = /^[0-9a-f]{16}\.(webp|png|jpg|svg)$/;

const ASSET_CONTENT_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
};

/**
 * A single 404. Unknown IDs, deleted IDs, documents at an unknown schema
 * version, `download: false` markdown requests and unauthenticated
 * `/_manifest` requests all return **this exact response**. Distinguishing
 * them confirms existence, and the entire privacy model of these links is that
 * they are unguessable.
 */
const NOT_FOUND_BODY = 'Not found\n';

function notFound(): Response {
  return new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/') {
      return html(renderRoot(env.SITE_NAME ?? 'Notes'), { cache: 'public, max-age=3600' });
    }

    if (path === '/_manifest') return handleManifest(request, env);

    const note = NOTE_ROUTE.exec(path);
    if (note) {
      const id = note[1] ?? '';
      if (!SHARE_ID_PATTERN.test(id)) return notFound();
      return note[2] === '.md'
        ? handleDownload(env, id)
        : handleNote(request, env, id);
    }

    const asset = ASSET_ROUTE.exec(path);
    if (asset) return handleAsset(request, env, asset[1] ?? '');

    return notFound();
  },
} satisfies ExportedHandler<Env>;

/**
 * `GET /_manifest` (§3.5).
 *
 * Constant-time token comparison, and the **same 404** as any unknown route on
 * a bad or missing token, so the endpoint's existence is not confirmable.
 *
 * This response is the complete list of published share_ids — every unlisted
 * URL you have, in one place. It is much safer than a PAT and considerably
 * more sensitive than "read-only metadata" implies.
 */
async function handleManifest(request: Request, env: Env): Promise<Response> {
  const expected = env.MANIFEST_TOKEN;
  const header = request.headers.get('Authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  // Compare even when no token is configured, so an unconfigured worker takes
  // the same time as a wrong guess against a configured one.
  const ok = timingSafeEqual(presented, expected ?? '\0unset');
  if (!expected || !ok) return notFound();

  const manifest = await env.NOTES.get('manifest', 'stream');
  if (!manifest) return notFound();

  return new Response(manifest, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/**
 * `GET|HEAD /n/:id` — a single KV read, wrapped in the page shell.
 *
 * HEAD is not merely GET-without-a-body: it is the plugin's no-token fallback
 * path (§3.5), so it answers from KV *key metadata* via `getWithMetadata` and
 * never parses the document value.
 */
async function handleNote(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method === 'HEAD') {
    // A keyed read, not a one-key `list`: lists are metered far more tightly
    // than reads (1,000 vs 100,000 a day on the free plan) and the plugin sends
    // one HEAD per note on every refresh, so `list` here exhausted the account
    // quota and broke the CI build that shares it. The value is opened as a
    // stream and cancelled unread, so this still never parses the document.
    const { value, metadata: meta } = await env.NOTES.getWithMetadata<DocKeyMetadata>(
      `doc:${id}`,
      { type: 'stream', cacheTtl: 60 },
    );
    if (!value) return notFound();
    await value.cancel();
    if (meta && meta.v > WORKER_MAX_SCHEMA_VERSION) return notFound();
    return new Response(null, {
      headers: pageHeaders({
        stagedHash: meta?.stagedHash ?? '',
        // Without reading the value we cannot know `indexable`, and guessing
        // wrong in the permissive direction would be the wrong error. A HEAD
        // is never what a crawler indexes anyway.
        indexable: false,
      }),
    });
  }

  const doc = await env.NOTES.get<DocRecord>(`doc:${id}`, 'json');
  if (!doc) return notFound();

  // Readers tolerate what they know (§4.4). An unknown higher `v` returns the
  // standard 404 rather than a partial render, and logs.
  if (doc.v > WORKER_MAX_SCHEMA_VERSION) {
    console.warn(
      `doc:${id} is schema v${doc.v}; this worker serves up to v${WORKER_MAX_SCHEMA_VERSION}. Deploy the reader first (§4.4).`,
    );
    return notFound();
  }

  const body = renderPage({
    title: doc.title,
    html: doc.html,
    updated: doc.updated,
    downloadHref: doc.download ? `/n/${id}.md` : null,
    siteName: env.SITE_NAME ?? 'Notes',
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...pageHeaders({ stagedHash: doc.stagedHash, indexable: doc.indexable }),
    },
  });
}

/** `GET /n/:id.md` — the download copy, with absolute asset URLs (§5.5). */
async function handleDownload(env: Env, id: string): Promise<Response> {
  const doc = await env.NOTES.get<DocRecord>(`doc:${id}`, 'json');
  if (!doc) return notFound();
  if (doc.v > WORKER_MAX_SCHEMA_VERSION) return notFound();
  // `download: false` is indistinguishable from "no such note", by design.
  if (!doc.download) return notFound();

  return new Response(doc.md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': contentDisposition(doc.title, id),
      ...pageHeaders({ stagedHash: doc.stagedHash, indexable: doc.indexable }),
    },
  });
}

/**
 * `GET /a/:key` — stream from R2.
 *
 * Assets stay behind the worker rather than being served from a public bucket
 * domain (§7.4): `r2.dev` is documented as not intended for production, and
 * routing through here keeps the asset headers below applying uniformly.
 */
async function handleAsset(request: Request, env: Env, key: string): Promise<Response> {
  if (!ASSET_KEY_PATTERN.test(key)) return notFound();

  const ext = key.slice(key.lastIndexOf('.') + 1);
  const contentType = ASSET_CONTENT_TYPES[ext];
  if (!contentType) return notFound();

  const object = await env.ASSETS.get(`assets/${key}`, {
    onlyIf: request.headers,
    range: request.headers,
  });
  if (!object) return notFound();

  const headers = new Headers({
    // Explicit, never sniffed. `nosniff` plus an explicit Content-Type stops a
    // mislabelled asset being reinterpreted as HTML.
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    // SVG is an active document format (§5.5). It is sanitized at build time,
    // but the sanitizer is the kind of thing that acquires a bypass, so
    // `sandbox` with no allow-list means an SVG opened at its own URL cannot
    // run script even if the build-time pass missed something. The page CSP in
    // §7.3 does not govern an asset fetched directly, which is why this exists.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    ETag: object.httpEtag,
  });

  // `onlyIf` returns a bodyless object when the precondition fails.
  if (!('body' in object) || object.body === null) {
    return new Response(null, { status: 304, headers });
  }

  if (object.range && 'offset' in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { headers });
}

function pageHeaders(opts: { stagedHash: string; indexable: boolean }): Record<string, string> {
  return {
    // `default-src 'none'` with no `script-src` means no JavaScript can run at
    // all — possible only because rendering happens at build time, and a large
    // part of why that choice was made (§2.3).
    'Content-Security-Policy':
      "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    'X-Robots-Tag': opts.indexable ? 'index, follow' : 'noindex, nofollow',
    // The plugin verifies `stagedHash`, never `contentHash`: the latter folds
    // in `renderConfigVersion`, a build-side constant the plugin has no
    // business knowing (§3.4, §7.1).
    'X-Staged-Hash': opts.stagedHash,
    'Referrer-Policy': 'no-referrer',
    // No `s-maxage` and no purge step: workers.dev has no zone to purge
    // (§7.4). A five-minute browser cache is the only staleness window, and it
    // bounds how long a reader who already has the page open can see removed
    // content.
    'Cache-Control': 'public, max-age=300',
  };
}

function html(body: string, opts: { cache: string }): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': opts.cache,
    },
  });
}

/**
 * A filename for the download. The title is already public, so using it leaks
 * nothing — but it must not be allowed to inject a header, so the ASCII
 * fallback is aggressively reduced and the real title goes in the RFC 5987
 * parameter.
 */
function contentDisposition(title: string, id: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const fallback = ascii.length > 0 ? `${ascii}.md` : `${id}.md`;
  const encoded = encodeURIComponent(`${title}.md`).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback.replace(/"/g, '')}"; filename*=UTF-8''${encoded}`;
}
