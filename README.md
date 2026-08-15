# Note publishing pipeline

An implementation of [`design docs.md`](design%20docs.md) v1.3 — publishing individual notes
from a private Obsidian vault to unguessable, downloadable public URLs, managed from a GUI
inside Obsidian.

The design document is the specification. This README covers what was built, how to run it,
and — at the end — every place the implementation had to decide something the design left
open, plus one finding that qualifies a claim the design makes.

```
┌───────────────────────────────────────────────┐
│  Obsidian + publisher plugin                  │  packages/plugin
│  Stages self-describing markdown → published/ │
└───────────────────┬───────────────────────────┘
                    │ review modal, then commit and push (§3.9)
┌───────────────────▼───────────────────────────┐
│  vault repo (private)                         │  your repo
│    Notes/…            ← never read by CI      │
│    published/         ← the only thing CI sees│
└───────────────────┬───────────────────────────┘
                    │ GitHub Actions, path-filtered to published/**
┌───────────────────▼───────────────────────────┐
│  build: discover → render → reconcile → write │  packages/build
└──────────┬────────────────────────┬───────────┘
    KV list + writes           R2 puts
           ▼                        ▼
   ┌───────────────┐        ┌────────────────┐
   │  Workers KV   │        │   R2 bucket    │
   └───────┬───────┘        └────────┬───────┘
           └───────────┬─────────────┘
             ┌─────────▼────────────┐
             │  Cloudflare Worker   │  packages/worker
             │  NO GitHub creds     │
             └──────────────────────┘
```

## Layout

| Path | What it is |
|---|---|
| `packages/shared` | The contract: `share_id`, the two hashes, the metadata block, the status table, and the three critical assertions (§11.2). Imported by all three other packages. |
| `packages/plugin` | The Obsidian plugin — staging pipeline (§3.7), publish panel (§3.4), review modal (§3.9), git integration. |
| `packages/build` | The CI pipeline (§5) — discover, render, assets, reconcile, publish, report. Plus `notes-preview`, which renders one file locally with no infrastructure. |
| `packages/worker` | The public-facing worker (§7). Holds no GitHub credentials and has no network path to the repo. |
| `fixtures/vault` | The pathological corpus from §11.1, as real notes. |
| `tests/` | 144 tests: the corpus, the three assertions, reconciliation (§11.4), worker routes (§11.5), asset and SVG handling. |
| `.github/workflows/publish.yml` | **Belongs in the vault repo**, not here. Copy it across. |

## Setup

About twenty minutes end to end. The ordering matters in two places, both flagged.

### Before you start

You need an Obsidian vault already backed up to a **private** GitHub repo, a Cloudflare
account (the free tier is enough — see §10 for the quotas), Node 20 or later, and either
`git` on your `PATH` or the Obsidian Git plugin installed. The plugin never stores a git
credential of its own (§3.9), so it uses whichever of those you already have configured.

One decision to make now, because it changes step 4: **will this pipeline repo be public or
private?** The vault's workflow checks it out to get the build code.

| Choice | What it costs |
|---|---|
| Public | Nothing — no credential needed for the checkout. Simplest. |
| Private | A read-only fine-grained PAT or deploy key, added to the checkout step. |
| Vendored into the vault repo | No second checkout at all. Add its directory to `sparse-checkout` instead. CI still cannot see `Notes/`. |

### 1. Build and test this repo

```bash
npm ci
npm run build
npm test
```

144 tests, no network and no Cloudflare account required. If that is green the pipeline
works, and everything below is configuration.

### 2. Cloudflare: KV, R2, and the worker

```bash
npx wrangler login
npx wrangler kv namespace create NOTES     # copy the id it prints
npx wrangler r2 bucket create notes-assets
```

Put that id into `packages/worker/wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.
Then:

```bash
cd packages/worker && npx wrangler deploy
```

It prints your URL — `https://notes.<your-subdomain>.workers.dev`. **Write it down**; three
later steps need it. Visiting it should return *Nothing to see here*, which is the static
placeholder from §7.1: no index, no listing.

> **Deploy the worker before the first build.** Not just convenience — it is the "deploy the
> reader first" rule from §4.4, and the reason the worker is deployed by hand at all. It is
> also why the CI token in the next step does not carry `Workers Scripts: Edit`: a
> compromised CI token cannot replace worker code.

Optionally, set the manifest token:

```bash
openssl rand -base64 32 | npx wrangler secret put MANIFEST_TOKEN
```

Skip it if unsure — without it the plugin issues one `HEAD` per known note and loses only the
rarer flavour of Orphan (§3.5). If you do set one, keep the value; it goes into plugin
settings in step 5.

> This token returns **every published `share_id` in one response** — the index of your
> unlisted URLs. It is much safer than a PAT and considerably more sensitive than "read-only
> metadata" implies (§3.5).

### 3. The Cloudflare API token for CI

Dashboard → My Profile → API Tokens → Create Custom Token. Exactly two permissions (§10):

- **Workers KV Storage: Edit**, scoped to the one namespace
- **R2: Edit**, scoped to the one bucket

Nothing else. No Cache Purge — there is no zone to purge on `workers.dev` (§7.4) — and
specifically **not** Workers Scripts: Edit. Worst case for a leaked token is vandalism of
already-public content.

Grab your account ID too; it is at the top of any Cloudflare dashboard page.

### 4. The vault repo

```bash
cd /path/to/your/vault-repo

echo '.publish-pending/' >> .gitignore    # ← this line first
mkdir -p published/_assets && touch published/_assets/.gitkeep
mkdir -p .github/workflows
cp /path/to/this/repo/.github/workflows/publish.yml .github/workflows/
git add -A && git commit -m "add publishing pipeline"
```

> **The gitignore line goes in before you stage anything.** The vault repo is a backup repo
> and Obsidian Git commits on a timer; if staged files landed in the tracked tree, auto-commit
> would sweep them up and publish them **without the review modal ever opening** (§3.3). That
> is the one failure that defeats the whole architecture. The plugin checks on every refresh
> and shows a red banner if the entry is missing, but the banner is a backstop, not the plan.

Now edit the two `CHANGE-ME` values in `.github/workflows/publish.yml`:

```yaml
env:
  PUBLIC_BASE_URL: https://notes.YOUR-SUBDOMAIN.workers.dev
…
      - name: Checkout the publishing pipeline
        with:
          repository: YOUR-USER/Obsidian-Public-Render
```

If this repo is private, add `token: ${{ secrets.PIPELINE_READ_TOKEN }}` to that step and
create a read-only fine-grained PAT for it. To vendor instead, copy this repo into the vault
under e.g. `publisher/`, add `publisher/` to the `sparse-checkout` list in the *first*
checkout step, and delete the second checkout step entirely.

Then add three repository secrets — Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | from step 3 |
| `CLOUDFLARE_ACCOUNT_ID` | from step 3 |
| `KV_NAMESPACE_ID` | from step 2 |

Consider adding `published/` to Obsidian's *Settings → Files and links → Excluded files* so
the staged copies do not clutter search. The plugin already ignores them.

### 5. The plugin

Either install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat), which
also handles updates, or copy the files in by hand.

**With BRAT.** Install BRAT from Community plugins, then *Add beta plugin* and give it:

```
aRandomHumanoid/Obsidian-Public-Render
```

BRAT reads `manifest.json` from the repository root — generated from
`packages/plugin/manifest.json`, never edited directly — and pulls `main.js`,
`manifest.json` and `styles.css` from the latest release.

**By hand.**

```bash
npm run build -w @notes/plugin
mkdir -p /path/to/vault/.obsidian/plugins/note-publisher
cp packages/plugin/{main.js,manifest.json,styles.css} \
   /path/to/vault/.obsidian/plugins/note-publisher/
```

In Obsidian: Settings → Community plugins → enable **Note publisher**. In its settings, set
**Base URL** to your worker origin, and paste the manifest token if you made one. Everything
else has a working default.

Desktop only (`isDesktopOnly: true`, §13) — the git half of the workflow is awkward on mobile
and it doubles the test surface.

### 6. First publish

1. Open any note → command palette → **Stage current note for publishing**.
2. Open the publish manager (ribbon icon). The note appears under **STAGED**.
3. Click **↑ Push (1)**. Read the diff — this is the real `git diff --cached`, the exact bytes
   about to become public, not a plugin-rendered approximation (§3.9).
4. **Commit and push**. The status moves to **BUILDING**.
5. Watch the Actions run. It runs the boundary probe first, then publishes.
6. The status flips to **LIVE**. Click the copy icon and open the URL.

If it sticks on BUILDING, the job summary is where to look — it lists every new URL and,
more importantly, any deletion the build refused (§5.8).

### 7. Verify the two assumptions (§12)

The first is automatic: the workflow's *Verify the vault is unreachable from the runner* step
runs on every build, probes for an object outside `published/` and an unauthenticated
`git fetch`, and fails the build if either succeeds. If it ever fails, §6.3's three outcomes
apply in order of likelihood — and since `persist-credentials: false` is already set, a
failure means taking the two-repo fallback.

The second needs the live site, so it stays manual:

```bash
curl -sI https://notes.YOUR-SUBDOMAIN.workers.dev/n/<id> | grep -i cf-cache-status
```

`DYNAMIC` is the wanted answer — no shared cache, so `max-age` governs only the browser and
the absence of purge costs nothing. `HIT` means an unevictable shared cache, and `max-age`
should drop to 60 in `packages/worker/src/index.ts`. Then measure the real number: publish,
delete, and poll a fresh request until it 404s. That figure replaces the two-to-three-minute
estimate in §6.2.

Finally, from inside Obsidian, run **Verify all**. It fetches each live page and compares
hashes — the only check in the design that observes rather than infers (§3.6).

### Things that will bite you

| Symptom | Cause |
|---|---|
| No build runs after a push | Expected — the commit touched nothing under `published/`. The path filter is working (§5.1). |
| Every build refuses every deletion | `fetch-depth` went shallow. Presents as a reconciliation bug; it is a checkout setting (§5.2). |
| Images publish as broken links | Git LFS. `lfs: true` is already in the workflow, so this means the checkout went wrong some other way. |
| A renderer change appears to do nothing | Bump `RENDER_CONFIG_VERSION` in `packages/build/src/config.ts`. Note it rewrites the whole corpus — above roughly 1,000 notes that exceeds the daily KV write quota (§4.2). |
| Mermaid fences fail the build | The workflow installs the renderer only when it finds a `mermaid` fence. If the grep misses one, set `MERMAID: skip` to degrade visibly instead of failing. |
| Nothing goes live but the panel says LIVE | Run **Verify all**. Every other status is inferred from hashes recorded at write time; this is the one that looks. |
| The plugin's Push button is disabled | Detached HEAD, no remote, or no acceptable git mode. The reason is shown next to the button (§3.9). |

One thing worth knowing before committing to this: CI can enumerate every *filename* in your
vault across all history, because `filter: blob:none` fetches trees. Not contents — but if
`Notes/Clients/Acme/Q4 layoffs.md` merely existing is sensitive, take the two-repo fallback
in §6.3. See *One finding that qualifies §6.1* below.

## Using it

| | |
|---|---|
| Stage a note | Command palette → *Stage current note for publishing*, or the panel, or the context menu (off by default) |
| See what is live | Ribbon icon, status bar, or *Open publish manager* |
| Publish | *Review and push* → read the real `git diff --cached` → **Commit and push** |
| Unpublish | *Stage for removal*, then push |
| Discard local work | *Unstage* — refuses on a live note, and points at Stage for removal (§3.6) |
| Check the site really matches | *Verify all* — the only check in the design that observes rather than infers |

The vocabulary is load-bearing. Everything before the review modal says **stage**; the modal
and everything after say **publish**, because at that point it is true (§3.10).

## Development

```bash
npm ci
npm run typecheck
npm test                       # 144 tests, no network, no Cloudflare account
npm run build

npm run dev -w @notes/plugin   # esbuild watch → packages/plugin/main.js
npm run dev -w @notes/worker   # wrangler dev

# Render one file locally, no infrastructure (M0):
MERMAID=skip node packages/build/dist/preview.js published/<id>.md out.html

# Reconcile against real KV without writing anything:
DRY_RUN=1 PUBLIC_BASE_URL=… CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
  KV_NAMESPACE_ID=… node packages/build/dist/cli.js
```

The M4 verification tasks (§12) are covered in *Setup* step 7: the first is a permanent
workflow step rather than a one-time check, the second is a `curl` against the live site.

## Notes on the design

Everything below is a decision the design did not make, or a place the implementation found
something. Recorded here rather than buried, on the same principle as §13 and §15.

### One finding that qualifies §6.1

**`fetch-depth: 0` with `filter: blob:none` gives CI the full tree of the vault, across all
history.** Partial clone omits *blob* contents; it fetches commits and trees. So the runner
can enumerate every path and filename in the repository — `Notes/Clients/Acme/Q4 layoffs.md`
— even though it can read no note's contents and the working tree holds only `published/`.

§6.1 lists "Folder names leaked" as mitigated by "staging is flat and share_id-named". That
is true of the *staged corpus*, and the row reads as though the vault's own structure is
therefore covered. It is not, and the design's own §5.2 change (depth 1 → 0) is what widened
it, for good reason.

The implementation follows the design as written, because the alternatives are worse:
`filter: tree:0` would omit trees but relies on lazy fetch, which `persist-credentials: false`
deliberately makes impossible; dropping to depth 1 breaks deletion corroboration in exactly
the way §5.2 describes. Filenames are a real disclosure but a much smaller one than contents,
and the two-repo fallback in §6.3 closes it completely if it matters. Worth an explicit row in
§6.1 either way.

### Decisions the design left open

| Decision | Why |
|---|---|
| **KaTeX renders to MathML, not HTML.** | HTML mode needs `katex.css` and six woff2 files. The page is permitted **zero** external requests (§7.2, §7.3), and inlining the CSS without the fonts renders math in a fallback face that looks broken. Browsers render MathML natively with no CSS at all. |
| **`rehype-slug` added to the render pipeline.** | §8 promises `[[Note#Heading]]` becomes "an anchor link if published", which needs heading ids. The §5.4 pipeline sketch does not list them. The plugin slugs fragments with the same `github-slugger` that `rehype-slug` uses, so the two agree. |
| **Block references materialise an anchor span.** | §8 says `[[Note^blockid]]` is "resolved to the block if published" without saying how. Staging turns a trailing `^blockid` into `<span id="b-blockid"></span>` — otherwise the marker would publish as literal text — and fragments point at the same id. |
| **DOM-clobbering protection is off in the sanitizer.** | `hast-util-sanitize` prefixes every `id` with `user-content-`, which breaks mermaid's `marker-end="url(#arrowhead12)"` self-references. The pages ship zero JavaScript and their CSP has no `script-src`, so there is no script to clobber. This is safe *because* of §2.3 and §7.3 and would stop being safe the moment a page shipped script; it is commented as such at the definition. |
| **`contentHash` uses a separator.** | §4.2 writes the formula as `sha256(stagedMarkdown + renderConfigVersion)`. Taken literally, markdown ending in `1` at version 1 collides with the same markdown at version 11. Nothing outside this repo depends on the byte-level formula. |
| **`updated` is the staged timestamp, not build time.** | Makes the whole KV record a pure function of the staged file, so a rebuild — a `renderConfigVersion` bump, a rollback, a re-run after a crash — does not change what the page says about when the content last changed. |
| **Every asset is converted on every build.** | The staged→published hash mapping changes at conversion (§4.3), so a complete map is the only way to describe the full live set in the manifest without reading KV values. Uploads are still skipped when the key exists, so the cost is CPU, not quota. If a large corpus makes this slow, the place to cache is a `assetmap` KV key — noted rather than built, since it reintroduces a memory. |
| **Mermaid is an optional dependency and fails closed.** | It needs a browser. A vault with no diagrams should not pay for a Chromium download, so the workflow installs it only when `published/` actually contains a fence. If a fence exists and the renderer does not, the build **fails** rather than publishing a diagram as unexplained code. `MERMAID=skip` downgrades that deliberately and says so in the summary. |
| **`dataviewjs` is a hard error.** | Materializing it means executing arbitrary JavaScript and trusting its DOM — the fidelity-for-reproducibility trade §9 already declined. Publishing the source instead would leak code and render as nonsense. |
| **The plugin locates comments with an AST but edits by byte offset.** | §3.7 step 5 requires AST-level handling, and it is right about why. But round-tripping markdown through mdast normalises emphasis markers, list bullets and table padding, which would churn every staged file and defeat the hash-skipping that keeps KV writes cheap (§5.6). So the parser locates; a splice edits; every byte not deliberately changed survives. The §11.2 verifier uses its own independent scanner, so a bug in the stripper cannot hide inside the check meant to catch it. |
| **The pipeline is checked out separately from the vault.** | §5.2's sparse checkout gives CI `published/` and nothing else — including none of the build code. The workflow therefore checks this repository into `.pipeline/`, also with `persist-credentials: false` (the default token is scoped to the *vault* repo, so persisting it anywhere on the runner would undo the boundary). Vendoring the pipeline into the vault repo and adding its directory to `sparse-checkout` works equally well. |
| **`HEAD /n/:id` reports `indexable: false` unconditionally.** | It answers from KV key metadata via a one-key `list` and never reads the document, which is the point of the no-token fallback (§3.5). `indexable` is only in the value. A HEAD is never what a crawler indexes, and guessing permissive would be the wrong error. |
| **`source_hash` ignores trailing whitespace and line endings.** | An editor adding or removing a final newline must not mark a note Stale. `source_hash` answers "would this publish differently?", and that answer is no. |
| **R2 uses Cloudflare's REST object API.** | Keeps the credential as the single scoped API token from §10 rather than adding an R2 access key pair. Everything is behind `R2Client`; nothing else in the pipeline knows how bytes reach the bucket. |

### Two small departures worth knowing

- **A staged file's `share_id` must match its filename.** §5.3 fails on duplicate ids; this
  adds a mismatch check, because the panel reads the filename and the reconciler reads the
  metadata, and a mismatch means they disagree about which page a file controls.
- **A hex hash that looks like scientific notation.** YAML parses `source_hash: 3e91` as a
  number. The serializer quotes such values correctly, so this only bites a hand-edited file
  — but the error now says why rather than claiming the field is missing.

### Where §15's objections landed

§15.1 is right that the credential inversion's value is out-of-band verifiability rather than
containment, and the implementation leans on that: the review modal renders from a real
`git diff --cached`, not from a plugin-computed preview, precisely so a buggy plugin cannot
lie to you in its own UI.

§15.2 is also right that the plugin is the least-examined zone. Two things were done about it
rather than none: the manifest token is described in the settings UI as plaintext in
`data.json` that syncs with the vault, and the plugin holds no git credential at all, with
`isomorphic-git` declined for exactly that reason. Neither addresses a hostile plugin sharing
the same vault, which remains unmitigable within Obsidian's security model.

§15.4's "nine milestones is a lot of runway" is worth acting on: M0–M4 is the real minimum,
and `notes-preview` plus `DRY_RUN=1` exist so the first four are usable on their own.
