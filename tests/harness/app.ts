/**
 * A minimal in-memory `App`, enough to exercise the plugin's guards.
 *
 * §11.4 lists one plugin-side test alongside the reconciliation suite, because
 * it is about state rather than content: "Unstage invoked on a live note from
 * the command palette refuses, points at Stage for removal, and leaves the
 * staged file intact." That guard lives in the shared implementation
 * specifically so the palette inherits it, so testing it means going through
 * the real `Actions`.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { splitFrontmatter } from '@notes/shared';
import type { App, TFile } from 'obsidian';
import { fakeFile } from './vault.js';
import type { FakeFile } from './vault.js';

export class FakeAdapter {
  readonly files = new Map<string, string>();
  readonly binaries = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.binaries.has(path) || this.dirs.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = this.binaries.get(path);
    if (!bytes) throw new Error(`ENOENT ${path}`);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.binaries.set(path, new Uint8Array(data));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.binaries.delete(path);
  }

  async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${dir}/`;
    const names = [...this.files.keys(), ...this.binaries.keys()].filter(
      (path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    );
    return { files: names, folders: [] };
  }
}

export class FakeApp {
  readonly adapter = new FakeAdapter();
  private readonly notes = new Map<string, FakeFile>();

  readonly vault = {
    adapter: this.adapter,
    getMarkdownFiles: (): TFile[] =>
      [...this.notes.values()].filter((f) => f.extension === 'md') as unknown as TFile[],
    cachedRead: async (file: TFile): Promise<string> =>
      this.notes.get((file as unknown as FakeFile).path)?.contents ?? '',
    read: async (file: TFile): Promise<string> =>
      this.notes.get((file as unknown as FakeFile).path)?.contents ?? '',
    readBinary: async (file: TFile): Promise<ArrayBuffer> => {
      const bytes = this.notes.get((file as unknown as FakeFile).path)?.bytes ?? new Uint8Array();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    on: () => ({}),
  };

  readonly metadataCache = {
    getFileCache: (file: TFile) => {
      const record = this.notes.get((file as unknown as FakeFile).path);
      if (!record?.contents) return null;
      const { frontmatter, body } = splitFrontmatter(record.contents);
      const headings = [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({
        level: (match[1] ?? '').length,
        heading: (match[2] ?? '').trim(),
      }));
      return {
        frontmatter: frontmatter ? (parseYaml(frontmatter) ?? {}) : undefined,
        headings,
      };
    },
    getFirstLinkpathDest: (linkpath: string): TFile | null =>
      (this.notes.get(linkpath) ??
        this.notes.get(`${linkpath}.md`) ??
        [...this.notes.values()].find((file) => file.basename === linkpath) ??
        null) as unknown as TFile | null,
    on: () => ({}),
    offref: () => {},
  };

  readonly fileManager = {
    processFrontMatter: async (
      file: TFile,
      fn: (frontmatter: Record<string, unknown>) => void,
    ): Promise<void> => {
      const record = this.notes.get((file as unknown as FakeFile).path);
      if (!record) return;
      const { frontmatter, body } = splitFrontmatter(record.contents ?? '');
      const parsed = (frontmatter ? (parseYaml(frontmatter) ?? {}) : {}) as Record<string, unknown>;
      fn(parsed);
      const yaml = Object.keys(parsed).length > 0 ? stringifyYaml(parsed).trimEnd() : '';
      record.contents = yaml ? `---\n${yaml}\n---\n${body}` : body;
    },
  };

  addNote(path: string, contents: string): TFile {
    const file = fakeFile(path, contents);
    this.notes.set(path, file);
    return file as unknown as TFile;
  }

  contentsOf(path: string): string {
    return this.notes.get(path)?.contents ?? '';
  }

  asApp(): App {
    return this as unknown as App;
  }
}
