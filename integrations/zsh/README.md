# Continuum zsh integration

This integration is opt-in:

```zsh
source '/absolute/path/to/Continuum/integrations/zsh/continuum.plugin.zsh'
```

The pre-execution hook pipes the raw command over stdin to the collector; it never places it in process arguments. The collector immediately reduces it to a safe command shape. Leading-space private commands, multiline commands, heredocs, environment assignments, and secret-shaped commands become aggregate privacy counters only. Completion captures the exit code, duration, and repository-relative working directory—never terminal output.

The collector reads the generated token from `~/Library/Application Support/Continuum/auth.token`. Set `CONTINUUM_TOKEN_FILE` when the daemon uses a custom token path. Project assignment is automatic: events contain a hashed local path alias and, inside Git, a fingerprint derived only from root commit IDs and the normalized repository name. This lets Continuum match clones without disclosing absolute paths or remotes. VS Code, zsh, and Git share the generated `~/.continuum/device-id`. `CONTINUUM_PROJECT_ID` is accepted only when it is an existing global UUID.

The bundled core CLI implements the same safe stdin protocol. After `npm run build -w @continuum/core`, set `CONTINUUM_CLI` to the absolute executable path `packages/continuum/dist/cli/main.js` to route collection through `continuum collect terminal start|complete`. The CLI delegates to this privacy reducer without reading or logging the raw command. Run `npm --prefix integrations/zsh test` to verify both paths.

The durable queue contains sanitized events only, retains at most 1,000 entries, and physically evicts entries outside the active policy's 1–24 hour retention period before every persistence or delivery attempt.

The collector validates `PrivacyPolicyV1` before writing sanitized command state or a queue file. Command names, relative working directories, personal collection, cloud eligibility, ignore patterns, and the terminal source switch are enforced locally. The last authenticated policy is cached with mode `0600`; without a valid cached or live policy collection fails closed, and retry re-evaluates existing queue entries.
