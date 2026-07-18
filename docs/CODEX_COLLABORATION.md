# Codex Collaboration and Decision Log

Continuum was developed with Codex as an implementation collaborator: architecture decomposition, contract design, privacy review, parallel component implementation, deterministic tests, native SwiftUI shell work, collector boundaries, and submission documentation.

This document records decisions and reproducible evidence without fabricating a Codex session identifier. The primary `/feedback` session ID must be added after the final submission session exists.

## Required submission reference

- **Primary Codex `/feedback` session ID:** `[PRIMARY_CODEX_FEEDBACK_SESSION_ID]`
- **Final implementation commit:** `[FINAL_COMMIT_SHA]`
- **Public repository:** `[PUBLIC_GITHUB_URL]`
- **Demo video:** `[PUBLIC_YOUTUBE_URL]`

## Collaboration workflow

The implementation was organized outcome-first:

1. Define the judge-visible success condition: Codex resumes from a bounded, cited Context Pack with no pasted history.
2. Encode strict shared contracts before wiring collectors or models.
3. Build a visibly synthetic deterministic Friday-to-Monday replay so privacy, retrieval, Context Diff, and MCP behavior are reproducible without network/model availability.
4. Add local/cloud providers behind the same schema and evidence validator.
5. Build source-specific collectors with their privacy boundary inside the adapter.
6. Add a native menu-bar inspector that exposes capture, baseline, cloud selection, privacy, provider health, and degraded retrieval.
7. Document limitations and distinguish deterministic evidence from live/provider/clean-machine claims.

Parallel Codex workstreams covered the TypeScript engine/MCP, four collectors, SwiftUI app, and submission materials. Shared-file changes were coordinated around the common event contract and REST routes.

## Decision log

### Event metadata instead of screenshots

**Decision:** Observe explicit developer-tool events and source-specific metadata, not screen pixels or OS-wide accessibility state.

**Reason:** It minimizes sensitive collection, creates better semantic precision, and reduces context size. It also makes the privacy boundary testable per source.

**Tradeoff:** Continuum cannot reconstruct arbitrary work performed outside installed adapters.

### Two privacy gates

**Decision:** Sanitize inside each adapter and repeat schema/allowlist/secret filtering before daemon persistence.

**Reason:** Raw values should not enter a durable retry queue or cross a process boundary. The daemon must still treat collectors as untrusted inputs.

**Tradeoff:** Rules are duplicated and require contract coordination.

### SQLite over a separate graph service

**Decision:** Use embedded SQLite with FTS5, graph tables, and optional sqlite-vec.

**Reason:** The MVP remains local, lightweight, source-runnable, and accessible read-only to MCP without a JVM or separate database daemon.

**Tradeoff:** Graph traversal and vector capabilities are intentionally narrower than a dedicated graph/vector platform.

### Explicit degraded retrieval

**Decision:** Continue with FTS5, graph, importance, and recency when local embeddings or sqlite-vec are unavailable; expose the degradation in state and Context Pack provenance.

**Reason:** A judge machine may be offline or lack native vector support. Silent quality loss would make the demo misleading.

**Tradeoff:** Query relevance may be lower until the embedding model and sqlite-vec are available.

### Evidence-backed checkpoints

**Decision:** Reject a provider output if any factual item cites an event ID outside its supplied window.

**Reason:** Fluent but ungrounded “memory” is worse than no checkpoint. Explicit blocker/hypothesis status also prevents an agent from treating a theory as fact.

**Tradeoff:** A schema/evidence failure leaves the window pending and requires retry.

### User-controlled Context Diff baseline

**Decision:** “Since I last cared” means the last checkpoint the user explicitly acknowledged, or a baseline explicitly passed to `diff`.

**Reason:** Reading context should not mutate it. A hidden moving baseline would make diffs non-repeatable and erase unseen changes.

**Tradeoff:** The user must press **Mark Caught Up** to advance the default baseline.

### Deterministic fixture before live providers

**Decision:** Implement a rules-based fixture provider and label every fixture surface **Synthetic deterministic replay**.

**Reason:** The critical MCP/diff/privacy path remains demonstrable and testable without Ollama model weights, an API key, or network access.

**Tradeoff:** Fixture output cannot be represented as captured activity or a live Gemma/OpenAI result. A genuine trace uses the guarded `export-recording` command and requires all four collectors.

### No silent local-to-cloud fallback

**Decision:** A failed local model does not trigger OpenAI.

**Reason:** Provider choice is a privacy decision. Sending eligible metadata to the cloud must remain visible and intentional.

**Tradeoff:** Checkpointing can pause until the local provider recovers or the user explicitly changes providers.

### `store:false` wording

**Decision:** Use `store:false` for OpenAI Responses requests and never call it Zero Data Retention.

**Reason:** Request storage configuration and contractual data-retention terms are not interchangeable.

### Source-run native app

**Decision:** Ship a SwiftPM macOS 14+ menu-bar app staged locally as `dist/Continuum.app`, without signing/notarization/DMG work during Build Week.

**Reason:** The native experience and reliable judge path matter more for the MVP than distribution packaging.

**Tradeoff:** Gatekeeper/distribution readiness is deferred.

## Codex-generated implementation areas

- npm workspace and shared Zod contracts
- Fastify daemon, bearer authentication, routes, SSE endpoint
- SQLite schema, FTS5, graph persistence, optional sqlite-vec integration
- privacy gate, event deduplication, windowing, provider orchestration
- deterministic, Ollama, and OpenAI providers plus evidence validation
- Context Pack ranking and Context Diff
- read-only stdio MCP tools
- VS Code, zsh, Git, and Chrome collectors
- SwiftPM menu-bar app and inspector
- fixture and deterministic tests
- build/bootstrap and submission documentation

All generated work remains subject to human review, local verification, provider terms, and the MIT license in this repository.

## Review corrections made during collaboration

The final documentation records the completed architecture changes rather than leaving them as plan-only claims:

- The native client consumes authenticated SSE, reconnects after interruption, and retains a 15-second polling fallback.
- The daemon purges processed and pending normalized events 24 hours after their trusted daemon receipt time at pipeline startup and hourly thereafter.
- Ollama checkpoint generation is globally serialized at concurrency one.
- Project switching flushes the prior project immediately.
- Context Pack and MCP diff character bounds are enforced even for oversized single results.
- Read-only MCP initializes sqlite-vec extension access when the vector table exists and otherwise reports embedding/vector degradation explicitly.
- Timeline labels fixture checkpoints **Synthetic deterministic replay**, bootstrap loads only Friday, and Context Diff exposes **Load Synthetic Catch-Up** for Monday after the user marks Friday caught up.
- Confidential evidence cannot cross via prior checkpoint text, a local-only Context Diff briefing, or the deliberately cloud-safe MCP view.
- Collector aggregate-drop events are audit-only and cannot become activity, checkpoint, graph, embedding, or provider input.
- Checkpoint entities carry valid event evidence; provider failures persist stable error codes without raw model-output snippets.
- `CONTINUUM_HOST` and `OLLAMA_URL` are constrained to loopback, and all collectors can share the canonical `npm run --silent project-id -- /path/to/repository` identity.
- Every bootstrap creates a fresh project-local demo database; the project MCP wrapper follows its active-database pointer without hard-coding a transient path.
- OpenAI health currently confirms key configuration, not a live model request.
- Vector retrieval is optional and can require a first-run local model download.
- Automated verification passed 32 engine, 29 collector, and 6 Swift tests plus build/type checks and MCP smoke; the full clean bootstrap and staged app/daemon verification also passed.
- A real `gemma3n:e2b` structured-output smoke test passed, and `npm audit` reported zero known vulnerabilities.
- The 10,000-checkpoint FTS5-plus-graph benchmark passed at 9.4 ms on the development machine.
- An ephemeral `codex exec -m gpt-5.6-sol` run called Continuum `resume` then `diff` and produced the grounded file/commit/blocker/next-action handoff.
- These results do not prove live OpenAI, a vector-mode/cross-machine benchmark, or the final recorded submission session.

Live status at this refresh is intentionally explicit: the local Gemma and ephemeral Codex resumption tests passed; `npm run smoke:openai` has not run because no key is configured; and the primary `/feedback` session ID, screenshots, public video, and public repository submission do not exist yet.

These are tracked as MVP limitations rather than hidden behind the intended architecture.

## Final `/feedback` procedure

Before submission:

1. Run the final demo flow in Codex on the final commit.
2. Prompt only “Continue where I left off.”
3. Confirm Codex invokes Continuum MCP and cites the correct checkpoint, file, and commit.
4. Use Codex `/feedback` for that session.
5. Paste the returned session ID into this file and `docs/DEVPOST.md`.
6. Record the exact commit and test evidence in `docs/JUDGE_TESTING.md`.

Do not invent or reuse an unrelated session ID.
