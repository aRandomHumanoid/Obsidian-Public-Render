/**
 * When the panel looks again after a push (§3.9).
 *
 * This used to be twelve fixed fifteen-second polls: three minutes,
 * unconditional. Three minutes is shorter than a realistic Actions queue plus
 * build, so the window routinely closed *before* the state it was waiting for
 * arrived — and because `refreshIntervalMinutes` defaults to 0, nothing
 * refreshed afterwards either. The panel then sat on a stale view until the
 * user reopened it, which reads as "it never updates" rather than "it gave up
 * too early".
 *
 * Removals show it worst. They are the case where the entry has to *disappear*,
 * so there is nothing left on screen to hint that the panel merely stopped
 * looking — and §3.6 already warns that a removal is the operation whose
 * outcome the user most needs confirmed.
 *
 * Two changes, then: back off out to roughly ten minutes rather than three, and
 * stop as soon as nothing is in flight rather than burning the whole schedule.
 * A build that lands in forty seconds costs four requests; one stuck behind a
 * queue still gets seen.
 *
 * The policy lives here rather than in `main.ts` so it can be tested without an
 * Obsidian runtime — the plugin class needs one, a schedule does not.
 */

import type { NoteStatus } from '@notes/shared';

/** Delay before each successive poll, in order. */
export const POST_PUSH_BACKOFF_MS: readonly number[] = [
  5_000, 5_000, 10_000, 10_000, 15_000, 15_000, 20_000, 30_000, 30_000, 45_000, 60_000, 60_000,
  60_000, 60_000, 60_000, 60_000,
];

/**
 * Statuses that mean CI still owes us an answer (§3.4).
 *
 * `removing` belongs here for the reason above: stopping while one is
 * outstanding leaves the panel showing a note that is already gone from KV.
 */
const IN_FLIGHT: readonly NoteStatus[] = ['building', 'removing'];

/** The delay before poll `index`, or `null` once the schedule is exhausted. */
export function nextPollDelay(index: number): number | null {
  return POST_PUSH_BACKOFF_MS[index] ?? null;
}

/** True while any note is still waiting on CI. */
export function hasInFlightWork(statuses: Iterable<NoteStatus>): boolean {
  for (const status of statuses) {
    if (IN_FLIGHT.includes(status)) return true;
  }
  return false;
}

/** Total wall time the schedule covers. */
export function pollWindowMs(): number {
  return POST_PUSH_BACKOFF_MS.reduce((total, delay) => total + delay, 0);
}
