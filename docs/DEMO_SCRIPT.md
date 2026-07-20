# Continuum live demo script

Target runtime: **2:45**. Hard limit: under three minutes.

Everything shown must come from activity captured during the recorded session. Do not load fixtures, seed checkpoints, use replay controls, or describe test-only synthetic data as work history.

## Before recording

- Build and launch with `./script/bootstrap.sh` or `./script/build_and_run.sh`.
- Use a disposable public-safe Git repository created for the live recording.
- Confirm Timeline is empty or contains only clearly acceptable live metadata from this recording session.
- Enable VS Code, terminal, Git, Chrome, macOS apps, focused-window titles, and approved-folder sources. Grant Accessibility only for the disposable, non-sensitive window-title demonstration.
- Install the VS Code, zsh, and Git collectors.
- Pair Chrome through **Settings → Privacy → Chrome pairing**. Allow only the documentation domain used in the recording.
- Approve only the disposable repository folder.
- Choose the provider that will actually be invoked. For the OpenAI segment, export the key before app launch and explicitly select GPT-5.6 Sol.
- Start the self-hosted stack, sign in to native/PWA, wait for sync health, and open the PWA in a narrow browser window.
- Configure local and authenticated remote MCP in Codex and verify discovery before recording.
- Prepare a fake secret canary that is not a real credential. Search all output/storage after rehearsal to ensure it appears only as a fixed aggregate rule count.
- Rehearse once, then reset to a clean live data directory. Do not reuse the rehearsal database as the recorded session.

## Timed narration and actions

### 0:00–0:15 — The problem and trust boundary

**Screen:** Launch Continuum from the Dock; briefly show the persistent menu-bar item and empty Now view.

**Say:**

> AI agents lose your working state, and screenshot-based memory captures far too much. Continuum observes live semantic events, never screen pixels or content, and turns them into cited context.

### 0:15–0:48 — Seven live sources, one project

**Screen/actions:**

1. Focus the disposable VS Code workspace and save `src/session.ts`.
2. Run a safe zsh test command.
3. Make the prepared Git commit.
4. Focus the allowlisted documentation tab in Chrome.
5. Switch to a harmless app and back, focus the disposable titled window, and rename a file inside the approved folder.
6. Return to Continuum Activity.

**Say:**

> VS Code and terminal establish the active project. Git and the approved folder add lower-confidence evidence. Chrome reads that expiring lease automatically—it has no project-ID or token field and cannot renew itself. macOS app, optional local-only window, and approved-folder events complete the seven sources.

**Show:** Source badges, one global project, sanitized relative metadata, and independent collector health.

### 0:48–1:03 — Privacy is executable policy

**Screen/actions:** Run the prepared fake secret-shaped command, then open Privacy.

**Say:**

> This fake credential is rejected before persistence. The audit keeps only the fixed rule, source, decision, count, and time. I can turn sources and safe metadata fields off, but secret detection, content exclusion, attribute allowlisting, and the confidential cloud block are permanently locked.

**Show:** The aggregate counter and locked protections. Never leave the fake payload visible long enough to be mistaken for stored data.

### 1:03–1:27 — Events become grounded state

**Screen/actions:** Choose **Checkpoint Now**, then open Timeline and Graph.

**Say:**

> The selected model compresses many sanitized events into one checkpoint. Every factual progress item, blocker, decision, and entity must cite an input event ID or the checkpoint is rejected.

**Show:** Provider/model label, cited checkpoint, file and commit nodes, selection provenance, pan/zoom, and Open in Chat.

### 1:27–1:47 — Context Diff

**Screen/actions:** Acknowledge the first live checkpoint. Perform the prepared blocker-resolution edit/test and a second checkpoint. Open Context Diff.

**Say:**

> “Since I last cared” is an explicit baseline, never a hidden read cursor. Context Diff reports the resolved blocker, new commit, changed file, and hypothesis status with both checkpoint IDs.

**Show:** Baseline/current IDs and typed cited changes.

### 1:47–2:07 — Grounded in-app agent

**Screen/actions:** In Chat ask, “What changed, and create a checkpoint after you summarize it.”

**Say:**

> Chat uses only bounded Continuum context. It cites checkpoints, files, commits, blockers, and decisions, and labels active hypotheses unverified. Searches run immediately; a state-changing action stays pending until I confirm it.

**Show:** Streaming answer, citations, and the explicit confirmation button. Confirm the checkpoint action.

### 2:07–2:24 — Same context on another device

**Screen/actions:** Switch to the PWA Graph or Chat view.

**Say:**

> Eligible sanitized context synchronizes through my self-hosted service. PostgreSQL is authoritative; Neo4j is a rebuildable graph projection. The PWA collects nothing—it is only a synchronized companion. Confidential context stays on the Mac.

**Show:** Device presence, last sync, the same project/graph, and projection health.

### 2:24–2:41 — Codex and remote MCP payoff

**Screen/actions:** In Codex ask only:

```text
Continue where I left off.
```

**Say:**

> Codex calls Continuum’s read-only MCP. Local stdio and authenticated remote Streamable HTTP expose the same bounded six tools.

**Show:** `resume` or `diff` MCP invocation and the answer citing the correct checkpoint, file, and commit with a grounded next action.

### 2:41–2:45 — Close

**Screen:** Continuum graph with the current project selected.

**Say:**

> Codex doesn’t need more memory. It needs better context.

## Recording guardrails

- Show **Live** status and actual timestamps; never show or say “demo,” “seed,” “fixture,” or “replay.”
- Do not claim Apple, Ollama, OpenAI, sync, Auth0, remote MCP, or Neo4j worked unless the recorded action visibly succeeds.
- If a provider is unavailable, record again after fixing it; do not switch providers off camera and imply fallback.
- Keep the OpenAI cloud-active indicator visible while OpenAI is selected.
- Keep window titles, terminal, browser, and repository content intentionally non-sensitive.
- Blur only incidental operating-system/account chrome. Do not blur product evidence that should prove the claim.
- Use system light/dark mode consistently and keep pointer movement slow enough to follow.

## Shot checklist

```text
[ ] Dock app plus menu-bar controls
[ ] Seven live source events
[ ] Automatic Chrome project lease and pairing
[ ] Secret aggregate drop and immutable locks
[ ] Real provider/model and evidence-backed checkpoint
[ ] Native graph provenance
[ ] Explicit baseline and Context Diff
[ ] Cited chat and confirmed mutating action
[ ] Synced PWA graph/chat and device health
[ ] Authenticated MCP call from Codex
[ ] Correct checkpoint/file/commit/next action
[ ] Closing line under 3:00
```

After recording, run the privacy canary search from [Judge Testing](JUDGE_TESTING.md) against the exact recorded data directory/account before publishing the video.
