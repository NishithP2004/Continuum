# Devpost submission draft

Do not publish placeholder links or unverified test claims. Replace every `TBD` only after the artifact exists on the final submission commit.

## Project name

**Continuum**

## Tagline

**Live, privacy-first context infrastructure that lets Codex continue your work without screenshots or pasted history.**

## Short description

Continuum turns live, allowlisted developer and macOS metadata into evidence-backed checkpoints, a semantic graph, and deterministic Context Diff. A native Mac app, grounded agent chat, synchronized PWA, and read-only local/remote MCP give Codex the exact files, commits, blockers, decisions, and next action it needs—without capturing screens or content.

## Inspiration

The failure mode in today’s “AI memory” is not a lack of storage. It is the choice to treat people’s screens and histories as an undifferentiated stream.

Screenshots are privacy-invasive, expensive to process, difficult to search, and surprisingly weak evidence of intent. A developer’s tools already know when a workspace was focused, a safe command finished, a file was saved, a commit landed, or a documentation tab was opened. Those semantic events are smaller, clearer, and can be filtered before they cross a process boundary.

Continuum treats context as operating-system infrastructure rather than another chat transcript. The local device remains the observer. A model becomes a bounded consultant.

## What it does

Continuum is a live-only, local-first context platform for developer work.

On macOS it collects allowlisted metadata from seven sources:

- trusted single-root VS Code workspace focus and active/save events;
- opt-in zsh command shape, cwd, duration, and exit code;
- repository-local Git commit/checkout/merge/rewrite metadata;
- a paired Chrome extension’s foreground allowlisted host and sanitized path;
- macOS application lifecycle metadata;
- optional, Accessibility-gated focused-window titles that stay local-only;
- coalesced relative-path/change-kind metadata from explicitly approved folders.

It never captures screenshots, file or page bodies, terminal output, keystrokes, clipboard, browser DOM/history/cookies, URL query data, Git patches/blobs/remotes, or credentials.

Events are grouped per global project and summarized into checkpoints. Every factual checkpoint item must cite one of the exact input event IDs. Those checkpoints feed:

- **Now and Timeline** for current focus and history;
- **Context Diff** for cited changes since the last checkpoint the user explicitly acknowledged;
- **Graph** for bounded project/task/file/commit/blocker/decision/concept relationships;
- **Chat** for cited answers and narrowly scoped context actions;
- **Codex MCP** for `current`, `timeline`, `search`, `resume`, `diff`, and `graph`.

The native app lives in both the Dock and menu bar. An optional self-hosted service synchronizes eligible context to PostgreSQL, projects it into Neo4j, exposes authenticated Streamable HTTP MCP, and powers an installable responsive PWA. The PWA is a companion; it never collects device activity.

There is no runtime seed or replay mode. The submission demo uses activity captured live during the recording.

## The “aha” moment

After a real work interruption, the user asks Codex only:

> Continue where I left off.

Codex calls Continuum, receives a bounded Context Pack and Context Diff, cites the relevant checkpoint, file, and commit, distinguishes an open blocker from a disproven hypothesis, and recommends the correct next action. No history is pasted into the prompt.

## How we built it

### Local engine

The Node 24/TypeScript daemon runs only on loopback, uses a generated bearer token, and stores local state in SQLite. FTS5, graph tables, and optional 384-dimensional MiniLM/sqlite-vec retrieval combine lexical score, vectors, one-hop graph expansion, importance, and recency. When vector support is unavailable, Continuum explicitly reports FTS-plus-graph mode.

Strict shared Zod contracts define live events, active project leases, privacy policy, checkpoints, context packs/diffs, graph snapshots, chat sessions/messages/actions, and HLC sync operations.

Projects use global UUIDs rather than path-derived IDs. Device-local paths become hashes; clones can match through normalized repository name and root commit fingerprint. Ambiguous matches create a provisional project and require the user to choose a candidate.

### Native product

The SwiftPM macOS 14+ app uses SwiftUI and narrow AppKit interop. It has a regular Dock window, persistent menu bar, separate Settings scene, authenticated SSE updates, polling recovery, live OS collectors, cited chat, and an interactive Canvas graph with deterministic off-main layout.

The Apple Foundation Models helper is a separate JSONL process compiled conditionally and guarded at runtime for macOS 26+. It exposes actual availability, guided checkpoint generation, and chat streaming without dropping macOS 14–25 support.

### Models

Continuum has capability-based providers for:

- Apple’s on-device system model when macOS 26+, hardware, and Apple Intelligence make it available;
- local Ollama, with `gemma3n:e2b` as the initial configured model;
- explicit OpenAI Responses API models, including GPT-5.6 Sol, Terra, and Luna plus an advanced custom ID.

Provider selection is a privacy decision. Continuum never silently falls back from one provider to another. OpenAI keys remain environment-only, eligible requests use `store:false`, and the product does not describe that setting as Zero Data Retention.

### Agent chat

Native chat builds a bounded Context Pack before calling the selected Apple, Ollama, or OpenAI provider. The PWA’s remote chat composes a bounded cited answer from synchronized checkpoints. Both surfaces cite checkpoints and related entities, while active hypotheses are labeled unverified. A second secret scan runs on assistant output before persistence.

The agent can only search context, get a diff, select a project, create a checkpoint, or acknowledge a baseline. Read actions run immediately. Every state-changing action requires an explicit confirmation button. There is no shell, file-content, arbitrary HTTP, or code-execution tool.

The remote companion can complete a confirmed synchronized-baseline acknowledgement. Checkpoint creation and authoritative project selection require the Mac; remote confirmation returns a structured `paired_mac_required` result without queueing or executing a device command.

### Synchronization, graph, and remote MCP

The optional Docker Compose deployment includes Fastify, PostgreSQL, Neo4j, an idempotent projection worker, the React/Vite PWA, and Caddy HTTPS termination.

PostgreSQL is the synchronized account/oplog source of truth. Neo4j is rebuildable. If projection is unavailable, sync continues, lag is shown, and bounded graph responses fall back to PostgreSQL until the projection recovers.

Authentication uses Auth0. The PWA and native app use Authorization Code with PKCE; the Mac stores refresh credentials only in Keychain. Remote MCP publishes OAuth protected-resource metadata. Copy-once API keys have `ctm_<id>_<secret>` format and are stored only as a peppered HMAC-SHA-256 digest. A key binds to its first physical sync device, and device revocation revokes its bound keys.

Local stdio and remote Streamable HTTP MCP share the same six read-only operations. Both are bounded, tenant/project scoped, and cite checkpoint provenance.

## How OpenAI is used

GPT-5.6 is an explicitly selected cloud provider for eligible checkpoint generation, grounded chat, and optional Context Diff briefing. Continuum sends only bounded, sanitized metadata and validates structured checkpoint evidence against the supplied event IDs.

Codex is also the primary agent consumer. The local/remote MCP server supplies current state, history, semantic search, resume packs, change diffs, and graph snapshots so Codex can recover context without a hand-written prompt or pasted transcript.

The recorded submission should select GPT-5.6 Sol visibly, show the cloud-active indicator, generate a real cited response, and finish with a Codex MCP handoff from the exact final build.

## Privacy architecture

Privacy runs twice: once inside each adapter and again before daemon persistence. Collector queues hold sanitized events only and retry through daemon deduplication.

Users can toggle sources, optional window titles, relative paths, URL hosts/paths, safe command names/flags, retention, allow/ignore rules, confidential local collection, and personal cloud eligibility. Four protections are immutable: secret rejection, attribute allowlisting, prohibited-content exclusion, and the confidential cloud block.

Rejected data never enters an audit row. The audit stores only fixed rule, decision, count, source, and time. Sanitized raw events expire after the configured period and never beyond 24 hours. Checkpoints retain minimal evidence summaries and IDs. Confidential context remains local and cannot enter providers, sync, MCP, or cloud storage.

## Challenges

### Identity without leaking paths

Clones need a shared identity, but absolute paths and remotes are sensitive and device-specific. The solution combines a global UUID with a device-local hashed alias and a repository fingerprint based on normalized name/root commits. The hard case is ambiguity, so Continuum refuses to merge silently and persists a user-confirmable conflict.

### One privacy contract across seven collectors

Each source starts with a different raw shape. A terminal command, browser URL, FSEvent path, and Git hook cannot share a superficial sanitizer. We built source-specific first gates plus a strict shared daemon gate and made retry queues contain only already-reduced events.

### Supporting Apple’s newest model without abandoning macOS 14

Foundation Models is compile-time and runtime conditional. A persistent Swift JSONL helper isolates availability checks and generation while the main product remains compatible with earlier macOS versions.

### Offline sync with a rebuildable graph

Device sequence, HLC, idempotency, immutable collision rules, tombstones, and privacy revalidation all need to agree. PostgreSQL therefore owns the operation log, while Neo4j is deliberately disposable and replayable.

### Keeping agent actions safe

A useful agent should help manage context, but this product should never become a remote shell. We constrained the action vocabulary to five context operations and separated immediate reads from confirmed mutations.

## Accomplishments we are proud of

- One architecture spans private local capture, native experience, synchronized companion, and two MCP transports without making the cloud the observer.
- Checkpoint claims are structurally tied to real event evidence.
- Context Diff has a user-controlled baseline; reading context never erases unseen changes.
- Chrome is paired by a short-lived challenge and automatically uses an expiring active-project lease.
- The graph has stable bounded contracts across SwiftUI, Sigma.js, local MCP, PostgreSQL fallback, and Neo4j.
- Provider, collector, engine, vector, synchronization, and projection health are independent rather than collapsed into one misleading “degraded” state.
- Privacy controls are flexible without making credential/content protections optional.

## What we learned

Better agent memory is mostly a systems problem: identity, provenance, privacy, lifecycle, and retrieval matter before model cleverness does. Events are valuable only when attribution is reliable. Summaries are valuable only when claims are cited. Sync is safe only when eligibility is rechecked at transmission time. A graph service is operationally useful only when it can be rebuilt from an authoritative log.

The strongest product behavior also came from refusing hidden automation: no silent provider fallback, no Chrome project guessing without a lease, no automatic baseline movement, no ambiguous clone merge, and no mutating chat action without confirmation.

## What is next

- Signed/notarized distribution and a packaged collector installer.
- Broader accessibility and performance validation on multiple Mac configurations.
- More explicit project-conflict management and graph comparison tools.
- Optional end-to-end encrypted synchronization for users who do not want a server-queryable companion.
- Additional opt-in semantic adapters that preserve the same no-content boundary.

Screen capture, content collection, remote shell/file access, and silent cloud fallback are not roadmap goals.

## Built with

TypeScript, Node.js 24, Fastify, Zod, SQLite/FTS5/sqlite-vec, local MiniLM embeddings, Swift, SwiftUI, AppKit, Foundation Models, Ollama, OpenAI Responses API, MCP, PostgreSQL, Neo4j, Docker Compose, Caddy, Auth0, React, Vite, TanStack Query, Graphology, Sigma.js, Chrome Manifest V3, VS Code Extension API, zsh, and Git hooks.

## Links and submission metadata

```text
Public repository: TBD
Public YouTube video: TBD
Primary Codex /feedback session ID: TBD
Final commit: TBD
Live service/PWA (if published): TBD
```

Before submission, replace each `TBD`, run the full protocol in [JUDGE_TESTING.md](JUDGE_TESTING.md), and remove any line whose evidence is not available to judges.
