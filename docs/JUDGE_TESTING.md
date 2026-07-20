# Continuum live judge testing

This document is both a reproducible test protocol and an evidence log for the final submission commit. It intentionally contains no claim that an environment-dependent check passed until a tester records the command, machine, commit, and result.

Continuum is live-only. The acceptance path is `./script/bootstrap.sh`; it must start empty and must not load test fixtures.

## Evidence header

Complete this immediately before submission:

```text
Commit:
macOS version / hardware:
Node / npm:
Xcode / Swift:
Ollama version and model:
OpenAI model tested:
Public service origin:
Auth0 tenant/application:
Chrome / VS Code versions:
Test start/end (timezone):
Tester:
```

Do not copy results from an earlier commit into this block.

## 1. Repository verification

From a clean checkout with Node 24:

```sh
npm ci
npm run verify
```

`verify` runs TypeScript builds/type checks, engine tests, all collector tests, Swift tests, cloud tests, PWA unit tests, production builds, and the local MCP subprocess smoke test.

Run the browser and staged-app checks separately:

```sh
npm run test:web:e2e
./script/build_and_run.sh --verify
```

Expected evidence:

- every command exits zero;
- local MCP stdout remains valid JSON-RPC with diagnostics on stderr;
- `dist/Continuum.app` contains the native executable and Foundation Models helper;
- the app launches as both a Dock application and menu-bar item;
- no runtime fixture route or replay control appears.

Record result:

```text
npm run verify:
Playwright:
staged app verify:
```

## 2. Clean live bootstrap

Stop any prior Continuum process, preserve any real database you need, and use a new empty data directory for this check. Then run:

```sh
CONTINUUM_DATA_DIR=/private/tmp/continuum-live-acceptance ./script/bootstrap.sh
```

Expected:

1. dependency installation and verification complete;
2. the loopback daemon becomes healthy;
3. the Dock app and menu-bar item appear;
4. Now/Timeline start empty and show live onboarding rather than a seeded project;
5. Settings opens from the menu and with Command-comma;
6. Privacy shows configurable sources/metadata plus locked immutable protections;
7. the database contains no runtime fixture source/project/model.

Database check:

```sh
sqlite3 /private/tmp/continuum-live-acceptance/continuum.sqlite \
  "select count(*) from events where source='demo'; select count(*) from checkpoints where model='fixture-rules-v1';"
```

Both values must be zero. Synthetic fixtures under test directories are allowed; runtime rows are not.

Record result:

```text
Bootstrap:
Empty state:
Fixture query:
Settings / Command-comma:
```

## 3. Live collector matrix

Use a disposable Git repository containing no secrets. Confirm the same global project appears for VS Code, terminal, Git, approved-folder, and Chrome events.

| Source | Live action | Expected retained metadata | Evidence to capture |
| --- | --- | --- | --- |
| VS Code | Focus a trusted single-root workspace; open and save a non-sensitive file. | Workspace focus and workspace-relative active/save metadata; no body. | Activity rows, active lease source `vscode`, queue drained. |
| zsh | Source the integration; run a safe command from the repository. | Safe command shape, relative cwd, duration, exit code; no output. | Activity row and lease source `terminal`. |
| Git | Install hooks in the disposable repo; commit and checkout. | SHA, branch, sanitized subject, operation, bounded relative paths. | Activity/timeline rows; no patch/blob/remote. |
| Chrome | Pair; allow one documentation domain; focus that tab while a lease exists. | Foreground allowlisted host and optional sanitized path. | Popup shows resolved project read-only; Activity shows Chrome. |
| macOS app | Activate, launch, and quit a harmless app. | Sanitized app name, bundle ID, lifecycle action. | OS app rows and collector health. |
| focused window | Explicitly enable; approve Accessibility; focus a non-sensitive window. | Sanitized title and app metadata, classified confidential/local-only. | Window row local only; permission health recovers. |
| approved folder | Approve a disposable subfolder; create/rename a non-sensitive file. | Coalesced relative path/change kind only. | Folder row on the approved project; no body. |

Also verify:

- capture pause/resume affects all sources without crashing;
- each source toggle stops that source independently;
- an offline collector keeps only its bounded sanitized queue and drains after daemon recovery;
- retrying the same event increments duplicate handling rather than storing another event;
- queued records disabled by a newer policy are dropped before persistence;
- switching projects flushes the prior project window;
- windows flush at 15 events, after 30 seconds, and with **Checkpoint Now**.

Record result:

```text
VS Code:
zsh:
Git:
Chrome:
macOS apps:
window titles:
approved folder:
offline/dedupe/policy replay:
```

## 4. Project identity and lease behavior

### Clone matching

1. Capture activity in a disposable Git repository.
2. Clone it to a different path on the same or second test Mac.
3. Capture VS Code/terminal activity in the clone.
4. Confirm both device-local aliases map to one global UUID when root commits and normalized names have one exact match.

Search the event transport/database to ensure neither absolute clone path nor Git remote was retained or synchronized.

### Ambiguous match

Create two candidate projects with the same fingerprint/name in the isolated test database, then ingest a new alias. Expected:

- a provisional project is created;
- `/v1/projects/identity/conflicts` returns a pending conflict and candidates;
- **Settings → Privacy → Project identity** shows the pending conflict, candidate picker, and explicit confirmation alert;
- only a listed target UUID is accepted;
- stale aliases and invalid targets fail without partial remapping.

### Lease authority

Verify VS Code/terminal activity overrides lower-authority Git/folder leases. Git expires after two minutes; ordinary strong leases expire after five minutes. Chrome must stop capturing when the lease expires and must not extend `expiresAt` after Chrome activity. A confirmed manual project selection can establish its separate lease.

Record result:

```text
Clone match:
Ambiguous confirmation:
Authority / expiry:
Chrome cannot renew:
```

## 5. Privacy canaries

Use fake, easily searchable values in an isolated data directory/account. Include:

- an OpenAI-shaped synthetic key;
- `Authorization: Bearer ...`;
- a private-key marker;
- `.env` and credential-like paths;
- a URL containing userinfo, token query, and fragment;
- a leading-space private command;
- an environment assignment;
- heredoc/multiline command input;
- distinctive document text and terminal output that never enters a collector event.

After exercising every adapter, chat, checkpoint provider, sync, and MCP path, search:

- adapter queue files;
- SQLite tables, FTS data, vector inputs, and migration backups;
- daemon/app/provider logs;
- captured provider requests;
- local REST/SSE/MCP responses;
- sync frames and PostgreSQL;
- Neo4j properties and projection logs;
- PWA responses and native/remote chat history.

Expected: the payload and meaningful substrings are absent everywhere. Only fixed aggregate rule/source/action/count/time rows exist in `privacy_audit`; there is no event ID or rejected value in the audit.

Toggle every mutable privacy control and prove the four immutable fields remain true in API responses and storage. Confirm confidential window/chat data never becomes cloud/provider/sync/MCP eligible.

Record result:

```text
Secret canaries:
Prohibited content:
Audit shape:
Mutable toggles:
Immutable protections:
Confidential isolation:
```

## 6. Retention and migrations

Automated migration tests must cover upgrade from the prior SQLite schema, transaction rollback, backup creation, live-data preservation, global UUID mapping, privacy-audit migration, and removal of demo-exclusive provenance only.

Manual checks on a copied database:

1. place expired and unexpired live events in the old schema;
2. open it with the new engine;
3. confirm the expired raw event is purged before the migration backup;
4. confirm unexpired live data/checkpoints/settings survive;
5. confirm runtime fixture-only rows are gone;
6. confirm backup filenames are versioned, the running-process 24-hour removal is scheduled, and overdue files are removed on the next launch.

Set retention below 24 hours and confirm local expiry honors it. Confirm server raw events never exceed 24 hours, pending raw-event operations are scrubbed to tombstones, and deletion tombstones remain available for offline convergence for 30 days.

Record result:

```text
Automated migration tests:
Backup / live preservation:
Local event expiry:
Server expiry / tombstones:
```

## 7. Model providers

No provider smoke test is valid unless it invokes that real provider on the recorded machine.

### Apple Foundation Models

On an eligible macOS 26 Apple Intelligence machine:

```sh
npm run smoke:apple
```

Expected: health is available and a schema/evidence-valid checkpoint is returned. Exercise cited streaming chat and cancellation.

On macOS 14–25 and on macOS 26 with each unavailable condition, confirm the helper reports the exact ineligible, Apple-Intelligence-disabled, model-not-ready, or unsupported-locale state. The selected provider must not change automatically after failure.

### Ollama

```sh
npm run setup:models
npm run doctor
npm run smoke:ollama
```

Expected: `gemma3n:e2b` returns a schema-valid checkpoint with only supplied event IDs. Stop Ollama while selected and confirm the error is visible and no OpenAI request occurs.

### OpenAI

```sh
export OPENAI_API_KEY='test-account-key'
npm run smoke:openai
```

Exercise Sol, Terra, Luna, and a mocked custom ID at the contract boundary. Capture the request and confirm `store:false`, bounded sanitized input, and no local-only prior checkpoint. Confirm the key is absent from SQLite, logs, UI state, and sync frames.

Record result:

```text
Apple eligible:
Apple unavailable states:
Ollama:
OpenAI presets / custom mock:
No fallback:
Evidence validation:
```

## 8. Checkpoint, Context Diff, graph, and chat

Using live events only:

1. create at least three checkpoints containing a resolved/added blocker, a changed hypothesis, a decision, a file, and a commit;
2. explicitly acknowledge the first checkpoint;
3. create later live activity and request Context Diff;
4. confirm both checkpoint IDs and every typed change citation;
5. read `resume` and `diff` repeatedly and prove the acknowledged baseline does not move;
6. query/expand the same graph from SwiftUI and the PWA;
7. verify graph responses never exceed 500 nodes/1,000 edges and pagination/truncation is explicit.

In native chat, ask for current focus, context search, and change since baseline. Expected citations include real checkpoint IDs and relevant files/commits; active hypotheses are visibly unverified. Ask to create a checkpoint, acknowledge a baseline, and select a project. Each must remain pending until the confirmation button is pressed. Reject one action and confirm there was no state change.

Exercise user-secret rejection, provider-response secret rejection, streaming cancellation, provider outage, confidential local chat, and eligible synchronized chat.

In remote chat, confirm `search_context`/`get_diff` complete immediately, `ack_baseline` changes synchronized state only after confirmation, and confirmed `create_checkpoint`/`select_project` return `paired_mac_required` without queueing a device command. A cancelled run must discard proposals and must not persist a completed assistant response.

Record result:

```text
Checkpoint evidence:
Context Diff / baseline:
Native graph:
PWA graph:
Chat citations / hypotheses:
Action confirmation:
Remote action boundary:
Secret / cancellation / provider failures:
```

## 9. Local and remote MCP

The automated subprocess check is part of `npm run verify`. It must cover discovery and all six tools with bounded output, clean stdout, and no write behavior.

For the final live Codex check:

1. build and run Continuum with real checkpoints;
2. run `npm run cli -- mcp-config` and verify the absolute workspace path;
3. restart Codex;
4. prompt only **Continue where I left off.**

Expected: Codex calls Continuum, cites the correct checkpoint/file/commit, labels an active hypothesis unverified, and recommends a grounded next action. No pasted history is provided. MCP reads do not acknowledge the baseline.

For remote MCP at `/mcp`, test discovery and all six tools with:

- valid Auth0 `context:read` token;
- valid scoped API key;
- missing scope;
- wrong issuer/audience;
- expired/revoked key;
- another account’s project/entity IDs;
- malformed Streamable HTTP requests.

Expected: valid requests see only the authenticated tenant’s eligible synchronized context. Invalid/missing auth fails, tenant IDs cannot be selected by the client, and all tools remain read-only.

Record result:

```text
Local MCP smoke:
Live Codex handoff:
Remote MCP OAuth:
Remote MCP API key:
Scope / tenant isolation:
Primary Codex /feedback session ID:
```

## 10. Synchronization and authentication

Start the real stack with configured Auth0 and HTTPS:

```sh
docker compose --env-file infra/.env -f infra/docker-compose.yml up --build
```

Verify:

- native Authorization Code + PKCE sign-in through `ASWebAuthenticationSession`;
- refresh credential exists in Keychain and no refresh/access token exists in preferences/SQLite/logs;
- PWA Authorization Code + PKCE and audience/scopes;
- copy-once `ctm_...` key display and peppered digest-only database storage;
- first-push/pull API-key device binding and rejection on a different device;
- device revocation also revokes bound keys;
- offline local changes replay in order with no duplicate materialization;
- sequence gaps and idempotency collisions return conflict;
- HLC last-write-wins converges mutable policy/settings;
- immutable record replacement and resurrection are rejected;
- deletion tombstones converge after offline use;
- chat, baselines, settings, projects, checkpoints, and explicit graph mutations synchronize;
- confidential/ineligible records never cross the sync boundary.

Stop Neo4j while PostgreSQL/cloud stay available. Sync must continue, graph status must show projection degradation/lag, and remote graph must use the bounded PostgreSQL fallback. Restart Neo4j, replay the outbox, then perform a full confirmed projection rebuild and compare the resulting graph.

Record result:

```text
Native Auth0 / Keychain:
PWA Auth0:
API keys / device binding:
Offline replay / conflicts:
Tombstones / revocation:
Projection outage / recovery / rebuild:
```

## 11. UI and accessibility

Native checks:

- launch visibility, Dock/menu coexistence, singleton main window, and Settings frontmost behavior;
- Command-comma, capture controls, checkpoint, catch-up, and quit;
- independent engine, collector-permission, provider, vector, sync, and projection health;
- Accessibility denial/grant recovery;
- daemon loss/reconnect and SSE/polling recovery;
- model/provider changes without crash or fallback;
- graph pan/zoom/search/filter/fit/reset/selection/Open in Chat;
- VoiceOver labels, keyboard navigation, high contrast, reduced motion, light/dark mode.

PWA Playwright checks:

- Auth0 callback/protected routes;
- installable manifest/service worker;
- Now, Chat, Graph, Timeline, Privacy, Devices, Settings;
- desktop and narrow mobile layouts, including selected-node bottom sheet;
- chat SSE/cancel/reconnect and graph interaction;
- privacy editing, device revocation, API-key administration, remote MCP instructions;
- keyboard navigation, visible focus, high contrast, reduced motion, light/dark mode.

Record result:

```text
Native UI:
Native accessibility:
PWA desktop/mobile:
PWA accessibility/installability:
```

## 12. Performance and bounds

Local retrieval:

```sh
npm run benchmark:retrieval
```

The command creates test-only synthetic checkpoints in a temporary database, requires the expected result in a 10,000-checkpoint corpus, and fails at 500 ms. This benchmark data is never loaded into the app.

Also benchmark local and remote graph queries at 500 nodes/1,000 edges, native Canvas interaction, and Sigma.js desktop/mobile interaction. Record cold/warm timings, hardware, projection mode, and whether vectors were available; do not compare measurements from different modes as if they were equivalent.

Record result:

```text
Retrieval mode / time:
Local graph:
Remote Neo4j graph:
Remote PostgreSQL fallback:
Native/PWA frame responsiveness:
```

## 13. Final live-only acceptance

The final acceptance path must use only real activity collected during the session:

1. clean live bootstrap;
2. collect VS Code, zsh, Git, Chrome, macOS app, focused-window, and approved-folder metadata;
3. show a synthetic secret being rejected only as an aggregate audit counter;
4. create evidence-backed checkpoints;
5. acknowledge a real baseline and produce a real Context Diff;
6. inspect the graph and chat in the native app;
7. sync eligible context to the self-hosted service;
8. inspect the same graph and chat from the PWA;
9. call the same context through authenticated remote MCP;
10. ask Codex only “Continue where I left off” through local MCP.

Before recording, verify no personal secret, private URL, customer name, or proprietary document content is present in the chosen live session.

## Submission artifact checklist

Mark only artifacts that exist and are public/accessible:

```text
[ ] Licensed public repository
[ ] README setup and supported-platform statement
[ ] Architecture and privacy documentation
[ ] Exact final test log for submission commit
[ ] Codex collaboration/decision log
[ ] GPT-5.6 usage explanation
[ ] Primary Codex /feedback session ID
[ ] Devpost description
[ ] Screenshots from live data
[ ] Public sub-three-minute YouTube video
```

Do not insert placeholder URLs, session IDs, or “passed” claims into submission material.
