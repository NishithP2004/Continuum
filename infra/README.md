# Self-hosted Continuum

1. Copy `.env.example` to `.env` and replace every placeholder.
2. Configure an Auth0 API whose identifier exactly matches `AUTH0_AUDIENCE`.
3. Grant the PWA Authorization Code + PKCE flow the required API scopes. Enable Auth0 Dynamic Client Registration if MCP clients will register dynamically.
4. Point the public DNS name at this host and set `CONTINUUM_DOMAIN` and `PUBLIC_BASE_URL` to that HTTPS origin.
5. Run `docker compose --env-file infra/.env -f infra/docker-compose.yml up --build` from the repository root.

## Native macOS Auth0 setup

Create a separate Auth0 **Native** application for the Continuum macOS client. Enable Authorization Code with PKCE, refresh-token rotation, and offline access. Add this exact callback URL:

```text
dev.continuum.app://auth/callback
```

Grant `openid profile offline_access context:read sync:read sync:write devices:write`. Continuum is a public native client: do not create, paste, or ship a client secret. Enter the HTTPS service URL, Auth0 issuer, native client ID, and API audience under **Continuum → Settings → Sync**, or launch the app with the equivalent non-secret variables:

```sh
export CONTINUUM_SYNC_URL="https://continuum.example.com"
export CONTINUUM_AUTH0_ISSUER="https://your-tenant.us.auth0.com/"
export CONTINUUM_AUTH0_CLIENT_ID="your-native-client-id"
export CONTINUUM_AUTH0_AUDIENCE="https://continuum.example.com"
```

The refresh credential is stored only in a non-synchronizable, device-only Keychain item. The access token remains in memory and is handed to the bearer-authenticated loopback daemon; neither credential is written to SQLite or user preferences. Signing out deletes the local credential before attempting Auth0 refresh-token revocation.

Caddy terminates HTTPS and routes `/v1/*`, `/mcp`, and OAuth protected-resource metadata to the cloud service. The remaining routes serve the installable PWA. PostgreSQL is not exposed on the host; the Neo4j browser is bound to loopback only.

To rebuild the Neo4j projection from the authoritative PostgreSQL outbox:

```sh
docker compose --env-file infra/.env -f infra/docker-compose.yml run --rm \
  -e CONTINUUM_CONFIRM_REBUILD=1 projection-worker node packages/cloud/dist/worker-main.js --rebuild
```
