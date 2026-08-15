/**
 * Deletion corroboration (§5.6).
 *
 * Before deleting anything, confirm each planned deletion corresponds to a
 * staged file actually removed in this commit. Deletions with no matching
 * removal are refused and reported.
 *
 * This replaced an earlier percentage threshold, which was the wrong
 * instrument: "refuse to delete more than 20%" blocks the legitimate case —
 * unpublishing six notes in one sitting — while forcing a manual override path
 * that people learn to reach for reflexively. The commit diff *is* the intent.
 * It distinguishes "you deliberately deleted six files" from "the checkout is
 * broken and two hundred files are missing", which is the distinction the
 * threshold was groping toward. No tuning, no override.
 *
 * Refusing to delete is always the safe default; the next build with a clean
 * baseline converges.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const EMPTY_SHA = '0000000000000000000000000000000000000000';

export interface RemovalBaseline {
  /**
   * share_ids whose staged file was removed between the baseline and HEAD.
   * `null` means no baseline could be established, in which case *every*
   * deletion is refused.
   */
  removed: Set<string> | null;
  baseline: string | null;
  reason: string;
}

export interface BaselineOptions {
  cwd: string;
  publishedDir: string;
  /** The push event's `before` SHA, where available. */
  baseSha?: string;
  headSha?: string;
}

export async function findRemovedShareIds(options: BaselineOptions): Promise<RemovalBaseline> {
  const cwd = options.cwd;
  const head = options.headSha ?? 'HEAD';
  const relative = path.relative(cwd, path.resolve(options.publishedDir)) || '.';

  if (!(await isRepo(cwd))) {
    return {
      removed: null,
      baseline: null,
      reason: 'not a git repository, so no commit can corroborate a deletion',
    };
  }

  const baseline = await resolveBaseline(cwd, options.baseSha);
  if (!baseline) {
    return {
      removed: null,
      baseline: null,
      reason:
        'no baseline commit is reachable. At fetch-depth 1 there is no previous commit, and ' +
        'after a force-push the event\'s `before` SHA can be further back than a shallow clone ' +
        'reaches — set fetch-depth: 0 (§5.2). Every deletion is refused until a baseline exists.',
    };
  }

  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--name-status', '--no-renames', baseline, head, '--', relative],
    { cwd, maxBuffer: 32 * 1024 * 1024 },
  );

  const removed = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [status, file] = line.split('\t');
    if (status !== 'D' || !file) continue;
    const base = path.basename(file);
    if (!base.endsWith('.md')) continue;
    removed.add(base.slice(0, -3));
  }

  return {
    removed,
    baseline,
    reason: `corroborated against ${baseline.slice(0, 12)}..${head === 'HEAD' ? 'HEAD' : head.slice(0, 12)}`,
  };
}

async function isRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Force-pushes and rollbacks compare against the previous tip rather than
 * `HEAD~1`, so the event's `before` SHA is preferred where it exists and is
 * actually present in the object database.
 */
async function resolveBaseline(cwd: string, baseSha?: string): Promise<string | null> {
  const candidates = [baseSha, 'HEAD~1'].filter(
    (sha): sha is string => Boolean(sha) && sha !== EMPTY_SHA,
  );

  for (const candidate of candidates) {
    try {
      await execFileAsync('git', ['cat-file', '-e', `${candidate}^{commit}`], { cwd });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
