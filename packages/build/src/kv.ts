/**
 * Workers KV access from CI.
 *
 * Everything the reconciler needs is behind `KvClient`, so the reconciliation
 * suite (§11.4) can run against an in-memory implementation with identical
 * semantics rather than against a live namespace. Those tests are the ones
 * that make every recovery story in §5.9 real, and they should not need
 * network access to run.
 */

import type { DocKeyMetadata } from '@notes/shared';

export interface KvListed {
  name: string;
  metadata?: DocKeyMetadata;
}

export interface KvWrite {
  key: string;
  value: string;
  metadata?: DocKeyMetadata;
}

export interface KvClient {
  /** Every key under a prefix, with its key metadata. */
  list(prefix: string): Promise<KvListed[]>;
  put(writes: KvWrite[]): Promise<void>;
  delete(keys: string[]): Promise<void>;
  get(key: string): Promise<string | null>;
}

const API = 'https://api.cloudflare.com/client/v4';

/** Cloudflare's bulk endpoints cap at 10,000 pairs; stay well inside it. */
const BULK_LIMIT = 1000;

export interface CloudflareKvOptions {
  accountId: string;
  apiToken: string;
  namespaceId: string;
  fetchImpl?: typeof fetch;
}

export class CloudflareKv implements KvClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CloudflareKvOptions) {
    this.base = `${API}/accounts/${options.accountId}/storage/kv/namespaces/${options.namespaceId}`;
    this.headers = { Authorization: `Bearer ${options.apiToken}` };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async list(prefix: string): Promise<KvListed[]> {
    const out: KvListed[] = [];
    let cursor: string | undefined;

    do {
      const url = new URL(`${this.base}/keys`);
      url.searchParams.set('limit', '1000');
      if (prefix) url.searchParams.set('prefix', prefix);
      if (cursor) url.searchParams.set('cursor', cursor);

      const body = await this.request<{ name: string; metadata?: DocKeyMetadata }[]>(url, {
        method: 'GET',
      });
      out.push(...body.result.map((k) => ({ name: k.name, metadata: k.metadata })));
      cursor = body.result_info?.cursor || undefined;
    } while (cursor);

    return out;
  }

  async put(writes: KvWrite[]): Promise<void> {
    for (const batch of chunk(writes, BULK_LIMIT)) {
      await this.request(new URL(`${this.base}/bulk`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          batch.map((w) => ({
            key: w.key,
            value: w.value,
            ...(w.metadata ? { metadata: w.metadata } : {}),
          })),
        ),
      });
    }
  }

  async delete(keys: string[]): Promise<void> {
    for (const batch of chunk(keys, BULK_LIMIT)) {
      await this.request(new URL(`${this.base}/bulk`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
    }
  }

  async get(key: string): Promise<string | null> {
    const response = await this.fetchImpl(`${this.base}/values/${encodeURIComponent(key)}`, {
      headers: this.headers,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`KV get ${key} failed: ${response.status} ${await response.text()}`);
    return response.text();
  }

  private async request<T>(
    url: URL,
    init: RequestInit,
  ): Promise<{ result: T; result_info?: { cursor?: string } }> {
    const response = await withRetry(() =>
      this.fetchImpl(url, { ...init, headers: { ...this.headers, ...init.headers } }),
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`KV ${init.method} ${url.pathname} failed: ${response.status} ${text}`);
    }
    const body = JSON.parse(text) as {
      success: boolean;
      errors?: { message: string }[];
      result: T;
      result_info?: { cursor?: string };
    };
    if (!body.success) {
      throw new Error(
        `KV ${init.method} ${url.pathname} reported failure: ${(body.errors ?? []).map((e) => e.message).join('; ')}`,
      );
    }
    return body;
  }
}

/** In-memory KV with the same semantics, for tests and `DRY_RUN`. */
export class MemoryKv implements KvClient {
  readonly store = new Map<string, { value: string; metadata?: DocKeyMetadata }>();

  async list(prefix: string): Promise<KvListed[]> {
    return [...this.store.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, entry]) => ({ name, metadata: entry.metadata }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async put(writes: KvWrite[]): Promise<void> {
    for (const write of writes) {
      this.store.set(write.key, { value: write.value, metadata: write.metadata });
    }
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Retry on 429 and 5xx only. A crashed run is safe — the next one re-reads
 * live KV state and recomputes the same convergence (§5.7) — but a transient
 * blip should not cost a whole build.
 */
export async function withRetry(fn: () => Promise<Response>, attempts = 4): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fn();
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === attempts - 1) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
