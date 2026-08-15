/**
 * What the staging steps are allowed to know about the vault.
 *
 * Every step takes this rather than an `App`, which keeps the pipeline
 * testable without an Obsidian runtime and makes the surface it depends on
 * explicit: five reads and two recursions. Anything a step wants that is not
 * here is a deliberate change to what staging can see.
 */

import type { DroppedLink, ValidationIssue } from '@notes/shared';
import type { TFile } from 'obsidian';
import type { PublisherSettings } from '../settings.js';

export interface DataviewBridge {
  /**
   * Resolves once Dataview's index is ready, or rejects.
   *
   * Querying too early returns empty results and silently publishes blank
   * tables — the single most likely way to ship something wrong (§9). Treat
   * "index not ready" as a hard block, never a warning.
   */
  waitForIndex(): Promise<void>;
  queryMarkdown(query: string, sourcePath: string): Promise<{ markdown: string; rows: number }>;
  evaluateInline(expression: string, sourcePath: string): Promise<string>;
}

export interface StagedBody {
  text: string;
  dropped: DroppedLink[];
  /** Source text of every note that contributed, for the §11.2 round-trip check. */
  sources: string[];
  issues: ValidationIssue[];
  /** Staged asset basenames referenced, e.g. `a1b2c3d4e5f6a7b8.png`. */
  assets: string[];
  /** Dataview queries that returned nothing, keyed by hash of the query text. */
  emptyQueries: { query: string; hash: string }[];
}

/**
 * Note there is no `sourcePath` here.
 *
 * Transclusion composes from the target's staged output, so every step runs
 * against a *different* note than the one being staged, and "which note am I
 * resolving relative to" changes as the recursion descends. Carrying it on the
 * context invites scoping it by copying the object — which quietly drops the
 * methods off a class instance. It is a parameter instead.
 */
export interface StagingContext {
  settings: PublisherSettings;
  dataview: DataviewBridge | null;

  resolve(linkpath: string, from: string): TFile | null;
  /** The share_id a note claims, when it is marked for publishing. */
  publishedShareId(file: TFile): string | null;
  noteTitle(file: TFile): string;
  readSource(file: TFile): Promise<string>;

  /**
   * Copy an attachment into the pending asset directory and return its staged
   * basename. Hashing the source bytes is what makes identical attachments
   * dedupe before they ever reach CI (§3.7 step 6).
   */
  addAsset(file: TFile): Promise<string>;

  /**
   * Compose a transclusion target's **staged output** (§3.7 step 4).
   *
   * `chain` carries the paths already being staged, for the cycle guard.
   */
  stageBody(file: TFile, chain: string[]): Promise<StagedBody>;

  /** `publish_ack` hashes already accepted for a note, suppressing the §9 prompt. */
  acknowledgedFor?(file: TFile): Set<string>;

  warn(issue: ValidationIssue): void;
}

export function emptyStagedBody(text: string, source: string): StagedBody {
  return { text, dropped: [], sources: [source], issues: [], assets: [], emptyQueries: [] };
}

export function mergeStagedBody(into: StagedBody, from: StagedBody): void {
  into.dropped.push(...from.dropped);
  into.sources.push(...from.sources);
  into.issues.push(...from.issues);
  into.assets.push(...from.assets);
  into.emptyQueries.push(...from.emptyQueries);
}
