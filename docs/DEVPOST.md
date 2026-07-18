# Devpost Submission Draft

Replace every `[PLACEHOLDER]` only after the artifact exists. Do not submit bracketed placeholders.

## Submission metadata

- **Project:** Continuum
- **Category:** Developer Tools
- **Tagline:** An event-driven context operating system for AI agents.
- **Deadline:** [July 21, 2026 at 5:00 PM PDT](https://openai.devpost.com/rules) / July 22 at 5:30 AM IST
- **Repository:** `[PUBLIC_GITHUB_URL]`
- **Video:** `[PUBLIC_YOUTUBE_URL]`
- **Primary Codex /feedback session ID:** `[PRIMARY_CODEX_FEEDBACK_SESSION_ID]`
- **Devpost URL after publication:** `[DEVPOST_PROJECT_URL]`
- **Supported platform:** macOS 14+ on Apple Silicon; source-run build
- **License:** MIT

## Elevator pitch

Current AI memory products often brute-force context by capturing screens or storing raw histories. Continuum captures less and understands more. It collects small, source-specific developer events, removes sensitive data twice on-device, turns the remaining metadata into evidence-backed semantic checkpoints, and exposes bounded Context Packs and Context Diffs to Codex over a read-only local MCP server.

The result is a simple moment: ask Codex only “Continue where I left off.” Codex retrieves the current goal, blockers, hypotheses, decisions, files, and commits—with checkpoint provenance—and recommends the next action without pasted history.

That handoff has passed in an ephemeral local `codex exec -m gpt-5.6-sol` test using Continuum `resume` and `diff`. The primary recorded `/feedback` session for submission is still pending.

## Inspiration

AI agents are good at reasoning over context but developers still spend time reconstructing that context: which branch mattered, what failed, what changed while they were away, and which hypothesis was disproven. Existing “memory” approaches tend to maximize observation. That creates privacy risk, noisy retrieval, and unnecessary tokens.

Continuum starts with a different abstraction: context is infrastructure. The operating layer should emit semantic state changes, keep the observer local, and let the cloud act only as an explicitly selected consultant.

## What it does

Continuum is a macOS menu-bar app backed by a local TypeScript daemon. Four opt-in adapters collect allowlisted metadata:

- VS Code: trusted workspace focus and workspace-relative active/save paths;
- zsh: safe command shape, repository-relative cwd, duration, and exit code;
- Git: SHA, branch, sanitized subject, operation, and changed paths;
- Chrome: the foreground allowlisted host and a URL path with sensitive components removed.

Every adapter filters before transport. The daemon validates and filters again, stores sanitized events in SQLite, and groups them into project windows. Ollama Gemma 3n or an explicitly selected OpenAI model produces a structured checkpoint. Every factual item must cite a supplied event ID; an invented ID rejects the checkpoint.

Retrieval combines local vectors, FTS5, graph expansion, importance, and recency. `continuum.resume` returns a maximum of 12 checkpoints and 12,000 serialized characters. `continuum.diff` compares the current state with the checkpoint the user explicitly marked as “last cared.” MCP reads never move that baseline.

## The “aha” moment

In the demo, bootstrap creates a fresh database and loads a clearly labeled **Synthetic deterministic replay** of Friday, ending with an unresolved dashboard 401 and a clock-skew hypothesis. The user presses **Mark Caught Up**, then **Load Synthetic Catch-Up** to load Monday. Context Diff identifies commit `a0ada710a0ada710a0ada710a0ada710a0ada710` and changed files, resolves the 401, marks clock skew disproven, and records the dataset-UUID/RLS decision. Codex receives only Continuum’s bounded, cloud-safe MCP output and can recommend the correct next action with cited provenance.

## How we built it

- Node 24, TypeScript, Fastify, Zod, and Node’s SQLite API
- SQLite FTS5, graph node/edge tables, optional sqlite-vec
- Local 384-dimensional MiniLM embeddings through Transformers
- Ollama structured JSON checkpointing with `gemma3n:e2b`
- OpenAI Responses API structured output with `store:false`
- MCP TypeScript SDK over local stdio
- SwiftPM and SwiftUI `MenuBarExtra` for the native macOS shell
- VS Code extension API, zsh hooks, repository-local Git hooks, and Chrome Manifest V3

The default cloud checkpoint model is `gpt-5.6-terra`; the recorded demo target uses `gpt-5.6-sol`. `gpt-5.6-luna` and an advanced custom model ID are also selectable. The OpenAI API key is accepted only through `OPENAI_API_KEY` and is never persisted by Continuum.

## How OpenAI is used

Continuum uses the OpenAI Responses API in two explicit, user-selected paths:

1. Generate a schema-valid, evidence-backed semantic checkpoint from sanitized `public`/`personal` events.
2. Turn an already-computed deterministic Context Diff into a concise catch-up briefing and next actions.

Both paths request structured output and set `store:false`. Secret events are rejected before persistence; confidential events are excluded from cloud input. OpenAI checkpointing receives no prior local-only checkpoint text, and briefing generation refuses any Context Diff containing a local-only checkpoint. Local-to-cloud fallback never happens silently. `store:false` is not presented as Zero Data Retention.

Codex is also the product surface: the project-scoped read-only MCP server lets Codex invoke `current`, `timeline`, `search`, `resume`, and `diff`. It omits any checkpoint whose source window included confidential metadata, while the native local inspector retains that view. The primary Codex collaboration session will be supplied as `[PRIMARY_CODEX_FEEDBACK_SESSION_ID]`.

## Privacy and security

Continuum never captures screenshots, file/document bodies, terminal output, keystrokes, browser DOM/history/titles/cookies, clipboard data, Git patches/blobs/remotes, or credentials.

The first privacy engine runs inside each adapter, before its local retry queue. The daemon repeats schema validation, source-specific attribute allowlisting, URL/path reduction, and secret scanning before SQLite. Secret and collector aggregate-drop events produce audit counters only; they cannot become stored activity or model input. Event expiry uses trusted daemon receipt time. Cloud selection is visible consent for eligible sanitized metadata; confidential data remains local.

The daemon binds to loopback only (`CONTINUUM_HOST` cannot select a LAN address), requires a generated bearer token for all data routes, and stores the token with restrictive file permissions. `OLLAMA_URL` is also restricted to credential-free loopback HTTP. MCP opens SQLite read-only.

## Challenges

The hardest design constraint was not model prompting; it was proving that useful context survives aggressive data minimization. Each source required a different safe boundary. A terminal command can be reduced to executable/subcommand shape, while a browser URL must be reconstructed from an allowlisted host with userinfo, query, fragment, and sensitive path segments removed.

The second challenge was evidence integrity. A fluent checkpoint is harmful if it invents progress. Continuum therefore validates every evidence ID against the exact input window, attaches evidence to entities as well as factual items, keeps hypotheses explicitly unverified, and stores stable provider failure codes rather than raw model-output snippets.

The third challenge was graceful degradation. Local vector dependencies and model weights are not guaranteed on a judge machine, so Continuum reports an explicit FTS5-plus-graph mode instead of hiding the loss or failing the product.

## Accomplishments

- One bounded, read-only MCP interface can resume work without pasted history.
- Context Diff uses a user-controlled baseline and never mutates it during reads.
- A visibly synthetic deterministic fixture exercises three checkpoints and meaningful Friday-to-Monday changes while including a secret canary that must not persist.
- The four collectors share one event contract while enforcing source-specific privacy rules.
- Local and cloud checkpoint providers share the same schema and evidence validation.
- The native menu-bar inspector makes capture, cloud selection, privacy counters, provider health, and degraded retrieval visible.
- Native updates use authenticated SSE with reconnect plus a 15-second polling fallback.
- The current verification pass completed 32 engine tests, 29 collector tests, 6 Swift tests, builds/type checks, and the read-only MCP subprocess smoke test.
- The full clean bootstrap and staged app/daemon verification passed; a real `gemma3n:e2b` smoke produced valid structured output; and `npm audit` reported zero known vulnerabilities.
- FTS5-plus-graph retrieval found the seeded result among 10,000 checkpoints in 9.4 ms on the development machine.

OpenAI live testing has not run because no API key is configured. The ephemeral grounded Codex handoff passed, but the primary recorded `/feedback` session, screenshots, public video, and public repository submission remain pending and must not be claimed as complete.

## What we learned

The best context is not the largest context. A checkpoint needs provenance, status, and a retrieval contract more than it needs raw activity. Separating blockers from hypotheses also changes agent behavior: Codex can recommend validation instead of repeating an unverified theory as fact.

We also learned that privacy needs a product surface. The cloud-active indicator, aggregate drop counters, explicit baseline acknowledgement, and degraded retrieval state are as important as the filtering code because they let the user understand what the system is doing.

## What’s next

- Checkpoint deletion and retention controls
- Signed/notarized packaging and first-class collector installers
- Encrypted local storage and richer local permission boundaries
- Remote/cross-device context with end-to-end encryption
- Additional opt-in adapters for issue trackers, Slack, and Calendar
- Interactive graph exploration and broader vector/cross-machine retrieval benchmarks

## Setup and testing

```sh
./script/bootstrap.sh --demo
npm run verify
npm run benchmark:retrieval
```

Detailed judge instructions, component commands, expected evidence, and known non-claims are in `docs/JUDGE_TESTING.md`. Fixture state is always labeled **Synthetic deterministic replay**. A genuine trace is created only with `npm run cli -- export-recording <output.jsonl> [projectId]`, which refuses demo-contaminated projects and requires all four sources. Verification, the full clean bootstrap, staged app check, real Gemma smoke, zero-vulnerability npm audit, 9.4 ms development-machine FTS5-plus-graph benchmark, and an ephemeral grounded Codex handoff have passed. OpenAI live, the primary `/feedback` session, screenshots, public video, and public submission have not.
