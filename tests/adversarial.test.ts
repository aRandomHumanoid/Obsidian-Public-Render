/**
 * Adversarial staging cases (§3.7, §11.2).
 *
 * The fixture corpus in `staging.test.ts` covers the *documented* pathological
 * notes. This file covers the ones an attacker — or an unlucky author — would
 * reach for instead: the boundaries between two correct-looking steps, where
 * the drop rule has already run, or where one parser and another disagree about
 * what counts as code.
 *
 * Priority 1 in §1 is "nothing private is ever published", so every case here
 * asks one of five questions:
 *
 *   1. Does transcluding an unpublished note leak its content?
 *   2. Do links to unpublished notes leak titles or vault paths?
 *   3. Can `%%` stripping mis-pair delimiters or splice across a boundary?
 *   4. Does private frontmatter survive into staged output?
 *   5. Do transclusion cycles and depth caps hold?
 *
 * Three cases are marked `it.fails`: they are *confirmed defects*, written as
 * the acceptance test for the fix. When one starts failing, the bug is fixed —
 * flip it to `it` and delete this sentence's row from the list.
 */

import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertFrontmatterAllowlist,
  frontmatterParseError,
  runCriticalAssertions,
  splitFrontmatter,
} from '@notes/shared';
import { CriticalAssertionError } from '@notes/shared';
import { stripComments } from '../packages/plugin/src/staging/strip.js';
import { stageNote } from '../packages/plugin/src/staging/pipeline.js';
import { Actions } from '../packages/plugin/src/actions.js';
import { DEFAULT_SETTINGS } from '../packages/plugin/src/settings.js';
import type { PublisherSettings } from '../packages/plugin/src/settings.js';
import { PublishStore } from '../packages/plugin/src/vault/store.js';
import { FakeApp } from './harness/app.js';
import { FakeDataview, FakeVault } from './harness/vault.js';

const VAULT_DIR = fileURLToPath(new URL('../fixtures/vault', import.meta.url));

/** Strings that must never reach a published artifact, from the fixture corpus. */
const CANARIES = ['Ambergris', 'Petrichor', 'Vellum', 'Q4 acquisition targets', 'internal-roadmap'];

let vault: FakeVault;

beforeEach(async () => {
  vault = await FakeVault.fromDirectory(VAULT_DIR);
  vault.dataview = new FakeDataview({
    'TABLE status FROM #project': { markdown: '| File | status |', rows: 1 },
    'TABLE status FROM #nothing-matches-this': { markdown: '', rows: 0 },
    'this.title': { markdown: 'Dataview table', rows: 1 },
  });
});

function note(shareId: string, title: string, ...body: string[]): string {
  return ['---', 'publish: true', `share_id: ${shareId}`, `title: ${title}`, '---', '', ...body, ''].join('\n');
}

function stage(path: string, shareId: string, title = 'Adversarial') {
  return stageNote({
    file: vault.file(path),
    shareId,
    title,
    indexable: false,
    download: true,
    acknowledged: new Set<string>(),
    ctx: vault,
  });
}

// ── 1. Transclusion and unpublished content ─────────────────────────────────

describe('transclusion never carries unpublished content', () => {
  it('A embeds published B which embeds unpublished C', async () => {
    vault.addNote('nest-b.md', note('eeeeffff00001111', 'Nest B', '# Nest B', '', '![[internal-roadmap]]', '', 'B tail.'));
    vault.addNote('nest-a.md', note('ffff000011112222', 'Nest A', '# Nest A', '', '![[nest-b]]', '', 'A tail.'));

    const staged = await stage('nest-a.md', 'ffff000011112222');

    expect(staged.contents).toContain('B tail.');
    for (const canary of CANARIES) expect(staged.contents).not.toContain(canary);
    // The drop happened during B's staging, and B's record propagated to A.
    expect(staged.dropped.some((d) => d.reason === 'unpublished')).toBe(true);
  });

  it('a section embed of a published note cannot pull in the dropped link', async () => {
    vault.addNote(
      'sect-b.md',
      note('q1q1q1q1q1q1q1q1', 'Sect B', '# Sect B', '', '## Public part', '', 'Safe text.', '', '## Other', '', '[[internal-roadmap]]'),
    );
    vault.addNote('sect-a.md', note('q2q2q2q2q2q2q2q2', 'Sect A', '# Sect A', '', '![[sect-b#Public part]]'));

    const staged = await stage('sect-a.md', 'q2q2q2q2q2q2q2q2');

    expect(staged.contents).toContain('Safe text.');
    for (const canary of CANARIES) expect(staged.contents).not.toContain(canary);
  });

  it('an embed of an unpublished note is dropped whole, alias or not', async () => {
    vault.addNote(
      'embed-alias.md',
      note('q3q3q3q3q3q3q3q3', 'Embed alias', '# Embed alias', '', '![[internal-roadmap|a harmless label]]', '', 'Tail.'),
    );

    const staged = await stage('embed-alias.md', 'q3q3q3q3q3q3q3q3');

    expect(staged.contents).toContain('Tail.');
    for (const canary of CANARIES) expect(staged.contents).not.toContain(canary);
    // An embed carries content, so unlike a link there is no alias-shaped
    // partial disclosure to preserve — the label goes too.
    expect(staged.contents).not.toContain('a harmless label');
  });

  it("a target that fails its own staging blocks the host rather than inlining raw source", async () => {
    // A dataviewjs fence is a hard error (§9). `materializeDataview` returns the
    // *unprocessed* text on that path and `buildStagedBody` early-returns, so
    // the target's staged body still holds unresolved links. The error must
    // therefore reach the host, because actions.ts refuses to write on any
    // error-severity issue.
    vault.addNote(
      'broken-target.md',
      note('q4q4q4q4q4q4q4q4', 'Broken target', '# Broken target', '', '```dataviewjs', 'dv.list([1])', '```', '', '[[internal-roadmap]]'),
    );
    vault.addNote('broken-host.md', note('q5q5q5q5q5q5q5q5', 'Broken host', '# Broken host', '', '![[broken-target]]'));

    const staged = await stage('broken-host.md', 'q5q5q5q5q5q5q5q5');

    const errors = staged.issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((i) => i.code === 'dataviewjs-unsupported')).toBe(true);
  });
});

// ── 2. Links to unpublished notes ───────────────────────────────────────────

describe('links to unpublished notes leak neither title nor vault path', () => {
  it('no folder name, filename or body text survives any link shape', async () => {
    vault.addNote('Clients/Acme/Q4 layoffs.md', ['---', 'title: Q4 layoffs', '---', '', '# Q4 layoffs', '', 'SENSITIVEBODY'].join('\n'));
    vault.addNote(
      'path-leak.md',
      note(
        'r4r4r5r5r6r6r7r7',
        'Path leak',
        '# Path leak',
        '',
        'Link: [[Q4 layoffs]]',
        '',
        'Embed: ![[Q4 layoffs]]',
        '',
        'Heading: [[Q4 layoffs#Some Private Heading]]',
        '',
        'Block: [[Q4 layoffs^blockref]]',
        '',
        'Missing: [[Clients/Acme/Nope]]',
      ),
    );

    const staged = await stage('path-leak.md', 'r4r4r5r5r6r6r7r7');

    for (const needle of ['Clients', 'Acme', 'Q4 layoffs', 'SENSITIVEBODY', 'Some Private Heading', '.md']) {
      expect(staged.contents, `leaked: ${needle}`).not.toContain(needle);
    }
    expect(staged.contents).not.toContain('[[');
  });

  it('the vault path appears in the GUI drop record but never in the artifact', async () => {
    vault.addNote('Clients/Acme/Q4 layoffs.md', ['---', 'title: Q4 layoffs', '---', '', 'x'].join('\n'));
    vault.addNote('drop-record.md', note('q6q6q6q6q6q6q6q6', 'Drop record', '# Drop record', '', '[[Q4 layoffs]]'));

    const staged = await stage('drop-record.md', 'q6q6q6q6q6q6q6q6');

    // The panel needs the path to be actionable (§3.4); the artifact must not.
    expect(staged.dropped.some((d) => d.target === 'Clients/Acme/Q4 layoffs.md')).toBe(true);
    expect(staged.contents).not.toContain('Clients');
  });

  it('an alias equal to the title survives neither case nor whitespace variation', async () => {
    vault.addNote(
      'alias-variants.md',
      note(
        'q7q7q7q7q7q7q7q7',
        'Alias variants',
        '# Alias variants',
        '',
        'A [[internal-roadmap|q4 ACQUISITION targets]] here.',
        '',
        'B [[internal-roadmap|  Q4 acquisition targets  ]] here.',
        '',
        'C [[internal-roadmap|Internal-Roadmap]] here.',
      ),
    );

    const staged = await stage('alias-variants.md', 'q7q7q7q7q7q7q7q7');

    expect(staged.contents.toLowerCase()).not.toContain('q4 acquisition targets');
    expect(staged.contents.toLowerCase()).not.toContain('internal-roadmap');
  });

  it('documents the exact-match limit of the alias rule', async () => {
    // §3.7 step 3 keeps an alias that "differs from both the target's filename
    // and its title". The comparison is equality after trim+lowercase, so an
    // alias that *contains* the title still survives. This is the design as
    // written, and the alias is author-typed text rather than something
    // Obsidian generates — but it is the outer edge of the rule's protection,
    // so it is pinned here rather than left to be rediscovered.
    vault.addNote(
      'alias-superstring.md',
      note('q8q8q8q8q8q8q8q8', 'Alias superstring', '# Alias superstring', '', 'See [[internal-roadmap|Q4 acquisition targets and more]].'),
    );

    const staged = await stage('alias-superstring.md', 'q8q8q8q8q8q8q8q8');

    expect(staged.contents).toContain('Q4 acquisition targets and more');
    // It is still reported to the user, which is how the default gets noticed
    // when it is wrong for a particular note (§3.4).
    expect(staged.dropped.some((d) => d.target === 'internal-roadmap.md')).toBe(true);
  });
});

// ── 3. Comment stripping ────────────────────────────────────────────────────

describe('%% stripping pairs delimiters structurally', () => {
  it('a fence between two comments does not mis-pair', () => {
    const out = stripComments('A %% one %%\n\n```\n%% stray %%\n```\n\nB %% two %% C');
    expect(out.text).toContain('%% stray %%');
    expect(out.text).not.toContain('one');
    expect(out.text).not.toContain('two');
    expect(out.unterminated).toBe(false);
  });

  it('an inline code span between two comments does not mis-pair', () => {
    const out = stripComments('A %% one %% B `%%` C %% two %% D');
    expect(out.text).toBe('A  B `%%` C  D');
    expect(out.unterminated).toBe(false);
  });

  it('a comment may wrap a fence, and takes it with it', () => {
    const out = stripComments('A %% pre\n```\ncode %% inside\n```\npost %% B');
    expect(out.text).toBe('A  B');
    expect(out.unterminated).toBe(false);
  });

  it('an unterminated marker fails closed and says so', () => {
    const out = stripComments('Keep A.\n\nStray %% here.\n\nSECRETTAIL');
    expect(out.text).not.toContain('SECRETTAIL');
    expect(out.unterminated).toBe(true);
  });

  it('adjacent and empty comments pair correctly', () => {
    expect(stripComments('A %%x%%%%y%% B').text).toBe('A  B');
    expect(stripComments('A %%%% B').text).toBe('A  B');
  });

  it('a comment inside a transclusion target is stripped before it is inlined', async () => {
    vault.addNote(
      'commented-target.md',
      note('q9q9q9q9q9q9q9q9', 'Commented target', '# Commented target', '', 'Visible. %% TARGETSECRET %% Also visible.'),
    );
    vault.addNote('commented-host.md', note('a0a0a0a0a0a0a0a0', 'Commented host', '# Commented host', '', '![[commented-target]]'));

    const staged = await stage('commented-host.md', 'a0a0a0a0a0a0a0a0');

    expect(staged.contents).toContain('Also visible.');
    expect(staged.contents).not.toContain('TARGETSECRET');
    expect(staged.contents).not.toContain('%%');
  });

  it('an embed inside a comment publishes neither the target nor its alt text', async () => {
    vault.addBinary('pic.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    vault.addNote(
      'comment-embed.md',
      note('b0b0b0b0b0b0b0b0', 'Comment embed', '# Comment embed', '', '%% private: ![[pic.png]] and ![[published-b]] %%', '', 'Tail.'),
    );

    const staged = await stage('comment-embed.md', 'b0b0b0b0b0b0b0b0');

    expect(staged.contents).toContain('Tail.');
    expect(staged.contents).not.toContain('Published B');
    expect(staged.contents).not.toContain('_assets/');
  });

  it('an unclosed fence arriving by transclusion cannot smuggle the host comment out', async () => {
    // If B's staged output ends inside an open fence, everything after the
    // splice point in A looks like code to A's parser — including A's own
    // `%%` comment, which would then survive. Assertion 2 (§11.2) is what
    // catches it: the resulting fence matches no source block byte-for-byte.
    vault.addNote('unclosed-b.md', note('c0c0c0c0c0c0c0c0', 'Unclosed B', '# Unclosed B', '', '```js', 'const x = 1;'));
    vault.addNote(
      'unclosed-a.md',
      note('d0d0d0d0d0d0d0d0', 'Unclosed A', '# Unclosed A', '', '![[unclosed-b]]', '', '%% HOSTSECRET %%', '', 'Tail.'),
    );

    await expect(stage('unclosed-a.md', 'd0d0d0d0d0d0d0d0')).rejects.toThrow(CriticalAssertionError);
  });

  /**
   * A stray `%%` — one the author never meant as a delimiter — shifts every
   * pairing after it. The damage is not that too much is removed: it is that
   * the *interior* of a real comment ends up outside the removed span and gets
   * published, while `runCriticalAssertions` sees nothing wrong because no `%%`
   * survives, only the private text between them.
   *
   * Three ways in, all previously silent, all now blocked at the write gate.
   */
  it('refuses a %% inside display math rather than publishing the comment', async () => {
    vault.addNote(
      'math-comment.md',
      note(
        'e0e0e0e0e0e0e0e0',
        'Math comment',
        '# Math comment',
        '',
        '$$',
        'E = mc^2  %% TODO: check the units',
        '$$',
        '',
        'Public sentence one.',
        '',
        '%% MATHSECRET do not publish this %%',
        '',
        'Public sentence two.',
      ),
    );

    const staged = await stage('math-comment.md', 'e0e0e0e0e0e0e0e0');

    expect(staged.issues.some((i) => i.severity === 'error' && i.code === 'ambiguous-comment')).toBe(true);
  });

  it('refuses a %% inside inline math', async () => {
    vault.addNote(
      'inline-math.md',
      note('f0f0f0f0f0f0f0f0', 'Inline math', '# Inline math', '', 'Let $x %% y$ denote it.', '', '%% INLINESECRET %%', '', 'Tail sentence.'),
    );

    const staged = await stage('inline-math.md', 'f0f0f0f0f0f0f0f0');

    expect(staged.issues.some((i) => i.severity === 'error' && i.code === 'ambiguous-comment')).toBe(true);
  });

  it('refuses an even number of stray markers straddling a real comment', async () => {
    // The case an odd-count check alone would miss: `50%%` and `75%%` are a
    // doubled percent sign, not delimiters, and they bracket a real comment.
    // Pairing shifts by one in each direction and the comment interior lands
    // in the middle, published, with `unterminated` never set.
    vault.addNote(
      'stray-percent.md',
      note('a1a1a1a1a1a1a1a1', 'Stray percent', '# Stray percent', '', 'Progress: 50%% done.', '', '%% PRIVATENOTE %%', '', 'Also 75%% complete.'),
    );

    const staged = await stage('stray-percent.md', 'a1a1a1a1a1a1a1a1');

    expect(staged.issues.some((i) => i.severity === 'error' && i.code === 'ambiguous-comment')).toBe(true);
  });

  it('still accepts the two comment shapes Obsidian documents', () => {
    // Inline, and a block comment whose opener is alone on its line. Neither
    // may be collateral damage from the ambiguity rule — every fixture in the
    // corpus uses one of these two shapes.
    expect(stripComments('Before. %%gone%% After.').ambiguous).toHaveLength(0);
    expect(stripComments('A\n\n%%\nblock\n\nwith a blank line\n%%\n\nB').ambiguous).toHaveLength(0);
    expect(stripComments('%% opens mid-paragraph\nand closes in it %%').ambiguous).toHaveLength(0);
    // Prices are not math delimiters, and a comment between them is ordinary.
    expect(stripComments('It costs $5 %% check %% and $10.').ambiguous).toHaveLength(0);
  });
});

// ── 4. Frontmatter ──────────────────────────────────────────────────────────

describe('private frontmatter never reaches staged output', () => {
  it("a transclusion target's private properties are dropped with its frontmatter", async () => {
    vault.addNote(
      'fm-target.md',
      [
        '---',
        'publish: true',
        'share_id: n0n0n1n1n2n2n3n3',
        'title: FM target',
        'client: Acme Corporation',
        'invoice_total: 48000',
        '---',
        '',
        '# FM target',
        '',
        'Target body.',
      ].join('\n'),
    );
    vault.addNote('fm-host.md', note('n1n1n2n2n3n3n4n4', 'FM host', '# FM host', '', '![[fm-target]]'));

    const staged = await stage('fm-host.md', 'n1n1n2n2n3n3n4n4');

    expect(staged.contents).toContain('Target body.');
    expect(staged.contents).not.toContain('Acme Corporation');
    expect(staged.contents).not.toContain('48000');
  });

  it('a body that merely looks like frontmatter does not confuse the allowlist check', async () => {
    vault.addNote(
      'fake-fm.md',
      note('c1c1c1c1c1c1c1c1', 'Fake fm', '# Fake fm', '', 'A YAML sample:', '', '```yaml', 'client: Acme', '```'),
    );

    const staged = await stage('fake-fm.md', 'c1c1c1c1c1c1c1c1');

    expect(assertFrontmatterAllowlist(staged.contents)).toHaveLength(0);
    // The fenced sample is content, and assertion 2 requires it to survive.
    expect(staged.contents).toContain('client: Acme');
  });

  /**
   * A YAML block scalar containing a `---` line used to end the frontmatter
   * early, and every property after it published as body text.
   *
   * `splitFrontmatter` closed the block on the first line whose *trimmed* value
   * was `---`. A block scalar's continuation lines are necessarily indented, so
   * a `---` inside one matched, the split landed mid-frontmatter, and the
   * remaining keys — `client`, `invoice_total` — became the first lines of the
   * body. In markdown a paragraph followed by `---` is a setext heading, so
   * they published as a visible `<h2>`.
   *
   * Neither allowlist check caught it: the plugin's self-check and CI's
   * re-verification (§3.2) call the same `splitFrontmatter` and both inspect
   * only the *first* block, which by then is the clean generated metadata. The
   * duplication that exists for exactly this failure provided no coverage,
   * because both copies shared the mis-split.
   *
   * The delimiter is now required at column 0, where YAML and Obsidian both put
   * it and where no block-scalar continuation can reach. A `---` alone on a line
   * inside a multi-line *quoted* scalar still mis-splits; far less reachable,
   * and the reason this check ultimately wants a parse rather than a scan.
   */
  it('keeps private properties out of the body when frontmatter holds a block scalar', async () => {
    vault.addNote(
      'block-scalar.md',
      [
        '---',
        'publish: true',
        'share_id: aaaabbbbccccdddd',
        'title: Block scalar',
        'description: |',
        '  intro',
        '  ---',
        '  outro',
        'client: Acme Corporation',
        'invoice_total: 48000',
        '---',
        '',
        '# Block scalar',
        '',
        'Body text.',
      ].join('\n'),
    );

    const staged = await stage('block-scalar.md', 'aaaabbbbccccdddd', 'Block scalar');

    expect(staged.contents).not.toContain('Acme Corporation');
    expect(staged.contents).not.toContain('48000');
  });

  it('refuses a note whose frontmatter does not parse, rather than guessing the body', async () => {
    // The residual the column-0 rule cannot reach: a `---` at column 0 inside
    // a multi-line quoted scalar. YAML forbids it, so this can only arise in
    // already-malformed frontmatter — but the split would still land mid-block
    // and publish `client` as body text, so it fails closed.
    vault.addNote(
      'quoted-scalar.md',
      ['---', 'publish: true', 'share_id: c2c2c2c2c2c2c2c2', 'desc: "line', '---', 'more"', 'client: Acme Corporation', '---', '', '# Quoted', '', 'Body.'].join('\n'),
    );

    const staged = await stage('quoted-scalar.md', 'c2c2c2c2c2c2c2c2');

    expect(staged.issues.some((i) => i.severity === 'error' && i.code === 'frontmatter-unparseable')).toBe(true);
  });

  it('never inlines a transclusion target whose frontmatter does not parse', async () => {
    // Two guards stack here, and the outer one fires first: a target whose
    // frontmatter will not parse has no readable `publish: true`, so it reads
    // as unpublished and the embed is dropped whole before its body is ever
    // composed. The `frontmatter-unparseable` check in `buildStagedBody` is
    // the backstop for the case where a target *is* legibly published and the
    // damage would land in the host's body.
    vault.addNote(
      'bad-fm-target.md',
      ['---', 'publish: true', 'share_id: c3c3c3c3c3c3c3c3', 'desc: "line', '---', 'more"', 'client: Acme Corporation', '---', '', '# Bad target', '', 'Target body.'].join('\n'),
    );
    vault.addNote('bad-fm-host.md', note('c4c4c4c4c4c4c4c4', 'Bad fm host', '# Bad fm host', '', '![[bad-fm-target]]'));

    const staged = await stage('bad-fm-host.md', 'c4c4c4c4c4c4c4c4');

    expect(staged.contents).not.toContain('Acme Corporation');
    expect(staged.contents).not.toContain('Target body.');
    expect(staged.dropped.some((d) => d.reason === 'unpublished')).toBe(true);
  });

  it('refuses a block that opens but never closes at column 0', async () => {
    // Two shapes reach this, and one of them is self-inflicted: requiring the
    // closing delimiter at column 0 means a block closed only by an *indented*
    // `---` no longer splits there, so it falls through to "unterminated" and
    // `splitFrontmatter` hands the whole document back as body — publishing
    // every key in it. The other shape, a block with no closing delimiter at
    // all, behaved that way before the change too. Both fail closed now.
    for (const [name, lines] of [
      ['indented close', ['---', 'publish: true', 'share_id: q9q9q9q9q9q9q9q9', 'client: Acme Corporation', '  ---', '', '# Note', '', 'Body.']],
      ['no close', ['---', 'publish: true', 'share_id: q8q8q8q8q8q8q8q8', 'client: Acme Corporation', '', '# Note', '', 'Body.']],
    ] as [string, string[]][]) {
      const id = name === 'indented close' ? 'q9q9q9q9q9q9q9q9' : 'q8q8q8q8q8q8q8q8';
      vault.addNote(`${id}.md`, lines.join('\n'));
      const staged = await stage(`${id}.md`, id, 'Note');
      expect(
        staged.issues.some((i) => i.severity === 'error' && i.code === 'frontmatter-unparseable'),
        `${name}: expected a blocking error`,
      ).toBe(true);
    }
  });

  it('does not flag a document with no frontmatter at all', () => {
    // The guard keys off a block being *opened*, so an ordinary note that
    // simply has no properties must stay stageable.
    expect(frontmatterParseError('# Just a note\n\nBody.')).toBeNull();
    expect(frontmatterParseError('')).toBeNull();
    expect(frontmatterParseError('---\ntitle: fine\n---\n\nBody.')).toBeNull();
  });

  it('closes frontmatter only on a column-0 delimiter', () => {
    const split = splitFrontmatter(['---', 'desc: |', '  a', '  ---', 'client: Acme', '---', '', 'Body.'].join('\n'));
    expect(split.frontmatter).toContain('client: Acme');
    expect(split.body.trim()).toBe('Body.');

    // Trailing whitespace and CRLF still close it; an indented or decorated
    // delimiter does not.
    expect(splitFrontmatter('---\na: 1\n--- \nBody').frontmatter).toBe('a: 1');
    expect(splitFrontmatter('---\na: 1\r\n---\r\nBody').frontmatter).toBe('a: 1\r');
    expect(splitFrontmatter('---\na: 1\n...\nBody').frontmatter).toBe('a: 1');
    expect(splitFrontmatter('---\na: 1\n  ---\nBody').frontmatter).toBeNull();
    expect(splitFrontmatter('---\na: 1\n----\nBody').frontmatter).toBeNull();
  });
});

// ── 5. Cycles and depth ─────────────────────────────────────────────────────

describe('transclusion terminates', () => {
  it('a note embedding itself', async () => {
    vault.addNote('self.md', note('n2n2n3n3n4n4n5n5', 'Self', '# Self', '', '![[self]]', '', 'tail'));

    const staged = await stage('self.md', 'n2n2n3n3n4n4n5n5');

    expect(staged.contents).toContain('tail');
    expect(staged.issues.some((i) => i.code === 'transclusion-cycle')).toBe(true);
  });

  it('a three-note cycle', async () => {
    vault.addNote('c3-a.md', note('aaaa000000000001', 'C3 A', '# C3 A', '', '![[c3-b]]'));
    vault.addNote('c3-b.md', note('aaaa000000000002', 'C3 B', '# C3 B', '', '![[c3-c]]'));
    vault.addNote('c3-c.md', note('aaaa000000000003', 'C3 C', '# C3 C', '', '![[c3-a]]'));

    const staged = await stage('c3-a.md', 'aaaa000000000001');

    expect(staged.contents).toContain('C3 B');
    expect(staged.contents).toContain('C3 C');
    expect(staged.issues.some((i) => i.code === 'transclusion-cycle')).toBe(true);
  });

  it('a chain deeper than the cap stops at the cap and reports it', async () => {
    for (let i = 0; i <= 7; i++) {
      const next = i < 7 ? `\n\n![[deep-${i + 1}]]` : '';
      vault.addNote(
        `deep-${i}.md`,
        note(`deep${String(i).padStart(12, '0')}`, `Deep ${i}`, `# Deep ${i}`, '', `LEVEL${i}MARKER`, next),
      );
    }

    const staged = await stage('deep-0.md', 'deep000000000000', 'Deep 0');

    // transclusionDepth defaults to 4 (settings.ts).
    for (const i of [0, 1, 2, 3]) expect(staged.contents).toContain(`LEVEL${i}MARKER`);
    for (const i of [4, 5, 6, 7]) expect(staged.contents).not.toContain(`LEVEL${i}MARKER`);
    expect(staged.issues.some((i) => i.code === 'transclusion-depth')).toBe(true);
  });

  it('a diamond embeds the shared target twice without tripping the cycle guard', async () => {
    vault.addNote('dia-c.md', note('dddd000000000003', 'Dia C', '# Dia C', '', 'SHAREDLEAF'));
    vault.addNote('dia-b1.md', note('dddd000000000001', 'Dia B1', '# Dia B1', '', '![[dia-c]]'));
    vault.addNote('dia-b2.md', note('dddd000000000002', 'Dia B2', '# Dia B2', '', '![[dia-c]]'));
    vault.addNote('dia-a.md', note('dddd000000000000', 'Dia A', '# Dia A', '', '![[dia-b1]]', '', '![[dia-b2]]'));

    const staged = await stage('dia-a.md', 'dddd000000000000');

    expect(staged.contents.match(/SHAREDLEAF/g)).toHaveLength(2);
    expect(staged.issues.some((i) => i.code === 'transclusion-cycle')).toBe(false);
  });
});

// ── The self-check itself ───────────────────────────────────────────────────

describe('the write gate refuses, so nothing reaches disk', () => {
  it('a mis-paired comment never becomes a pending file', async () => {
    // The layer that matters: `stageNote` still *returns* the mangled body,
    // and it is actions.ts that refuses on an error-severity issue (§3.7 step
    // 7). Asserting on the outcome object alone would not prove the bytes stay
    // off disk, so this goes through the real store.
    const app = new FakeApp();
    const settings: PublisherSettings = { ...DEFAULT_SETTINGS, properties: { ...DEFAULT_SETTINGS.properties } };
    const store = new PublishStore(app.asApp(), settings);
    await store.ensureDirs();

    const id = 'b1b1b1b1b1b1b1b1';
    const source = app.addNote(
      'Projects/Mispaired.md',
      [
        '---',
        'publish: true',
        `share_id: ${id}`,
        '---',
        '',
        '# Mispaired',
        '',
        'Progress: 50%% done.',
        '',
        '%% PRIVATENOTE %%',
        '',
        'Also 75%% complete.',
        '',
      ].join('\n'),
    );

    const actions = new Actions({
      app: app.asApp(),
      settings,
      store,
      scan: () => null,
      refresh: async () => {},
    });

    const result = await actions.stageForPublishing(source, { silent: true });

    expect(result.ok).toBe(false);
    expect(result.issues?.some((i) => i.code === 'ambiguous-comment')).toBe(true);
    expect(await store.readPending(id)).toBeNull();

    // Control, so the assertion above cannot pass because writing never works
    // in the fake: the same note with the stray markers removed does write.
    const cleanId = 'b2b2b2b2b2b2b2b2';
    const clean = app.addNote(
      'Projects/Clean.md',
      ['---', 'publish: true', `share_id: ${cleanId}`, '---', '', '# Clean', '', 'Progress: 50 percent done.', '', '%% PRIVATENOTE %%', '', 'Tail.', ''].join('\n'),
    );
    const ok = await actions.stageForPublishing(clean, { silent: true });

    expect(ok.ok).toBe(true);
    const written = await store.readPending(cleanId);
    expect(written).not.toBeNull();
    expect(written).not.toContain('PRIVATENOTE');
  });
});

describe('the pre-publish self-check is the last line, not the only one', () => {
  it('catches a comment delimiter that survived upstream', () => {
    const output = ['---', 'share_id: 7k2m9x4qp8vw3n6r', 'title: x', 'source_hash: a', 'staged: 2026-01-01T00:00:00Z', 'indexable: false', 'download: true', '---', '', 'left %% over'].join('\n');
    expect(runCriticalAssertions({ output })).not.toHaveLength(0);
  });

  it('cannot see comment *content* once the delimiters are gone', () => {
    // Worth stating plainly: assertion 1 looks for the `%%` sequence, so a bug
    // that removes both delimiters and keeps the text between them is
    // invisible to it. That is the shape of the math finding above, and the
    // reason it needs a parser fix rather than a stronger assertion.
    const output = ['---', 'share_id: 7k2m9x4qp8vw3n6r', 'title: x', 'source_hash: a', 'staged: 2026-01-01T00:00:00Z', 'indexable: false', 'download: true', '---', '', 'PRIVATE TEXT that was inside a comment'].join('\n');
    expect(runCriticalAssertions({ output })).toHaveLength(0);
  });
});
