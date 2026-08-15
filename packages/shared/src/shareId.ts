/**
 * share_id generation and validation (§4.1).
 *
 * 16 characters of Crockford base32 from `crypto.getRandomValues` — 80 bits.
 * Generated once, never changed. Stable across rename, move and retitle, and
 * derived from nothing, so it leaks nothing and cannot be enumerated.
 */

/** Crockford base32, lowercase. Excludes i, l, o and u. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Matches the worker's own route validation in §7.1. Keep the two in step. */
export const SHARE_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{16}$/;

export const SHARE_ID_LENGTH = 16;

/** 16 base32 characters is 80 bits, so 10 random bytes exactly. */
const RANDOM_BYTES = 10;

export function isShareId(value: unknown): value is string {
  return typeof value === 'string' && SHARE_ID_PATTERN.test(value);
}

/**
 * Mint a new share_id. Uses WebCrypto, which is present in Node >= 18, in
 * Electron (so, in Obsidian) and in Workers — the one RNG available in all
 * three trust zones.
 */
export function generateShareId(): string {
  const bytes = new Uint8Array(RANDOM_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return encodeCrockford(bytes);
}

/**
 * Encode exactly 10 bytes as 16 base32 characters, most significant bit first.
 * Written out rather than pulled from a dependency because it is nine lines and
 * this value is the entire privacy model of the published links.
 */
function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Normalise a hand-typed share_id: Crockford treats I/L as 1 and O as 0, and
 * is case-insensitive. Only used when reading frontmatter a human may have
 * edited — never when minting.
 */
export function normalizeShareId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[il]/g, '1')
    .replace(/o/g, '0')
    .replace(/-/g, '');
}
