# Continuum privacy model

Continuum treats privacy as a data-shape constraint, not a prompt. Collection starts from a narrow metadata allowlist, applies source-side sanitization before a retry queue or transport, and repeats policy/secret enforcement before SQLite persistence, provider use, synchronization, REST/MCP output, and chat persistence.

The system is live-only. There is no runtime fixture or replay route that can be mistaken for collected activity.

## Permanent exclusions

No policy switch, provider selection, sync setting, API client, or chat action can enable collection of:

- screenshots, screen recordings, or screen pixels;
- document, source-file, or web-page bodies;
- terminal output or transcripts;
- environment-variable values;
- keystrokes or input event streams;
- clipboard contents;
- browser DOM, page titles, full history, cookies, URL userinfo, query strings, or fragments;
- Git patches, diffs, blobs, remotes, or credential-bearing configuration;
- arbitrary filesystem reads, remote shell commands, or code execution.

The four immutable `PrivacyPolicyV1` fields are literal `true` values:

- credential/secret detection;
- contract and attribute allowlisting;
- prohibited-content exclusion;
- confidential cloud-provider/sync block.

A PATCH request cannot set these protections to false because the server reconstructs them as true before strict schema validation.

## Two local privacy gates

### 1. Adapter gate

Each adapter receives only the minimum raw value needed to produce safe metadata and reduces it before writing a queue or crossing the loopback transport boundary.

- VS Code evaluates workspace membership and path sensitivity, then keeps a workspace-relative path and language ID.
- zsh passes raw command input to the sanitizer over stdin, not process arguments or logs. It retains a safe command shape plus bounded completion metadata.
- Git invokes local Git commands but retains only bounded metadata; it never reads a patch or blob.
- Chrome parses the current foreground URL in memory, applies the app-managed domain policy, and discards prohibited URL components.
- The native collector receives workspace notifications, Accessibility window-title values, or FSEvent paths and immediately reduces them to allowlisted attributes.

Only already-sanitized events enter a collector retry queue. Queues are bounded, physically evict expired records, and are re-evaluated against the daemon’s current policy when delivery resumes.

### 2. Daemon gate

The daemon treats every adapter as untrusted. Before an event can enter SQLite it applies:

1. strict `NormalizedEventV2` parsing and size limits;
2. live-source and source-switch validation;
3. source-specific event-type and attribute allowlists;
4. secret/credential scanning across title and permitted attributes;
5. URL component stripping and path normalization;
6. current metadata switches, allow/ignore rules, and classification policy;
7. relevance and aggregate-audit handling;
8. project resolution, sync-eligibility reduction, and deduplication.

An adapter’s `cloud_eligible` bit is only a request. The daemon can reduce it to `local_only`; it cannot promote confidential or prohibited data.

## Source inventory

| Source | Possible retained metadata | Source-specific boundary |
| --- | --- | --- |
| VS Code | trusted workspace focus; active/saved workspace-relative path; language ID; hashed local project alias; repository fingerprint | Trusted, single-root, local-file workspaces only. Document text is never read. Sensitive/generated paths are dropped. |
| zsh terminal | safe command name/shape, optional flag names, repository-relative cwd metadata, duration, exit code, session/command ID | Leading-space private commands, multiline input, heredocs, assignments, secret-shaped input, and unsafe command forms become aggregate counters. No output. |
| Git | SHA, branch, sanitized subject, hook operation, at most 50 relative changed paths | Repository-local refuse-overwrite hooks. No patches, blobs, remotes, or credentials. |
| Chrome | allowlisted foreground host and optional sanitized path | Paired collector only; non-incognito focused window only. No project field, bearer-token field, title, DOM, history, cookie, query, or fragment. |
| macOS apps | app name, sanitized bundle identifier, launch/activate/terminate action | `NSWorkspace` metadata only. Continuum ignores its own process. |
| focused window | sanitized title, app name, bundle identifier | Off by default, Accessibility opt-in, deduplicated, confidential, and permanently local-only. |
| approved folder | coalesced relative path or generic change label, change kind, approved project | FSEvents only for folders explicitly selected in the app. No implicit home-directory watch and no file read. |

## What the user can control

The native app and synchronized PWA expose the mutable parts of `PrivacyPolicyV1`:

- enable/disable VS Code, terminal, Git, Chrome, macOS applications, optional windows, and approved folders;
- enable/disable workspace-relative file paths, URL hosts/paths, safe command names/flag names, and personal metadata;
- allow or disallow confidential local collection;
- allow or disallow personal metadata for cloud providers and synchronization;
- set raw sanitized-event retention from 1 to 24 hours;
- maintain Chrome domain allowlists and ignored domains;
- maintain ignored relative-path globs;
- add/remove approved folders locally.

Focused-window capture and personal cloud eligibility are off on a fresh store. Chrome also captures nothing until pairing is approved, at least one domain is allowed, and a valid active-project lease exists.

Every persisted policy has a monotonically increasing revision and update time. Collector and local UI policy updates travel through the daemon revision stream; eligible policy records can synchronize by HLC last-write-wins. Regardless of a mutable-policy merge, the immutable exclusions above remain enforced. Pending records are rechecked against the currently materialized policy before a push.

## Classification and eligibility

| Classification | Local collection | Local model | OpenAI | Sync/cloud storage | Local/remote MCP |
| --- | --- | --- | --- | --- | --- |
| `public` | When source/metadata policy permits | Yes | Only when OpenAI is explicitly selected | Eligible | Eligible after other bounds |
| `personal` | When personal metadata is enabled | Yes | Only when both cloud eligibility and OpenAI selection permit | Only when policy permits | Only cloud-eligible derived context |
| `confidential` | Only when confidential local collection is enabled | Yes, for the selected on-device provider | Never | Never | Never |
| `secret` or secret-shaped | Never persisted as an event/message | Never | Never | Never | Never |

Selecting a cloud model is explicit provider consent, not a privacy-policy bypass. `OPENAI_API_KEY` is read from the process environment and not persisted. OpenAI requests use `store:false`, which must not be described as Zero Data Retention.

## Secret rejection

Secret detection covers recognized API-key/token formats, private-key markers, authorization headers, credential-bearing URL patterns, generic credential assignments, and source-specific unsafe forms. A secret decision produces only a fixed aggregate rule counter. The raw rejected string, event title, event ID, command, URL, path, or model response is not stored in the privacy audit.

The same boundary applies to chat:

- a secret-shaped user message is rejected before chat persistence, context retrieval, or provider invocation;
- a provider response is scanned before assistant-message persistence or SSE completion;
- confidential/local-only sessions cannot use OpenAI or synchronize;
- active hypotheses are stored and rendered as unverified, not factual memory.

## Privacy audit

Audit records intentionally contain only:

- a fixed rule identifier;
- decision/action;
- aggregate count;
- source;
- timestamp.

They contain no rejected payload, title, event ID, local path, command, URL, token fragment, or provider output. Dedupe uses a separate one-way hash table, not a copy of the rejected identifier.

## Chrome pairing and project attribution

Chrome requests a five-minute localhost challenge from its `chrome-extension://` origin. The user must approve that exact pending request in Continuum. The extension proves possession of its original challenge and receives a `ctc_...` credential; the database stores only its SHA-256 hash. Revocation invalidates it.

That credential can read only the active lease/current privacy policy and submit only Chrome-source events. It cannot invoke general daemon routes or masquerade as VS Code, terminal, Git, or OS collection.

Chrome has no manually entered project ID. It reads an unexpired device lease created by VS Code/terminal, lower-confidence Git/folder activity, or explicit project selection. Chrome never renews the lease; without one, capture is skipped.

## Global project identity

VS Code, zsh, and Git use a shared physical device ID and a SHA-256 device-local path alias. When available, a repository fingerprint is derived from normalized project name and root commit IDs. Absolute paths and remotes are excluded.

One exact fingerprint/name match joins a clone to its global UUID. Multiple matches create a new provisional project and a persisted conflict. The user must select one of the candidate projects before the local alias is remapped; Continuum never silently merges an ambiguous clone.

## Provider request boundary

Only the selected provider receives a bounded, already-sanitized input:

- at most 15 events for checkpointing;
- a bounded Context Pack and chat history for chat;
- no prior local-only checkpoint in a cloud request;
- no local-only Context Diff in an OpenAI briefing request.

All provider-generated checkpoint evidence IDs must belong to the supplied event set. Any unknown ID fails validation. Provider error storage uses stable error codes rather than raw model output.

There is no provider fallback. An unavailable Apple model, Ollama daemon, or OpenAI configuration is displayed as that provider’s own failure.

## Local REST, SSE, and MCP

The local daemon binds only to `127.0.0.1`, `localhost`, or `::1`. Its 32-byte random bearer token is stored in a mode-`0600` file under a mode-`0700` data directory when the filesystem permits. `/health` reveals only process health.

The stdio MCP server opens SQLite read-only with `PRAGMA query_only`, reserves stdout for JSON-RPC, bounds every result, and emits only cloud-eligible context. MCP reads cannot acknowledge a checkpoint, change settings, create chat, or move the diff baseline.

## Synchronization boundary

Synchronization is optional. The local sync client sends only operations that remain eligible under the current policy. Confidential data is converted to no outbound payload. Expired raw-event operations are scrubbed to payload-free tombstones.

The cloud service repeats strict entity-schema, secret, URL/path, classification, eligibility, event-age, sequence, HLC, idempotency, and immutable-collision checks before PostgreSQL persistence. Every query and projection operation is scoped by the authenticated account.

Authentication options:

- Auth0 access tokens validated against issuer, audience, and required scopes;
- copy-once API keys in `ctm_<id>_<secret>` form, stored only as a server-peppered HMAC-SHA-256 digest.

An API key binds to the first physical sync device that uses it. A different device cannot reuse it. Revoking the device atomically revokes keys bound to that device. Native refresh credentials are stored only in macOS Keychain; PWA tokens remain in the Auth0 SPA flow.

PostgreSQL is the synchronized source of truth. Neo4j is a rebuildable projection and receives only eligible graph state from the PostgreSQL outbox. Sync continues during a projection outage; the service reports degradation and can replay the outbox after recovery.

This release is TLS-protected and server-queryable, not zero-knowledge end-to-end encrypted. The self-hosted server can process eligible plaintext context for search, graph, chat, and MCP.

## Retention and deletion

- Raw sanitized events in the primary local database use trusted daemon receipt time and expire after the policy’s 1–24-hour interval.
- Server event expiry is capped at 24 hours from the event’s occurrence/accepted record.
- Collector queues physically remove records older than 24 hours before persistence/retry.
- Migration backups are created only after already-expired raw events are purged. Removal is scheduled after 24 hours while Continuum runs, and overdue backups are removed on the next launch after downtime.
- Checkpoints retain concise evidence summaries and IDs, not raw content.
- Mutable synchronized deletions use tombstones retained for 30 days so offline devices cannot resurrect data.
- Chat synchronization follows the session/message eligibility; confidential conversations remain local.

## Privacy verification checklist

Use synthetic canaries only in an isolated test database and test account. Search all of the following for the full canary and meaningful substrings:

1. collector retry queues;
2. SQLite tables, FTS rows, vector inputs, migration backups, and logs;
3. provider request captures and provider error storage;
4. REST/SSE and local MCP output;
5. sync frames and PostgreSQL rows;
6. Neo4j node/edge properties and projection logs;
7. remote REST/MCP/PWA responses;
8. native and PWA chat history.

The expected result is absence of the secret payload everywhere, with only fixed aggregate audit rule/count evidence. Repeat this check for `.env` paths, authorization headers, URL tokens, private commands, document text, terminal output, and browser content.
