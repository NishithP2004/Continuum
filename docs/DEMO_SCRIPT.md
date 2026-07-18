# Continuum Demo Script — 2:45 Target

This script is designed for a sub-three-minute Developer Tools submission. Rehearse it against the exact commit being submitted. Never imply that fixture data was captured activity: keep the **Synthetic deterministic replay** label visible.

## Pre-record checklist

- Run `npm run verify` and save the 32-engine / 29-collector / 6-Swift result.
- Run the full `./script/bootstrap.sh --demo`, `./script/build_and_run.sh --verify`, `npm audit`, and `npm run benchmark:retrieval`; save the clean bootstrap, zero-vulnerability audit, staged-build result, and 9.4 ms 10,000-checkpoint timing.
- The root verification already includes 6 Swift tests; optionally rerun `swift test --package-path native/ContinuumApp` when isolating native changes.
- Start Ollama and confirm the already-passed `npm run smoke:ollama` still succeeds before showing a live Gemma checkpoint.
- Export `OPENAI_API_KEY`, run `npm run smoke:openai`, select `gpt-5.6-sol`, and generate a real briefing once.
- Build the MCP entry point, restart Codex with the included project `.codex/config.toml`, and test all five tools. The wrapper follows the fresh bootstrap database unless `CONTINUUM_DB` is explicitly set.
- Let bootstrap create the fresh demo database and load Friday only. Confirm the synthetic canary does not appear in SQLite, daemon logs, REST, or MCP output.
- Run `npm run --silent project-id -- /path/to/repository`, paste that canonical ID into Chrome, and use the same project in VS Code/zsh/Git.
- Increase UI/text size, hide unrelated notifications, and keep the menu-bar icon and terminal readable.
- Put the final YouTube URL and primary Codex `/feedback` session ID into `docs/DEVPOST.md` only after they exist.

If a live model check fails, stop and fix it before recording. Do not replace a failed live call with prewritten output unless the video labels that output as recorded/cached.

## Timeline and narration

### 0:00–0:15 — The problem

**Shot:** Start on a clean desktop. Open Continuum’s menu-bar panel, showing capture active and the selected local provider.

**Narration:**

> AI memory usually watches everything. Continuum does the opposite: it turns small, privacy-filtered developer events into evidence-backed context that Codex can query locally.

**On-screen callout:** `No screenshots · No file bodies · No terminal output`

### 0:15–0:40 — Four live metadata sources

**Shot sequence:**

1. Save `src/GuestTokenService.ts` in the trusted VS Code workspace.
2. Run a safe `npm test` command in zsh.
3. Focus an allowlisted documentation tab in Chrome.
4. Make a small Git commit in the demo repository.
5. Open Continuum → Activity and show the four source types as metadata, not content.

**Narration:**

> VS Code sends only workspace-relative focus and save metadata. zsh keeps command shape, duration, and exit code—not output. Chrome sees only the foreground tab on my allowlist, with query and fragment removed. Git sends the SHA, branch, subject, and changed paths—never the patch.

### 0:40–1:05 — Privacy gate to checkpoint

**Shot:** Run the prepared synthetic-secret action. Open Privacy to show the aggregate rule counter; search the inspector or prepared database check to show the secret value is absent. Trigger **Checkpoint Now**, then show the resulting checkpoint with cited event IDs.

**Narration:**

> A synthetic API key is dropped inside the collector and checked again before persistence. Continuum records only the rule counter. Many low-level events become one local Gemma checkpoint, and every factual item must cite a real input event ID.

**On-screen callout:** `Secret value absent · Rule count retained`

### 1:05–1:36 — The Context Diff “aha”

**Shot:** Start from the Friday phase already loaded by bootstrap. Confirm its current checkpoint in Timeline, then press **Mark Caught Up** in the Inspector toolbar. Open Context Diff and press **Load Synthetic Catch-Up** to load Monday; keep Timeline’s literal **Synthetic deterministic replay** label visible.

**Narration:**

> Friday, I marked the point I cared about. This clearly labeled synthetic replay now loads Monday’s safe metadata deterministically. Context Diff shows exactly what changed: the dashboard 401 was resolved, a commit touched two files, the clock-skew hypothesis was disproven, and the dataset-UUID decision is new.

**Expected visible facts:**

- Baseline checkpoint ID and current checkpoint ID
- resolved `Dashboard 401`
- disproven clock-skew hypothesis
- commit `a0ada710a0ada710a0ada710a0ada710a0ada710` (shown as `a0ada710…` where abbreviated)
- `src/DashboardAuth.ts` and `tests/dashboard-auth.test.ts`
- dataset UUID / RLS decision

### 1:36–2:00 — GPT-5.6 briefing

**Shot:** Settings → OpenAI → `gpt-5.6-sol`; keep the cloud-active state visible. Press **Generate GPT Briefing** in Context Diff and show its concise next actions.

**Narration:**

> When I select OpenAI, that visible choice is consent for public and personal sanitized events. Confidential data stays local, secrets are ineligible, and a diff containing local-only checkpoints is blocked. GPT-5.6 Sol turns this eligible deterministic diff into a briefing with structured output and `store:false`—which I do not describe as Zero Data Retention.

**On-screen callout:** `Cloud active · Sanitized eligible metadata only`

### 2:00–2:33 — Codex resumes without pasted history

**Shot:** Switch to Codex. The prompt contains only:

```text
Continue where I left off.
```

Show the `continuum.resume` and/or `continuum.diff` MCP tool call, then the answer citing a checkpoint, commit, and file and recommending the correct next action.

**Narration:**

> I paste no history. Codex calls Continuum’s read-only local MCP server, receives a bounded Context Pack, treats hypotheses as unverified, and grounds the next action in the exact checkpoint, commit, blocker, and files.

**Acceptance line to verify before recording:** Codex recommends validating the dataset UUID plus preserved RLS clause in `src/DashboardAuth.ts`, grounded in the Monday checkpoint and commit `a0ada710…`. An ephemeral local `codex exec -m gpt-5.6-sol` test has already passed this handoff; the primary recorded `/feedback` session still must be created.

### 2:33–2:45 — Close

**Shot:** Return to the inspector’s Now view with the local architecture/privacy callout.

**Narration:**

> The cloud never becomes the observer. It becomes the consultant. Codex doesn’t need more memory. It needs better context.

**End card:** `Continuum · Developer Tools · github.com/[REPLACE]`

## Recording truth checklist

- The fixture is visibly labeled **Synthetic deterministic replay** every time it appears. Only `npm run cli -- export-recording <output.jsonl> [projectId]` may create a **Recorded live session**, and that command refuses demo data and requires all four sources.
- Any OpenAI output shown was generated by the selected model during or before the recorded take and is not attributed to Gemma.
- Any Gemma checkpoint shown came from a successful `gemma3n:e2b` call, not the deterministic fixture provider.
- `store:false` is never called Zero Data Retention.
- The measured 10,000-checkpoint claim must be qualified as 9.4 ms in FTS5-plus-graph mode on the development machine; do not imply vector-mode or cross-machine performance.
- Gemma’s real smoke passed. OpenAI remains unrun because the key is absent, so do not show or claim an OpenAI briefing until that live smoke succeeds.
- Keep the primary Codex `/feedback` session ID from the session shown in the video.
