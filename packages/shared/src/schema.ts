/**
 * Schema versioning (§4.4).
 *
 * Both KV records carry `v`. Three rules govern it:
 *
 *   1. Readers tolerate what they know. The worker serves any `v` at or below
 *      its own; an unknown higher `v` returns the standard 404 and logs.
 *   2. Writers never downgrade. If a live key's metadata carries a higher `v`
 *      than this build writes, the build skips that document and reports it.
 *      A rollback across a schema bump degrades to "no change", not corruption.
 *   3. Deploy the reader first. Bump `v`, deploy the worker, confirm it serves
 *      both versions, then ship the build that writes the new one.
 *
 * Rule 2 is why `v` is carried in KV *key metadata* and not only in the value:
 * the build must be able to check the version from a single `list` call,
 * before deciding whether to write.
 */

/** The schema version this codebase writes. Bump deliberately; see §4.4. */
export const SCHEMA_VERSION = 1 as const;

/**
 * The highest schema version the worker knows how to render. Kept separate
 * from SCHEMA_VERSION on purpose: during a "deploy the reader first" rollout
 * these differ, and that difference is the whole point of the exercise.
 */
export const WORKER_MAX_SCHEMA_VERSION = 1 as const;
