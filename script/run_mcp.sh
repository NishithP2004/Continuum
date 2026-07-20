#!/usr/bin/env bash
set -euo pipefail

continuum_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mcp_entry="${continuum_root}/packages/continuum/dist/mcp/main.js"

# The MCP entrypoint applies the same precedence as the daemon:
# CONTINUUM_DB, then CONTINUUM_DATA_DIR/continuum.sqlite, then the macOS default.
exec node "${mcp_entry}"
