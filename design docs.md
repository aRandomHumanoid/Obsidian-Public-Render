# Note Publishing Pipeline — Design Document

Publishing individual notes from an existing private Obsidian vault repo to public,
unguessable, downloadable URLs, managed from a GUI inside Obsidian.

Status: draft · Version: 1.3

> **Changes from v1.2.** Two checkout fixes found while specifying the M4 tests.
> `fetch-depth` moves from `1` to `0` — deletion corroboration (§5.6) compares against the
> previous commit, which a shallow clone does not have, so every build would have refused
> every deletion while looking like a reconciliation bug. Added
> **`persist-credentials: false`**: partial clone lazily fetches missing blobs rather than
> refusing them, so a persisted token would have let any later step read unpublished notes
> and reduced sparse checkout to presentation (§5.2, §6.3). The M4 verification tasks now
> specify commands and pass conditions rather than intentions (§12).
>
> **Changes from v1.1.** `*.workers.dev` is now a **permanent** decision rather than a
> starting point, recorded in §13 with what it forecloses. Cloudflare positions workers.dev
> as suited to personal, non-business-critical projects, which describes this accurately, so
> the choice sits inside the stated intent rather than against it. Removed the
> migrate-to-a-custom-domain hedges from §7.3 and §14, and added a second reason assets stay
> behind the worker: `r2.dev` is documented as not intended for production (§7.4).
>
> **Changes from v1.0.** Two related fixes to how publishing is triggered. The workflow is now
> **path-filtered to `published/**`**, so ordinary vault syncs start no build — without this
> a timer-based auto-commit would have run roughly 8,600 builds a month against a 2,000
> minute allowance (§5.1). More seriously, staging moved to a **gitignored
> `.publish-pending/`** directory, because staging directly into the tracked tree meant
> Obsidian Git's auto-commit would sweep up and publish unreviewed notes minutes later,
> defeating the review gate entirely (§3.3). Files now enter `published/` only when the review
> modal opens, which also lets the modal show a real `git diff --cached` (§3.9). Separately,
> the hostname is now **`*.workers.dev`** rather than a custom domain: no registration cost,
> but no zone means no cache purge, so §7.3 relies on a short browser TTL and the Cloudflare
> token drops its Cache Purge scope (§7.4, §10).
>
> **Changes from v0.9.** Adversarial review. One confidentiality hole closed: transclusion now
> composes from the target's **staged output** recursively, so a published note embedding
> another cannot smuggle a private note's content past the drop rule (§3.7). `source_hash`
> now covers body plus allowlisted properties rather than raw bytes, which was marking every
> note Stale the moment it was staged. SVG is sanitized at build time and assets get their own
> sandboxed headers — Excalidraw exports made this a live path, not a hypothetical (§5.4,
> §7.3). EXIF stripping is explicit. The percentage deletion threshold is replaced by
> commit-diff corroboration, which permits the legitimate case it used to block (§5.5). Added
> a **Conflict** status for duplicated `share_id`s, a **Verify all** command, a third critical
> assertion covering code-block round-tripping, and §1's statement of what this optimizes for.
> New §15 records the strongest arguments against the architecture, including one that
> qualifies §2.1.
>
> **Changes from v0.8.** Correctness pass after a full read-through. Three fixes that were
> load-bearing: documents now carry **`stagedHash`** alongside `contentHash`, because the
> plugin cannot compute the latter and the HEAD fallback was therefore unimplementable
> (§3.4, §4.2, §7.1); `doc:` keys are written with **KV key metadata** so the reconciler
> really does work from one `list` call rather than falling back on the manifest, as v0.8
> claimed but did not deliver (§4.2, §5.5); and **Unstage now refuses on a live note**, with
> the guard in the shared implementation so the command palette inherits it (§3.6). Added
> §4.4 on schema versioning — the one rollback case convergence could not handle alone.
> Resolved a self-contradiction about the manifest token's risk (§3.5) and cleaned up stale
> cross-references left by earlier revisions.
>
> **Changes from v0.7.** The build is now a **reconciler** rather than a differ: actual state
> is read from `KV.list` instead of a remembered manifest, which makes any commit a valid
> publish target (§5.5, §5.8). The stored manifest is demoted to a cache. Added a deletion
> safety valve, build serialization, an **Unstaged** status for partial rollbacks, and
> reconciliation tests (§11.4). The never-delete rule for R2 is reframed as a rollback safety
> property rather than a storage-cost one (§13).
>
> **Changes from v0.6.** **Stage for removal** is redefined to key off the staged file rather
> than the source note, so it repairs an **Orphan** with no special case (§3.6). Corrected an
> error in v0.5–v0.6: the common orphan flavour is detectable from disk without the manifest
> token, so the token is a completeness measure rather than a prerequisite (§3.4, §3.5). The
> token's risk is also restated — it returns every published `share_id` at once, making it
> the index of your unlisted URLs rather than harmless metadata (§6.1).
>
> **Changes from v0.5.** Main-area placement confirmed as the panel default. Menu and command
> labels adopt **stage** vocabulary — "Stage for publishing" rather than "Publish note" —
> with publish language reserved for the review modal and everything after it, so the verbs
> mark the point where content actually leaves the machine (§3.10). This split the old
> "Unpublish" into two distinct actions, **Unstage** and **Stage for removal**, which were
> being conflated (§3.6).
>
> **Changes from v0.4.** The GUI is consolidated into one panel that defaults to a main-area
> tab rather than a sidebar, with a master–detail layout that degrades cleanly when narrow
> (§3.4). Added optional file and editor context menu integration, off by default, with
> state-dependent items (§3.10). Folder-level bulk publish is declined (§13). Context-menu
> "Publish" stages rather than publishes, so the notice copy and an optional
> open-review-immediately setting carry that truth instead of the label.
>
> **Changes from v0.3.** The publish view now owns the git step (§3.9). Push is a review
> modal rather than a one-click action, so the `git diff published/` gate survives the
> convenience. Reading local git state also splits the old Pending status into **Staged**
> (not pushed) and **Building** (pushed, awaiting CI), which is the distinction the view
> existed to make in the first place. A stored PAT implementation was considered and
> declined; the plugin holds no git credential (§13).
>
> **Changes from v0.2.** Sixteen open decisions resolved. Structurally: `index.json` is gone
> — staged files are now self-describing, which removes the multi-device conflict entirely
> (§3.3). `contentHash` now includes a render-config version so renderer changes actually
> take effect (§4.2). Cache TTL raised with explicit purge-on-publish, which makes
> unpublishing faster *and* caching better (§7.3). New: a testing section built around a
> fixture corpus (§11), and a record of what was deliberately deferred or declined (§13).
>
> **Changes from v0.1.** Dataview is materialized, a custom domain is used, and the index of
> published notes lives in the plugin GUI. The first made the plugin mandatory, which moved
> all vault-aware work out of CI and introduced the staged publishing directory.

---

## 1. Goals and non-goals

### Goals

- Publish **individual notes** from a vault already backed up to a private GitHub repo.
- Each note gets a **stable, unguessable public URL** that survives renames and retitles.
- Readers can **view** the note and **download** its markdown source.
- **Unpublishing works**, via the same stage-then-push path as publishing.
- **Any commit is a valid publish target.** Roll the repo back and the live site converges to
  what that commit describes, without manual repair (§5.9).
- Manage the published set from a **GUI inside Obsidian** — what is live, what is pending,
  what has drifted, and what link each note points to.
- **No third party** holds note content. All infrastructure is owned by the vault owner.
- It is **structurally impossible** for the public-facing service to reach an unpublished note.

### Non-goals

- Whole-vault site, graph view, backlinks, or public full-text search.
- Editing, comments, or collaboration. Published pages are read-only artifacts.
- Real-time publishing. Git-push-to-live latency of a few minutes is acceptable.
- Theme-identical rendering. Pages will look clean and readable, not like Obsidian.
- Access control beyond link secrecy. See §6.2 for what this does and does not buy.
- Mobile support in v1 (§13).

### What this optimizes for

Stated explicitly, because a design with no priority ordering has no principled way to
decline the next reasonable-sounding feature — and this one has already accreted nine
milestones.

In order:

1. **Nothing private is ever published.** Every other property is negotiable against this one.
2. **You can see exactly what is public, from inside Obsidian.**
3. **Any state is recoverable** — rollback, rebuild, or repair, without manual reconstruction.
4. **The infrastructure is boring** — no server to maintain, no process to restart.
5. **Publishing is fast.**

Speed is last on purpose. Every latency cost in this design — the git round-trip, the review
modal, staging before push — was accepted in service of the first three, and a future
proposal that improves speed at their expense should be rejected on that basis rather than
debated afresh. §15 records the strongest argument that this ordering is wrong.

### The constraint that drives the design

The vault repo contains **the entire vault**, not just published notes. Any component
holding credentials for that repo can read everything ever written. The architecture is
shaped primarily around denying the public-facing component those credentials — and, since
v0.2, around denying them to the build as well.

---

## 2. Architecture

```
┌───────────────────────────────────────────────┐
│  Obsidian + publisher plugin                  │
│                                               │
│  GUI: which notes are live, at which URLs     │
│  Stages self-describing markdown → published/ │
└───────────────────┬───────────────────────────┘
                    │ Review and push (§3.9), or existing git sync
                    ▼
┌───────────────────────────────────────────────┐
│  vault repo (private)                         │
│    Notes/…            ← never read by CI      │
│    published/         ← the only thing CI sees│
└───────────────────┬───────────────────────────┘
                    │ GitHub Actions, on push to main
                    │ sparse checkout: published/ only
                    ▼
┌───────────────────────────────────────────────┐
│  build job                                    │
│  discover → render → reconcile → write        │
└──────────┬────────────────────────┬───────────┘
           │ KV list + writes       │ R2 puts
           ▼                        ▼
   ┌───────────────┐        ┌────────────────┐
   │  Workers KV   │        │   R2 bucket    │
   │  rendered docs│        │   attachments  │
   └───────┬───────┘        └────────┬───────┘
           │                         │
           └───────────┬─────────────┘
                       ▼
             ┌──────────────────────┐
             │  Cloudflare Worker   │  NO GitHub credentials
             │  <sub>.workers.dev   │  (no custom domain)
             └──────────────────────┘
                       │
              ┌────────┴────────┐
              ▼                 ▼
           readers      plugin (GET /_manifest, authenticated)
```

### 2.1 Push, not pull — the core decision

The obvious design is a worker that reads the vault repo on demand and serves notes marked
public. That design is rejected. It requires giving an internet-facing service a token for
the entire vault, which makes every bug in URL parsing, path resolution, or allowlist logic
a full-vault disclosure.

Instead the pipeline **pushes** finished artifacts outward. The worker holds no GitHub
credentials and has no network path to the repo. Its bindings — one KV namespace, one R2
bucket — are the complete universe of data it can reach, and that universe contains only
things already marked for publication.

**Invariant:** *the worker can only serve bytes that a build already decided to publish.*
Every change to the worker or its bindings should be reviewed against this sentence.

§15.1 qualifies this section: the credential inversion's real value is out-of-band
verifiability, not limiting what a compromised plugin can read. Read both.

### 2.2 Three trust zones

| Zone | Sees | Trusted with |
|---|---|---|
| **Obsidian + plugin** | Entire vault | Everything. Runs on the author's machine. |
| **CI build** | `published/` only, via sparse checkout | Publish-ready markdown that has already been reviewed |
| **Worker** | KV + R2 | Only rendered, published output |

Each boundary is crossed by an explicit, reviewable artifact: the plugin writes
`published/`, git carries it, CI writes KV and R2. There is no path backwards through any
boundary. §6.3 covers how strong the middle boundary actually is, which is a question with
a pending empirical answer.

### 2.3 Render at build time, not at the edge

Markdown → HTML rendering happens in CI, not in the worker.

- No worker bundle size pressure.
- Full Node toolchain: unified/remark/rehype, shiki, KaTeX, sharp, mermaid.
- Edge responses are a single KV read.
- Pages ship with **zero client-side JavaScript**, making XSS essentially impossible and
  allowing a maximally strict CSP (§7.3).

Note this is distinct from rendering *inside Obsidian*, which would mean capturing
Obsidian's DOM plus a megabyte of theme CSS. The plugin emits clean, portable **markdown**;
CI turns that into HTML.

---

## 3. The Obsidian plugin

### 3.1 Why it is mandatory

Only Obsidian can execute a Dataview query, and only Obsidian can authoritatively resolve
`[[wikilinks]]` — CI would have to reimplement Obsidian's nearest-path resolution rule and
would get it subtly wrong on ambiguous basenames. Since a plugin-produced artifact is
required regardless, the plugin produces a complete one.

### 3.2 Division of labour

| Task | Plugin | CI |
|---|---|---|
| Dataview materialization | ✓ | |
| Wikilink resolution | ✓ | |
| Transclusion inlining | ✓ | |
| Attachment collection | ✓ | |
| `%%comment%%` stripping | ✓ | ✓ (again) |
| Frontmatter allowlisting | ✓ | ✓ (re-verified) |
| Markdown → HTML | | ✓ |
| Syntax highlighting, math, mermaid | | ✓ |
| Image optimization and URL rewriting | | ✓ |
| KV/R2 publishing and reconciling | | ✓ |

The rule: **anything requiring vault knowledge happens in the plugin; everything else
happens in CI.** Comment stripping and frontmatter allowlisting are duplicated deliberately,
because they are the two failures with the worst consequences (§11.2).

### 3.3 Staging: pending, then published

Staging happens in two places, and the split exists for one reason: **auto-commit tooling
must not be able to publish anything.**

```
.publish-pending/          ← gitignored. Plugin writes here. Never committed.
  7k2m9x4qp8vw3n6r.md
  _assets/…

published/                 ← tracked. Only the review modal writes here (§3.9).
  7k2m9x4qp8vw3n6r.md
  9v3n6r7k2m9x4qp8.md
  _assets/
    a1b2c3d4e5f6a7b8.png   named by hash of the source bytes
```

**Why not stage directly into `published/`.** The vault repo is a backup repo, and Obsidian
Git commits on a timer. If staged files landed in the tracked tree, auto-commit would sweep
them up within minutes and push them — the workflow's path filter (§5.1) would match, the
build would run, and the note would go live **without the review modal ever opening**. The
gate that justifies this entire architecture would be defeated by the sync tooling the design
assumes you already have.

A gitignored pending directory makes that impossible rather than unlikely. Nothing enters the
tracked tree except through §3.9, so no configuration of any other plugin can publish on your
behalf.

The leading dot also keeps Obsidian from indexing pending files as notes.

**What lands in `published/` is unchanged:** flat, share_id-named, no vault folder structure,
so folder names — often more revealing than note content — never reach CI or the public.

**There is no manifest file.** Each staged file carries its own metadata:

```yaml
---
share_id: 7k2m9x4qp8vw3n6r
title: Widget design
source_hash: 3e91…               # hash of body + allowlisted properties, NOT raw file bytes
staged: 2026-08-02T14:03:11Z
indexable: false
download: true
---
```

Everything else is derived: `stagedHash` from the file bytes, the asset list by scanning
image references in the body, the published set from the directory listing. CI strips this
block entirely before storing the download copy.
**`source_hash` deliberately excludes raw file bytes.** Staging writes `publish: true` and
possibly `share_id` back to the source note *after* computing the hash, so hashing the whole
file would mark every note Stale the instant it was first staged. Hashing the body plus only
the allowlisted properties also stops unrelated tag edits, `updated` timestamps, and
Obsidian's own frontmatter rewrites from producing false Stale — none of which change what
gets published.

This is what removed the multi-device conflict. Two machines staging different notes now
touch disjoint files, so git has nothing to conflict over. Two machines staging the *same*
note produce a normal single-file conflict with readable content, which is the best
available outcome.

**The safety property that makes the duplication worth it:** at review time the plugin
materializes pending files into `published/` and `git add`s them, so the modal shows a real
`git diff --cached` — the exact bytes about to become public, not a plugin-rendered
approximation. Cancelling rolls the staging area back and returns the files to pending
(§3.9).

Asset cleanup: at stage time the plugin deletes anything in `.publish-pending/_assets/` no
longer referenced by a pending file. R2 objects are never deleted (§13).

### 3.4 The publish panel

Everything the plugin surfaces lives in one place: a single registered view type,
`publish-manager`, which is the index, the detail inspector, and the action surface.

**Placement is the workspace's decision, not the plugin's.** Open it with
`workspace.getLeaf('tab')` so it defaults to a main-area tab — the content is dense enough
that a 300px sidebar makes it unusable — and let the user drag it to a sidebar or pop it out
into its own window if they prefer. Obsidian handles detachable leaves for free; hard-coding
placement only takes options away.

Wide layout, master–detail:

```
┌────────────────────────────────────────────────────────────────────┐
│ Publish manager                         ⟳ 2 min ago    ↑ Push (3)  │
├─────────────────────────┬──────────────────────────────────────────┤
│ 🔍 filter               │  Widget design                           │
│                         │  notes.workers.dev/n/7k2m9x4qp8vw3n6r  ⧉ │
│ STAGED (2)              │  ──────────────────────────────────────  │
│  ○ Widget design     ◀  │  Status   Staged · not pushed            │
│  ○ Q3 retrospective     │  Source   Projects/Widget.md          ↗  │
│                         │  Staged   2 minutes ago                  │
│ BUILDING (1)            │  Assets   3 files · 1.2 MB               │
│  ◔ Meeting notes        │                                          │
│                         │  ⚠ 2 links dropped during staging        │
│ STALE (1)               │     [[Internal roadmap]]                 │
│  ◐ Reading list         │     [[Private spec]]                     │
│                         │                                          │
│ LIVE (12)               │  ▸ Staged markdown diff                  │
│  ● Bookshelf            │                                          │
│  ● Recipes              │  [Re-stage]  [Unstage]  [Open note]      │
│  …                      │                                          │
│                         │                                          │
│ ISSUES (1)              │                                          │
│  ▲ Roadmap              │                                          │
└─────────────────────────┴──────────────────────────────────────────┘
```

Below a width threshold the detail pane collapses and selecting a row pushes it in with a
back control, so the same view degrades cleanly into a sidebar without a second
implementation.

Status derivation:

| Status | Condition | Meaning |
|---|---|---|
| **Live** | local `stagedHash` == remote `stagedHash` | Published and current |
| **Staged** | pending file exists, not yet materialized and pushed | Waiting on you — press Push |
| **Building** | pushed, remote hash still absent or different | Waiting on CI, or the build failed |
| **Stale** | source hash (body + allowlisted properties) != staged `source_hash` | Note edited since it was staged |
| **Unstaged** | `publish: true` with a `share_id`, but neither a pending nor a published file | Re-stage. Arises from a partial rollback (§5.9), a sync from another machine, or hand-edited frontmatter. |
| **Removing** | staged file deleted, still live in KV | Will disappear on next build |
| **Orphan** | live, but no source note carries that `share_id` | Re-attach it, or stage it for removal |
| **Conflict** | two or more source notes carry the same `share_id` | Almost always a duplicated note. Clear the ID from the copy. |
| **Issue** | validation failure | Blocked; see the detail pane |

All are derivable from three hashes — source, staged, remote — plus a frontmatter scan and,
for the Staged/Building split, local git state (§3.9). No local state file is required, so
the panel is correct immediately after a fresh install or a sync from another machine.

**Pending work is local by design.** Because `.publish-pending/` is gitignored, staged-but-
unpushed work does not sync. Stage on one machine and the other sees the note as **Unstaged**
until you re-stage or push. That is the correct trade: unreviewed content should not travel,
and it removes the last multi-device conflict surface entirely, since the only thing two
machines can now collide on is a note both have actually published.

**Conflict is detected on scan, not on stage.** "Make a copy" in the file explorer is one
click and copies frontmatter with it, producing two notes claiming one `share_id`. Validating
uniqueness only when a note is staged would let the duplicate sit undetected until someone
stages it — possibly months later, possibly overwriting the wrong page. The frontmatter scan
that drives every other status already sees both notes, so the check is free there.

The plugin never auto-resolves a Conflict. It cannot know which note is the original, and
guessing wrong silently republishes the wrong content at a URL someone has already shared.

**The plugin compares `stagedHash`, never `contentHash`.** `contentHash` folds in
`renderConfigVersion` (§4.2), a build-side constant the plugin has no business knowing;
reconstructing it would mean duplicating the hash formula in two codebases that will
eventually drift. `stagedHash` is a plain hash of the staged markdown, which the plugin
computes from bytes it already has. Both are published in the manifest and in KV key
metadata, so each side reads the one it can verify.

**Orphans come in two flavours, and only one of them needs the manifest.** A staged file
whose `share_id` appears in no source note is detectable from disk alone — walk `published/`,
scan frontmatter, find the gap. That is the common case, and the dangerous one: CI will keep
republishing that file forever and no note will ever remind you it exists. The rarer flavour
is a `share_id` live in KV with no staged file at all, which requires
`/_manifest` to see; it should not normally persist, since §5.6 reconciliation already deletes
KV keys whose staged file has vanished. If one lingers, KV and the repo have
genuinely diverged.

Causes, roughly by likelihood: the source note was deleted outside the plugin; frontmatter
was stripped by a bulk edit, a linter, or a bad conflict resolution; a partial commit landed
staged files without the note's frontmatter change (§3.9); or the vault was restored from a
backup predating the `share_id`.

Either flavour is repaired by **Stage for removal**, which keys off the staged file rather
than the note and so does not need a note to exist (§3.6). The alternative repair is to
re-attach — put the `share_id` back into a note's frontmatter. The staged file carries the
title, so the original is usually easy to find or rebuild.

Distinguishing Staged from Building is the whole reason this panel exists. "I marked it
published, why is the link 404ing?" almost always resolves to *not pushed yet* or *build
failed*, and neither is visible from the note itself. Before git integration these were one
undifferentiated state and the user had to guess; now the panel answers it, and the answer
comes with the right next action attached.

**Degraded-link warnings** appear in the detail pane as the actual list of dropped links,
not just a count (§3.7). This matters more than the dropping rule itself — the rule is a
default, the list is how you notice when the default was wrong for a particular note.

Detail-pane actions are state-dependent and use the same labels as the context menu (§3.10).
The mockup shows a Staged note, so it offers **Unstage**; a Live note would offer **Stage
for removal** instead, because those are different operations on different things.

### 3.5 Reading remote state

The plugin needs to know what is actually live. One authenticated route on the worker:

```
GET /_manifest
Authorization: Bearer <MANIFEST_TOKEN>
```

Returns the KV `manifest` value. Constant-time token comparison. On a bad or missing token,
return the **same 404** as any unknown route rather than a 401, so the endpoint's existence
is not confirmable.

The token is a Worker secret and a plugin setting. It is read-only, cannot write or delete,
and cannot reach the vault — which is why the plugin talks to the worker rather than to the
GitHub or Cloudflare APIs, either of which would require a far more dangerous credential in
`data.json`.

That said, it is not trivial. The manifest is the complete list of your published
`share_id`s, which is to say **every unlisted URL you have, in a single response**. The
entire privacy model of these links is that they are unguessable, and this is the master
index. Treat it accordingly: it is much safer than a PAT and considerably more sensitive
than "read-only metadata" implies. That is why the endpoint 404s rather than 401s on a bad
token, and why the comparison is constant time.

**The token is optional.** With it unset, the plugin falls back to issuing a `HEAD` per
known share_id and reading **`X-Staged-Hash`** from the response — not `X-Content-Hash`,
which the plugin cannot verify (§3.4). That covers every status except one: Staged and
Building come from local git state, so they survive the fallback intact, but the rarer
flavour of **Orphan** — a `share_id` live in KV with nothing local referencing it — needs the
manifest. The common flavour, a staged file no note claims, is found from disk with no token
at all (§3.4).

The token is therefore a completeness measure rather than a prerequisite.

Refresh on view open, on explicit command, and optionally on a slow interval.

### 3.6 Commands

| Command | Behaviour |
|---|---|
| Stage current note for publishing | Generate `share_id` if absent → validate → stage → set `publish: true` → copy link |
| Re-stage current note | Rebuild the staged copy from current source |
| Stage for removal | Delete the staged file and any assets it uniquely references. If a source note carries that `share_id`, also set `publish: false`. Takes effect on next push. |
| Unstage current note | Discard staged work and revert the frontmatter the plugin added. **Refuses if the note is live** — see below. |
| Copy public link | From `share_id` + configured base URL |
| Open published page | External browser |
| Re-stage all stale | Bulk fix for the Stale group |
| Verify all | Fetch every live URL and compare against local state — see below |
| **Review and push** | Open the review modal, then commit and push touched paths (§3.9) |
| Open publish manager | Focus the panel, opening it if needed |
| Reveal in publish manager | Open the panel and select the current note |

Every command here is also reachable from the panel and, optionally, the context menu
(§3.10). All three routes call the same underlying functions, and all use the same
stage-versus-publish vocabulary (§3.10).

`publish: false` rather than deleting the property, because it keeps `share_id` in the note
— staging it for publishing again later restores the **same URL**. CI treats `false` and
absent identically.

**Verify all closes a loop nothing else closes.** Every status in §3.4 is derived from hashes
recorded at write time — the plugin's, the build's, the manifest's. Nothing in the system ever
fetches a live page and confirms it matches. A partial write, a manual `wrangler` edit, a
purge that silently failed, or an edge node serving something stale would all report as Live
and correct, because each layer is faithfully reporting what it believes it wrote.

Verify all fetches each live URL, compares `X-Staged-Hash` against the staged file, and
optionally diffs the body. It is thirty lines and the only check in the design that observes
rather than infers. Run it after a bulk operation, after a rollback, or whenever the site
seems out of step with the panel.

**Unstage refuses on a live note, and the guard is behavioural, not visual.** Unstage deletes
the staged file, and §5.6 reconciliation deletes any KV key whose staged file is absent — so
unstaging something that is already published would take the page down, silently, without the
`publish: false` write and without the permanence warning that Stage for removal carries.
That is precisely the confusion the §3.10 vocabulary split exists to prevent, arriving through
a different door.

Hiding the action in the panel is not sufficient, because the command palette offers every
command unconditionally and cannot be state-filtered. The refusal therefore lives in the
shared implementation, not in menu-construction code: the function checks live state, aborts,
and points at Stage for removal. Panel and context menu additionally omit the action where it
does not apply, but that is presentation. Every entry point inherits the guard because there
is only one code path (§3.10).

The same reasoning applies in reverse: **Stage for removal on a note that was never live** is
harmless and behaves as Unstage, so it needs no guard — only the asymmetric case is dangerous.
absence: a `share_id` live in KV with no corresponding file in `published/` gets its key
deleted (§5.6). Frontmatter is never consulted. Deleting the staged file is
therefore both necessary and sufficient, and the `publish: false` write is bookkeeping that
stops the note being re-staged later by a bulk command.

Defining the action this way is what lets it repair an **Orphan** (§3.4), where there is no
source note to write frontmatter to. One command, working from either end, rather than a
separate repair path for a case that is not actually a different problem.

The consequence worth surfacing in the UI: normally the `share_id` survives in the note, so
re-staging later restores the identical URL. An orphan has nothing holding its ID, so removal
is permanent — republishing that content mints a new `share_id` and the old link stays dead.
That is usually the desired outcome for an orphan, but it should be stated in the
confirmation rather than discovered afterwards.

### 3.7 Staging pipeline, per note

1. **Validate** — `share_id` present, and unique across the vault as a whole rather than
   merely unused by other staged notes (§3.4); embed targets resolvable; transclusion depth
   within cap; attachments within caps (warn at 2 MB, hard-fail at 10 MB, both configurable).
2. **Materialize Dataview** — wait for the index-ready signal, then `queryMarkdown()` each
   block and replace the fence with its markdown output (§9).
3. **Resolve links** — `metadataCache.getFirstLinkpathDest()` per wikilink.
   - Published target → `/n/<id>`
   - Unpublished target with an alias that **differs from both the target's filename and its
     title** → keep the alias as plain text
   - Otherwise → remove the link and its text entirely
   - Every removal is recorded and surfaced in the GUI (§3.4)

   The alias condition exists because Obsidian frequently writes aliases identical to the
   target's title, and keeping those would leak exactly what the rule is meant to protect.
4. **Inline transclusions** — `![[Note]]`, `![[Note#Heading]]`. **Inline the target's staged
   output, not its source**, resolving recursively with a cycle guard and a depth cap.

   This ordering is load-bearing. Step 3 has already run over the *host* note, so it never
   sees material that arrives by transclusion. If A transcludes published note B, and B links
   to unpublished note C, inlining B's raw source would carry C's title — or with a nested
   embed, C's content — straight into A's published page without ever passing the drop rule.
   Composing from staged output means B's own staging already handled C.

   After composition, **re-run steps 3 and 5 over the merged result** as a backstop. Cheap,
   and it catches anything a partially-staged or hand-edited target smuggles in.
5. **Strip** — `%%comments%%` first, then frontmatter down to the allowlist. Comment removal
   operates on the parsed AST, never on raw text: a regex mis-pairs delimiters when a fenced
   code block contains a stray `%%`, silently swallowing everything between two unrelated
   markers (§11.2).
6. **Collect attachments** — hash the source bytes, copy to `_assets/<hash>.<ext>`, rewrite
   references.
7. **Self-check** — run the three critical assertions against the output about to be written
   (§11.3). Fail closed.
8. **Write** — `published/<share_id>.md` with its metadata block.

Steps 2–4 are the ones CI cannot do. The rest are there because the plugin already has the
file open.

### 3.8 Settings

- **Base URL** — e.g. `https://notes.<sub>.workers.dev` (§7.4)
- **Manifest token** — optional (§3.5)
- **Property names** — all source-frontmatter keys, configurable to avoid collisions
- **Staging folder** — default `published/`
- **Dataview materialization** — on/off
- **Attachment caps** — warn 2 MB, fail 10 MB
- **Auto-restage on save** — default **off**
- **Refresh interval**
- **Git mode** — auto-detect / Obsidian Git / system git / disabled (§3.9)
- **Commit message template** — default `publish: {summary}`
- **File context menu** — default **off** (§3.10)
- **Editor context menu** — default **off**
- **Open review after staging from the context menu** — default **off**
- **Default panel placement** — main tab / right sidebar / left sidebar

Auto-restage defaults off deliberately. Restaging on every save means publishing
half-finished edits; surfacing them as Stale and requiring one deliberate action is safer.

### 3.9 Git integration

Staged files only become live once they are committed and pushed. Requiring a terminal for
that is the main workflow regression against direct-upload plugins, so the publish panel owns
the git step.

#### The button must not bypass the review

`git diff published/` is the review gate that justifies the entire staging design (§3.3). A
button that commits and pushes on one click silently deletes that property. The action is
therefore a modal, not an immediate effect:

```
┌─────────────────────────────────────────────┐
│ Review changes                              │
│                                             │
│ PUBLISHING (2)                              │
│   Widget design                             │
│     → notes.workers.dev/n/7k2m9x4qp8vw3n6r  │
│     ⚠ 2 links to unpublished notes dropped  │
│   Q3 retrospective                          │
│     → notes.workers.dev/n/9v3n6r7k2m9x4qp8  │
│                                             │
│ UPDATING (1)                                │
│   Meeting notes 2026-07        [show diff]  │
│                                             │
│ UNPUBLISHING (1)                            │
│   Old draft · link dies in ~3 min           │
│                                             │
│ Also committing 3 source notes (frontmatter)│
│                                             │
│            [Cancel]   [Commit and push]     │
└─────────────────────────────────────────────┘
```

This is strictly better than the terminal equivalent. It shows titles and destination URLs
rather than `share_id` filenames, and it surfaces the staging warnings from §3.7 next to the
diff rather than in a log the user has already scrolled past.

The modal is also where the vocabulary switches from *stage* to *publish* (§3.10). Every
label up to this point describes local work; the headings here describe what the push will
make true. Confirming this dialog is the moment content leaves the machine, and the wording
should make that feel like a threshold rather than a formality.

#### What gets committed, and when it enters the tree

Nothing reaches `published/` until this modal opens. On open, the plugin materializes pending
files into `published/`, stages them with `git add`, and renders the modal from the real
`git diff --cached`. Confirming commits and pushes. Cancelling runs `git restore --staged`,
moves the files back to `.publish-pending/`, and leaves the tree as it was.

The commit contains exactly the paths the plugin touched: materialized staged files,
`_assets/` additions and removals, and the source notes whose frontmatter changed (`publish`,
`share_id`, `publish_ack`).

Committing staged files *without* their source notes would be a correctness bug rather than
an optimization. Another device syncing the repo would find a staged file whose `share_id`
appears in no source note, and would correctly classify it as an **Orphan** (§3.4).

There is a narrow window — modal open, files materialized, not yet committed — in which an
auto-commit could capture unreviewed content. It is seconds long, and the plugin closes it by
cleaning up any materialized-but-uncommitted files on load. Worth knowing about rather than
pretending away.

#### Implementation, and the credential rule

Three approaches were considered. Two are acceptable:

| Approach | Verdict |
|---|---|
| Delegate to Obsidian Git via `executeCommandById` | **Preferred when installed.** Auth is already configured and no new credential is introduced. Cost: it commits the whole vault rather than touched paths, and the command IDs are an undocumented cross-plugin dependency. |
| Shell out to system `git` | **Fallback.** Uses the machine's existing SSH agent or credential helper, and can be scoped to exact paths. Desktop-only, which is already the case (§13). |
| `isomorphic-git` with a stored PAT | **Declined.** Requires a write-scoped GitHub token in `data.json` — precisely the credential this design exists to avoid, and a worse instance of it, since the token would have write access to the entire vault repo. |

**Rule: the plugin never stores a git credential.** This is a security requirement, not a
preference — it is what preserves the credential inversion described in §6.1. If neither
acceptable mode is available, the button is disabled with the reason shown and the workflow
degrades to the terminal, which still works.

When shelling out, arguments are passed as an argv array via `execFile`, never interpolated
into a shell string. Note titles reach the commit message, and a title containing a
semicolon must not become a command injection.

#### After the push

Reading local git state is what lets the plugin separate **Staged** from **Building**
(§3.4): comparing the local ref against upstream tells it whether a staged file has actually
left the machine. That distinction was unavailable before this feature and is the single
most useful thing the panel reports.

Following a push, poll `/_manifest` on a short interval for a few minutes before returning to
the normal cadence. Derive the Actions URL from `git remote get-url origin` and link it from
the Building group — no credential required, and it is exactly where to look when a build
fails.

#### Failure handling

| Condition | Behaviour |
|---|---|
| Push rejected, non-fast-forward | Report it and offer pull-and-retry. Never force. |
| Conflict inside `published/` | Surface the conflicting files; never auto-resolve |
| Not a repo, no remote, detached HEAD | Button disabled, reason shown |
| Auth failure | Point at credential setup. Never offer to store a token. |
| Offline | Fail clearly; staged files are already safe on disk |

Repository hooks run as normal. A slow or interactive `pre-commit` hook will block the modal,
so surface hook output rather than appearing to hang.

### 3.10 Entry points

The panel is where the work happens, but reaching it should never be the friction. Five ways
in, all of which converge on the same code path:

| Entry point | Offers |
|---|---|
| Ribbon icon | Open the panel |
| Status bar | `● 12 live · 1 staged`, click to open the panel |
| Command palette | The full command set (§3.6) |
| File context menu | Per-note actions, optional (below) |
| Editor context menu | The same actions for the note being edited |

#### The file context menu

Right-clicking a note in the file explorer, or using its ⋮ tab menu, adds items via the
`file-menu` workspace event. **Off by default and enabled in settings** — context menus are
crowded, and a plugin that quietly colonises them is a bad citizen.

Items are state-dependent, because offering a publish action on something already published
is how people accidentally create duplicates:

| Note state | Menu items |
|---|---|
| Not published | **Stage for publishing** |
| Staged, not pushed | Copy public link · **Unstage** · Reveal in publish manager |
| Unstaged (`publish: true`, no staged file) | **Re-stage** · Unstage · Reveal in publish manager |
| Live | Copy public link · Open published page · Re-stage · **Stage for removal** |
| Stale | **Re-stage** · Copy public link · Stage for removal |

Orphans are absent from this table by definition — there is no note to right-click. They are
reachable only from the panel (§3.4), which is one more reason the panel is the primary
surface and the context menu a shortcut to it.

Multi-select is supported through the `files-menu` event. Each file runs the same per-note
validation from §3.7, and the result is reported as one summary rather than a burst of
notices. Folders are deliberately excluded (§13).

#### The vocabulary marks the boundary

Menu and command labels use **stage** language, because staging is what these actions
actually do — nothing reaches the internet until push. The review modal and the build then
use **publish** language, because at that point it is true.

This is not pedantry for its own sake; the split does three things a friendlier label could
not:

1. **It teaches the architecture through use.** Someone who never reads this document still
   learns that publishing has two steps, because the verbs change at the boundary.
2. **It removes the need for compensating notice copy.** With an honest label, the success
   notice can simply read *"Staged. 3 changes waiting."* rather than working to correct an
   impression the label just created.
3. **It exposes a distinction the old wording hid.** *Unstage* and *Stage for removal* are
   different operations: the first discards local work on something that was never live, the
   second stages a deletion of something that is currently public and will 404 after the next
   build. Both were "Unpublish" before, and conflating them is how someone discards a staged
   draft believing they took a live page down — or worse, the reverse.

The cost is that "Stage for publishing" is not the phrase anyone arrives expecting. That is
acceptable: it is unfamiliar for about one use, whereas a misleading label stays misleading
indefinitely.

The setting **Open review after staging from the context menu** (default off) closes the gap
for anyone who wants immediacy — right-click, then confirm, and it is on its way. Two clicks
with the gate intact. That option exists specifically so there is a supported path to fast
publishing that does not require weakening the review gate later.

#### Invariants that hold at every entry point

- **Never auto-publish.** Every route to `publish: true` is an explicit user action.
- **Never auto-push.** The review modal is the point (§3.9).
- **One code path.** Context menu, palette, and panel all call the same staging function, so
  validation and warnings cannot diverge between them.

---

## 4. Data contracts

### 4.1 Source frontmatter

The vault is the source of truth. The plugin manages these; hand-editing is supported.

```yaml
---
publish: true                    # false or absent = not published
share_id: 7k2m9x4qp8vw3n6r       # required when publish: true
title: Optional display override # defaults to H1, then filename
publish_index: false             # allow search engines. default false
publish_download: true           # offer .md download. default true
publish_ack: 4c8e…               # plugin-managed. see §9
---
```

**Everything not on this list is stripped from published output.** Allowlist, not denylist —
a denylist leaks the first personal property you forget to add to it. Note the allowlist
governs what is *published*, not what may exist in the source; `publish_ack` is
plugin-managed and never leaves the vault.

`share_id` is 16 characters of Crockford base32 from `crypto.getRandomValues`, ~80 bits.
Generated once, never changed. Stable across rename, move, and retitle, and derived from
nothing, so it leaks nothing and cannot be enumerated.

Neither CI nor the worker ever writes to the vault. The plugin is the only writer.

### 4.2 KV schema

Namespace `NOTES`.

| Key | Value |
|---|---|
| `doc:<share_id>` | rendered document |
| `manifest` | record of what is currently live |

```jsonc
// doc:<share_id>
{
  "v": 1,
  "title": "Widget design",
  "html": "<article>…</article>",
  "md": "# Widget design\n…",       // metadata block stripped, asset URLs absolute
  "updated": "2026-08-02T14:03:11Z",
  "contentHash": "9f2c…",           // sha256(stagedMarkdown + renderConfigVersion)
  "stagedHash": "7a41…",            // sha256(stagedMarkdown) — what the plugin verifies
  "indexable": false,
  "download": true
}
```

**Every `doc:` key is written with KV metadata**, which `list` returns without reading values:

```jsonc
// key metadata on doc:<share_id>
{ "v": 1, "contentHash": "9f2c…", "stagedHash": "7a41…" }
```

This is what lets §5.6 reconcile from live state in a single `list` call. Without it, getting
hashes would mean either reading every document or consulting the stored manifest — and the
latter would quietly reintroduce the drift dependency the reconciler exists to remove.

```jsonc
// manifest
{
  "v": 1,
  "generated": "2026-08-02T14:03:11Z",
  "renderConfigVersion": 3,
  "docs": {
    "7k2m9x4qp8vw3n6r": {
      "contentHash": "9f2c…",
      "stagedHash": "7a41…",
      "updated": "2026-08-02T14:03:11Z",
      "assets": ["a1b2c3d4e5f6a7b8.webp"]
    }
  }
}
```

**Two hashes, two audiences.** `contentHash` is `sha256(stagedMarkdown + renderConfigVersion)`
and belongs to the build: hashing markdown alone would mean a renderer change — a new shiki
theme, different callout markup, a KaTeX upgrade — silently applied only to notes that happen
to be edited afterwards, leaving the corpus in mixed states indefinitely. `stagedHash` is
`sha256(stagedMarkdown)` and belongs to the plugin, which cannot know `renderConfigVersion`
and should not have to (§3.4). Publishing both means neither side reimplements the other's
formula.

`renderConfigVersion` is a constant in the build, bumped by hand on any material renderer
change.

*Caveat:* bumping it rewrites every document at once. At a few hundred notes that is one
build. Above roughly a thousand it exceeds the daily KV write quota (§10) and needs a
resumable batch carrying progress across runs. Reconciliation makes a half-finished bulk
re-render safe rather than corrupting — the next run simply continues — but the corpus sits
in mixed render states until it completes, which is the thing to plan around.

The manifest is a **cache with no role in the build**. It exists so the plugin can get live
state in one request via `/_manifest` instead of a `HEAD` per note. The build writes it and
never reads it: hashes come from key metadata, deletions from `list` (§5.6). Losing or
corrupting it costs a degraded plugin refresh and nothing else — never a stranded document,
never a wrong build. It contains no vault paths.

### 4.3 R2 schema

Bucket `notes-assets`, keys `assets/<sha256[:16]>.webp`.

Content-addressed on the **converted** bytes, so identical images dedupe and objects are
immutable: `Cache-Control: public, max-age=31536000, immutable`.

Note the hash changes at conversion: a staged asset is `_assets/<hash-of-png>.png` and the
published object is `assets/<hash-of-webp>.webp`. CI maintains the mapping for the run and
rewrites references in both the HTML and the download copy (§5.5).

Objects are never deleted (§13).

### 4.4 Schema versioning

Both records carry `v`. Now that any commit is a valid publish target (§5.9), a rolled-back
build could otherwise write old-schema documents over new-schema ones — the one rollback case
convergence does not handle by itself, because both states are internally consistent.

Three rules:

- **Readers tolerate what they know.** The worker serves any `v` at or below its own. An
  unknown higher `v` returns the standard 404 rather than a partial render, and logs.
- **Writers never downgrade.** If a live key's metadata carries a `v` higher than the build
  writes, the build skips that document and reports it rather than overwriting. A rollback
  across a schema bump therefore degrades to "no change," not to corruption.
- **Deploy the reader first.** Bumping `v` means deploying the worker, confirming it serves
  both versions, then shipping the build that writes the new one. The worker is deployed by
  hand precisely so this ordering is possible (§10).

The `v` in KV key metadata exists for the second rule: the build must be able to check
version before deciding to write, and `list` metadata is the only way to see it without
reading every value.

---

## 5. Build pipeline

### 5.1 Trigger

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'published/**'
```

**The path filter is not an optimization, it is the difference between this working and not.**
The vault repo is a backup repo: Obsidian Git commits on a timer, so ordinary note-taking
produces a push every few minutes. Without the filter, every one of those starts a build.
At a five-minute auto-commit interval that is roughly 8,600 builds a month against a 2,000
minute allowance (§10) — four times over budget, to publish nothing.

With the filter, a normal vault sync touches only `Notes/…` and starts nothing. Only a commit
that changes something under `published/` runs the pipeline, and §3.9 guarantees that only
happens at review time.

### 5.2 Checkout

```yaml
- uses: actions/checkout@<full-sha>
  with:
    sparse-checkout: published/
    fetch-depth: 0
    filter: blob:none
    persist-credentials: false
    lfs: true
```

Sparse checkout is what makes the CI trust zone real. **This must be verified, not assumed**
— see §6.3 and the M4 verification tasks in §12.

**`fetch-depth: 0`, not `1`.** Deletion corroboration in §5.6 compares
`git diff --name-status` against the previous commit, and at depth 1 there is no previous
commit — every build would refuse every deletion, forever, and the symptom would look like a
reconciliation bug rather than a checkout setting. Depth 0 combined with `filter: blob:none`
fetches the complete commit graph without blob contents, which is cheap and exactly the shape
required: `--name-status` compares tree entries and never needs file contents. It also covers
the force-push case, where the push event's `before` SHA can be further back than any fixed
depth would reach.

**`persist-credentials: false` is a security setting, not hygiene.** By default
`actions/checkout` leaves a working token in `.git/config`. Combined with partial clone —
which does not refuse missing blobs but *lazily fetches* them on demand — that token would
let any later step read unpublished notes straight out of the repo, over the network, from a
working tree that appears to contain only `published/`. Sparse checkout would be presentation
rather than a boundary. Dropping the credential after checkout removes the mechanism: lazy
fetch has nothing to authenticate with.

This is the most likely reason §6.3's verification fails on a first attempt, and it is a
one-line fix rather than grounds for the two-repo fallback.

`lfs: true` still matters: staged attachments live in the repo and may be LFS-tracked.
Without it, images publish as pointer text.

### 5.3 Discover

Glob `published/*.md`. Parse each file's metadata block. Derive the asset list per document
by scanning image references.

Fail on: duplicate `share_id` across files, a referenced asset missing from `_assets/`, a
metadata block that does not parse.

No vault scanning, no link resolution, no manifest cross-check — there is no manifest file
to disagree with.

### 5.4 Render

```
remark-parse
  → remark-gfm
  → remark-math
  → [custom] strip %% comments %%      ← defence in depth; plugin already did this
  → [custom] callouts
  → [custom] highlights ==x==
  → remark-rehype
  → rehype-katex
  → rehype-shiki
  → [custom] mermaid → inline SVG
  → rehype-sanitize
  → rehype-stringify
```

Wikilinks, embeds, and transclusions are absent from the input by this point — the plugin
resolved them into ordinary markdown.

### 5.5 Assets

For each raster file in `_assets/`: convert to webp, cap width at 1600px via `sharp`, hash
the result, skip upload if the key already exists in R2. Build a source-hash → published-URL
map for the run.

**Strip metadata explicitly.** `sharp` discards EXIF by default, but the correct posture is
an explicit `.withMetadata(false)` with a comment saying why, because someone will eventually
add `.withMetadata()` to preserve a colour profile and start silently publishing GPS
coordinates from phone photos. A geotagged fixture asserts this (§11.1).

**SVG is an active document format and must be sanitized, not merely passed through.** This
is not hypothetical: Excalidraw's auto-export is SVG, so it is the normal path for diagrams.
An SVG can carry `<script>`, event handlers, `<foreignObject>`, and external references, and
it is served from the same origin as your pages — so the strict CSP in §7.3 does not protect
it, because that governs the *page*, not an asset fetched directly.

Sanitize at build time: parse, drop `<script>`, `<foreignObject>`, every `on*` attribute, and
any `href`/`xlink:href` that is not a local fragment. Assets are then also served with their
own restrictive headers (§7.3) — defence in depth, because the sanitizer is the kind of thing
that acquires a bypass.

Rasterizing SVG instead would remove the class of problem entirely, at the cost of
scalability and text selection in diagrams. Sanitize-plus-headers is the chosen trade; the
residual risk is a sanitizer bypass reaching same-origin script execution, which is the
strongest remaining argument for a separate asset hostname (§7.4).

Rewrite image references using the source-hash map in **both** outputs:

- the rendered HTML
- the `md` download copy, using **absolute URLs** on the worker hostname

Absolute URLs in the download mean the file renders correctly in any markdown viewer rather
than showing broken images. A zip bundle with local assets would be better for true archival
and is deferred (§13).

### 5.6 Reconcile

The build is a **reconciler, not a differ**. Desired state is `published/` at the commit
being built. Actual state is read from KV directly — `list({ prefix: 'doc:' })`, whose
returned key **metadata** carries `contentHash`, `stagedHash` and `v` (§4.2) — rather than
remembered from a stored manifest. Converge one to the other.

```
desired = { share_id → contentHash }   from published/ at this commit
actual  = { share_id → contentHash }   from KV.list metadata, values never read

write  = desired − actual, plus any share_id whose contentHash differs
delete = actual − desired
skip   = everything else, plus anything whose live `v` exceeds this build's (§4.4)
```

Carrying the hashes in key metadata is what makes this a single `list` call. Reading every
document to compare would be prohibitive, and consulting the stored manifest for a hash index
would quietly reintroduce exactly the drift dependency this section exists to remove — the
build would once again be trusting a memory rather than observing reality.

This distinction is what makes the system tolerant of history rewriting (§5.9). A stored
manifest is a *memory* of what a previous build did, and memories drift — they can be
deleted, restored from a different environment, or written by a build that then crashed.
Enumerating KV asks the only question that matters: what is actually being served right now?

Skipping unchanged documents is what keeps the KV write quota comfortable (§10). One `list`
per build is negligible against the daily cap, and the manifest is still written — but as a
cache for the plugin and a hash index, never as the authority for deletion.

**Deletions must be corroborated by the commit.** Before deleting anything, check
`git diff --name-status HEAD~1 HEAD -- published/` and confirm each planned deletion
corresponds to a staged file actually removed in this commit. Deletions with no matching
removal are refused and reported.

This replaces an earlier percentage threshold, which was the wrong instrument. "Refuse to
delete more than 20%" blocks the legitimate case — unpublishing six notes in one sitting —
while forcing a manual override path that people learn to reach for reflexively. Worse, it
approximates intent with a proxy. The commit diff *is* the intent: it distinguishes "you
deliberately deleted six files" from "the checkout is broken and two hundred files are
missing," which is the distinction the threshold was groping toward. No tuning, no override,
and it fails precisely on the case that matters.

Force-pushes and rollbacks compare against the previous tip rather than `HEAD~1`, so the
check uses the push event's `before` SHA where available and falls back to refusing all
deletions when it cannot establish a baseline. Refusing to delete is always the safe default;
the next build with a clean baseline converges.

This rule is why §5.2 checks out at `fetch-depth: 0`. At a shallow depth the baseline commit
is simply absent, the check can never be satisfied, and deletions are refused on every build
— a failure that presents as broken reconciliation rather than as a checkout misconfiguration.

**A missing `published/` directory is an error, not an empty desired state.** Only an
existing-but-empty directory means "nothing should be published."

### 5.7 Publish

Order matters, because a crashed run must be safely resumable:

1. Upload new assets to R2
2. Write changed `doc:` keys
3. Delete removed `doc:` keys
4. **Write the manifest**

If the job dies partway, nothing is corrupted: the next run re-reads live KV state and
recomputes the same convergence. Under the old manifest-as-authority model, ordering was
load-bearing and a crash between deletion and manifest write could strand documents
permanently. Reconciling from ground truth makes every step of this sequence individually
idempotent and the whole thing safely re-runnable — the manifest write is now bookkeeping
rather than a commit point.

**Serialize builds.** Set `concurrency: { group: publish, cancel-in-progress: false }` so a
burst of pushes produces sequential builds rather than racing ones. Each build reconciles to
its own commit, so the last to run wins and is correct by construction. Cancelling in-progress
runs is the wrong choice here — it can interrupt a write sequence, and reconciliation already
makes a slightly-late run harmless.

### 5.8 Report

A job summary with counts and the full URL of anything newly published. The plugin's Building
group should empty on the next refresh; if it does not, this summary is where to look.

Report deletions explicitly, including any the commit-diff check refused. "Refused to delete
14 documents — no matching removals in this commit" is the single most important line this
job can print.

### 5.9 Rollback and history rewriting

The design goal: **any commit is a valid publish target.** Check one out, push it, and the
live site converges to what that commit describes — no manual repair, no stranded documents.

Four properties combine to give this, none of which were added for it specifically:

| Property | Where from | What it buys |
|---|---|---|
| Reconcile from live KV state | §5.6 | The build never depends on a memory of previous builds, so rewritten history cannot confuse it |
| Content-addressed, never-deleted R2 assets | §4.3, §13 | Every asset any historical commit referenced still exists. Rollback cannot break images. |
| Commits are self-consistent snapshots | §3.9 | Staged files and their source frontmatter move together, so no commit is internally contradictory |
| No local state file in the plugin | §3.3 | After a checkout the panel recomputes from disk and is immediately correct |

Walking through what a rollback actually does:

- A note published *after* the target commit is absent from `published/`, present in KV →
  **deleted**.
- A note whose content changed since the target commit reverts → its `contentHash` differs
  → **rewritten** with the older content.
- A note unpublished after the target commit reappears in `published/`, absent from KV →
  **republished at its original URL**, because `share_id` is stored in the file and travels
  with it.
- Assets referenced by the older content are already in R2 → **nothing to restore**.

`renderConfigVersion` rolls back with the code, so a rollback across a renderer change
re-renders the corpus with the older renderer. Correct, but it means such a rollback is a
full rewrite and can approach the KV write cap (§4.2).

**Partial rollbacks are the one hazard.** `git checkout <old> -- published/` reverts staged
files while leaving source frontmatter at HEAD, producing notes marked `publish: true` whose
staged file no longer exists. That is the **Unstaged** status (§3.4), and it is repaired by
re-staging. Prefer whole-tree operations — `git revert`, or checking out a full commit — and
the inconsistency never arises.

Detached HEAD disables the push button (§3.9) but the panel remains fully readable, so
inspecting historical state is safe.

**What rollback does not do:** it removes content from the site going forward, not from the
world. Anyone who already loaded a page or downloaded its markdown still has it, exactly as
in §6.2. Rollback is a state-convergence tool, not a recall.

**The corollary worth stating outright: the repo is a complete backup of published state.**
Delete the KV namespace entirely — fat-fingered `wrangler`, wrong account, Cloudflare
incident — and a single build restores every document at its original URL. R2 assets are
still there because they are never deleted, and `share_id` lives in the staged file rather
than in any remote record. There is no backup procedure to remember, no export to schedule,
and nothing to test beyond the reconciliation suite that already exists (§11.4). This falls
out of reconciling from ground truth rather than being designed in, but it is worth naming so
it does not get traded away later.

---

## 6. Security model

### 6.1 Threat table

| Threat | Mitigation |
|---|---|
| Worker bug exposes an unpublished note | Worker has no vault credentials or network path; unpublished notes do not exist in KV |
| CI dependency exfiltrates the vault | Sparse checkout — pending verification (§6.3) |
| URL enumeration | 80-bit random `share_id` |
| Search engine indexing | `X-Robots-Tag: noindex, nofollow` unless opted in |
| Private frontmatter published | Allowlist in plugin, re-verified in CI, asserted in fixtures |
| Private note title leaked via wikilink | Links dropped unless the alias differs from filename and title; every drop surfaced in the GUI |
| `%%comments%%` published | Stripped in plugin and CI; asserted in fixtures; plugin self-checks before writing |
| Manifest token leaked | Read-only and cannot write or reach the vault — but it returns every published `share_id` at once, so treat it as the index of your unlisted URLs (§3.5) |
| Cloudflare API token leaked | Scoped to one KV namespace and one R2 bucket; worst case is vandalism of public content |
| Accidental publish | Explicit action only; the review modal shows exact changes before push; build summary lists new URLs |
| Bad checkout silently unpublishes the corpus | Deletions must be corroborated by an actual file removal in the commit; a missing `published/` fails the build (§5.6) |
| Folder names leaked | Staging is flat and share_id-named |
| Vault-repo write credential leaked from `data.json` | The plugin never stores one. Git uses the OS credential helper or Obsidian Git (§3.9). |
| Review gate bypassed by convenience tooling | Push is a modal, never one-click; no auto-push setting exists (§3.10) |
| Review gate bypassed by Obsidian Git auto-commit | Staging writes to a gitignored `.publish-pending/`; nothing enters the tracked tree except through the review modal (§3.3) |
| Bulk publish by accident | No folder-level action; multi-select runs full per-note validation and reports one combined summary (§3.10) |
| Context menu misleads about live state | Labels say "stage", not "publish"; publish language appears only at push and after (§3.10) |
| Staged draft discarded believing a live page was taken down | Unstage and Stage for removal are separate labelled actions, offered only in the state where each applies (§3.10) |
| Live page taken down by Unstage without confirmation | Guard lives in the shared implementation, so the command palette inherits it too (§3.6) |
| Rolled-back build downgrades the KV schema | Writers never overwrite a higher `v`; readers deploy first (§4.4) |

### 6.2 What unpublishing actually guarantees

Stage for removal deletes the staged file; the next build deletes the KV key. Expected
propagation:

- git push → Actions start: seconds to ~1 minute
- build runtime: ~1 minute
- KV global propagation: up to ~60 seconds
- browser cache: up to 5 minutes for a reader who already loaded the page (§7.3)

Budget roughly **two to three minutes**, dominated by CI and KV propagation rather than
cache. This is an estimate, not a measurement — M4's second verification task replaces it
with the real figure (§12). This is content removal, not revocation — anyone who already loaded the page still
has it, and the download copy is a file on their disk. Unpublishing is not a security
control.

The note also remains in the vault repo's git history, as does the staged copy. That history
is private, so it is not a disclosure, but "unpublish" does not mean "erase."

### 6.3 Residual risk, and the pending question

With sparse checkout, the runner's working tree contains only `published/`. Whether that is
a *security boundary* or merely a convenience depends on whether git objects for other paths
are fetched at all.

**This must be tested, not assumed.** The M4 verification task runs, after checkout:

```bash
git show HEAD:Notes/SomePrivateNote.md   # must fail
git fetch origin                          # must also fail
ls                                        # only published/
```

Both commands must fail with an authentication or missing-object error. A "path not found"
error is not a pass — it may mean the path is merely absent from the working tree while the
object remains reachable.

**Expect three possible outcomes, not two:**

1. **Passes as configured.** The boundary holds; nothing to do.
2. **Fails, then passes with `persist-credentials: false`.** The most likely result, and the
   reason that setting is already in §5.2. Partial clone lazily fetches missing blobs rather
   than refusing them, so a persisted token turns sparse checkout into presentation. Removing
   the credential removes the mechanism.
3. **Fails even then.** Take the two-repo fallback.

**Fallback if it cannot be made to hold:** a second repository that receives only
`published/`, with the Cloudflare credentials living there and the vault repo pushing to it.
That is a genuine boundary at the cost of another repo and a sync step. The pipeline should be
written so this swap changes only the checkout stage — nothing downstream of §5.3 knows or
cares where `published/` came from.

What remains regardless:

- A compromised dependency can read and exfiltrate everything in `published/` — content
  already on its way to being public.
- It could tamper with rendered output before upload, publishing something you did not write.
- It could exhaust quotas or delete published content.

Mitigations: `npm ci` against a committed lockfile, third-party actions pinned to full commit
SHAs, minimal dependency surface, `permissions: contents: read`, reviewed rather than
auto-merged dependency updates.

The larger trust surface has moved to the plugin, which runs with full vault access on the
author's machine. That is the correct place for it, but it is worth stating plainly rather
than treating the plugin as free.

---

## 7. Worker

### 7.1 Routes

| Route | Behaviour |
|---|---|
| `GET /n/:id` | KV lookup, wrap `html` in the page shell. Emits `X-Staged-Hash`. |
| `HEAD /n/:id` | Headers only, including `X-Staged-Hash` — supports the no-token plugin mode (§3.5) |
| `GET /n/:id.md` | Return `md` with `Content-Disposition: attachment` |
| `GET /a/:key` | Stream from R2 |
| `GET /_manifest` | Authenticated. Returns the manifest. |
| `GET /` | Static placeholder. No index, no listing. |
| everything else | 404 |

Unknown IDs, deleted IDs, and unauthenticated `/_manifest` requests return **byte-identical**
404s. Distinguishing them confirms existence.

`:id` is validated against `^[0-9a-hjkmnp-tv-z]{16}$` and used only as a KV key suffix. It is
never joined into a path, because there are no paths.

`:key` is validated against `^[0-9a-f]{16}\.(webp|png|jpg|svg)$` before use. This is the one
route where input is concatenated into a storage key rather than a flat lookup, so it gets an
explicit rule rather than relying on R2 to reject nonsense.

The worker emits `X-Staged-Hash` rather than `X-Content-Hash` because the plugin is the only
consumer and `contentHash` is not something it can independently compute (§3.4).

### 7.2 Page shell

One inlined stylesheet. No external requests, no fonts, no analytics, no JavaScript. Title
and updated date in the header; download link in the footer when `download` is true.

### 7.3 Headers

```
Content-Security-Policy: default-src 'none'; img-src 'self' data:;
                         style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'
X-Robots-Tag: noindex, nofollow          # unless indexable
X-Staged-Hash: 7a41…
Referrer-Policy: no-referrer
Cache-Control: public, max-age=300
```

`default-src 'none'` with no `script-src` means no JavaScript can run at all — possible only
because rendering happens at build time, and a large part of why that choice was made.

**Asset responses need their own headers**, because the page CSP above does not govern an
asset fetched directly and SVG is an active document (§5.5):

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
X-Content-Type-Options: nosniff
Content-Type: image/webp | image/svg+xml     # explicit, never sniffed
Cache-Control: public, max-age=31536000, immutable
```

`sandbox` with no allow-list means an SVG opened at its own URL cannot run script even if the
build-time sanitizer missed something. `nosniff` with an explicit `Content-Type` stops a
mislabelled asset being reinterpreted as HTML.

There is no `s-maxage` and no purge step, because `workers.dev` has no zone to purge (§7.4).
A five-minute browser cache is the only staleness window, and it bounds how long a reader who
already has the page open can see removed content. Since the hostname decision is permanent,
this is the steady state rather than an interim setting.

### 7.4 Hostname

`<worker>.<subdomain>.workers.dev`, **permanently**. No custom domain, no registration cost,
nothing to renew, and no migration planned.

Cloudflare recommends custom domains for production Workers and describes workers.dev as
being treated as a Free website, intended for personal or hobby projects that are not
business-critical. That is an accurate description of this project rather than a warning
against it — but it is the reason the decision is recorded here instead of assumed, and it
sets expectations correctly if this ever stops being a hobby project.

Four consequences of settling on it:

**No zone means no cache purge.** Purge-by-URL is a zone operation and `workers.dev` is not
your zone, so the explicit-purge strategy is permanently unavailable. Responses are also not
served through a zone's CDN cache the way a custom domain's would be, so `s-maxage` has
little to act on. §7.3 relies on a short browser `max-age` alone. Net effect on unpublish
latency is roughly neutral — you lose purge, but also lose the edge cache that made purge
necessary. Confirm which applies at M4 (§12).

**One less token scope.** Without purge, the Cloudflare API token needs only KV and R2
(§10). Smaller credential, one fewer permission to explain.

**`workers.dev` is on the Public Suffix List**, so other people's subdomains cannot set
cookies scoped to yours. Combined with pages that set no cookies and run no script, the
shared suffix is not a meaningful exposure.

**Assets stay behind the worker at `/a/`.** Serving them from a public R2 bucket domain would
be the obvious simplification, and it is wrong for a second reason now: Cloudflare documents
`r2.dev` as not intended for production, with a variable rate limit and possible throttling.
Routing through the worker avoids that entirely and keeps §7.3's asset headers applying
uniformly.

Secondary sources report that workers.dev adds some TLS negotiation overhead on cold start
relative to a routed custom domain. Unverified, and irrelevant at this traffic level, but
worth knowing if page-load time ever becomes interesting.

**Shared links are `workers.dev` links forever.** §5.9 and §6.2 already establish that
published URLs cannot be recalled; this decision makes the hostname part of that permanence.
Accepted deliberately (§13).

---

## 8. Obsidian syntax handling

**Resolved by the plugin, before CI sees it:**

| Syntax | Handling |
|---|---|
| `[[Note]]`, `[[Note\|alias]]` | Published → `[text](/n/<id>)`. Unpublished → alias only if it differs from the target's filename and title; otherwise removed entirely. Every removal reported. |
| `[[Note#Heading]]` | Anchor link if published |
| `[[Note^blockid]]` | Resolved to the block if published, else stripped |
| `![[image.png]]` | Copied to `_assets/`, rewritten to a standard image link |
| `![[image.png\|300]]` | Width preserved as an attribute |
| `![[Note]]`, `![[Note#Heading]]` | Inlined from the target's **staged output** if published, dropped otherwise. Recursive, cycle-guarded, depth-capped; drop and strip passes re-run on the composed result (§3.7). |
| `![[drawing.excalidraw]]` | Requires the plugin's auto-exported SVG companion; validation error if absent |
| ` ```dataview `, `` `= expr` `` | Materialized to markdown (§9) |
| `%%comment%%` | Removed |
| `#tag` | Plain text. No link — there is no tag index. |
| frontmatter | Reduced to the staged metadata block |

**Handled by CI:**

| Syntax | Handling |
|---|---|
| `> [!note]`, `> [!warning]` | `<div class="callout" data-callout="note">`, styled in the shell |
| `==highlight==` | `<mark>` |
| `$x$`, `$$x$$` | KaTeX |
| ` ```mermaid ` | Inline SVG |
| fenced code | shiki |
| tables, footnotes, task lists | remark-gfm |
| `%%comment%%` | Removed again, defensively |

`.canvas` files are out of scope (§13).

---

## 9. Dataview materialization

**Decision: materialize.** Rendering inside Obsidian and capturing its DOM is rejected — it
would cost theme-CSS capture, HTML sanitization of arbitrary plugin output, and
reproducibility, in exchange for fidelity this project does not need.

At stage 2 of §3.7 the plugin:

1. Waits for Dataview's index-ready signal. **Querying too early returns empty results and
   silently publishes blank tables** — the single most likely way to ship something wrong.
   Treat "index not ready" as a hard block, never a warning.
2. Calls `queryMarkdown()` for each `dataview` block and replaces the fence with its markdown
   output. Inline queries are evaluated the same way.
3. **Blocks publishing on any query returning zero rows**, listing it under Issues with a
   "publish anyway" action. Accepting stores `publish_ack: <hash of the query text>` in the
   source note, which suppresses the prompt until the query itself changes. An empty table
   and a broken query are indistinguishable after the fact, so the confirmation has to happen
   at publish time or not at all.

The original note is never modified except for `publish_ack` — materialization happens on the
way into `published/<share_id>.md`, and the live query stays live in the vault.

A published Dataview table is a point-in-time snapshot. It updates when the note is
re-published, and Stale status is how you know it needs to be.

---

## 10. Operational notes

### Quotas (Cloudflare free tier)

| Resource | Limit | Headroom |
|---|---|---|
| Worker requests | 100,000/day | Not a concern |
| KV reads | 100,000/day | Not a concern |
| KV writes | 1,000/day | The one to watch. One write per *changed* note plus the manifest. Hash-skipping (§5.6) is what keeps this comfortable; a `renderConfigVersion` bump defeats it (§4.2). |
| KV value size | 25 MB | Documents are well under 1 MB |
| KV storage | 1 GB | Not a concern for text |
| R2 storage | 10 GB | Post-webp, thousands of images |

### Secrets

| Secret | Location | Scope |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Actions secret | Workers KV Storage: Edit on one namespace; R2: Edit on one bucket. Nothing else — no Cache Purge (§7.4), and **not** Workers Scripts: Edit, since the worker is deployed by hand so a compromised CI token cannot replace worker code. |
| `CLOUDFLARE_ACCOUNT_ID` | Actions secret | — |
| `MANIFEST_TOKEN` | Worker secret + plugin settings | Read-only manifest access. Optional. |

Workflow permissions: `contents: read`.

`MANIFEST_TOKEN` sits in plaintext in `.obsidian/plugins/<id>/data.json`, which syncs and
backs up with the vault. Acceptable precisely because the token is low-value; the same would
not be true of a GitHub PAT.

Note what is **absent** from this table: any git credential. Push uses the operating
system's existing credential helper or Obsidian Git's configuration (§3.9), so no
vault-repo write token ever enters plugin storage.

### Known failure modes

| Symptom | Cause |
|---|---|
| Note stuck in Staged | Never pushed. Use Review and push. |
| Note stuck in Building | Push landed but the build failed or is queued. Follow the run link. |
| Published table is empty | Dataview queried before index-ready (§9) |
| Published content out of date | Note edited but not re-staged — shows as Stale |
| Images publish as broken links | Git LFS on `_assets/`; set `lfs: true` |
| Orphan appears in the panel | A source note lost its `share_id`, or was deleted outside Obsidian. Re-attach the ID, or stage it for removal (§3.4). |
| Renderer change had no effect | `renderConfigVersion` not bumped (§4.2). Easy to forget; the symptom looks like a broken renderer rather than a stale hash. |
| Build fails on missing asset | A partial commit split a staged note from `_assets/`. The push button commits touched paths together; hand-commits must do the same. |
| Push button disabled | No remote, detached HEAD, or no acceptable git mode available (§3.9) |
| Staged a note but nothing is live | Expected — staging is local. Push to publish (§3.9) |
| No publish items in the right-click menu | Context menu integration is off by default; enable in settings |
| Every build refuses every deletion | `fetch-depth` is shallow, so there is no baseline commit to corroborate against (§5.2). Presents as a reconciliation bug. |
| Build refused to delete documents | Planned deletions had no matching removals in the commit (§5.6). Usually a bad checkout or an unestablished baseline after a force-push. |
| Note shows Unstaged | No pending or published file — partial rollback, a sync from another machine, or hand-edited frontmatter. Re-stage (§3.4). |
| Build never runs after a push | The commit touched nothing under `published/`; the path filter is working as intended (§5.1) |
| Build runs on every vault sync | Path filter missing from the workflow, or `.publish-pending/` is not gitignored (§3.3, §5.1) |
| Build failed: `published/` missing | Checked out a commit predating the pipeline. Expected; a missing directory is an error, not an empty state. |
| Rollback re-rendered everything | `renderConfigVersion` differs at the target commit (§4.2) |
| Orphan appears only on a second device | Source notes committed without their staged files, or the reverse |

---

## 11. Testing

### 11.1 Fixture corpus

A directory of pathological notes with golden-file assertions — expected staged markdown and
expected rendered HTML for each.

| Fixture | Asserts |
|---|---|
| `comments.md` | No `%%` content survives staging or rendering |
| `private-frontmatter.md` | Only allowlisted keys survive |
| `link-to-unpublished.md` | Link removed; the target's title appears nowhere in output |
| `link-with-alias.md` | Alias kept only when it differs from filename and title |
| `dataview-table.md` | Fence replaced by a markdown table |
| `dataview-empty.md` | Publish blocked absent `publish_ack` |
| `transclusion-cycle.md` | Terminates |
| `transclusion-unpublished.md` | Dropped entirely |
| `case-mismatch-embed.md` | Validation error, not a silent 404 |
| `excalidraw-no-export.md` | Validation error |
| `oversized-image.md` | Warns at 2 MB, fails at 10 MB |
| `math-and-mermaid.md` | KaTeX and SVG present; no `<script>` in output |
| `comments-in-code-block.md` | A `%%` inside a fenced block survives byte-identically |
| `transclusion-of-note-linking-private.md` | A published note transcluding another that links a private note leaks neither title nor content |
| `duplicate-share-id/` | Two notes with one `share_id` surface as Conflict on scan, before either is staged |
| `geotagged-image.md` | No EXIF or GPS data in the published asset |
| `malicious.svg` | Script, event handlers, and `foreignObject` removed at build time |
| `.publish-pending/` contents | Never appear in `git status` or any commit |
| `orphan-staged-file.md` | A staged file no note claims is flagged, and Stage for removal succeeds without a source note |
| `everything.md` | Kitchen sink; full snapshot |

### 11.2 The three assertions that matter most

- **No `%%` sequence survives into any published artifact.**
- **Fenced code blocks round-trip byte-identically.**
- **No frontmatter key outside the allowlist survives into any published artifact.**

The second exists because the first is satisfiable by a broken implementation. A regex that
strips `%%…%%` from raw text passes the comment assertion while corrupting any code block
containing a stray `%%` — and worse, mis-pairs delimiters across unrelated markers, silently
swallowing real content in between. Asserting comment removal alone rewards exactly the
implementation you do not want. Together they force AST-level handling (§3.7 step 5).

Run all three in the plugin's test suite *and* in CI against the staged corpus. The
duplication is deliberate: these are the failures that cannot be walked back once a link is
shared.

### 11.3 Pre-publish self-check

Before writing a staged file, the plugin runs those same three assertions against the bytes it
is about to write and refuses on failure. Tests catch regressions in fixtures; the self-check
catches them in real notes.

### 11.4 Reconciliation tests

Rollback tolerance (§5.9) is a property of the build, not of any fixture, so it needs its own
tests against a scratch KV namespace:

| Scenario | Asserts |
|---|---|
| Manifest key deleted, then build | Converges correctly; no stranded documents |
| Build at commit N, then at N−5 | Live set matches commit N−5 exactly |
| Roll back across an unpublish | Note returns at its **original** URL |
| Roll back across a `renderConfigVersion` bump | Corpus re-renders with the older renderer |
| `published/` emptied by a broken checkout | Deletions refused; nothing removed from KV |
| Six notes genuinely unpublished in one commit | All six deleted; the commit corroborates them |
| `published/` removed entirely | Build fails rather than unpublishing everything |
| Same commit built twice | Second run writes nothing |
| Push touching only `Notes/` | No workflow run at all (§5.1) |
| Build interrupted mid-write, then re-run | Converges; no duplicates, no strays |
| Build writes `v: 1` against live `v: 2` keys | Skipped and reported, never downgraded (§4.4) |

Plus one plugin-side guard test, which belongs with these rather than the fixtures because it
is about state rather than content:

| Scenario | Asserts |
|---|---|
| Unstage invoked on a live note from the command palette | Refuses, points at Stage for removal, leaves the staged file intact (§3.6) |

The last two matter most. Idempotence is what makes every other recovery story work, and it
is cheap to assert.

### 11.5 Worker tests

Route-level tests asserting that unknown IDs, deleted IDs, and unauthenticated `/_manifest`
requests produce byte-identical responses, and that no route reflects input into a path.

---

## 12. Rollout

| Milestone | Deliverable |
|---|---|
| M0 | Local script renders one hand-written markdown file to HTML. No infrastructure. |
| M1 | Worker + KV live on `workers.dev`. One hand-populated note reachable. |
| M2 | Fixture corpus and the three critical assertions, before either half exists. |
| M3 | Plugin: `share_id` generation, staging one note to `.publish-pending/`, copy link. No Dataview, no assets. |
| M4 | CI pipeline: path-filtered trigger, sparse checkout, discover, render, reconcile, publish. First end-to-end publish. **Plus both verification tasks below.** |
| M5 | Plugin: publish panel with master–detail layout, `/_manifest` endpoint, HEAD fallback, ribbon and status bar. |
| M6 | Git integration: materialize-at-review, review modal, Review and push, Staged vs Building. |
| M6.5 | Context menu integration, multi-select, notice copy. Deliberately after the review modal exists. |
| M7 | Assets — plugin collection, R2 upload, webp conversion, URL rewriting. |
| M8 | Reconciliation from `KV.list`, commit-corroborated deletion, Stage for removal, orphan detection and repair, rollback tests. |
| M9 | Dataview materialization, transclusion inlining, full syntax coverage. |

**M4 verification tasks** — both are load-bearing assumptions and both are cheap to test:

1. **Vault unreachable from the runner.** `git show HEAD:<a private note>` and `git fetch`
   both fail after checkout (§6.3). Three outcomes: passes as configured; passes once
   `persist-credentials: false` is set; or take the two-repo fallback.
2. **Caching behaviour on `workers.dev`.** `curl -sI` a live note and read `cf-cache-status`.
   `DYNAMIC` is the wanted answer — no shared cache, so `max-age` governs only the browser and
   the absence of purge costs nothing (§7.4). `HIT` means an unevictable shared cache and
   `max-age` should drop to 60. Then measure the real number: publish, delete, and poll a
   fresh request until it 404s. That figure replaces the estimate in §6.2.

M2 before M3 is deliberate: the assertions define what "correct" means, and writing them
against fixtures is much easier than retrofitting them to a working plugin. M3 before M4 is
also deliberate — the staging format is the contract between the two halves, and it is far
easier to change while only one side exists.

---

## 13. Deferred and declined

Recorded so they are not relitigated by accident.

| Decision | Rationale |
|---|---|
| **R2 orphan collection — never delete in v1** | Primarily a rollback safety property (§5.9): every asset any historical commit referenced must still exist, or checking out an old commit publishes broken images. Storage economics make it easy — 10 GB free versus orphaned webp files takes years to matter. Any future collection must be history-aware, not just reachability-aware. |
| **Mobile — `isDesktopOnly: true`** | Everything works on mobile in principle, but the git-sync half of the workflow is awkward there and it doubles the test surface. Shelling out to system git (§3.9) makes this firmer than it was. Cheap to revisit if the Obsidian Git path proves sufficient alone. |
| **`isomorphic-git` with a stored PAT — declined** | The only implementation that would work identically everywhere, but it requires a write-scoped token for the entire vault repo in `data.json`. That is the exact credential this architecture exists to avoid. Terminal fallback is preferable to holding it. |
| **Auto-push on stage — declined** | Would remove the review modal, which is the property that distinguishes this from direct-upload plugins. Latency is the cost of the gate, not an accident. |
| **Expiring links — not built** | The GUI makes manual unpublishing a two-second action, which is most of the value of `publish_until` without scheduled-job infrastructure. |
| **Analytics — nothing built** | Cloudflare's zone-level request analytics are server-side and free. A JS beacon would break the CSP; worker-side counting in KV would exhaust the write quota immediately. |
| **`.canvas` files — out of scope** | Same shape as Excalidraw, but Obsidian has no built-in canvas image export, so there is no cheap version. |
| **Folder-level "publish all" — declined** | A single right-click that could expose dozens of notes is the worst available accident in this design. Multi-select requires deliberately selecting each file, which is the right amount of friction. |
| **Custom domain — declined permanently** | Cloudflare positions workers.dev as suited to personal, non-business-critical projects, which is exactly this. Costs nothing, renews nothing. Accepts three things in exchange: no cache purge (§7.4), URLs that advertise their infrastructure, and shared links that are workers.dev links forever. Reversing later means keeping the old route alive indefinitely or breaking published links. |
| **File explorer decoration — skipped** | Cosmetic, and depends on an unofficial API. |
| **Zip download bundles — deferred** | Better for true archival than absolute-URL markdown, but the markdown download covers the stated requirement. Revisit if offline reading matters. |

---

## 14. Open questions

The list is short now, and nothing here blocks starting.

- **Does sparse checkout hold as a boundary?** Answered empirically at M4 (§6.3). The
  fallback is designed; only the checkout stage changes either way.
- **Are `workers.dev` responses edge-cached, and can anything evict them?** Answered at M4
  (§7.4). With the hostname now permanent, the only lever is `max-age`, so the answer decides
  whether five minutes is the real staleness window or an underestimate.
- **Does the manifest token stay optional?** If the HEAD fallback proves good enough in
  practice, the endpoint could be dropped entirely and the worker's surface shrinks by one
  authenticated route. Decide after living with M5.

---

## 15. Arguments against this design

The strongest objections found in adversarial review, recorded rather than quietly won.
None were fatal enough to change course, but each has a real answer that a future reader —
including future me — is entitled to see before accepting the architecture.

### 15.1 The credential inversion may not buy what it costs

**The objection.** Denying the plugin publish credentials is the stated justification for the
staging directory, the git round-trip, the desktop-only constraint, and a large fraction of
this document. But the plugin already has full vault read access. A *malicious* plugin
exfiltrates everything whether or not it can publish, so the split protects nothing there. A
*buggy* plugin publishes the wrong thing — and staging does not prevent that either. The
**review modal** prevents it. The modal does not require the credential split; it would work
identically in front of a direct upload.

Remove the inversion and you get: no git dependency, publish in seconds rather than minutes,
mobile support for free, no Staged/Building distinction to explain, and materially less
design. That is close to Share Note's architecture, which exists, works, and self-hosts.

**The answer.** The git artifact provides three things the modal does not: history, rollback
(§5.9), and an audit trail outside the plugin's control. The last matters most — if the
plugin has a bug that stages the wrong content, the modal is rendered *by the buggy plugin*.
`git diff` is not. A compromised or broken plugin can lie to you in its own UI; it cannot
easily lie in the repository, because the artifact outlives the process that made it.

That is a real answer, but note it is a different argument from the one §2.1 makes. The
credential inversion is justified by **out-of-band verifiability**, not by limiting what a
malicious plugin can read. §2.1 overstates its case and should be read with this in mind.

### 15.2 The threat modeling is inverted

Eighteen rows in §6.1, most concerning the worker — which holds only public content — and CI,
which holds only published content. The plugin gets one paragraph in §6.3 saying full vault
access is "the correct place for it."

The zone with the most to lose receives the least analysis. Unexamined: what happens when a
*different* Obsidian plugin reads `.obsidian/plugins/<id>/data.json` and takes the manifest
token; whether the staging directory should be excluded from other plugins' reach; what a
supply-chain compromise of this plugin's own dependencies would do; and whether Obsidian's
plugin model offers any isolation worth relying on (it does not).

The honest position is that this is not analysed because it is largely unmitigable within
Obsidian's security model — but "unmitigable" and "unexamined" should not look the same in a
document.

### 15.3 It may simply be disproportionate

Roughly 1,400 lines, nine milestones, a reconciler, schema versioning, a two-hash contract,
and a fixture corpus — to let one person publish occasional notes. Share Note covers most of
the requirement today and self-hosts via a published Docker image.

The design has consistently answered "how do we do this correctly" and never "should we do
this at all." Several individual decisions are better than the alternatives — the review
gate, reconciliation, the vocabulary split — but better-than-alternatives is not the same as
worth-building.

**The answer, such as it is:** the requirements that pushed away from Share Note were
markdown download, an in-vault index, and no server to maintain. Those are real and Share
Note does not meet them. Whether they justify this much machinery is a judgement about how
much the build itself is worth doing, which is a legitimate reason but should be named as
one rather than dressed as necessity. §1 now states the priority ordering that makes this
answerable rather than arguable.

### 15.4 Smaller objections that survived

- **Nine milestones is a lot of runway before anything is useful.** M0–M4 is the real
  minimum; everything after is refinement. Anyone building this should be prepared to stop
  at M5 and find it sufficient.
- **The vocabulary split is unfamiliar** (§3.10). Accepted deliberately, but it is a genuine
  cost paid on every first use by anyone but the author.
- **Two hashes is a contract that can drift** (§4.2). Mitigated by each side reading only the
  one it can verify, but a third consumer would have to be told which is which.
- **`renderConfigVersion` is a manual constant.** It will be forgotten at least once, and the
  symptom — a renderer change that appears not to work — is confusing enough to warrant the
  failure-mode row it now has (§10).