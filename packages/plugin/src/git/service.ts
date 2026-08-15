/**
 * Git integration (§3.9).
 *
 * Staged files only become live once they are committed and pushed. Requiring
 * a terminal for that is the main workflow regression against direct-upload
 * plugins, so the publish panel owns the git step.
 *
 * **Rule: the plugin never stores a git credential.** This is a security
 * requirement, not a preference — it is what preserves the credential
 * inversion described in §6.1. Two implementations are acceptable:
 *
 *   - delegate to Obsidian Git, where auth is already configured;
 *   - shell out to system `git`, using the machine's SSH agent or credential
 *     helper.
 *
 * `isomorphic-git` with a stored PAT was declined: it would require a
 * write-scoped token for the entire vault repo in `data.json`, which is the
 * exact credential this architecture exists to avoid.
 *
 * If neither acceptable mode is available, the button is disabled with the
 * reason shown and the workflow degrades to the terminal, which still works.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileSystemAdapter } from 'obsidian';
import type { App } from 'obsidian';
import { PENDING_DIR } from '../settings.js';
import type { GitMode, PublisherSettings } from '../settings.js';

const execFileAsync = promisify(execFile);

export interface GitState {
  /** Whether Review and push can run at all. */
  ready: boolean;
  mode: GitMode;
  /** Why not, when `ready` is false — shown next to the disabled button. */
  reason?: string;
  root: string | null;
  branch: string | null;
  detached: boolean;
  hasRemote: boolean;
  remoteUrl: string | null;
  /** Repo-relative paths under `published/` with uncommitted changes. */
  dirty: Set<string>;
  /** Repo-relative paths under `published/` committed but not yet pushed. */
  unpushed: Set<string>;
  /** True when `.publish-pending/` is covered by a gitignore rule (§3.3). */
  pendingIgnored: boolean;
}

export class GitService {
  private cachedRoot: string | null | undefined;

  constructor(
    private readonly app: App,
    private readonly settings: PublisherSettings,
  ) {}

  /** Absolute path of the vault on disk, or null on a non-filesystem adapter. */
  private vaultPath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  /**
   * The repository root, which is not necessarily the vault root — a vault is
   * often a subdirectory of the repo.
   */
  async root(): Promise<string | null> {
    if (this.cachedRoot !== undefined) return this.cachedRoot;
    const cwd = this.vaultPath();
    if (!cwd) {
      this.cachedRoot = null;
      return null;
    }
    try {
      const { stdout } = await this.run(['rev-parse', '--show-toplevel'], cwd);
      this.cachedRoot = stdout.trim();
    } catch {
      this.cachedRoot = null;
    }
    return this.cachedRoot;
  }

  /** Path of a vault-relative file, relative to the repository root. */
  async repoRelative(vaultRelative: string): Promise<string> {
    const root = await this.root();
    const vault = this.vaultPath();
    if (!root || !vault) return vaultRelative;
    const prefix = vault.slice(root.length).replace(/^[/\\]/, '');
    return prefix ? `${prefix}/${vaultRelative}` : vaultRelative;
  }

  async state(): Promise<GitState> {
    const base: GitState = {
      ready: false,
      mode: 'disabled',
      root: null,
      branch: null,
      detached: false,
      hasRemote: false,
      remoteUrl: null,
      dirty: new Set(),
      unpushed: new Set(),
      pendingIgnored: false,
    };

    if (this.settings.gitMode === 'disabled') {
      return { ...base, reason: 'git integration is turned off in settings' };
    }

    const root = await this.root();
    if (!root) {
      return { ...base, reason: 'the vault is not inside a git repository' };
    }

    const [branch, remoteUrl, pendingIgnored] = await Promise.all([
      this.currentBranch(root),
      this.remoteUrl(root),
      this.isPendingIgnored(root),
    ]);

    const detached = branch === null;
    const published = await this.repoRelative(this.settings.stagingFolder.replace(/\/+$/, ''));
    const [dirty, unpushed] = await Promise.all([
      this.dirtyPaths(root, published),
      this.unpushedPaths(root, published),
    ]);

    const mode = await this.resolveMode();

    const state: GitState = {
      ...base,
      mode,
      root,
      branch,
      detached,
      hasRemote: remoteUrl !== null,
      remoteUrl,
      dirty,
      unpushed,
      pendingIgnored,
    };

    if (detached) {
      // Inspecting historical state is safe; publishing from it is not (§5.9).
      return { ...state, reason: 'HEAD is detached — check out a branch to publish' };
    }
    if (!state.hasRemote) return { ...state, reason: 'this repository has no remote' };
    if (mode === 'disabled') {
      return {
        ...state,
        reason:
          'no acceptable git mode is available. Install Obsidian Git, or make the `git` ' +
          'binary reachable. The plugin will not store a credential of its own (§3.9).',
      };
    }

    return { ...state, ready: true };
  }

  private async resolveMode(): Promise<GitMode> {
    const preferred = this.settings.gitMode;
    const systemAvailable = await this.hasSystemGit();
    const obsidianGitAvailable = this.hasObsidianGit();

    if (preferred === 'system') return systemAvailable ? 'system' : 'disabled';
    if (preferred === 'obsidian-git') return obsidianGitAvailable ? 'obsidian-git' : 'disabled';

    // auto: prefer Obsidian Git when installed, because its auth is already
    // configured and no new credential is introduced. Cost: it commits the
    // whole vault rather than touched paths.
    if (obsidianGitAvailable) return 'obsidian-git';
    if (systemAvailable) return 'system';
    return 'disabled';
  }

  private hasObsidianGit(): boolean {
    const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
    return Boolean(plugins?.plugins?.['obsidian-git']);
  }

  private async hasSystemGit(): Promise<boolean> {
    const cwd = this.vaultPath();
    if (!cwd) return false;
    try {
      await this.run(['--version'], cwd);
      return true;
    } catch {
      return false;
    }
  }

  // ── read-only queries ─────────────────────────────────────────────────────

  private async currentBranch(root: string): Promise<string | null> {
    try {
      const { stdout } = await this.run(['symbolic-ref', '--short', '-q', 'HEAD'], root);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async remoteUrl(root: string): Promise<string | null> {
    try {
      const { stdout } = await this.run(['remote', 'get-url', 'origin'], root);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async dirtyPaths(root: string, scope: string): Promise<Set<string>> {
    try {
      const { stdout } = await this.run(['status', '--porcelain', '--', scope], root);
      const out = new Set<string>();
      for (const line of stdout.split('\n')) {
        if (line.length < 4) continue;
        out.add(line.slice(3).trim().replace(/^"|"$/g, ''));
      }
      return out;
    } catch {
      return new Set();
    }
  }

  /**
   * Files committed locally but not yet on the upstream branch. This is what
   * separates **Staged** from **Building** (§3.4), and it is the single most
   * useful thing the panel reports.
   */
  private async unpushedPaths(root: string, scope: string): Promise<Set<string>> {
    try {
      const { stdout } = await this.run(
        ['diff', '--name-only', '@{u}..HEAD', '--', scope],
        root,
      );
      return new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean));
    } catch {
      // No upstream configured: treat everything as unpushed rather than
      // claiming it is live.
      try {
        const { stdout } = await this.run(['ls-files', '--', scope], root);
        return new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean));
      } catch {
        return new Set();
      }
    }
  }

  /**
   * Verify `.publish-pending/` is actually ignored (§3.3).
   *
   * The gitignore entry is not a convenience — it is what makes it impossible
   * for auto-commit tooling to publish unreviewed content. If it is missing,
   * the design's central guarantee is silently absent, so the plugin says so
   * loudly rather than discovering it after the fact.
   */
  async isPendingIgnored(root?: string): Promise<boolean> {
    const cwd = root ?? (await this.root());
    if (!cwd) return false;
    const path = await this.repoRelative(`${PENDING_DIR}/probe.md`);
    try {
      await this.run(['check-ignore', '-q', '--no-index', path], cwd);
      return true;
    } catch {
      return false;
    }
  }

  /** `git diff --cached` for the paths the plugin touched (§3.9). */
  async diffCached(paths: string[]): Promise<string> {
    const root = await this.root();
    if (!root || paths.length === 0) return '';
    const { stdout } = await this.run(['diff', '--cached', '--', ...paths], root, 32 * 1024 * 1024);
    return stdout;
  }

  async diffCachedNameStatus(paths: string[]): Promise<{ status: string; path: string }[]> {
    const root = await this.root();
    if (!root || paths.length === 0) return [];
    const { stdout } = await this.run(['diff', '--cached', '--name-status', '--', ...paths], root);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split('\t');
        return { status: status ?? '', path: path ?? '' };
      });
  }

  // ── mutations ─────────────────────────────────────────────────────────────

  async add(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const root = await this.root();
    if (!root) throw new Error('not a git repository');
    // `-A` so deletions are staged too: Stage for removal is a deletion.
    await this.run(['add', '-A', '--', ...paths], root);
  }

  async restoreStaged(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const root = await this.root();
    if (!root) return;
    try {
      await this.run(['restore', '--staged', '--', ...paths], root);
    } catch {
      // `git restore` needs 2.23+. `reset` is the older spelling and is
      // equivalent for un-staging.
      await this.run(['reset', '-q', 'HEAD', '--', ...paths], root);
    }
  }

  /**
   * Commit the given paths and push.
   *
   * In `obsidian-git` mode this delegates: Obsidian Git commits the whole
   * vault rather than the touched paths, which is a known cost of not
   * introducing a credential (§3.9).
   */
  async commitAndPush(message: string, paths: string[], mode: GitMode): Promise<void> {
    if (mode === 'obsidian-git') {
      const commands = (this.app as unknown as {
        commands: { executeCommandById(id: string): boolean };
      }).commands;
      // Undocumented cross-plugin dependency, acknowledged in §3.9. Try the
      // current id first, then the one older versions used.
      const ok =
        commands.executeCommandById('obsidian-git:commit-and-sync') ||
        commands.executeCommandById('obsidian-git:push');
      if (!ok) {
        throw new Error(
          'Obsidian Git did not accept the commit-and-sync command. Switch Git mode to ' +
            '"system git" in settings, or commit from a terminal.',
        );
      }
      return;
    }

    const root = await this.root();
    if (!root) throw new Error('not a git repository');

    await this.add(paths);
    // Arguments go as an argv array, never interpolated into a shell string:
    // note titles reach the commit message, and a title containing a semicolon
    // must not become a command injection (§3.9).
    await this.run(['commit', '-m', message, '--', ...paths], root);

    try {
      await this.run(['push'], root, 8 * 1024 * 1024, 120_000);
    } catch (err) {
      throw new PushError((err as Error).message);
    }
  }

  /**
   * The Actions URL, derived from the remote (§3.9). No credential required,
   * and it is exactly where to look when a build fails.
   */
  actionsUrl(remoteUrl: string | null): string | null {
    if (!remoteUrl) return null;
    const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remoteUrl);
    const https = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(remoteUrl);
    const host = ssh?.[1] ?? https?.[1];
    const repo = ssh?.[2] ?? https?.[2];
    if (!host || !repo || !host.includes('github')) return null;
    return `https://${host}/${repo}/actions`;
  }

  private run(
    args: string[],
    cwd: string,
    maxBuffer = 8 * 1024 * 1024,
    timeout = 30_000,
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, {
      cwd,
      maxBuffer,
      timeout,
      // Never prompt: a hung credential prompt inside Obsidian is invisible.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
  }
}

export class PushError extends Error {
  constructor(readonly detail: string) {
    super(describePushFailure(detail));
    this.name = 'PushError';
  }
}

/** §3.9's failure table, as messages that say what to do next. */
function describePushFailure(detail: string): string {
  if (/non-fast-forward|fetch first|rejected/i.test(detail)) {
    return 'Push rejected — upstream has commits you do not have. Pull, then push again. Never force.';
  }
  if (/could not read Username|Authentication failed|Permission denied|publickey/i.test(detail)) {
    return (
      'Push failed authentication. Configure your SSH agent or git credential helper — ' +
      'the plugin will not store a token (§3.9).'
    );
  }
  if (/Could not resolve host|unable to access|network/i.test(detail)) {
    return 'Push failed: no network. Staged files are already safe on disk.';
  }
  return `Push failed: ${detail.split('\n').slice(0, 4).join('\n')}`;
}
