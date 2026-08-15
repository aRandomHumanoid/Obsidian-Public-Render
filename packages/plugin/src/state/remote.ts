/**
 * Reading remote state (§3.5).
 *
 * One authenticated route on the worker:
 *
 *     GET /_manifest
 *     Authorization: Bearer <MANIFEST_TOKEN>
 *
 * **The token is optional.** With it unset, the plugin falls back to issuing a
 * `HEAD` per known share_id and reading `X-Staged-Hash` from the response —
 * not `X-Content-Hash`, which the plugin cannot verify (§3.4). That covers
 * every status except the rarer flavour of Orphan, so the token is a
 * completeness measure rather than a prerequisite.
 */

import { requestUrl } from 'obsidian';
import type { Manifest } from '@notes/shared';
import type { PublisherSettings } from '../settings.js';

export interface RemoteState {
  /** share_id → stagedHash, for everything the plugin could see. */
  hashes: Map<string, string>;
  /** True when the full published set is known — i.e. the manifest was read. */
  complete: boolean;
  fetchedAt: number;
  error?: string;
}

export function emptyRemoteState(): RemoteState {
  return { hashes: new Map(), complete: false, fetchedAt: 0 };
}

export async function fetchRemoteState(
  settings: PublisherSettings,
  knownShareIds: string[],
): Promise<RemoteState> {
  if (!settings.baseUrl) {
    return { ...emptyRemoteState(), error: 'no base URL configured' };
  }

  if (settings.manifestToken) {
    try {
      return await fetchManifest(settings);
    } catch (err) {
      // Fall through to HEAD probing rather than reporting nothing: a wrong
      // token should degrade the panel, not blank it.
      const error = (err as Error).message;
      const probed = await probeHeads(settings, knownShareIds);
      return { ...probed, error };
    }
  }

  return probeHeads(settings, knownShareIds);
}

async function fetchManifest(settings: PublisherSettings): Promise<RemoteState> {
  const response = await requestUrl({
    url: `${settings.baseUrl.replace(/\/+$/, '')}/_manifest`,
    method: 'GET',
    headers: { Authorization: `Bearer ${settings.manifestToken}` },
    throw: false,
  });

  if (response.status === 404) {
    // The worker returns the same 404 for a bad token as for an unknown route,
    // deliberately, so the endpoint's existence is not confirmable (§3.5).
    // From here that is indistinguishable from "no manifest has been written
    // yet", and both are worth saying out loud.
    throw new Error(
      'The manifest endpoint returned 404. Either the token is wrong, or no build has ' +
        'written a manifest yet. Falling back to per-note HEAD requests.',
    );
  }
  if (response.status !== 200) {
    throw new Error(`manifest request failed: HTTP ${response.status}`);
  }

  const manifest = response.json as Manifest;
  const hashes = new Map<string, string>();
  for (const [shareId, entry] of Object.entries(manifest.docs ?? {})) {
    hashes.set(shareId, entry.stagedHash);
  }

  return { hashes, complete: true, fetchedAt: Date.now() };
}

/** The no-token fallback: one HEAD per known share_id (§3.5, §7.1). */
async function probeHeads(
  settings: PublisherSettings,
  knownShareIds: string[],
): Promise<RemoteState> {
  const hashes = new Map<string, string>();
  const base = settings.baseUrl.replace(/\/+$/, '');

  // Bounded concurrency: a few hundred notes should not open a few hundred
  // sockets, and the worker's request quota is not the constraint (§10).
  const queue = [...knownShareIds];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      try {
        const response = await requestUrl({
          url: `${base}/n/${id}`,
          method: 'HEAD',
          throw: false,
        });
        if (response.status !== 200) continue;
        const hash = response.headers['x-staged-hash'] ?? response.headers['X-Staged-Hash'];
        if (hash) hashes.set(id, hash);
      } catch {
        // A single failed probe is not worth failing the refresh over.
      }
    }
  });

  await Promise.all(workers);

  return {
    hashes,
    // Incomplete by construction: a HEAD can only ask about ids we already
    // know, so a live key with nothing local referencing it stays invisible.
    complete: false,
    fetchedAt: Date.now(),
  };
}

/**
 * Verify all (§3.6).
 *
 * Every status in §3.4 is derived from hashes recorded at write time — the
 * plugin's, the build's, the manifest's. Nothing else in the system ever
 * fetches a live page and confirms it matches. A partial write, a manual
 * `wrangler` edit, a purge that silently failed, or an edge node serving
 * something stale would all report as Live and correct, because each layer is
 * faithfully reporting what it believes it wrote.
 *
 * This is the only check in the design that observes rather than infers.
 */
export interface VerifyResult {
  shareId: string;
  ok: boolean;
  detail: string;
}

export async function verifyAll(
  settings: PublisherSettings,
  expected: Map<string, string>,
): Promise<VerifyResult[]> {
  const base = settings.baseUrl.replace(/\/+$/, '');
  const results: VerifyResult[] = [];

  for (const [shareId, stagedHash] of expected) {
    try {
      const response = await requestUrl({ url: `${base}/n/${shareId}`, method: 'GET', throw: false });
      if (response.status !== 200) {
        results.push({ shareId, ok: false, detail: `HTTP ${response.status}` });
        continue;
      }
      const live = response.headers['x-staged-hash'] ?? response.headers['X-Staged-Hash'] ?? '';
      results.push(
        live === stagedHash
          ? { shareId, ok: true, detail: 'matches' }
          : {
              shareId,
              ok: false,
              detail: `live hash ${live.slice(0, 12)}… does not match staged ${stagedHash.slice(0, 12)}…`,
            },
      );
    } catch (err) {
      results.push({ shareId, ok: false, detail: (err as Error).message });
    }
  }

  return results;
}
