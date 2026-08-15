/**
 * Source frontmatter (§4.1) and the allowlists derived from it.
 *
 * The property *names* are configurable so the plugin can avoid collisions
 * with whatever else a vault already puts in frontmatter (§3.8). Everything
 * downstream therefore takes a PropertyNames rather than hard-coding strings.
 */

export interface PropertyNames {
  publish: string;
  shareId: string;
  title: string;
  index: string;
  download: string;
  ack: string;
}

export const DEFAULT_PROPERTY_NAMES: PropertyNames = {
  publish: 'publish',
  shareId: 'share_id',
  title: 'title',
  index: 'publish_index',
  download: 'publish_download',
  ack: 'publish_ack',
};

/**
 * Keys the plugin manages in the source note.
 *
 * Note this governs what may exist *in the vault*, not what is published.
 * `publish_ack` is plugin-managed and never leaves the vault.
 */
export function managedSourceKeys(names: PropertyNames): string[] {
  return [names.publish, names.shareId, names.title, names.index, names.download, names.ack];
}

/**
 * The properties that feed `source_hash` (§3.3).
 *
 * Deliberately excludes:
 *   - `publish` and `share_id`, which staging writes back *after* hashing;
 *   - `publish_ack`, which is plugin bookkeeping and changes nothing published.
 *
 * What remains is exactly the set that changes published output.
 */
export function sourceHashProperties(names: PropertyNames): string[] {
  return [names.title, names.index, names.download];
}

/**
 * Keys permitted in a *published* artifact's metadata block.
 *
 * Allowlist, not denylist — a denylist leaks the first personal property you
 * forget to add to it. Asserted in the plugin before writing, re-verified in
 * CI, and asserted again in fixtures (§11.2), because this is one of the two
 * failures with the worst consequences.
 */
export const PUBLISHED_METADATA_KEYS: readonly string[] = Object.freeze([
  'share_id',
  'title',
  'source_hash',
  'staged',
  'indexable',
  'download',
]);
