#!/usr/bin/env bash
set -euo pipefail

continuum_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mcp_entry="${continuum_root}/packages/continuum/dist/mcp/main.js"
active_demo_pointer="${continuum_root}/.continuum-runtime/active-demo-db"

if [[ -n "${CONTINUUM_DB:-}" ]]; then
  exec node "${mcp_entry}" --db "${CONTINUUM_DB}"
fi

if [[ -f "${active_demo_pointer}" ]]; then
  active_demo_db="$(head -n 1 "${active_demo_pointer}")"
  if [[ -f "${active_demo_db}" ]]; then
    exec node "${mcp_entry}" --db "${active_demo_db}"
  fi
fi

exec node "${mcp_entry}"
