/**
 * Build configuration.
 *
 * Everything the pipeline needs, resolved once from the environment so that
 * nothing downstream reads `process.env` directly and the whole thing can be
 * driven from a test with an object literal.
 */

/**
 * Bumped **by hand** on any material renderer change — a new shiki theme,
 * different callout markup, a KaTeX upgrade (§4.2).
 *
 * It is folded into `contentHash`, so bumping it re-renders the corpus.
 * Forgetting to bump it is the failure mode where a renderer change appears
 * not to work: only notes that happen to be edited afterwards pick it up, and
 * the corpus sits in mixed states indefinitely (§10).
 *
 * *Caveat:* bumping this rewrites every document at once. At a few hundred
 * notes that is one build. Above roughly a thousand it exceeds the daily KV
 * write quota and needs a resumable batch carrying progress across runs.
 * Reconciliation makes a half-finished bulk re-render safe rather than
 * corrupting — the next run simply continues.
 */
export const RENDER_CONFIG_VERSION = 3;

export interface BuildConfig {
  /** Directory holding the staged corpus. Absolute or relative to cwd. */
  publishedDir: string;
  /** Public origin, used for absolute asset URLs in the download copy. */
  baseUrl: string;
  cloudflare: {
    accountId: string;
    apiToken: string;
    kvNamespaceId: string;
    r2Bucket: string;
  };
  renderConfigVersion: number;
  /** Base commit for deletion corroboration (§5.6). */
  baseSha?: string;
  headSha?: string;
  /** Print what would change and write nothing. */
  dryRun: boolean;
  /** `error` (default) or `skip` when mermaid rendering is unavailable. */
  mermaid: 'error' | 'skip';
  /** Path to append the job summary to, if any. */
  summaryPath?: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BuildConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new ConfigError(`${name} is not set`);
    return value;
  };

  const baseUrl = required('PUBLIC_BASE_URL').replace(/\/+$/, '');

  return {
    publishedDir: env['PUBLISHED_DIR'] ?? 'published',
    baseUrl,
    cloudflare: {
      accountId: required('CLOUDFLARE_ACCOUNT_ID'),
      apiToken: required('CLOUDFLARE_API_TOKEN'),
      kvNamespaceId: required('KV_NAMESPACE_ID'),
      r2Bucket: env['R2_BUCKET'] ?? 'notes-assets',
    },
    renderConfigVersion: RENDER_CONFIG_VERSION,
    // The push event's `before` SHA where available, so force-pushes and
    // rollbacks compare against the previous tip rather than HEAD~1 (§5.6).
    baseSha: env['BASE_SHA'] || undefined,
    headSha: env['HEAD_SHA'] || undefined,
    dryRun: env['DRY_RUN'] === '1' || env['DRY_RUN'] === 'true',
    mermaid: env['MERMAID'] === 'skip' ? 'skip' : 'error',
    summaryPath: env['GITHUB_STEP_SUMMARY'] || undefined,
  };
}
