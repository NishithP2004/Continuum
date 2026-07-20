# Continuum VS Code collector

The extension records only trusted, single-root workspace focus, active-file, and save metadata. File paths are workspace-relative; sensitive and generated paths are dropped. It never reads document text.

For a reproducible development launch, run `npm ci` at the repository root, open the Continuum repository in VS Code, choose **Run Continuum VS Code Collector** in Run and Debug, and press F5. The checked-in launch configuration builds the extension and opens an Extension Development Host on this single-root workspace. Trust the workspace, then run **Continuum: Connect to Local Engine** and paste the daemon bearer token. The token is kept in VS Code SecretStorage.

Project assignment is automatic. Every event carries a device-local, SHA-256 path alias and—when Git has a root commit—a repository fingerprint derived from the root commit plus the normalized repository name. Continuum maps clones at different paths to one global project UUID; absolute paths and remotes never leave the collector. The collector shares a generated device ID through `~/.continuum/device-id`. `continuum.projectId` is only for an already-established global UUID; ordinary users do not need to set it.

Sanitized events that cannot be delivered are retained in extension global storage and retried by **Continuum: Retry Pending Events**. The durable queue keeps the newest 1,000 events for the active policy's 1–24 hour retention period; tightening retention physically removes older records before a retry or queue write.

Before anything enters that queue, the extension fetches and validates the current `PrivacyPolicyV1`, applies source/path/personal/cloud switches, and caches the last authenticated policy for offline use. With no valid cache it fails closed. Every retry re-applies the current policy, so disabled sources are removed rather than grandfathered.

Transport is restricted to loopback HTTP and defaults to `http://127.0.0.1:43117/v1/events/batch`.
