# Continuum Git integration

From the repository to observe, run the installer by absolute path:

```sh
/absolute/path/to/Continuum/integrations/git/install.sh
```

The installer preflights `post-commit`, `post-checkout`, `post-merge`, and `post-rewrite` and refuses the entire installation if any target already exists. It copies the collector into that repository's Git metadata; it never modifies global Git configuration.

Hooks retain only the commit SHA, branch, sanitized subject, operation, and up to 50 repository-relative changed paths. Secret paths are represented by aggregate counters. No patches, blobs, remotes, or credentials are read or sent. The collector reads the default generated token from `~/Library/Application Support/Continuum/auth.token`; set `CONTINUUM_TOKEN_FILE` for a custom path. Delivery is loopback-only and failed deliveries remain as sanitized per-event files under the repository's Git metadata.

Project assignment is automatic. Each V2 event contains a SHA-256 alias for the device-local repository path and a fingerprint derived only from root commit IDs plus the normalized repository name. Clones can therefore resolve to one global UUID without collecting an absolute path or remote. Git, zsh, and VS Code share the generated `~/.continuum/device-id`. `CONTINUUM_PROJECT_ID` and `continuum.projectId` are accepted only as existing global UUIDs; the environment value takes precedence over repository config.

The repository-local retry queue retains at most 1,000 sanitized events and physically evicts entries outside the active policy's 1–24 hour retention period before every persistence or delivery attempt.

Each hook validates the daemon's current `PrivacyPolicyV1` before it writes a queue file. The Git source switch, personal metadata, relative-path visibility, ignored paths, policy revision, and cloud eligibility are applied at this boundary and again before retry. A validated policy is cached under the repository's Git metadata; with no live or cached policy the hook fails closed. Because support files are copied at install time, repositories installed with an older Continuum collector must remove those Continuum-owned hooks/support files and run the installer again; the installer intentionally never overwrites hooks.

Run `npm --prefix integrations/git test` for sanitizer, collector, and refuse-overwrite integration tests.
