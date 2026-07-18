# Judge Testing Guide

This guide separates measured build/provider/MCP results from environment-dependent or unpublished submission evidence. The current suite, clean bootstrap, Gemma smoke, and FTS5-plus-graph benchmark have passed on the development machine. They do not prove OpenAI credentials, a genuine exported four-collector session, independent-machine setup, vector-mode performance, or a final recorded Codex `/feedback` session.

## Supported test environment

- macOS 14+ on Apple Silicon
- Node.js 24 and npm
- Xcode Command Line Tools / Swift 5.10+
- Optional for live local-model test: Ollama and `gemma3n:e2b`
- Optional for live cloud test: an `OPENAI_API_KEY` with access to the selected model
- Optional for live capture: VS Code 1.95+, Chrome 114+, Git, and zsh

## One-command demo path

From the repository root:

```sh
./script/bootstrap.sh --demo
```

Expected behavior:

1. Dependencies and build products are prepared.
2. The daemon starts on `127.0.0.1:43117` with a generated bearer token.
3. A unique project-local demo database is created, and only the Friday phase of `fixtures/jwt-friday-monday.jsonl` is replayed through the real ingestion/privacy/windowing pipeline with the deterministic provider.
4. Bootstrap terminal/API output and Timeline literally label fixture state **Synthetic deterministic replay**.
5. Friday has two semantic checkpoints. Press the Inspector toolbar’s **Mark Caught Up** to acknowledge the current Friday checkpoint.
6. In Context Diff, press **Load Synthetic Catch-Up**; Monday loads and the project now has three checkpoints.
7. The fixture secret canary is rejected.
8. Context Diff contains at least four meaningful changes, including a resolved dashboard 401, a disproven clock-skew hypothesis, a decision, files, and commit `a0ada710a0ada710a0ada710a0ada710a0ada710`.
9. `dist/Continuum.app` launches as a menu-bar accessory app.

The bootstrap pointer `.continuum-runtime/active-demo-db` lets `script/run_mcp.sh` open this fresh database without hard-coding its temporary path. An explicit `CONTINUUM_DB` still takes precedence.

If the bootstrap script reports degraded vector retrieval, that is a supported state. It should say `fts_graph`/degraded rather than silently representing vector search as available.

## Recorded verification results

The following commands passed on the development Apple Silicon Mac:

| Command | Recorded result |
| --- | --- |
| `npm run verify` | 32/32 engine tests, 29/29 collector tests, 6/6 Swift tests, TypeScript/collector builds and type checks, and MCP subprocess smoke passed. |
| `./script/bootstrap.sh --demo` | Full clean bootstrap passed with a fresh project-local database and Friday-phase load. |
| `./script/build_and_run.sh --verify` | Staged `dist/Continuum.app`, `Info.plist`, executable, and daemon health verified. |
| `npm run smoke:ollama` | Real `gemma3n:e2b` call returned a schema-valid checkpoint. |
| `npm audit` | Zero known vulnerabilities. |
| Normal app embedding warm-up | Official MiniLM `q4` weights downloaded and engine state reached `hybrid`. |
| `npm run benchmark:retrieval` | Correct result retrieved from 10,000 synthetic checkpoints in 9.4 ms, explicit `fts_graph` mode. |
| Ephemeral Codex MCP resumption | `codex exec -m gpt-5.6-sol` called `resume`, then `diff`, and returned the grounded file/commit/blocker/next action. |

These are local results on the development machine and are tied to verified implementation commit `7f3e0ca2c881f28673caec0658e88c3c7a6d9571`. The clean bootstrap used fresh dependencies/build state and a new demo database; it is not evidence from an unrelated judge machine.

Live-provider status at this refresh:

- `npm run smoke:openai` has not run because `OPENAI_API_KEY` is absent.
- The local ephemeral Codex handoff passed, but the primary recorded `/feedback` session is pending.
- Screenshots, the public video, public repository, and Devpost publication are pending.

## Deterministic verification

Run:

```sh
npm run verify
```

The core tests cover:

- daemon bearer authentication;
- event deduplication and aggregate secret auditing;
- collector aggregate-drop events being consumed as audit-only records;
- the Friday-to-Monday fixture producing three checkpoints and at least four changes;
- the acknowledged baseline;
- the 12,000-character Context Pack bound;
- oversized single-pack and MCP diff hard-bound behavior;
- populated graph nodes;
- the privacy canary’s absence from event and checkpoint storage;
- physical normalized-event expiry by trusted `received_at` while checkpoints remain;
- cloud exclusion of confidential events, prior local-only checkpoint text, local-only Context Diffs, and local-only checkpoints from all MCP tools;
- deterministic checkpoint and entity evidence plus rejection of hallucinated evidence IDs;
- stable provider failure codes without raw model-output snippets;
- canonical project identities across repository-root collectors;
- Ollama repair and global concurrency-one behavior;
- OpenAI `store:false`, every preset, custom model schema behavior, and evidence validation through mocked provider responses.

On the current MVP, the root command includes the core suite, all four collector suites, native Swift tests, TypeScript/collector builds, and the MCP subprocess smoke test. To isolate a component failure, run:

```sh
npm run verify -w @continuum/vscode-collector
npm --prefix collectors/chrome run verify
npm --prefix integrations/zsh run verify
npm --prefix integrations/git run verify
swift test --package-path native/ContinuumApp
```

Build/stage verification:

```sh
./script/build_and_run.sh --verify
```

This command has passed on the development machine. `.codex/environments/environment.toml` also provides a Codex **Run** action wired to `./script/build_and_run.sh`. Repeated launches stop only a daemon verified as belonging to this repository, refuse unrelated port owners, bind readiness to the newly launched PID, and detach the daemon from the invoking shell before opening the app.

## Inspect engine health

```sh
npm run doctor
```

The report includes Node version, database and token paths, sqlite-vec availability, embedding model status, provider health, and selected models. Interpret it carefully:

- `sqliteVector: false` or unavailable embeddings means supported FTS5-plus-graph degradation.
- OpenAI “available” currently means an API key is configured; it is not a live API request.
- Ollama health checks the local `/api/tags` endpoint, but checkpoint generation still needs a separate smoke test.

## Replay assertions

Run the fixture directly against a fresh temporary data directory so a prior replay cannot be deduplicated:

```sh
continuum_fixture_data="$(mktemp -d)"
CONTINUUM_DATA_DIR="${continuum_fixture_data}" CONTINUUM_DISABLE_EMBEDDINGS=1 npm run demo
```

Expected output contains:

- `label: "Synthetic deterministic replay"`;
- `checkpoints: 3`;
- one dropped/secret event;
- a baseline set to the second checkpoint;
- a bounded Context Pack with checkpoint provenance;
- a Context Diff that cites checkpoint IDs.

Do not publish the canary value from logs or screenshots. Its presence in the fixture source and absence from persistence is asserted by the automated test.

## MCP smoke test

The repository includes `.codex/config.toml` for the current workspace. It invokes `script/run_mcp.sh`, which uses an explicit `CONTINUUM_DB`, the latest bootstrap pointer, or the default database in that order. Build and print/regenerate the configuration if the clone path differs:

```sh
npm run build
npm run cli -- mcp-config
```

Copy the emitted block into `.codex/config.toml`, restart Codex in this project, and verify:

1. The `continuum` server discovers exactly `current`, `timeline`, `search`, `resume`, and `diff`.
2. `resume({ projectId: "continuum-demo" })` returns the correct blocker/files and stays under 12,000 characters.
3. `diff({ projectId: "continuum-demo" })` returns the acknowledged baseline and does not change it.
4. `search({ query: "dataset UUID dashboard 401", projectId: "continuum-demo" })` returns checkpoint provenance.
5. Hypotheses remain labeled `active`, `supported`, or `disproven` and are not stated as facts.
6. MCP diagnostics appear on stderr and stdout remains valid JSON-RPC.
7. A checkpoint backed by any confidential event is absent from every MCP tool while remaining available to the local inspector.

Final product test:

```text
Continue where I left off.
```

The acceptable answer cites a checkpoint ID, commit `a0ada710…`, and `src/DashboardAuth.ts`, distinguishes the disproven clock-skew hypothesis, and recommends validating the dataset UUID with the preserved RLS clause. No pasted history should be present in the user prompt.

An ephemeral local `codex exec -m gpt-5.6-sol` run passed this acceptance test: it invoked Continuum `resume`, recovered to the 12,000-character contract bound, invoked `diff`, and grounded the handoff in checkpoint `69359515-7842-407f-bdb4-eebb6ccf9231`, the file, commit, resolved 401, disproven hypothesis, and correct next action. This is not the still-pending primary `/feedback` session.

`npm run verify` includes `script/mcp-smoke.mjs`, which creates a temporary fixture database, discovers the five tools, calls each tool, checks compatibility text plus `structuredContent.data`, and byte-compares SQLite before/after a read. MCP opens the database read-only, enables sqlite-vec extension access when an initialized vector table exists, and otherwise continues in explicit degraded mode. Treat the manual Codex run and captured `/feedback` session as separate required product evidence, not an assumed pass from the protocol smoke test.

## Retrieval benchmark

Run:

```sh
npm run benchmark:retrieval
```

The command creates a temporary database, inserts 10,000 synthetic checkpoints, disables embeddings to force `fts_graph`, retrieves a known lexical checkpoint, fails at 500 ms or above, prints JSON, and removes the temporary data. The measured development-machine result was **9.4 ms** with the expected checkpoint present.

This supports a qualified FTS5-plus-graph claim only. It is not evidence for vector-mode latency, a different machine, or a clean clone.

## Live Ollama smoke test

```sh
npm run setup:models
npm run doctor
npm run smoke:ollama
```

Then:

1. Select Local / `gemma3n:e2b` in Continuum Settings.
2. Produce at least one new sanitized collector event.
3. Press **Checkpoint Now**.
4. Verify the checkpoint provider/model fields are `ollama` / `gemma3n:e2b`.
5. Verify every factual checkpoint item cites one of that window’s event IDs.
6. Stop Ollama and repeat once: Continuum must report provider failure and must not fall back to OpenAI.

This real smoke command passed with `gemma3n:e2b` on the development machine. The interactive collector-to-checkpoint and stopped-Ollama behavior remain useful final-demo rehearsals, and a different machine still requires its own model installation.

## Live OpenAI smoke test

```sh
export OPENAI_API_KEY="your-key"
npm run smoke:openai
./script/build_and_run.sh
```

Then:

1. Select OpenAI and test `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` only if the account has access.
2. For each tested model, create a checkpoint from sanitized public/personal events and verify the shared schema/evidence contract.
3. Test an advanced custom ID with a mock or an actually available model; record which was used.
4. Create a confidential synthetic event and verify it and prior local-only checkpoint text are excluded from OpenAI input.
5. Create a secret-shaped synthetic event and verify it is rejected before persistence.
6. Verify a Context Diff containing a local-only checkpoint is refused for briefing; generate an eligible briefing and verify it adds no facts beyond the diff.

This smoke command has not run because no API key is configured. Do not expose the API key in screenshots, shell history, logs, or test fixtures. Do not describe `store:false` as Zero Data Retention.

## Live collector matrix

Before capture, print the canonical ID and paste it into Chrome:

```sh
npm run --silent project-id -- /path/to/repository
```

VS Code, zsh, and Git derive that same ID when their observed root is the canonical repository root. `CONTINUUM_HOST` accepts only `127.0.0.1`, `localhost`, or `::1`; `OLLAMA_URL` is likewise restricted to credential-free loopback HTTP.

| Collector | Action | Expected safe event | Negative assertion |
| --- | --- | --- | --- |
| VS Code | Focus/save a file in a trusted single-root workspace. | Workspace-relative path and language ID. | No document text; secret/generated/outside paths absent or aggregated. |
| zsh | Run a safe test command. | Safe command shape, relative cwd, duration, exit code. | No output or full sensitive arguments; private/heredoc/assignment commands aggregated. |
| Git | Commit and checkout in a repo with installed hooks. | SHA, branch, subject, operation, relative paths. | No patch/blob/remote; installer refuses existing hooks. |
| Chrome | Focus an allowed documentation URL containing query and fragment. | Allowlisted host and sanitized path. | No query, fragment, title, DOM, history, cookies, background or incognito tab. |

Disconnect the daemon for each collector, generate one safe event, reconnect, and confirm the sanitized queue retries once effectively; the daemon should count retry duplicates instead of creating duplicate events.

To create a genuine sanitized trace after all four sources have produced events for one non-demo project:

```sh
npm run cli -- export-recording <output.jsonl> [projectId]
```

The exporter refuses any demo-contaminated project, refuses a project missing VS Code, terminal, Git, or Chrome, and refuses to overwrite an existing file. Fixture replay must never be called a recorded live session.

## Native app checks

1. Confirm no Dock icon appears and the menu-bar status item does.
2. Stop the daemon; verify the UI becomes disconnected without crashing.
3. Restart the daemon; verify authenticated SSE reconnects after its two-second retry delay while the 15-second polling fallback remains active.
4. Pause capture and confirm ingestion returns no accepted events; resume and confirm capture continues.
5. Switch local/cloud provider and model; confirm the menu-bar label and Provider Health update.
6. Trigger a manual checkpoint.
7. Open every Inspector section: Now, Activity, Timeline, Context Diff, Privacy, Provider Health.
8. On the Friday synthetic state, press **Mark Caught Up** and verify it becomes the baseline.
9. Press **Load Synthetic Catch-Up** and verify Monday appears without moving that baseline.
10. Force embeddings off and confirm the inspector shows degraded retrieval.
11. Confirm Privacy shows fetched aggregate rule counts and Timeline labels fixture checkpoints **Synthetic deterministic replay**.
12. With a configured key and cloud-eligible diff, press **Generate GPT Briefing**; confirm local-only diffs are refused.

The current app uses authenticated SSE revision events as its live path, retries a failed stream after two seconds, and independently refreshes every 15 seconds as fallback.

## Privacy inspection

After a synthetic-secret session, inspect all relevant surfaces without printing real credentials:

- SQLite event titles/attributes and checkpoint JSON;
- graph labels and FTS values;
- provider-run metadata;
- collector queue files;
- daemon and collector logs;
- REST `/v1/resume`, `/v1/diff`, and `/v1/privacy`;
- all MCP tool responses.

Expected result: no synthetic secret value, `.env` path, URL query token, private command, file/document text, or terminal output. Privacy audit output may include generic rule names and counts. Collector aggregate-drop messages must not appear in events, checkpoints, FTS, graph, embeddings, or provider input. Provider failures may contain only stable error codes such as `provider_invalid_response`, not raw model responses.

## Checks not yet proven by the deterministic suite

Do not claim these without separate evidence on the final commit:

- live OpenAI success for every model preset;
- the final recorded Codex response and primary `/feedback` session (the ephemeral local MCP run passed);
- all four collectors in one genuine exported live session;
- bootstrap on an independent judge machine without repository caches;
- vector-mode or cross-machine retrieval latency;
- signed/notarized packaging.

## Final submission record

Fill this table after testing; leave failures explicit.

| Check | Commit | Machine/environment | Result | Evidence link |
| --- | --- | --- | --- | --- |
| `npm run verify` | `7f3e0ca2c881f28673caec0658e88c3c7a6d9571` | Development Apple Silicon Mac | **PASS** — 32 engine, 29 collector, 6 Swift, build/typecheck, MCP smoke | `[TERMINAL_EVIDENCE_LINK]` |
| Staged app/daemon verify | `7f3e0ca2c881f28673caec0658e88c3c7a6d9571` | Development Apple Silicon Mac | **PASS** | `[TERMINAL_EVIDENCE_LINK]` |
| Full clean bootstrap | `7f3e0ca2c881f28673caec0658e88c3c7a6d9571` | Development Apple Silicon Mac | **PASS** — fresh project-local demo database | `[TERMINAL_EVIDENCE_LINK]` |
| Gemma 3n live | `7f3e0ca2c881f28673caec0658e88c3c7a6d9571` | Development machine | **PASS** — real schema-valid `gemma3n:e2b` output | `[TERMINAL_EVIDENCE_LINK]` |
| MiniLM hybrid warm-up | `7f3e0ca2c881f28673caec0658e88c3c7a6d9571` | Development machine | **PASS** — official `q4` weights, `hybrid` ready | `[TERMINAL_EVIDENCE_LINK]` |
| `npm audit` | `7f3e0ca2c881f28673caec0658e88c3c7a6d9571` | Development machine | **PASS** — zero known vulnerabilities | `[TERMINAL_EVIDENCE_LINK]` |
| OpenAI live | `7f3e0ca2c881f28673caec0658e88c3c7a6d9571` | Development machine | **NOT RUN — missing key** | `[LINK]` |
| Four-collector live session | `7f3e0ca2c881f28673caec0658e88c3c7a6d9571` | `[ENV]` | **NOT YET RECORDED** | `[LINK]` |
| Codex MCP resumption | `7f3e0ca2c881f28673caec0658e88c3c7a6d9571` | Development machine | **PASS — ephemeral GPT-5.6 Sol `resume` + `diff`; primary `/feedback` pending** | `[PRIMARY_CODEX_FEEDBACK_SESSION_ID]` |
| 10k retrieval benchmark | `7f3e0ca2c881f28673caec0658e88c3c7a6d9571` | Development Apple Silicon Mac | **PASS — 9.4 ms, `fts_graph`** | `[TERMINAL_EVIDENCE_LINK]` |
