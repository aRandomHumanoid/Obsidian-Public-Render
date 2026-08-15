/**
 * A fake vault, for running the staging pipeline without an Obsidian runtime.
 *
 * The pipeline was written against `StagingContext` rather than `App`
 * precisely so this is possible: the surface it depends on is five reads and
 * two recursions, all of which are trivial to fake. Everything the fixture
 * corpus (§11.1) asserts therefore runs in an ordinary test process.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assetHash, splitFrontmatter } from '@notes/shared';
import type { ValidationIssue } from '@notes/shared';
import type { TFile } from 'obsidian';
import type { DataviewBridge, StagedBody, StagingContext } from '../../packages/plugin/src/staging/context.js';
import { buildStagedBody } from '../../packages/plugin/src/staging/pipeline.js';
import { DEFAULT_SETTINGS } from '../../packages/plugin/src/settings.js';
import type { PublisherSettings } from '../../packages/plugin/src/settings.js';

export interface FakeFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  parent: { path: string } | null;
  /** Text content, for markdown; binary fixtures carry `bytes` instead. */
  contents?: string;
  bytes?: Uint8Array;
}

export function fakeFile(filePath: string, contents?: string, bytes?: Uint8Array): FakeFile {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const parentPath = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  return {
    path: filePath,
    name,
    basename: dot === -1 ? name : name.slice(0, dot),
    extension: dot === -1 ? '' : name.slice(dot + 1),
    parent: { path: parentPath },
    contents,
    bytes,
  };
}

export class FakeVault implements StagingContext {
  readonly files = new Map<string, FakeFile>();
  readonly pendingAssets = new Map<string, Uint8Array>();
  readonly issues: ValidationIssue[] = [];
  settings: PublisherSettings = { ...DEFAULT_SETTINGS, properties: { ...DEFAULT_SETTINGS.properties } };
  dataview: DataviewBridge | null = null;

  add(file: FakeFile): FakeFile {
    this.files.set(file.path, file);
    return file;
  }

  addNote(filePath: string, contents: string): FakeFile {
    return this.add(fakeFile(filePath, contents));
  }

  addBinary(filePath: string, bytes: Uint8Array): FakeFile {
    return this.add(fakeFile(filePath, undefined, bytes));
  }

  /** Load every file under a directory as a vault path relative to it. */
  static async fromDirectory(root: string): Promise<FakeVault> {
    const vault = new FakeVault();
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        const relative = path.relative(root, full).split(path.sep).join('/');
        if (entry.name.endsWith('.md')) {
          vault.addNote(relative, await readFile(full, 'utf8'));
        } else {
          vault.addBinary(relative, new Uint8Array(await readFile(full)));
        }
      }
    };
    await stat(root);
    await walk(root);
    return vault;
  }

  // ── StagingContext ────────────────────────────────────────────────────────

  /**
   * Obsidian's nearest-path rule, approximated: an exact path wins, then a
   * unique basename match. Ambiguous basenames resolve to the first match,
   * which is where CI would "get it subtly wrong" (§3.1) — the fixtures avoid
   * relying on the ambiguous case.
   */
  resolve(linkpath: string, _from: string): TFile | null {
    const clean = linkpath.replace(/^\.\//, '').trim();
    const direct =
      this.files.get(clean) ??
      this.files.get(`${clean}.md`) ??
      [...this.files.values()].find((file) => file.path === clean);
    if (direct) return direct as unknown as TFile;

    const byName = [...this.files.values()].filter(
      (file) => file.basename === clean || file.name === clean,
    );
    return (byName[0] as unknown as TFile) ?? null;
  }

  publishedShareId(file: TFile): string | null {
    const record = this.files.get((file as unknown as FakeFile).path);
    if (!record?.contents) return null;
    const frontmatter = this.frontmatterOf(record);
    const publish = frontmatter[this.settings.properties.publish];
    const shareId = frontmatter[this.settings.properties.shareId];
    return publish === true && typeof shareId === 'string' ? shareId : null;
  }

  noteTitle(file: TFile): string {
    const record = this.files.get((file as unknown as FakeFile).path);
    if (!record) return '';
    const explicit = this.frontmatterOf(record)[this.settings.properties.title];
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    const { body } = splitFrontmatter(record.contents ?? '');
    const h1 = /^#\s+(.+)$/m.exec(body);
    return h1?.[1]?.trim() ?? record.basename;
  }

  async readSource(file: TFile): Promise<string> {
    return this.files.get((file as unknown as FakeFile).path)?.contents ?? '';
  }

  async addAsset(file: TFile): Promise<string> {
    const record = this.files.get((file as unknown as FakeFile).path);
    const bytes = record?.bytes ?? new TextEncoder().encode(record?.contents ?? '');

    if (bytes.byteLength > this.settings.attachmentFailBytes) {
      throw new AssetTooLarge(
        `${record?.path} is ${bytes.byteLength} bytes, over the ${this.settings.attachmentFailBytes} hard limit`,
      );
    }
    if (bytes.byteLength > this.settings.attachmentWarnBytes) {
      this.warn({
        severity: 'warning',
        code: 'attachment-large',
        message: `${record?.path} is over the warning threshold`,
      });
    }

    const basename = `${await assetHash(bytes)}.${(record?.extension ?? 'bin').toLowerCase()}`;
    this.pendingAssets.set(basename, bytes);
    return basename;
  }

  stageBody(file: TFile, chain: string[]): Promise<StagedBody> {
    return buildStagedBody(file, this, chain);
  }

  acknowledgedFor(file: TFile): Set<string> {
    const record = this.files.get((file as unknown as FakeFile).path);
    if (!record) return new Set();
    const ack = this.frontmatterOf(record)[this.settings.properties.ack];
    return new Set(Array.isArray(ack) ? ack.map(String) : typeof ack === 'string' ? [ack] : []);
  }

  warn(issue: ValidationIssue): void {
    this.issues.push(issue);
  }

  // ── helpers for tests ─────────────────────────────────────────────────────

  frontmatterOf(file: FakeFile): Record<string, unknown> {
    const { frontmatter } = splitFrontmatter(file.contents ?? '');
    if (!frontmatter) return {};
    try {
      const parsed = parseYaml(frontmatter);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  file(filePath: string): TFile {
    const found = this.files.get(filePath);
    if (!found) throw new Error(`fixture vault has no ${filePath}`);
    return found as unknown as TFile;
  }
}

export class AssetTooLarge extends Error {}

/** A Dataview bridge that answers from a table of canned results. */
export class FakeDataview implements DataviewBridge {
  constructor(
    private readonly results: Record<string, { markdown: string; rows: number }>,
    readonly indexReady = true,
  ) {}

  async waitForIndex(): Promise<void> {
    if (!this.indexReady) {
      throw new Error("Dataview's index is not ready");
    }
  }

  async queryMarkdown(query: string): Promise<{ markdown: string; rows: number }> {
    const result = this.results[query.trim()];
    if (!result) throw new Error(`no canned result for query: ${query.trim()}`);
    return result;
  }

  async evaluateInline(expression: string): Promise<string> {
    return this.results[expression.trim()]?.markdown ?? '';
  }
}
