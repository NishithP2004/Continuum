# Continuum zsh integration

This integration is opt-in:

```zsh
source '/absolute/path/to/Continuum/integrations/zsh/continuum.plugin.zsh'
```

The pre-execution hook pipes the raw command over stdin to the collector; it never places it in process arguments. The collector immediately reduces it to a safe command shape. Leading-space private commands, multiline commands, heredocs, environment assignments, and secret-shaped commands become aggregate privacy counters only. Completion captures the exit code, duration, and repository-relative working directory—never terminal output.

The collector reads the generated token from `~/Library/Application Support/Continuum/auth.token`. Set `CONTINUUM_TOKEN_FILE` when the daemon uses a custom token path. Inside a Git repository, the project ID defaults to the first 24 hexadecimal characters of SHA-256 over its canonical root path; outside Git it uses the canonical working directory. This matches Git and a repository-root VS Code workspace. Run `npm run --silent project-id -- /path/to/repository` to print only the copyable ID. Set `CONTINUUM_PROJECT_ID` to that output before sourcing the plugin when you need an explicit shared override.

The bundled core CLI implements the same safe stdin protocol. After `npm run build -w @continuum/core`, set `CONTINUUM_CLI` to the absolute executable path `packages/continuum/dist/cli/main.js` to route collection through `continuum collect terminal start|complete`. The CLI delegates to this privacy reducer without reading or logging the raw command. Run `npm --prefix integrations/zsh test` to verify both paths.

The durable queue contains sanitized events only, retains at most 1,000 entries, and physically evicts entries older than 24 hours before every persistence or delivery attempt.
