/**
 * A throwaway git repository, for the reconciliation suite (§11.4).
 *
 * Rollback tolerance (§5.9) is a property of the build, not of any fixture, so
 * it needs a real commit graph to reconcile against — the deletion
 * corroboration in §5.6 reads `git diff --name-status`, and faking that would
 * test the fake.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { serializeStagedFile, sourceHash } from '@notes/shared';
import type { StagedMetadata } from '@notes/shared';

const execFileAsync = promisify(execFile);

export class TestRepo {
  private constructor(readonly root: string) {}

  static async create(): Promise<TestRepo> {
    const root = await mkdtemp(path.join(tmpdir(), 'notes-repo-'));
    const repo = new TestRepo(root);
    await repo.git(['init', '-q', '-b', 'main']);
    await repo.git(['config', 'user.email', 'test@example.invalid']);
    await repo.git(['config', 'user.name', 'Test']);
    await repo.git(['config', 'commit.gpgsign', 'false']);
    await mkdir(path.join(root, 'published', '_assets'), { recursive: true });
    await mkdir(path.join(root, 'Notes'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), '.publish-pending/\n');
    await writeFile(path.join(root, 'published', '_assets', '.gitkeep'), '');
    await repo.commit('initial');
    return repo;
  }

  get publishedDir(): string {
    return path.join(this.root, 'published');
  }

  async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: this.root, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }

  async writeNote(shareId: string, title: string, body: string): Promise<void> {
    const metadata: StagedMetadata = {
      share_id: shareId,
      title,
      source_hash: await sourceHash(body, { title }),
      staged: '2026-08-02T14:03:11Z',
      indexable: false,
      download: true,
    };
    await writeFile(
      path.join(this.publishedDir, `${shareId}.md`),
      serializeStagedFile(metadata, body),
      'utf8',
    );
  }

  async removeNote(shareId: string): Promise<void> {
    await rm(path.join(this.publishedDir, `${shareId}.md`), { force: true });
  }

  /** A vault note, which must never start a build (§5.1). */
  async writeVaultNote(name: string, body: string): Promise<void> {
    await writeFile(path.join(this.root, 'Notes', name), body, 'utf8');
  }

  async commit(message: string): Promise<string> {
    await this.git(['add', '-A']);
    await this.git(['commit', '-q', '--allow-empty', '-m', message]);
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  async checkout(ref: string): Promise<void> {
    await this.git(['checkout', '-q', ref]);
  }

  async head(): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
