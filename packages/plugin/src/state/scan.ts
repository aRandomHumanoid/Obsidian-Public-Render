/**
 * The vault scan that drives every status (§3.4).
 *
 * All nine statuses come from three hashes — source, staged, remote — plus a
 * frontmatter scan and, for the Staged/Building split, local git state. No
 * local state file is required, so the panel is correct immediately after a
 * fresh install or a sync from another machine.
 */

import {
  deriveStatus,
  parseStagedFile,
  sourceHash,
  stagedHash as hashStaged,
} from '@notes/shared';
import type { NoteStatus, StatusResult } from '@notes/shared';
import type { App, TFile } from 'obsidian';
import { readFrontmatter, resolveTitle } from '../vault/frontmatter.js';
import { PENDING_DIR, publicUrl } from '../settings.js';
import type { PublisherSettings } from '../settings.js';
import type { GitService, GitState } from '../git/service.js';
import type { PublishStore } from '../vault/store.js';
import type { RemoteState } from './remote.js';

export interface NoteEntry {
  shareId: string;
  title: string;
  /** null for an Orphan — there is no note to right-click (§3.10). */
  file: TFile | null;
  status: NoteStatus;
  detail: StatusResult;
  url: string;
  stagedAt: string | null;
  /** Every source note claiming this share_id, for the Conflict case. */
  claimants: TFile[];
  /** sha256 of whichever local file represents this note. */
  localHash: string | null;
  assets: string[];
}

export interface ScanResult {
  entries: NoteEntry[];
  byShareId: Map<string, NoteEntry>;
  counts: Record<NoteStatus, number>;
  remote: RemoteState;
  git: GitState;
  scannedAt: number;
}

export interface ScanDeps {
  app: App;
  settings: PublisherSettings;
  store: PublishStore;
  git: GitService;
  gitState: GitState;
  remote: RemoteState;
}

export async function scanVault(deps: ScanDeps): Promise<ScanResult> {
  const { app, settings, store } = deps;
  const names = settings.properties;

  // ── frontmatter scan ──────────────────────────────────────────────────────
  const claimants = new Map<string, TFile[]>();
  const publishedDir = `${store.publishedDir}/`;

  for (const file of app.vault.getMarkdownFiles()) {
    // The staging directories are not part of the vault's published set, and
    // `published/` is a normal tracked folder Obsidian happily indexes.
    if (file.path.startsWith(publishedDir) || file.path.startsWith(`${PENDING_DIR}/`)) continue;

    const frontmatter = readFrontmatter(app, file, names);
    if (!frontmatter.shareId) continue;
    const list = claimants.get(frontmatter.shareId) ?? [];
    list.push(file);
    claimants.set(frontmatter.shareId, list);
  }

  // ── local staging state ───────────────────────────────────────────────────
  const pendingIds = await store.listPending();
  const publishedIds = await store.listPublished();

  const pending = new Map<string, LocalFile>();
  for (const id of pendingIds) {
    const local = await readLocal(await store.readPending(id));
    if (local) pending.set(id, local);
  }

  const published = new Map<string, LocalFile>();
  for (const id of publishedIds) {
    const local = await readLocal(await store.readPublished(id));
    if (local) published.set(id, local);
  }

  // ── assemble the universe of share_ids ────────────────────────────────────
  const shareIds = new Set<string>([
    ...claimants.keys(),
    ...pending.keys(),
    ...published.keys(),
    ...deps.remote.hashes.keys(),
  ]);

  const repoPublishedDir = await deps.git.repoRelative(store.publishedDir);
  const entries: NoteEntry[] = [];

  for (const shareId of shareIds) {
    const notes = claimants.get(shareId) ?? [];
    const primary = notes[0] ?? null;
    const frontmatter = primary ? readFrontmatter(app, primary, names) : null;
    const local = pending.get(shareId) ?? published.get(shareId) ?? null;

    let currentSourceHash: string | undefined;
    if (primary && frontmatter) {
      const contents = await app.vault.cachedRead(primary);
      const body = stripFrontmatterFast(contents);
      currentSourceHash = await sourceHash(body, {
        title: resolveTitle(app, primary, names),
        indexable: frontmatter.indexable,
        download: frontmatter.download,
      });
    }

    const repoPath = `${repoPublishedDir}/${shareId}.md`;
    const pushed =
      published.has(shareId) &&
      !deps.gitState.dirty.has(repoPath) &&
      !deps.gitState.unpushed.has(repoPath);

    const detail = deriveStatus({
      shareId,
      sourceNotes: notes.length,
      publishFlag: frontmatter?.publish ?? false,
      currentSourceHash,
      stagedSourceHash: local?.sourceHash,
      pendingHash: pending.get(shareId)?.hash,
      publishedHash: published.get(shareId)?.hash,
      pushed,
      remoteHash: deps.remote.hashes.get(shareId),
      remoteKnown: deps.remote.fetchedAt > 0,
    });

    if (!detail) continue;

    entries.push({
      shareId,
      title:
        local?.title ??
        (primary ? resolveTitle(app, primary, names) : `(orphan ${shareId.slice(0, 8)}…)`),
      file: primary,
      status: detail.status,
      detail,
      url: publicUrl(settings, shareId),
      stagedAt: local?.staged ?? null,
      claimants: notes,
      localHash: local?.hash ?? null,
      assets: local?.assets ?? [],
    });
  }

  entries.sort((a, b) => a.title.localeCompare(b.title));

  const counts = Object.fromEntries(
    (
      [
        'live',
        'staged',
        'building',
        'stale',
        'unstaged',
        'removing',
        'orphan',
        'conflict',
        'issue',
      ] as NoteStatus[]
    ).map((status) => [status, entries.filter((e) => e.status === status).length]),
  ) as Record<NoteStatus, number>;

  return {
    entries,
    byShareId: new Map(entries.map((entry) => [entry.shareId, entry])),
    counts,
    remote: deps.remote,
    git: deps.gitState,
    scannedAt: Date.now(),
  };
}

interface LocalFile {
  hash: string;
  sourceHash: string;
  title: string;
  staged: string;
  assets: string[];
}

async function readLocal(contents: string | null): Promise<LocalFile | null> {
  if (contents === null) return null;
  try {
    const { metadata, body } = parseStagedFile(contents);
    return {
      hash: await hashStaged(contents),
      sourceHash: metadata.source_hash,
      title: metadata.title,
      staged: metadata.staged,
      assets: extractAssets(body),
    };
  } catch {
    // A staged file that does not parse is a real problem, but it is CI's
    // problem to report (§5.3). Here it simply is not a usable local state.
    return null;
  }
}

function extractAssets(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/_assets\/([A-Za-z0-9._-]+)/g)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

/** Cheap frontmatter strip for hashing; the full parser is in `shared`. */
function stripFrontmatterFast(contents: string): string {
  if (!contents.startsWith('---')) return contents;
  const end = contents.indexOf('\n---', 3);
  if (end === -1) return contents;
  const after = contents.indexOf('\n', end + 1);
  return after === -1 ? '' : contents.slice(after + 1);
}
