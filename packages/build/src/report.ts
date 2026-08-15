/**
 * Report (§5.8).
 *
 * A job summary with counts and the full URL of anything newly published. The
 * plugin's Building group should empty on the next refresh; if it does not,
 * this summary is where to look.
 *
 * Deletions are reported explicitly, including any the commit-diff check
 * refused. "Refused to delete 14 documents — no matching removals in this
 * commit" is the single most important line this job can print.
 */

import { appendFile } from 'node:fs/promises';
import type { RefusedDeletion } from './reconcile.js';

export interface PublishedEntry {
  shareId: string;
  title: string;
  url: string;
  reason: 'new' | 'changed';
}

export interface BuildReport {
  published: PublishedEntry[];
  deleted: string[];
  refusedDeletions: RefusedDeletion[];
  unchanged: number;
  skippedNewerSchema: string[];
  assetsUploaded: string[];
  assetsSkipped: number;
  warnings: string[];
  baseline: string;
  dryRun: boolean;
}

export function formatSummary(report: BuildReport): string {
  const lines: string[] = [];
  const fresh = report.published.filter((p) => p.reason === 'new');
  const updated = report.published.filter((p) => p.reason === 'changed');

  lines.push(`## Publish${report.dryRun ? ' (dry run — nothing was written)' : ''}`);
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Published | ${fresh.length} |`);
  lines.push(`| Updated | ${updated.length} |`);
  lines.push(`| Deleted | ${report.deleted.length} |`);
  lines.push(`| Unchanged | ${report.unchanged} |`);
  lines.push(`| Assets uploaded | ${report.assetsUploaded.length} |`);
  lines.push('');

  if (fresh.length > 0) {
    lines.push('### Newly published');
    lines.push('');
    for (const entry of fresh) lines.push(`- **${escape(entry.title)}** — <${entry.url}>`);
    lines.push('');
  }

  if (updated.length > 0) {
    lines.push('### Updated');
    lines.push('');
    for (const entry of updated) lines.push(`- ${escape(entry.title)} — <${entry.url}>`);
    lines.push('');
  }

  if (report.deleted.length > 0) {
    lines.push('### Deleted');
    lines.push('');
    for (const id of report.deleted) lines.push(`- \`${id}\` — the link is now dead`);
    lines.push('');
  }

  // The most important thing this job can say.
  if (report.refusedDeletions.length > 0) {
    lines.push(
      `### ⚠ Refused to delete ${report.refusedDeletions.length} document${report.refusedDeletions.length === 1 ? '' : 's'}`,
    );
    lines.push('');
    lines.push(
      'Nothing was removed from KV. A planned deletion must correspond to a staged file ' +
        'actually removed in this commit (§5.6). Usually this means a bad checkout, or a ' +
        'baseline that could not be established after a force-push.',
    );
    lines.push('');
    for (const refusal of report.refusedDeletions) {
      lines.push(`- \`${refusal.shareId}\` — ${refusal.reason}`);
    }
    lines.push('');
  }

  if (report.skippedNewerSchema.length > 0) {
    lines.push('### Skipped: live schema is newer than this build');
    lines.push('');
    lines.push(
      'These keys carry a higher `v` than this build writes, so they were left alone rather ' +
        'than downgraded (§4.4). Deploy the reader first, then the writer.',
    );
    lines.push('');
    for (const id of report.skippedNewerSchema) lines.push(`- \`${id}\``);
    lines.push('');
  }

  if (report.warnings.length > 0) {
    lines.push('### Warnings');
    lines.push('');
    for (const warning of report.warnings) lines.push(`- ${escape(warning)}`);
    lines.push('');
  }

  lines.push(`_Deletion baseline: ${escape(report.baseline)}_`);
  lines.push('');
  return lines.join('\n');
}

export async function writeSummary(report: BuildReport, summaryPath?: string): Promise<void> {
  const summary = formatSummary(report);
  process.stdout.write(`${summary}\n`);
  if (summaryPath) await appendFile(summaryPath, summary, 'utf8');
}

function escape(value: string): string {
  return value.replace(/[|\\]/g, '\\$&');
}
