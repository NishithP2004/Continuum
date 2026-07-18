# Continuum Chrome collector

Run `npm run --silent project-id -- /path/to/repository` from the Continuum source tree and copy the printed 24-character ID. Chrome cannot inspect the local filesystem, so this explicit copy is how its events join the same project as the canonical VS Code, zsh, and Git fallback. Load this directory as an unpacked extension at `chrome://extensions`. Open the extension popup, paste that project ID, list exact domains (or explicit `*.example.com` wildcards), paste the local bearer token, and enable capture. Capture remains off when the project ID is empty.

The extension requests `tabs` and loopback host access only after that user gesture. It observes only the active tab of the focused window and stores only the allowlisted host plus a URL with credentials, query, fragment, email-like segments, and high-entropy path segments removed. It does not request history, inject content scripts, read page content or titles, or run in incognito. The token lasts for the browser session; the already-sanitized retry queue is durable. The queue keeps the newest 500 events for at most 24 hours, physically removing expired events before a retry or queue write.

Run `npm --prefix collectors/chrome run verify` to check privacy invariants and sanitizer tests.
