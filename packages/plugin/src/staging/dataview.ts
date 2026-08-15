/**
 * Dataview materialization (§9).
 *
 * **Decision: materialize.** Rendering inside Obsidian and capturing its DOM
 * is rejected — it would cost theme-CSS capture, HTML sanitization of
 * arbitrary plugin output, and reproducibility, in exchange for fidelity this
 * project does not need.
 *
 * A published Dataview table is a point-in-time snapshot. It updates when the
 * note is re-published, and Stale status is how you know it needs to be.
 */

import { sha256Hex } from '@notes/shared';
import type { App } from 'obsidian';
import { MarkdownIndex, applySplices } from './ast.js';
import type { Splice } from './ast.js';
import type { DataviewBridge, StagedBody, StagingContext } from './context.js';

/** How long to wait for Dataview's index before giving up and blocking. */
const INDEX_TIMEOUT_MS = 30_000;

interface DataviewApi {
  index?: { initialized?: boolean };
  queryMarkdown(query: string, sourcePath?: string): Promise<{ successful: boolean; value?: unknown; error?: string }>;
  query(query: string, sourcePath?: string): Promise<{ successful: boolean; value?: unknown; error?: string }>;
  evaluate(expression: string, sourcePath?: string): { successful: boolean; value?: unknown; error?: string } | Promise<{ successful: boolean; value?: unknown; error?: string }>;
}

function getApi(app: App): DataviewApi | null {
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { api?: DataviewApi }> } }).plugins;
  return plugins?.plugins?.['dataview']?.api ?? null;
}

export function createDataviewBridge(app: App): DataviewBridge | null {
  const api = getApi(app);
  if (!api) return null;

  return {
    async waitForIndex(): Promise<void> {
      if (api.index?.initialized) return;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          app.metadataCache.offref(ref);
          reject(
            new Error(
              'Dataview\'s index is not ready. Querying too early returns empty results and ' +
                'silently publishes blank tables (§9), so staging stopped instead. Wait for ' +
                'indexing to finish and try again.',
            ),
          );
        }, INDEX_TIMEOUT_MS);

        const ref = app.metadataCache.on(
          // Dataview fires this on the metadata cache once its index is built.
          'dataview:index-ready' as unknown as 'changed',
          () => {
            clearTimeout(timer);
            app.metadataCache.offref(ref);
            resolve();
          },
        );
      });
    },

    async queryMarkdown(query: string, sourcePath: string) {
      const structured = await api.query(query, sourcePath);
      if (!structured.successful) {
        throw new Error(`Dataview query failed: ${structured.error ?? 'unknown error'}`);
      }

      const rendered = await api.queryMarkdown(query, sourcePath);
      if (!rendered.successful) {
        throw new Error(`Dataview query failed: ${rendered.error ?? 'unknown error'}`);
      }

      return { markdown: extractMarkdown(rendered.value), rows: countRows(structured.value) };
    },

    async evaluateInline(expression: string, sourcePath: string) {
      const result = await api.evaluate(expression, sourcePath);
      if (!result.successful) {
        throw new Error(`Dataview expression failed: ${result.error ?? 'unknown error'}`);
      }
      return String(result.value ?? '');
    },
  };
}

function extractMarkdown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === 'string') return inner;
  }
  return '';
}

function countRows(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const record = value as { type?: string; values?: unknown[] };
  if (Array.isArray(record.values)) return record.values.length;
  return 0;
}

export interface MaterializeResult {
  text: string;
  emptyQueries: StagedBody['emptyQueries'];
  issues: StagedBody['issues'];
}

/**
 * Replace every Dataview fence and inline query with its markdown output.
 *
 * Blocks publishing on any query returning zero rows, listing it under Issues
 * with a "publish anyway" action. Accepting stores `publish_ack: <hash of the
 * query text>` in the source note, which suppresses the prompt until the query
 * itself changes. An empty table and a broken query are indistinguishable
 * after the fact, so the confirmation has to happen at publish time or not at
 * all.
 */
export async function materializeDataview(
  text: string,
  ctx: StagingContext,
  sourcePath: string,
  acknowledged: Set<string>,
): Promise<MaterializeResult> {
  const issues: MaterializeResult['issues'] = [];
  const emptyQueries: MaterializeResult['emptyQueries'] = [];

  const index = MarkdownIndex.parse(text);
  const fences = index.fenced('dataview');
  const scripted = [...index.fenced('dataviewjs'), ...index.inlineStartingWith('$=')];
  const inlines = index.inlineStartingWith('=');

  if (fences.length === 0 && inlines.length === 0 && scripted.length === 0) {
    return { text, emptyQueries, issues };
  }

  if (scripted.length > 0) {
    // `dataviewjs` is arbitrary JavaScript. Materializing it means executing it
    // and trusting whatever DOM it produces, which is the fidelity-for-
    // reproducibility trade §9 already declined. Publishing the source instead
    // would leak code and render as nonsense, so this is a hard stop.
    issues.push({
      severity: 'error',
      code: 'dataviewjs-unsupported',
      message:
        `this note contains ${scripted.length} dataviewjs block${scripted.length === 1 ? '' : 's'}, ` +
        `which cannot be materialized (§9). Convert it to a DQL query, or remove it.`,
    });
    return { text, emptyQueries, issues };
  }

  if (!ctx.settings.dataview) {
    issues.push({
      severity: 'error',
      code: 'dataview-disabled',
      message: 'this note contains Dataview queries but materialization is turned off in settings',
    });
    return { text, emptyQueries, issues };
  }

  const dataview = ctx.dataview;
  if (!dataview) {
    issues.push({
      severity: 'error',
      code: 'dataview-missing',
      message: 'this note contains Dataview queries but the Dataview plugin is not available',
    });
    return { text, emptyQueries, issues };
  }

  // Hard block, never a warning (§9).
  await dataview.waitForIndex();

  const splices: Splice[] = [];

  for (const fence of fences) {
    const query = fence.value;
    const hash = (await sha256Hex(query.trim())).slice(0, 16);
    try {
      const { markdown, rows } = await dataview.queryMarkdown(query, sourcePath);
      if (rows === 0 && !acknowledged.has(hash)) {
        emptyQueries.push({ query: query.trim(), hash });
        issues.push({
          severity: 'error',
          code: 'dataview-empty',
          message: `a Dataview query returned no rows: ${firstLine(query)}`,
        });
        continue;
      }
      splices.push({ start: fence.start, end: fence.end, replacement: markdown.trim() });
    } catch (err) {
      issues.push({
        severity: 'error',
        code: 'dataview-failed',
        message: (err as Error).message,
      });
    }
  }

  for (const inline of inlines) {
    const expression = inline.value.slice(1).trim();
    try {
      const value = await dataview.evaluateInline(expression, sourcePath);
      splices.push({ start: inline.start, end: inline.end, replacement: value });
    } catch (err) {
      issues.push({
        severity: 'error',
        code: 'dataview-failed',
        message: (err as Error).message,
      });
    }
  }

  if (issues.length > 0) return { text, emptyQueries, issues };

  return { text: applySplices(text, splices), emptyQueries, issues };
}

function firstLine(query: string): string {
  return (query.trim().split('\n')[0] ?? '').slice(0, 80);
}
