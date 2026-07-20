# Continuum Chrome collector

The Chrome collector is a Manifest V3 foreground-tab adapter for the local Continuum engine. It has no project-ID or daemon bearer-token field. Project attribution comes from Continuum’s current expiring active-project lease, and authentication comes from a user-approved five-minute localhost pairing challenge.

## Install and pair

1. Start Continuum with `./script/bootstrap.sh` or `./script/build_and_run.sh`.
2. Open `chrome://extensions`.
3. Enable Developer mode, choose **Load unpacked**, and select this `collectors/chrome` directory.
4. Open the extension popup and choose **Pair with Continuum**.
5. Approve the pending request under **Continuum → Settings → Privacy → Chrome pairing** before its five-minute expiry.
6. Add exact allowed domains in Continuum Privacy settings.
7. Focus a trusted VS Code workspace or use a Continuum-enabled terminal inside the project.

The popup displays the resolved project read-only, including the authoritative lease source and expiry. VS Code and terminal activity establish the strongest ordinary leases. Git and approved-folder activity can establish lower-confidence leases. Chrome only reads a still-valid lease; it never creates or renews one. With no active lease it skips capture and explains how to establish one.

The pairing flow proves possession of a random challenge and returns a `ctc_...` collector credential once. Continuum stores only its SHA-256 hash. That credential is scoped to Chrome event ingestion plus the active-lease/privacy reads needed to sanitize an event; it cannot invoke general daemon routes or submit another source. Pairings can be revoked from the app.

If an authenticated daemon request returns `401` or `403`, the extension clears the rejected token, cached policy, and stale pairing state, then creates a new five-minute pairing request. Collection remains fail-closed until the user approves it again in Continuum.

## Captured metadata

Capture occurs only for the active tab in the focused, non-incognito window, and only when:

- Chrome collection is enabled in the daemon policy;
- extension capture is enabled;
- pairing is valid;
- an unexpired project lease exists;
- the host matches the app-managed allowlist.

The event contains the allowlisted host only when host metadata is enabled and a sanitized path only when path metadata is enabled. When host metadata is off, allowlist matching happens in memory and the queued event uses a generic title with no host. The sanitizer removes URL userinfo, query, fragment, email-like segments, and high-entropy path segments.

The extension does not collect page title, page/DOM content, browser history, cookies, form input, downloads, screenshots, or background-tab activity. Incognito is disabled in the manifest.

## Offline queue

Only a fully sanitized `NormalizedEventV2` enters extension storage. The extension caches the last authenticated `PrivacyPolicyV1` and fails closed without one. The durable queue keeps at most 500 records for the active policy's 1–24 hour retention period, evicts expired records before a read/write, and re-applies current source, domain, host/path, personal, revision, and cloud-eligibility rules before retry. The daemon applies the policy independently again before persistence.

## Verification

```sh
npm --prefix collectors/chrome run verify
```

The checks cover the no-manual-project invariant, active-lease behavior, privacy sanitizer, queue retention, Manifest V3 permissions, and prohibited browser capabilities. A unit check does not replace a live pairing/lease/privacy acceptance test against the running app.
