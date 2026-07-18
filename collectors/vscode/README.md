# Continuum VS Code collector

The extension records only trusted, single-root workspace focus, active-file, and save metadata. File paths are workspace-relative; sensitive and generated paths are dropped. It never reads document text.

For a reproducible development launch, run `npm ci` at the repository root, open the Continuum repository in VS Code, choose **Run Continuum VS Code Collector** in Run and Debug, and press F5. The checked-in launch configuration builds the extension and opens an Extension Development Host on this single-root workspace. Trust the workspace, then run **Continuum: Connect to Local Engine** and paste the daemon bearer token. The token is kept in VS Code SecretStorage.

The default project identity is the first 24 hexadecimal characters of SHA-256 over the canonical workspace-root path. It matches the zsh and Git collectors when the workspace root is the repository root. Run `npm run --silent project-id -- /path/to/repository` to print only the copyable ID. For a subdirectory workspace or a deliberate shared ID, set `continuum.projectId` in VS Code workspace settings (or launch VS Code with `CONTINUUM_PROJECT_ID`); the VS Code setting takes precedence.

Sanitized events that cannot be delivered are retained in extension global storage and retried by **Continuum: Retry Pending Events**. The durable queue keeps the newest 1,000 events for at most 24 hours; expired events are physically removed before a retry or queue write.

Transport is restricted to loopback HTTP and defaults to `http://127.0.0.1:43117/v1/events/batch`.
