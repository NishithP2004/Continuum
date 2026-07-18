# Continuum Git integration

From the repository to observe, run the installer by absolute path:

```sh
/absolute/path/to/Continuum/integrations/git/install.sh
```

The installer preflights `post-commit`, `post-checkout`, `post-merge`, and `post-rewrite` and refuses the entire installation if any target already exists. It copies the collector into that repository's Git metadata; it never modifies global Git configuration.

Hooks retain only the commit SHA, branch, sanitized subject, operation, and up to 50 repository-relative changed paths. Secret paths are represented by aggregate counters. No patches, blobs, remotes, or credentials are read or sent. The collector reads the default generated token from `~/Library/Application Support/Continuum/auth.token`; set `CONTINUUM_TOKEN_FILE` for a custom path. Delivery is loopback-only and failed deliveries remain as sanitized per-event files under the repository's Git metadata.

The project ID defaults to the first 24 hexadecimal characters of SHA-256 over the canonical repository-root path, matching zsh and a repository-root VS Code workspace. Print only the copyable value for Chrome with `npm run --silent project-id -- /path/to/repository`. Set `CONTINUUM_PROJECT_ID` for a process-level override, or `git config --local continuum.projectId 'shared-project-id'` for an override that also works in hooks started by GUI Git clients. The environment value takes precedence over repository config.

The repository-local retry queue retains at most 1,000 sanitized events and physically evicts entries older than 24 hours before every persistence or delivery attempt.

Run `npm --prefix integrations/git test` for sanitizer, collector, and refuse-overwrite integration tests.
