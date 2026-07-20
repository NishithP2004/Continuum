# Continuum

**A live, privacy-first context operating system for AI agents.**

Continuum observes allowlisted developer-tool and macOS metadata, turns related events into evidence-backed checkpoints, and makes that context available in a native app, a synchronized PWA, agent chat, and Model Context Protocol (MCP). It captures semantic state—not screens or content—so an agent can answer “Continue where I left off” with cited checkpoints, files, commits, blockers, and decisions.

> Codex doesn’t need more memory. It needs better context.

Continuum is a Developer Tools submission for [OpenAI Build Week](https://openai.devpost.com). The submission deadline is July 21, 2026 at 5:00 PM PDT. See the [official rules](https://openai.devpost.com/rules).

## What is implemented

- A macOS 14+ Dock app with a primary inspector window and persistent menu-bar controls.
- Seven live metadata sources: VS Code, zsh terminals, Git, Chrome, macOS application lifecycle, optional focused-window titles, and explicitly approved folders.
- A loopback-only Fastify daemon on `127.0.0.1:43117`, authenticated with a generated bearer token and backed by SQLite.
- Global project UUIDs with device-local hashed path aliases. Git clones can match through their root commit fingerprint and normalized name; ambiguous matches wait for explicit confirmation.
- Evidence-backed checkpoints, deterministic Context Diff, FTS5/graph retrieval, and optional local MiniLM/sqlite-vec retrieval.
- Native cited chat with Apple Foundation Models, Ollama, or explicitly selected OpenAI. Mutating context actions always require confirmation.
- A native interactive SwiftUI Canvas graph and a responsive Sigma.js PWA graph using the same bounded graph contract.
- Policy-controlled collection, metadata fields, retention, domain/path rules, cloud eligibility, and aggregate-only privacy audit.
- Optional multi-device synchronization through a self-hosted Fastify/PostgreSQL/Neo4j service with Auth0, device-bound API keys, tombstones, projection recovery, and a PWA.
- Read-only local stdio MCP and tenant-scoped remote Streamable HTTP MCP. Both expose `current`, `timeline`, `search`, `resume`, `diff`, and `graph`.

Continuum is live-only. Every ordinary launch starts from existing live state or an empty store and never loads fixture activity. Synthetic data remains only inside automated tests.

## Requirements

- Apple Silicon Mac running macOS 14 or later
- Node.js 24 and npm
- Xcode Command Line Tools / Swift 5.10 or later
- VS Code 1.95+, Chrome 114+, Git, and zsh for their respective collectors
- Optional: Ollama and a compatible installed model such as `gemma3n:e2b`
- Optional on macOS 26+: Apple Intelligence and the Foundation Models system model
- Optional: `OPENAI_API_KEY` for explicit OpenAI use
- Optional remote companion: Docker Compose, Auth0, and a public HTTPS hostname

This repository produces a source-run app in `dist/Continuum.app`. Signing, notarization, a DMG, and App Store distribution are outside this release.

## Start the live app

From the repository root:

```sh
./script/bootstrap.sh
```

Bootstrap installs dependencies, runs the repository verification suite, builds the TypeScript services and Swift helpers, stages `dist/Continuum.app`, starts the local daemon, and opens Continuum. It creates an empty live system; it does not load activity or checkpoints.

For a quicker development restart after dependencies are already installed:

```sh
./script/bootstrap.sh --skip-verify
```

Or rebuild and relaunch directly:

```sh
./script/build_and_run.sh
```

Continuum appears both in the Dock and in the menu bar. The menu provides capture pause/resume, Checkpoint Now, Catch Up, Inspector, Settings, and Quit. Settings also opens with Command-comma.

The local data directory is:

```text
~/Library/Application Support/Continuum/
├── auth.token
└── continuum.sqlite
```

The physical device ID shared by the daemon and collectors is stored at `~/.continuum/device-id`. A migration of an existing database creates a pre-migration SQLite backup after purging expired raw events; Continuum schedules that backup for removal after 24 hours and also purges overdue backups on the next launch.

### Launch troubleshooting

If the inspector says disconnected, verify the daemon and inspect its project-local log:

```sh
curl --fail http://127.0.0.1:43117/health
tail -n 80 .continuum-runtime/daemon.log
```

Relaunch through `./script/build_and_run.sh` so the daemon, staged app, data directory, and generated token agree. Do not paste the daemon’s general bearer token into Chrome; Chrome uses its pairing challenge. A visible **FTS + graph** retrieval warning does not disable capture—it means embeddings/sqlite-vec are unavailable. If `CONTINUUM_DISABLE_EMBEDDINGS=1` was set earlier, unset it before relaunching to allow vector initialization.

If the app is connected but Activity stays empty, check the source-specific prerequisite: VS Code SecretStorage connection, sourced zsh hook, installed Git hooks, approved native source/folder, or Chrome pairing plus domain allowlist plus active-project lease.

## First live capture

1. Open **Continuum → Settings** and choose a checkpoint and chat provider.
2. Open **Settings → Privacy**. Enable only the sources and metadata fields you want, add approved folders, and add any Chrome domains you want to allow.
3. Install one or more developer collectors below.
4. Focus a trusted VS Code workspace or run a command from a Continuum-enabled zsh inside a repository. Either source establishes the strongest active-project lease.
5. Use the app normally. Windows flush after 30 seconds, 15 relevant events, a project switch, or **Checkpoint Now**.
6. Open **Timeline**, **Graph**, **Context Diff**, or **Chat** to inspect the resulting live context.

Git and approved-folder activity can establish lower-confidence leases. Chrome only reads a still-valid lease and can never renew one. If no lease exists, the extension skips capture and explains how to establish it.

### VS Code

Build the extension, then open `collectors/vscode` in VS Code and launch its Extension Development Host:

```sh
npm run build -w @continuum/vscode-collector
```

In a trusted, single-root workspace, run **Continuum: Connect to Local Engine** and paste the contents of `~/Library/Application Support/Continuum/auth.token`. VS Code stores it in SecretStorage. The extension records workspace focus plus active/saved workspace-relative file metadata; it never reads document text.

### zsh terminals

Add this opt-in integration to `.zshrc`:

```zsh
source '/absolute/path/to/Continuum/integrations/zsh/continuum.plugin.zsh'
```

It works in Terminal.app, iTerm2, and VS Code terminals. Raw command input reaches the sanitizer over stdin and is immediately reduced to a safe command shape, working directory alias, duration, and exit code. Terminal output is never collected. Leading-space private commands, environment assignments, heredocs, multiline input, and secret-shaped commands become aggregate rule counters only.

### Git

Run the installer from each repository you approve:

```sh
/absolute/path/to/Continuum/integrations/git/install.sh
```

It installs repository-local `post-commit`, `post-checkout`, `post-merge`, and `post-rewrite` hooks. It refuses the complete installation if a target hook already exists. Events contain only commit SHA, branch, sanitized subject, operation, and bounded repository-relative changed paths—never patches, blobs, remotes, or credentials.

### Chrome

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `collectors/chrome`.

1. Open the Continuum extension and choose **Pair with Continuum**.
2. Approve the five-minute challenge under **Settings → Privacy → Chrome pairing**.
3. Add allowed domains in Continuum’s Privacy settings.
4. Focus a VS Code workspace or use a Continuum-enabled terminal so an active-project lease exists.

There is no project-ID or bearer-token field in Chrome. The paired credential is scoped to Chrome event ingestion, and the project is displayed read-only. The extension observes only the foreground tab in the focused, non-incognito window. It stores an allowlisted host and, when enabled, a sanitized path. Userinfo, query, fragment, page title, DOM, cookies, and history are excluded.

### macOS sources

The app collects application launch, activation, and termination metadata through `NSWorkspace` when that source is enabled. Approved folders use FSEvents and emit coalesced relative-path/change-kind metadata only.

Focused-window titles are off by default, require Accessibility permission, pass through the secret/sensitive-metadata filter, and are always local-only. Continuum does not use Accessibility for keystrokes or screen content.

All adapters keep bounded, already-sanitized retry queues for daemon outages. Queued records are re-evaluated against the current policy before persistence, and daemon deduplication makes retries effectively once-only.

## Providers and chat

Checkpoint and chat providers are selected independently in Settings. A selected provider failure is surfaced; Continuum never silently switches providers.

### Apple Foundation Models

The staged app includes a Swift JSONL helper that is compiled conditionally and guarded at runtime. On macOS 26+ it reports the system model’s real availability, including device-ineligible, Apple-Intelligence-disabled, model-not-ready, and unsupported-locale states. It verifies `supportsLocale()` before selection and labels unsupported prompt-language failures explicitly. If Apple’s system model is available on first launch, Continuum selects it automatically; otherwise the initial selection remains Ollama. There is no later automatic fallback.

The helper serializes generation at concurrency one, bounds input for the system model, supports checkpoint and streaming-chat operations, and returns evidence that is revalidated by the TypeScript engine. See Apple’s [Foundation Models documentation](https://developer.apple.com/documentation/FoundationModels).

### Ollama

The default Ollama model is `gemma3n:e2b`:

```sh
npm run setup:models
npm run doctor
npm run smoke:ollama
```

Ollama must remain on loopback. Checkpoint generation uses a bounded event window and JSON-schema output, with one repair attempt after invalid output. Other installed models can be selected manually.

### OpenAI

Export the key before launching Continuum:

```sh
export OPENAI_API_KEY='your-key'
./script/build_and_run.sh
```

The key is never persisted by Continuum. Settings offers `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and an advanced custom model ID. OpenAI is explicit cloud consent for policy-eligible sanitized context. Requests use structured outputs where applicable and `store:false`; **this is not the same as Zero Data Retention**. Secret, confidential, and local-only evidence cannot enter an OpenAI request.

Model IDs follow the official [GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6).

### Grounded agent chat

Native and PWA chat cite checkpoints and related files, commits, blockers, decisions, and entities. Active hypotheses are labeled unverified. Messages and provider responses are secret-scanned before persistence.

The agent has only five context actions:

- `search_context` and `get_diff` execute immediately because they are read-only.
- `select_project`, `create_checkpoint`, and `ack_baseline` create a proposal that the user must explicitly confirm or reject.

There is no shell, file-content, arbitrary HTTP, or code-execution tool in chat.

On the remote companion, confirmed `ack_baseline` can update the synchronized baseline. `create_checkpoint` and `select_project` require a connected Mac; the remote service returns `paired_mac_required` and does not queue or execute a command. Cancelling a run discards its proposals and does not persist a completed assistant response.

## Codex MCP

Build, then print the project-scoped local configuration:

```sh
npm run build
npm run cli -- mcp-config
```

The equivalent `.codex/config.toml` entry is:

```toml
[mcp_servers.continuum]
command = "/absolute/path/to/Continuum/script/run_mcp.sh"
args = []
cwd = "/absolute/path/to/Continuum"
enabled_tools = ["current", "timeline", "search", "resume", "diff", "graph"]
startup_timeout_sec = 10
tool_timeout_sec = 30
env = { CONTINUUM_DB = "/absolute/path/to/Continuum data/continuum.sqlite" }
```

Restart Codex, then ask:

```text
Continue where I left off.
```

The generated configuration pins the resolved database path. Without `--db`, the stdio process resolves `CONTINUUM_DB`, then `CONTINUUM_DATA_DIR/continuum.sqlite`, then the standard Application Support location. It opens SQLite read-only with `PRAGMA query_only`, reserves stdout for JSON-RPC, and writes diagnostics to stderr. Its output is bounded and restricted to cloud-eligible context because it may be consumed by a cloud agent. MCP reads never move the acknowledged Context Diff baseline.

If a checkpoint depends on personal metadata such as workspace-relative paths, enable **Privacy → Allow eligible sanitized metadata for cloud providers and sync** before using Codex MCP. Otherwise Continuum intentionally keeps that checkpoint out of MCP results; public-only checkpoints remain eligible without this switch.

The self-hosted service exposes the same six read-only tools at `https://your-host/mcp` over Streamable HTTP. It publishes OAuth protected-resource metadata and accepts Auth0 access tokens or scoped `ctm_<id>_<secret>` API keys. Configure remote MCP against the public HTTPS resource with `context:read`; see the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) and [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Self-hosted synchronization and PWA

Copy the environment template, configure Auth0 and DNS, then start the stack:

```sh
cp infra/.env.example infra/.env
docker compose --env-file infra/.env -f infra/docker-compose.yml up --build
```

The stack contains:

- Fastify cloud API and remote MCP
- PostgreSQL account, operation-log, outbox, policy, chat, device, and API-key state
- Neo4j as a rebuildable graph projection
- an idempotent projection worker
- the React/TypeScript/Vite installable PWA
- Caddy HTTPS termination

PostgreSQL remains authoritative if Neo4j is unavailable. Sync continues, projection lag is reported, and the worker can replay the outbox after recovery. The PWA provides Now, Chat, Graph, Timeline, Privacy, Devices, and Settings routes; it is a synchronized companion and never performs collection on the viewing device.

The macOS Auth0 flow uses Authorization Code with PKCE in `ASWebAuthenticationSession`. Configure the native Auth0 callback as `dev.continuum.app://auth/callback`. Refresh credentials are stored only in Keychain; transient access tokens are handed to the local sync client. API keys are shown once, stored server-side only as an HMAC-SHA-256 digest using the configured pepper, and bound to the first physical sync device that uses them. Revoking that device revokes its bound keys.

See [infra/README.md](infra/README.md), [packages/cloud/README.md](packages/cloud/README.md), and [apps/web/README.md](apps/web/README.md).

## Privacy boundary

These controls are configurable: source enablement, optional window titles, relative paths, URL hosts/paths, safe command names/flag names, retention from 1–24 hours, allow/ignore rules, confidential local collection, and personal cloud eligibility.

These protections cannot be disabled:

- credential and secret detection/rejection;
- strict contract and source-specific attribute allowlists;
- exclusion of screenshots, screen video, document/file bodies, terminal output, environment values, keystrokes, clipboard, browser DOM/history/cookies, URL userinfo/query/fragment, and Git patches/blobs/remotes;
- confidential metadata never entering a cloud provider, sync, local MCP, remote MCP, or cloud storage. It may be used by the explicitly selected on-device Apple/Ollama provider when confidential local collection is enabled.

Privacy audit rows contain only a fixed rule name, decision, count, source, and time. Rejected payloads and event IDs are not stored in the audit. Sanitized raw events expire from the primary device/server stores after the configured interval and never beyond 24 hours. A pre-migration SQLite backup is a separate bounded recovery artifact with the cleanup behavior described above. Checkpoints retain concise evidence summaries and IDs.

See [Privacy](docs/PRIVACY.md) for the complete trust-boundary description.

## Runtime configuration

| Variable | Purpose |
| --- | --- |
| `CONTINUUM_DATA_DIR` | Override the local data directory. |
| `CONTINUUM_DB` | Override the SQLite path, including for MCP. |
| `CONTINUUM_TOKEN` / `CONTINUUM_AUTH_TOKEN` | Supply the shared local daemon/app token instead of generating one; explicit tokens must contain at least 32 non-whitespace characters. |
| `CONTINUUM_TOKEN_FILE` | Tell the daemon, collectors, and native app where to read the same token. Existing token files are permission-hardened to `0600`; empty/weak files are regenerated. |
| `CONTINUUM_DEVICE_ID` | Explicit physical-device UUID override; non-UUID values are rejected. |
| `CONTINUUM_DEVICE_ID_FILE` | Override the shared device-ID file. |
| `CONTINUUM_HOST` | Local daemon host; only `127.0.0.1`, `localhost`, or `::1` is accepted. |
| `CONTINUUM_PORT` | Compatibility check only; if set, it must be `43117`, the fixed native/Chrome origin. |
| `OLLAMA_URL` | Override the loopback Ollama URL. |
| `CONTINUUM_APPLE_BRIDGE` | Override the Foundation Models helper path. |
| `OPENAI_API_KEY` | Enable explicit OpenAI use; never persisted. |
| `CONTINUUM_SYNC_URL` | Remote HTTPS service origin; loopback HTTP is allowed for development. |
| `CONTINUUM_SYNC_TOKEN` | Remote OAuth access token or scoped API key; never stored in SQLite. |
| `CONTINUUM_AUTH0_ISSUER` | Auth0 HTTPS issuer used by the native PKCE flow. |
| `CONTINUUM_AUTH0_CLIENT_ID` | Auth0 Native Application client ID. |
| `CONTINUUM_AUTH0_AUDIENCE` | Continuum Auth0 API audience. |
| `CONTINUUM_AUTH0_SCOPES` | Space-delimited native scopes; must include `openid offline_access`. |
| `CONTINUUM_DISABLE_EMBEDDINGS=1` | Force the explicit FTS5-plus-graph retrieval mode. |

## Verification

Run the repository suite:

```sh
npm run verify
```

Additional opt-in checks:

```sh
npm run test:web:e2e
npm run smoke:apple
npm run smoke:ollama
npm run smoke:openai
npm run benchmark:retrieval
./script/build_and_run.sh --verify
```

Provider smoke tests require their corresponding system model, local model, or API configuration. Remote acceptance requires Auth0, PostgreSQL, Neo4j, Caddy, and an HTTPS host. The repository does not claim those environment-dependent checks have passed merely because their test paths exist. Use [Judge Testing](docs/JUDGE_TESTING.md) to record evidence from the exact submission commit.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Privacy model](docs/PRIVACY.md)
- [Live judge testing](docs/JUDGE_TESTING.md)
- [Live demo script](docs/DEMO_SCRIPT.md)
- [Devpost draft](docs/DEVPOST.md)
- [Codex collaboration and decision log](docs/CODEX_COLLABORATION.md)

Licensed under the [MIT License](LICENSE).
