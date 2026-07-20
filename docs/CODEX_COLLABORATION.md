# Codex collaboration and decision log

Continuum was designed and implemented in collaboration with Codex. The human supplied the product direction, privacy posture, release scope, visual concepts, platform constraints, and acceptance criteria. Codex helped inspect the evolving repository, implement bounded workstreams, connect interfaces, write tests, identify trust-boundary gaps, and maintain this decision record.

This document does not claim a test or external deployment succeeded. Final evidence belongs in [JUDGE_TESTING.md](JUDGE_TESTING.md) and must be recorded from the exact submission commit.

## Human-provided goals

The core product requirements were:

- treat context as infrastructure rather than a screenshot archive or chatbot transcript;
- keep SQLite as the Mac’s local source of truth;
- collect live macOS/developer metadata only and remove runtime fixtures/replay;
- support a real Dock app plus persistent menu-bar controls;
- provide cited native/PWA chat and an interactive graph;
- support Apple Foundation Models, Ollama, and opt-in OpenAI without silent fallback;
- make privacy controls configurable while keeping credential/content exclusions immutable;
- identify projects globally across clones without exposing paths/remotes;
- add self-hosted multi-device sync, Auth0, API keys, PostgreSQL, Neo4j, PWA, and remote MCP;
- keep local stdio MCP read-only and add authenticated tenant-scoped Streamable HTTP MCP;
- preserve macOS 14+ while runtime-gating Apple Foundation Models to macOS 26+.

The visual direction was supplied through approved desktop graph/chat, privacy, and mobile PWA concepts. Implementation translated those concepts into native SwiftUI and responsive React surfaces; the source concepts are development inputs, not public submission links.

## How Codex was used

Codex work was divided into repository-bounded streams so interfaces could be reviewed together:

- shared V2 contracts, global project identity, SQLite migrations, privacy, HLC sync, graph, chat, and local APIs;
- source-specific VS Code, zsh, Git, Chrome, and macOS collectors;
- SwiftUI Dock/menu-bar app, Settings behavior, OS collectors, chat, graph, Auth0 PKCE, and Keychain integration;
- Fastify/PostgreSQL/Neo4j synchronization, Auth0/API keys, remote context/chat/MCP, and Docker Compose;
- React/Vite PWA transport, routes, graph/chat UX, responsiveness, and tests;
- threat-boundary review, migration/revocation/secret tests, documentation, and live-only acceptance design.

Codex also used repository inspection and executable tests to challenge plan assumptions. When an interface existed only on one side—for example, a Chrome challenge without an in-app approval surface, or an API key without a physical-device binding—the implementation was treated as incomplete rather than documented as finished.

## Decision log

### Semantic events instead of visual observation

**Decision:** Collect allowlisted tool/OS events, not screenshots or content.

**Reason:** Semantic metadata is smaller, more precise, and can be sanitized before persistence or transport. It also makes source-specific privacy invariants testable.

**Tradeoff:** Continuum cannot reconstruct arbitrary on-screen activity or work performed outside enabled sources.

### Live-only runtime

**Decision:** Remove runtime fixture routes, seeded Context Packs/checkpoints, fixture providers from ordinary flows, and replay/loading controls.

**Reason:** The app should prove real collection and should never let judges confuse deterministic fixture output with live user activity.

**Tradeoff:** A live demo depends on functioning collectors and a configured provider. Synthetic fixtures remain only in automated tests, where they are appropriate and isolated.

### Two privacy gates

**Decision:** Sanitize at each adapter and repeat strict validation/allowlisting/secret scanning before daemon persistence.

**Reason:** Raw values should not enter a durable retry queue or cross a process boundary. The daemon must still treat a collector as untrusted.

**Tradeoff:** Some privacy logic is source-specific and duplicated by design; changes require contract coordination and tests on both sides.

### Configurable policy with immutable protections

**Decision:** Let users control sources, selected metadata, retention, domain/path rules, and personal cloud eligibility, but encode secret detection, attribute allowlisting, prohibited-content exclusion, and confidential cloud blocking as non-disableable literal-true contract fields.

**Reason:** Users need control over useful metadata without a switch that turns Continuum into a content or credential collector.

**Tradeoff:** “Privacy filters are toggleable” does not mean every exclusion is optional.

### Global UUID plus local alias and repository fingerprint

**Decision:** Replace path-derived project IDs with global UUIDs. Use a device-local path hash and normalized-name/root-commit fingerprint to match clones. Require confirmation on ambiguity.

**Reason:** Paths are device-specific and sensitive; remotes may include credentials. A root fingerprint supports clone matching without either.

**Tradeoff:** Repositories without commits cannot fingerprint, and deliberately duplicated histories/names can require user intervention.

### Expiring active-project lease

**Decision:** Use an authority-ranked lease. VS Code focus/terminal are strongest; Git/folder are lower confidence; Chrome reads but never renews.

**Reason:** Chrome cannot safely inspect the filesystem and should not ask users to paste project IDs. A lease makes attribution automatic while preventing the browser from declaring its own project indefinitely.

**Tradeoff:** Chrome correctly skips activity if the user has not recently established a project elsewhere.

### SQLite locally, PostgreSQL for sync, Neo4j as projection

**Decision:** Keep SQLite as the local source of truth; use PostgreSQL for synchronized account/oplog state; rebuild Neo4j from a PostgreSQL outbox.

**Reason:** The Mac remains lightweight/offline-capable, synchronization has an auditable ordered log, and a graph outage cannot block device convergence.

**Tradeoff:** There are two graph representations and explicit projection lag/recovery semantics.

Neo4j was chosen over Kùzu because the Kùzu repository is archived. This does not make Neo4j a local runtime dependency.

### Ordered migrations and bounded backups

**Decision:** Run ordered SQLite/PostgreSQL migrations transactionally. Before a local schema upgrade, purge already-expired raw events and create a versioned backup whose removal is scheduled at 24 hours and retried by startup cleanup.

**Reason:** Live data should survive upgrades without extending raw-event privacy retention through backups.

**Tradeoff:** Migration code must understand old provenance well enough to remove demo-only rows without damaging live history.

### Evidence-backed checkpoints

**Decision:** Reject a checkpoint if any factual item cites an event outside the supplied window.

**Reason:** Fluent but unsupported memory is actively harmful. Explicit blocker/hypothesis lifecycle makes uncertainty machine-readable.

**Tradeoff:** Invalid model output leaves the window pending and requires a retry rather than producing a partial checkpoint.

### Explicit degraded retrieval

**Decision:** Use vectors when local MiniLM/sqlite-vec are ready; otherwise continue with FTS5 plus graph, importance, and recency while visibly reporting degradation.

**Reason:** Capture and local memory must work offline or on a machine where a native vector extension/model is unavailable.

**Tradeoff:** Retrieval quality/mode differs and performance evidence must identify the active mode.

### User-controlled Context Diff baseline

**Decision:** “Since I last cared” means the last checkpoint the user explicitly acknowledged or a baseline explicitly supplied to `diff`.

**Reason:** Reading context must not mutate it or erase unseen change.

**Tradeoff:** The user has to mark caught up intentionally.

### Capability-based providers with no fallback

**Decision:** Apple Foundation Models, Ollama, and OpenAI each expose health, structured checkpoint generation, and chat capability. On a fresh store Apple is selected only if an initial health check reports it available; otherwise Ollama remains selected. Later failures never switch providers.

**Reason:** Provider choice affects privacy, cost, availability, and model behavior. Cloud use cannot be a hidden recovery path.

**Tradeoff:** Generation pauses until the configured provider recovers or the user explicitly changes it.

### Swift helper for Apple Foundation Models

**Decision:** Isolate Foundation Models behind a persistent JSONL Swift helper compiled conditionally and guarded with macOS 26 availability checks.

**Reason:** The newest on-device framework can be used without raising the app’s macOS 14 deployment target or coupling the Node daemon directly to a Swift-only API.

**Tradeoff:** The helper protocol needs its own lifecycle, serialization, error mapping, and evidence validation.

### OpenAI `store:false` wording

**Decision:** Use `store:false` for eligible Responses API requests and never describe it as Zero Data Retention.

**Reason:** A request storage option and contractual retention terms are not interchangeable.

### Five safe chat actions

**Decision:** Chat can only search context, get a diff, select a project, create a checkpoint, or acknowledge a baseline. Read actions execute immediately; mutations require an explicit confirmation UI.

**Reason:** The agent can help manage Continuum context without becoming a shell, filesystem reader, browser automator, or general tool runner.

**Tradeoff:** Chat cannot directly edit code or execute a recommended next action.

### Read-only MCP on both transports

**Decision:** Extract `current`, `timeline`, `search`, `resume`, `diff`, and `graph` into read-only bounded semantics for local stdio and remote Streamable HTTP.

**Reason:** Codex receives useful context without gaining a covert mutation channel. A common contract keeps local and synchronized handoffs comparable.

**Tradeoff:** Checkpoint creation and baseline acknowledgement stay in the native/PWA confirmed-action path, not MCP.

### Auth0 plus device-bound API keys

**Decision:** Use Auth0 Authorization Code with PKCE for people and compatible clients, with native refresh credentials in Keychain. Add copy-once, pepper-digested API keys that bind to their first physical sync device.

**Reason:** OAuth supports browser/native sign-in and MCP discovery; scoped API keys support automation. Binding prevents a revoked device from returning under an unbound key.

**Tradeoff:** Auth0 is a managed identity dependency, and operators must configure issuer, audience, clients, scopes, rotation, and HTTPS correctly.

### Server-queryable sync, not zero knowledge

**Decision:** Encrypt transport with TLS but allow the self-hosted service to process policy-eligible plaintext context for search, projection, chat, and MCP.

**Reason:** The requested remote graph and agent interface need server-side queries in this release.

**Tradeoff:** This is not end-to-end encrypted or zero knowledge; deployment operators are inside the trust boundary.

### Dock app plus persistent menu bar

**Decision:** Run as a regular application with a primary window while retaining `MenuBarExtra` quick controls and a real Settings scene.

**Reason:** Chat, graph, privacy, and devices require a discoverable full product surface; capture status still benefits from persistent lightweight access.

**Tradeoff:** Continuum is visible in the Dock rather than behaving as a hidden accessory process.

## Review corrections during implementation

The working design was tightened when repository evidence exposed gaps:

- Chrome’s manual project-ID and bearer-token UX was replaced with a five-minute pairing challenge and read-only active lease.
- All collectors were moved to V2 global project/device identity instead of retaining path-derived IDs.
- Ambiguous clone matches gained a persisted confirmation workflow rather than returning a transient warning.
- Privacy audit rows stopped retaining event IDs; one-way hashes live in a separate dedupe table.
- HLC/device sequence allocation became transactional and monotonic, with materialized per-entity clocks for deterministic LWW.
- Pending sync operations are revalidated against current policy; expired event payloads are scrubbed.
- Explicit graph node/edge operations synchronize instead of relying only on checkpoint reconstruction.
- Chat user text and provider output both pass the secret boundary before durable completion.
- Chrome collector credentials were narrowed to Chrome-source ingestion and limited policy/lease reads.
- API keys gained transactional physical-device binding, and device revocation gained bound-key revocation.
- One generic degraded banner was split into independent engine, collector, provider, vector, sync, and projection health.
- Settings uses a real `openSettings()` action with activation/frontmost recovery and Command-comma.
- macOS OAuth moved to `ASWebAuthenticationSession` with PKCE and Keychain-only refresh credential storage.

These bullets describe architectural changes in the source, not proof that every environment-dependent acceptance scenario has been run.

## Areas requiring human/external verification

The following cannot be inferred from source inspection or unit tests alone:

- Apple Foundation Models output on eligible macOS 26 hardware and every unavailable system state;
- live Ollama and OpenAI output with the submission models/accounts;
- Auth0 issuer/audience/client/scopes and refresh-token rotation in the real deployment;
- public HTTPS/Caddy behavior, tenant isolation, and remote MCP interoperability;
- offline multi-device conflict/revocation and Neo4j outage/rebuild against real services;
- seven-source live capture and privacy-canary absence on the recording machine;
- accessibility, performance, native/PWA rendering, and clean-machine bootstrap;
- public repository, screenshots, video, Devpost entry, and the primary Codex `/feedback` session ID.

Record these only after running [JUDGE_TESTING.md](JUDGE_TESTING.md).

## Final Codex `/feedback` procedure

1. Check out the final submission commit and run the full verification/live acceptance path.
2. Capture real activity and checkpoints; do not load test data.
3. Start a fresh Codex task with the final Continuum MCP configuration.
4. Prompt only **Continue where I left off.**
5. Confirm Codex calls Continuum and cites the correct checkpoint, file, commit, blocker/hypothesis state, and next action.
6. Use Codex `/feedback` for that exact task.
7. Record the returned session ID, commit, provider, and MCP transport here and in `DEVPOST.md`.

```text
Primary /feedback session ID: TBD
Commit: TBD
Provider/model: TBD
MCP transport: TBD
```

Do not invent, reuse, or prefill an unrelated session ID.
