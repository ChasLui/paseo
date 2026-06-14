# ArtifactFS Evaluation for Paseo

Feasibility, comparison, and design evaluation of [cloudflare/artifact-fs](https://github.com/cloudflare/artifact-fs) for Paseo maintainers. **This is a decision document, not an implementation.** It records what ArtifactFS actually does (from its source), why its headline mechanism does not transfer to Paseo, the narrow places where the _idea_ could still help, and a cost/benefit verdict for each candidate.

## 1. TL;DR

- **ArtifactFS's headline win — blobless clone + on-demand blob hydration over the network — gives Paseo near-zero benefit.** Paseo provisions agent workspaces with `git worktree add` (`packages/server/src/utils/worktree.ts:1191`), which reuses the host repo's already-present `.git` object store and never re-downloads blobs. There is no network clone to avoid.
- **Only the _philosophy_ transfers: "return something usable immediately, materialize the rest on demand / by priority."** That philosophy lands on three existing Paseo subsystems with very different payoffs.
- **Already applied where it counts:** the "return immediately, do the slow part in the background" idea is _already_ how Paseo provisions worktrees — every production path forces `runSetup: false` and runs setup fire-and-forget with a live `workspace_setup_progress` status stream (`worktree-session.ts:579,605`; `create.ts:152→158`). The only genuinely unbuilt surgical, pure-TypeScript win is the **file explorer**: priority prefetch + large-file range reads + large-directory pagination (none implemented today).
- **Not recommended:** integrating the ArtifactFS binary itself (Go + FUSE, macFUSE/fuse3, no mobile support) — unless Paseo grows a genuine remote/sandbox provisioning mode that fetches large repos over the network. That is a different product, not an optimization.
- **Rejected outright:** `--filter=blob:none` / sparse-checkout on worktrees. Blobs are already local, so the filter saves nothing, and sparse checkout would hide files from the agent's own tools.

## 2. What ArtifactFS is

A Git-backed FUSE filesystem daemon written in Go (1.24+), depending on FUSE 3 (macFUSE / fuse3) and a pure-Go SQLite driver. It makes a repository's tree visible _before_ its file contents have been downloaded.

### 2.1 Two-phase model

1. **`add-repo` (Phase 1)** — a _blobless_ clone that downloads only commits, trees, and refs, not file contents: `git clone --filter=blob:none --no-checkout --single-branch --branch <branch> …` (`internal/gitstore/gitstore.go:85`). It then builds an immutable SQLite snapshot of the tree (`base_nodes`, keyed by `(generation, path)`; `internal/snapshot/store.go:19-28`). During tree indexing, `git cat-file --batch-check` runs with `GIT_NO_LAZY_FETCH=1` (`internal/gitstore/gitstore.go:190`) so blob-size resolution does **not** trigger a network round-trip per missing blob — unresolved blobs are marked `size_state='unknown'` and resolved later during hydration. `prepareRepo` clones → resolves HEAD → builds the index → publishes a snapshot generation atomically (`internal/daemon/daemon.go:312-348`).
2. **`daemon` (Phase 2)** — mounts the repo via FUSE; the whole tree is visible immediately, and file _contents_ are fetched on demand. `mountRepo` wires up a Resolver (snapshot + overlay merged view), an Engine (read/write/create/rename ops), the FUSE server, hydrator workers, and a watcher goroutine (`internal/daemon/daemon.go:352-412`).

The problem it solves: the initial `git clone` blocks ephemeral workloads (CI, AI agents, sandboxes) by downloading everything up front. ArtifactFS makes the tree available before the bytes arrive.

### 2.2 Lazy hydration engine and priority rules

- On read, `Engine.Read` calls `Hydrator.EnsureHydrated` and blocks until the blob is fetched, then serves the chunk (`internal/fusefs/ops.go:42-58`). Reads are **synchronously blocking**; directory opens (`OpenDir`) speculatively prefetch children in a goroutine without blocking (`internal/fusefs/fuse_unix.go:266-282`, `internal/fusefs/ops.go:178-201`).
- A priority queue (max-heap) sorts tasks by `(priority DESC, enqueuedAt ASC)` (`internal/hydrator/hydrator.go:436-440`), giving FIFO fairness within a tier. Priority constants (`hydrator.go:393-398`): `ExplicitRead=1000`, `Sibling=800`, `Bootstrap=700`, `LikelyText=500`, `NearbyCode=400`, `Binary=100`. `ClassifyPriority` boosts manifests (`go.mod`, `Cargo.toml`, `package.json`, `pyproject.toml`, lockfiles) and `README`/`LICENSE`/`Makefile` to `Bootstrap=700`, code extensions to `LikelyText=500`, and demotes binaries (`.png`/`.jpg`/`.zip`/`.pdf`/`.mp4`) to `Binary=100` (`hydrator.go:401-416`).
- Concurrent reads of the same blob are coalesced: an inflight map (`map[string][]chan T`) lets the first caller enqueue the fetch and later callers wait on the same result channel (`internal/hydrator/inflight.go:3-50`, `hydrator.go:118`). A `verified` map plus `verifyBlobOnce` dedupes blob verification across concurrent reads (`hydrator.go:38,245-294`).
- Worker pool: `Start(workers)` spawns goroutines that drain the queue one task at a time and re-signal `workReady` so others can help (`hydrator.go:309-326`). **Caveat from exploration:** this is _not_ batch hydration — each worker processes one blob per step; "batch" in the README refers to the persistent `git cat-file --batch` subprocess, not task batching. `PrioritySibling=800` is _defined but unreferenced_ (possible dead code / future use).

### 2.3 Copy-on-write overlay

- A SQLite `overlay_entries` table plus an `upper/` directory holds local writes; five operation kinds (`create`, `modify`, `delete`, `rename`, `mkdir`), each carrying `source_oid` and `backing_path` (`internal/overlay/store.go:20-32`, `internal/model/types.go:61-70`).
- The Resolver checks the overlay first (delete → whiteout, modify, create), else falls back to the snapshot, else `ErrNotExist` (`internal/fusefs/merged.go:54-66`). On write, `EnsureCopyOnWrite` hydrates then copies the base blob into `upper/` before modification, preserving the original blob's integrity (`internal/fusefs/ops.go:60-71`, `internal/overlay/store.go:109-153`).
- A watcher polls `HEAD`/ref mtimes every 500 ms (`internal/watcher/watcher.go:24-37`); on change it publishes a new snapshot generation, reconciles the overlay, and runs `git read-tree HEAD` to refresh the index so `git status` doesn't report phantom diffs (`internal/daemon/daemon.go:415-466`). Reconciliation removes `modify`/`rename` entries whose `source_oid` no longer matches the new base, guarding against silently overwriting rebased content; it uses `WHERE source_oid=? AND mtime_unix_ns=?` for optimistic concurrency (`internal/overlay/store.go:447-535`).
- A synthesized `.git` gitfile (`gitdir: <path>\n`) is placed at the mount root so ordinary `git` commands work inside the mount (`internal/fusefs/fuse_unix.go:72-88`). Metadata operations (`git log`, `git branch`, `git show`) read the real `.git` packs at native speed; only content reads/writes (`git diff`, `git add`, `git checkout`) traverse FUSE.

### 2.4 Dependency / platform matrix

| Aspect                  | Value                                                                                            | Evidence                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Language / runtime      | Go 1.24.0+                                                                                       | `go.mod:3`                                                                      |
| FUSE library            | `github.com/jacobsa/fuse` (pinned Feb-2026 commit)                                               | `go.mod:6`                                                                      |
| SQLite                  | `modernc.org/sqlite` — pure Go, **no CGO**                                                       | `go.mod:8`; `examples/Dockerfile:25` builds `CGO_ENABLED=0`                     |
| macOS                   | requires **macFUSE**                                                                             | `README.md:31`; `internal/fusefs/fuse_darwin.go:8`                              |
| Linux                   | requires **fuse3** + `/dev/fuse`                                                                 | `README.md:32`; `internal/fusefs/fuse_linux.go:9`; `e2e_setup_linux_test.go:13` |
| Windows / iOS / Android | **unsupported** (all FUSE code is `//go:build !windows`; no mobile FUSE)                         | `fuse_unix.go` build tags; README lists only macOS+Linux                        |
| Container               | `--cap-add SYS_ADMIN --device /dev/fuse`; Ubuntu also needs `--security-opt apparmor:unconfined` | `README.md:107,114-128`                                                         |
| Default concurrency     | 4 hydration workers, each a persistent `git cat-file` process                                    | `README.md:99`                                                                  |

**Known limitations (from ArtifactFS's own README):** `git status` ~7 s on 5800+-entry repos and `git reset` ~6.5 s, both from full tree walks through FUSE (`README.md:245-246`). The watcher uses polling, not inotify, so HEAD changes can be detected up to 500 ms late. Submodules/worktrees are not explicitly supported.

## 3. Why the core mechanism does not transfer

The decisive fact: Paseo never clones over the network to provision a workspace. A Paseo worktree is created by `runGitCommand(["worktree", "add", …])` (`packages/server/src/utils/worktree.ts:1191`), and a worktree **shares** the main repo's `.git`, so all blobs are already on disk. ArtifactFS's lazy _network_ hydration has nothing to avoid.

|                     | ArtifactFS solves                                          | Paseo's reality                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bottleneck          | Network download of all blobs at clone time                | No clone — `git worktree add` reuses the local `.git` object store (`worktree.ts:1191`)                                                                                   |
| Target environment  | Ephemeral container / CI / sandbox, cold start             | "Connects to your own dev machine; your code stays local" (`docs/architecture.md:1-4`)                                                                                    |
| Data path           | Remote object store → FUSE → content over network          | Local object store → working-tree checkout (disk I/O only)                                                                                                                |
| Local writes        | CoW overlay + reconciliation against remote HEAD           | Plain on-disk files in the worktree; git handles state                                                                                                                    |
| Dependency surface  | Go binary + FUSE 3 (macFUSE/fuse3); no Windows/iOS/Android | Node.js daemon spawning the `git` CLI; no native FS driver; runs on iOS/Android/web/desktop                                                                               |
| Remote provisioning | Core use case                                              | **Does not exist** — daemon requires the repo to be local already (`worktree.ts:1251-1329`); relay is encryption-only, not a provisioner (`docs/architecture.md:115-124`) |

What remains slow in Paseo is **local checkout disk I/O** and, dominantly, **post-checkout setup commands** — neither of which ArtifactFS addresses.

## 4. Paseo current-state audit

Three subsystems where a "lazy / by-priority" idea could plausibly apply.

### 4.1 Worktree materialization — already non-blocking in production

The "return something usable immediately, do the slow part in the background" idea — candidate A below — is **already how Paseo provisions worktrees**. The synchronous `await runWorktreeSetupCommands` inside `createWorktree` (`worktree.ts:1220-1226`, gated on a `runSetup` flag) is **dead code in production**: every production caller forces `runSetup: false`, overriding the `?? true` default at `worktree-core.ts:113` — `worktree-session.ts:229,579`, `worktree/commands.ts:76`, `create-agent-lifecycle-dispatch.ts:108`, `create-agent/create.ts:430`. So `createWorktree` is effectively just `git worktree add` (`worktree.ts:1191`, 120 s timeout; no `--filter`/`--depth`/sparse-checkout — verified).

Setup then runs in the background on two paths:

- **Explicit worktree creation** (`createPaseoWorktreeWorkflow`, `worktree-session.ts:576-615`): returns right after `git worktree add`, schedules `runWorktreeSetupInBackground` in `setTimeout(…, 0)` (`:591,605`) — fire-and-forget, not awaited.
- **Create-agent-with-worktree** (`createAgentCommand`, `create.ts:143-160`): `await createAgent` spawns the agent first, then `startAfterAgentCreate` fires `runAsyncWorktreeBootstrap` fire-and-forget (`:158`). The agent process — and even its initial prompt (`:165`) — start without waiting for setup.

Status is already streamed to the client: WS event `workspace_setup_progress` (`running|completed|failed`, `messages.ts:2594`), reconnect pull `workspace_setup_status_request` (`:1608`), the `setup-panel.tsx` UI, and a `"Setting up workspace..."` string. On the live paths, a setup-command failure **keeps** the worktree and marks it `failed` — it is not deleted (`worktree-session.ts:742-744`). All git commands route through `runGitCommand` (`run-git-command.ts`): `pLimit(8)` concurrency (`:11-12`), 30 s default timeout, 20 MB stdout cap (`:7-9`).

**So the only genuinely unbuilt parts of the candidate-A philosophy are:** a _readiness gate_ (make the agent's first prompt wait for setup — but Paseo's agents are globally-installed CLIs that don't need the project's `node_modules` to _launch_, so the parallel design is usually correct, not a bug), and deleting the dead synchronous branch. The real lazy-materialization opportunity is the **file explorer** (§4.2).

### 4.2 File explorer — one-shot listings and reads, no chunking on the request path

Protocol `FileExplorerRequestSchema` (`packages/protocol/src/messages.ts:1700`) has two modes:

- `mode: "list"` — a single directory level; the server does one `fs.readdir()` and returns **all** entries with no count limit or pagination (`packages/server/src/server/file-explorer/service.ts:89-137`; `FileExplorerDirectorySchema`, `messages.ts:1695`). Tree expansion is client-driven and lazy in the good sense — one level per expand, cached per workspace in `Map`s with no TTL/eviction (`packages/app/src/components/file-explorer-pane.tsx:642-679,655-656`; `packages/app/src/stores/session-store.ts:234-244`).
- `mode: "file"` — reads the **entire** file into memory via `handle.readFile()` with **no range/chunking** (`service.ts:139-177,200`). Encoding is `utf-8` (text), `base64` (image), or `none` (binary, content omitted; `FileExplorerFileSchema`, `messages.ts:1685-1693`). Binary detection samples 8 KB (`FILE_TYPE_SAMPLE_BYTES`, `service.ts:58`).

Note: a chunked **binary frame** protocol _already exists_ for large transfers — `FileBegin`/`FileChunk`/`FileEnd` opcodes `0x10/0x11/0x12` (`packages/protocol/src/binary-frames/file-transfer.ts:5-7`), used when `acceptBinary=true` (`packages/server/src/server/session.ts:5854-5884`; client reassembly `packages/client/src/daemon-client.ts:4527-4575`), plus a separate token-based HTTP download path (`session.ts:5997-6022`). So large _reads opted into binary mode_ are chunked; the gaps are (a) very large single directory listings ship in one frame, (b) the inline `mode:"file"` text/image path returns the whole file, with no `offset/length` range read, and (c) no prefetch of likely-next entries.

**Idea fit:** ArtifactFS's priority hydration (manifests/source first) maps to **prefetching likely-next files** and **range-reading large files** so the first screenful renders fast; directory pagination caps frame size.

### 4.3 Git wrapper & performance bottlenecks — metadata cached, contents are not

`WorkspaceGitService` keeps 7 LRU + TTL caches of git **metadata** (branches, stashes, worktrees, diffs, default branch, validations; `packages/server/src/server/workspace-git-service.ts:365-392`), with a 15 s aux TTL and 2 s min refresh gap to absorb watcher bursts (`:48,50`). The main snapshot (`isDirty`, branch, remote) doesn't expire on read — refreshed by watchers or a 60 s self-heal timer (`:45,47`). Read-only ops set `GIT_OPTIONAL_LOCKS=0` (`packages/server/src/server/checkout-git-utils.ts:8-10`). File watching is OS-native with a Linux 5,000-directory cap falling back to polling (`workspace-git-service.ts:56,61`).

The relevant bottleneck: tracked diffs use one `git diff HEAD --numstat` then **per-file `git show`** for large/binary detection (`packages/server/src/utils/checkout-git.ts:2227,552-615`), i.e. up to ~1200 spawns for a 1200-file changeset (caveat from exploration: no batching mechanism observed). Per-file diffs cap at 1 MB, total at 2 MB, marking overflow `too_large` (`checkout-git.ts:1624-1625,1712`). This subsystem is **not an ArtifactFS-shaped target** — it caches metadata, not file contents — but it owns the existing performance harness (see §9).

## 5. Candidate optimizations

### A. Non-blocking worktree setup — already implemented (see §4.1)

- **What it would be:** Return the worktree path as soon as `git worktree add` completes; run setup in the background with a `running | completed | failed` status surfaced to the client. The agent UI shows "Setting up…" instead of a frozen create.
- **Maps to:** ArtifactFS "tree visible before bytes are ready" (`internal/fusefs/ops.go:178-201` prefetch / non-blocking `OpenDir`).
- **Status:** **Already the production design.** All callers pass `runSetup: false` and run setup fire-and-forget (`worktree-session.ts:579,605`; `create.ts:152→158`); status streams via `workspace_setup_progress`; `setup-panel.tsx` renders "Setting up workspace…". The synchronous branch in `createWorktree` (`worktree.ts:1220`) is dead code.
- **Remaining (optional):** a readiness gate before the agent's initial prompt (likely unnecessary — agents are global CLIs, not dependent on project `node_modules` to launch), and deleting the dead synchronous branch.
- **Verdict:** No build needed. Optionally delete the dead branch; add a readiness gate only if a provider is observed failing on missing setup.

### B. File-explorer priority prefetch + large-file range/chunking + large-directory pagination — recommended (do second)

- **What:** (1) Paginate large directory listings (add a cursor to `mode:"list"`) instead of one frame. (2) Add `offset`/`length` range reads to `mode:"file"` so the first screenful renders before the whole file arrives — note the chunked binary-frame transport already exists (`binary-frames/file-transfer.ts:5-7`); this extends the _request_ shape and the inline text path. (3) Optionally prefetch sibling/likely-next entries by a manifest/code-first heuristic, mirroring ArtifactFS `ClassifyPriority` (`internal/hydrator/hydrator.go:401-416`).
- **Maps to:** ArtifactFS priority hydration + on-demand content + `OpenDir` prefetch.
- **Benefit:** Snappier browsing on large dirs/files, lower peak memory and frame size — especially over the relay on mobile. **Magnitude unmeasured — see §9.**
- **Cost / risk:** Medium. All protocol additions are additive and back-compat-safe (`offset`/`length`/`cursor` all `.optional()` on `FileExplorerRequestSchema`, `messages.ts:1700`), gated behind a `server_info.features.*` capability flag with a `COMPAT(...)` tag per the repo's feature-contract rules. Client cache (`session-store.ts:234-244`) has no eviction today — paginating large dirs interacts with that; keep it simple.
- **Verdict:** Worth doing, independent of A.

### C. Integrate the ArtifactFS binary (remote / large-repo mounting) — not recommended now

- **What:** Bundle the Go FUSE driver as an optional capability to mount large repos quickly for remote/sandbox agent workspaces.
- **Maps to:** ArtifactFS used as-is.
- **Benefit:** Real **only** if Paseo provisions workspaces by cloning over the network — which it does not today (the daemon attaches to local repos; `worktree.ts:1251-1329`; relay is encryption-only, `docs/architecture.md:115-124`).
- **Cost / risk:** High. Ship + maintain a Go binary per platform; macFUSE on macOS (kext/system-extension approval friction) and fuse3 + `SYS_ADMIN` + `/dev/fuse` + AppArmor override on Linux (`README.md:107,114-128`); **FUSE is unavailable on iOS/Android entirely** (`fuse_unix.go` `//go:build !windows`, no mobile FUSE), which collides with Paseo's mobile-first surface. Inherits ArtifactFS's own caveats: ~7 s `git status` on large repos, 500 ms-late HEAD detection, no submodule support.
- **Verdict:** Defer until/unless a remote-provisioning mode exists. Revisit then with this document as the baseline.

### D. Sparse / blobless worktree checkout — rejected

- **What:** Use `git worktree add --filter=blob:none` or sparse-checkout to materialize fewer files.
- **Why rejected:** Blobs are already local (worktree shares `.git`; `worktree.ts:1191`), so `--filter` saves ~nothing — there is no network fetch to defer. Sparse checkout would hide files from the agent's own tools (`grep`, `find`, build), breaking the "agent sees the full repo" contract. High risk, near-zero gain. Documented here so it is not re-proposed.

## 6. Cost / benefit matrix

| Candidate                                 | Idea fit     | Benefit                                                           | Cost / risk                                              | Verdict                                                                           |
| ----------------------------------------- | ------------ | ----------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A. Non-blocking setup                     | High         | —                                                                 | —                                                        | **Already implemented** (§4.1; optional: delete dead branch / add readiness gate) |
| B. Explorer prefetch / range / pagination | High         | Medium (browsing UX, mobile/relay; unmeasured)                    | Medium (additive, gated protocol)                        | **Do second**                                                                     |
| C. Integrate ArtifactFS binary            | High (as-is) | Conditional (needs a remote-provisioning mode that doesn't exist) | High (Go + FUSE, no iOS/Android, per-platform packaging) | **Defer**                                                                         |
| D. Sparse / blobless checkout             | Superficial  | ~Zero (blobs already local)                                       | High (breaks agent tools)                                | **Reject**                                                                        |

## 7. Recommendation

Adopt the _philosophy_, not the _binary_. **A is already implemented** — Paseo provisions worktrees non-blocking with streamed setup status (§4.1); at most, delete the dead synchronous branch and add a readiness gate only if a provider is observed failing without setup. The remaining surgical, pure-TypeScript work is **B** (file-explorer prefetch + large-file range reads + large-directory pagination), all currently unbuilt. Treat **C** as out of scope until Paseo grows a remote/sandbox provisioning path where a network clone is actually on the critical path; revisit it then. **D** stays rejected.

## 8. If we proceed — entry points

- **A — already implemented (§4.1):** production paths at `packages/server/src/server/worktree-session.ts:576-615` (explicit creation, background `runWorktreeSetupInBackground`) and `packages/server/src/server/agent/create-agent/create.ts:143-160` (agent path, `startAfterAgentCreate`); status via `workspace_setup_progress` (`packages/protocol/src/messages.ts:2594`). Optional cleanup only: delete the dead synchronous branch in `packages/server/src/utils/worktree.ts:1220-1226` and the `runSetup` field on `CreateWorktreeOptions`.
- **B — Explorer prefetch / range / pagination:**
  - `packages/server/src/server/file-explorer/service.ts:89-137` (listing — add cursor) and `:139-177,200` (file read — add `offset`/`length` range).
  - `packages/protocol/src/messages.ts:1700` (`FileExplorerRequestSchema` — add `offset`/`length`/`cursor`, all `.optional()`); `:1685-1695` (response schemas — add `hasMore`/`nextCursor`).
  - Transport already present: `packages/protocol/src/binary-frames/file-transfer.ts:5-7` (chunk opcodes), `packages/client/src/daemon-client.ts:4527-4575` (reassembly).
  - Client: `packages/app/src/components/file-explorer-pane.tsx:642-679`, `packages/app/src/stores/session-store.ts:234-244` (cache).
  - **Capability gating:** flag under `server_info.features.*` with `// COMPAT(fileExplorerRange): added in v0.1.X, drop the gate when floor >= v0.1.X`.

## 9. Benchmark — candidate B measured

Candidate B's payoff is now measured by a dedicated opt-in harness,
`packages/server/src/server/daemon-e2e/file-explorer-benchmark.local.e2e.test.ts`
(`PASEO_FILE_EXPLORER_BENCH=1`, 240 s timeout, mirroring the git-diff-bottleneck pattern). It
calls the production `service.ts` functions directly with the production constants
(`DIRECTORY_PAGE_LIMIT=500`, `FILE_PREVIEW_HEAD_BYTES=512 KB`):

| Scenario                                | Whole                       | Candidate B                            | Reduction                                   |
| --------------------------------------- | --------------------------- | -------------------------------------- | ------------------------------------------- |
| **B-2** large directory (5,000 entries) | 557 KB JSON listing, 187 ms | first page 56 KB / 500 entries, 142 ms | **payload −89.9%**                          |
| **B-1** large file (10 MB text)         | read 10 MB, 24 ms           | head slice 512 KB, 1 ms                | **bytes −95%**, whole-file `size` preserved |

These are **local, in-process payload/memory reductions**, not end-to-end latency. The relay/mobile
path is where shipping 56 KB instead of 557 KB (or 512 KB instead of 10 MB) converts into faster
time-to-first-render; that conversion still wants a real over-relay measurement. The payload
reduction is the lever, and it is now quantified rather than assumed.

An **end-to-end variant** in the same harness drives `ctx.client.listDirectory`/`readFile` across a
real in-process daemon WebSocket (the full client→daemon→protocol→service path): first page 500 of
5,001 entries; head read 512 KB with the whole-file `size` (10 MB) preserved. It also **caught a real
B-1 bug** the pure-function tests could not — ranged reads travel as a binary frame, and the client
sized the reassembly buffer from the whole-file `size` instead of the bytes actually received, so a
512 KB head deserialized into a 10 MB buffer (truncation detection broken, content zero-padded).
Fixed by sizing the buffer to the received chunk total (`daemon-client.ts` reassembler). This is the
payoff of exercising the real transport, not only the pure functions.

Still unmeasured (out of candidate B's scope):

1. **Worktree create breakdown** — setup already runs in the background (§4.1), so this would
   measure _user-perceived_ readiness, not whether to build A. Time `git worktree add`
   (`worktree.ts:1191`) alone on a huge repo; if the checkout itself is slow, that (not setup) is
   the next target.
2. **File-explorer over-relay latency** — the table above is direct/in-process; time-to-first-render
   over the encrypted relay on a real mobile client is the remaining number.

The harness mirrors `packages/server/src/server/daemon-e2e/git-diff-bottleneck.local.e2e.test.ts`
(opt-in via env var, 240 s timeout, direct-call timing plus a relative-baseline assertion) rather
than inventing a new pattern.

---

**Caveats carried from the exploration (honesty markers):**

- ArtifactFS "batch" is a persistent `git cat-file --batch` _subprocess_, not task batching; workers process one blob per step (`hydrator.go:309-326`). `PrioritySibling=800` is defined but unreferenced — possible dead/future code.
- ArtifactFS performance figures (7 s `git status`, 6.5 s `git reset`) are empirical from one 5800-entry repo; they vary with tree size and FUSE implementation. Watcher polling means HEAD changes can lag up to 500 ms; submodules/worktrees are not explicitly supported.
- Paseo file-explorer inline size limits are not enforced in code (`service.ts` relies on external WS message-size limits); download-token validation internals were not examined. The exact per-file `git show` count for binary detection (§4.3) scales O(n) with changeset size with no observed batching.
- No profiling of checkout-vs-setup contribution to worktree-create time exists in the code; §9 step 1 must produce it before A is greenlit.
