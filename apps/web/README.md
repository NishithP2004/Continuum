# Continuum PWA

The PWA is an installable synchronized companion for Continuum. It never performs device collection, never creates fixture activity, and never reads the viewing browser’s tabs/history. Every screen is backed by the authenticated self-hosted API.

Routes include Now, Chat, Graph, Timeline, Privacy, Devices, and Settings. Desktop graph rendering uses Graphology/Sigma.js; narrow layouts use a simplified graph and selected-node bottom sheet. Chat consumes cited SSE responses and supports cancellation. Privacy edits, device revocation, copy-once API-key management, projection health, and remote MCP setup remain tenant-scoped.

## Local development

The package is part of the root npm workspace and can also be run directly by prefix:

```sh
npm ci
cp apps/web/.env.example apps/web/.env.local
npm --prefix apps/web run dev
```

Configure the public HTTPS API URL and Auth0 SPA application values in `.env.local`. Auth0 must allow the development/production origins as callback, logout, and web origins, and issue tokens for the Continuum API audience. HTTP API overrides are accepted only for loopback development.

The Settings service-URL override is stored locally. Auth0 access tokens remain in the SPA authentication flow and are not written into application records.

## Checks

```sh
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npm --prefix apps/web test
npm --prefix apps/web run test:e2e
```

Vitest and Playwright exercise empty/live API states and mocked transport boundaries only. They do not seed the running Continuum app or cloud service.

## Container

`Dockerfile` builds the Vite app and serves it through nginx with an SPA fallback on port 80. Pass the four `VITE_*` values from `infra/.env`; Caddy owns public HTTPS and routes API/MCP traffic to the cloud service. The PWA is not a standalone source of truth—PostgreSQL remains authoritative for synchronized state.
