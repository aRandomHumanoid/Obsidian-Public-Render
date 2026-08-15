/**
 * R2 access from CI.
 *
 * Objects are content-addressed on the **converted** bytes, so identical
 * images dedupe and every object is immutable (§4.3). Nothing is ever deleted:
 * that is a rollback safety property, not a storage-cost one — every asset any
 * historical commit referenced must still exist, or checking out an old commit
 * publishes broken images (§13).
 *
 * Uses the Cloudflare REST object API rather than the S3-compatible endpoint,
 * so the credential stays the single scoped API token from §10 and CI never
 * holds an R2 access key pair. If that endpoint is ever unavailable, swap this
 * class: nothing else in the pipeline knows how bytes reach the bucket.
 */

const API = 'https://api.cloudflare.com/client/v4';

export interface R2Client {
  exists(key: string): Promise<boolean>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface CloudflareR2Options {
  accountId: string;
  apiToken: string;
  bucket: string;
  fetchImpl?: typeof fetch;
}

export class CloudflareR2 implements R2Client {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  /** Existence is stable within a run: keys are immutable and never deleted. */
  private readonly known = new Map<string, boolean>();

  constructor(options: CloudflareR2Options) {
    this.base = `${API}/accounts/${options.accountId}/r2/buckets/${options.bucket}/objects`;
    this.headers = { Authorization: `Bearer ${options.apiToken}` };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async exists(key: string): Promise<boolean> {
    const cached = this.known.get(key);
    if (cached !== undefined) return cached;

    const response = await this.fetchImpl(this.url(key), { method: 'HEAD', headers: this.headers });
    if (response.status === 404) {
      this.known.set(key, false);
      return false;
    }
    if (!response.ok) {
      throw new Error(`R2 HEAD ${key} failed: ${response.status} ${await response.text()}`);
    }
    this.known.set(key, true);
    return true;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const response = await this.fetchImpl(this.url(key), {
      method: 'PUT',
      headers: {
        ...this.headers,
        'Content-Type': contentType,
        // Objects are immutable by construction — the key *is* the hash of the
        // bytes — so the reader can cache them forever (§4.3, §7.3).
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
      body: bytes as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new Error(`R2 PUT ${key} failed: ${response.status} ${await response.text()}`);
    }
    this.known.set(key, true);
  }

  private url(key: string): string {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
}

/** In-memory R2 with the same semantics, for tests and `DRY_RUN`. */
export class MemoryR2 implements R2Client {
  readonly store = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.store.set(key, { bytes, contentType });
  }
}
