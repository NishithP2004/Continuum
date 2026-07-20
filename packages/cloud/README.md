# Continuum Cloud

The cloud package is the self-hosted synchronization, remote context, Neo4j projection, and Streamable HTTP MCP service. It receives only data that has already passed device privacy policy and revalidates every operation before persistence.

## Security boundaries

- Every query includes the authenticated account ID; API keys cannot select a tenant.
- Auth0 access tokens must match both the configured issuer and audience.
- API-key secrets are returned once. PostgreSQL stores only an HMAC-SHA-256 digest produced with `API_KEY_PEPPER`.
- An API key is transactionally bound to the physical `deviceId` on its first push or pull. It cannot be reused by another device, and revoking that device atomically revokes every bound key. OAuth tokens retain their normal account/client semantics.
- Live event operations are parsed again against the exact V2 schema and source-specific attribute allowlists. URL userinfo/query/fragment, full paths, terminal transcripts/output, bodies/content, confidential/secret classifications, and credential patterns are rejected.
- Event, checkpoint, and chat-message IDs are immutable: idempotent copies are accepted, content replacement and resurrection are rejected, and payload-free deletion tombstones remain supported.
- Raw sanitized events expire in no more than 24 hours. Tombstones expire after 30 days.
- Neo4j is a rebuildable projection. PostgreSQL remains authoritative while projection health is degraded.

## Development

Run PostgreSQL and Neo4j, export the variables documented in `infra/.env.example`, then use:

```sh
npm ci
npm --prefix packages/cloud run migrate
npm --prefix packages/cloud run dev
npm --prefix packages/cloud run worker
```

Run these commands from the repository root. The root workspace lockfile is
authoritative because the cloud service imports the private shared contracts
workspace; it is also the dependency graph used by the production Docker image.

The service listens on port `43118`. Remote MCP is a stateless Streamable HTTP endpoint at `/mcp` and requires the `context:read` scope.

Remote companion chat accepts `{ "text": "…" }` at `POST /v1/chat/sessions/:id/messages` and streams SSE. The cloud context composer uses synchronized checkpoints only, emits checkpoint/entity citations, and persists only messages that pass the immutable secret boundary. If no synchronized checkpoint exists, it emits `synchronized_context_unavailable` without persisting the message.

Chat recognizes only `search_context`, `get_diff`, `select_project`, `create_checkpoint`, and `ack_baseline`. The two read actions execute immediately. The other three are proposed and require `POST /v1/chat/actions/:id/confirm`. A confirmed synchronized-baseline acknowledgement can complete remotely; checkpoint creation and authoritative project selection return HTTP 409 `paired_mac_required` and do not queue or execute a device command. Cancelling a run discards proposals and does not persist a completed assistant message. There is no shell, filesystem-content, arbitrary HTTP, or code-execution action.

The device sync wire format is deliberately identical to the live engine contract:

- `POST /v1/sync/push` with `{ "deviceId": "…", "operations": [...] }` returns accepted and duplicate operation IDs plus a numeric cursor.
- `POST /v1/sync/pull` with `{ "deviceId": "…", "cursor": 0, "limit": 200 }` returns operations from other devices, `nextCursor`, and `hasMore`.
- Sequence gaps and idempotency collisions return HTTP 409. A caller's own operations are filtered from results but still advance its cursor.
