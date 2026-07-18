#!/usr/bin/env bash
set -euo pipefail

continuum_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-}"

if [[ "${mode}" != "--demo" ]]; then
  echo "Usage: ./script/bootstrap.sh --demo" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Continuum's native MVP requires macOS 14 or newer." >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [[ -z "${node_major}" ]] || (( node_major < 24 )); then
  echo "Node.js 24 or newer is required." >&2
  exit 1
fi

if [[ -f "${continuum_root}/package-lock.json" ]]; then
  npm ci --prefix "${continuum_root}"
else
  npm install --prefix "${continuum_root}"
fi

npm run verify --prefix "${continuum_root}"

# A bootstrap is always a fresh, project-local demo run. A unique directory
# avoids deleting user data and makes repeated judging deterministic.
mkdir -p "${continuum_root}/.continuum-runtime"
continuum_data_dir="$(mktemp -d "${continuum_root}/.continuum-runtime/demo.XXXXXX")"
export CONTINUUM_DATA_DIR="${continuum_data_dir}"
export CONTINUUM_DISABLE_EMBEDDINGS=1
printf '%s\n' "${continuum_data_dir}/continuum.sqlite" > "${continuum_root}/.continuum-runtime/active-demo-db"

if command -v ollama >/dev/null 2>&1; then
  if ! ollama list 2>/dev/null | awk '{print $1}' | grep -Fx 'gemma3n:e2b' >/dev/null; then
    echo "Note: Ollama is installed, but gemma3n:e2b is not. The synthetic replay remains available with deterministic checkpoints."
    echo "Install the local model later with: npm run setup:models"
  fi
else
  echo "Note: Ollama is not installed. The synthetic replay remains available with deterministic checkpoints."
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "Note: OPENAI_API_KEY is not set. Cloud checkpointing and GPT briefing stay disabled."
fi

"${continuum_root}/script/build_and_run.sh"

token_path="${continuum_data_dir}/auth.token"
if [[ -n "${CONTINUUM_TOKEN:-}" ]]; then
  continuum_token="${CONTINUUM_TOKEN}"
else
  for _ in {1..40}; do
    [[ -f "${token_path}" ]] && break
    sleep 0.1
  done
  if [[ ! -f "${token_path}" ]]; then
    echo "Continuum token was not created at ${token_path}" >&2
    exit 1
  fi
  continuum_token="$(tr -d '\r\n' < "${token_path}")"
fi
curl --fail --silent \
  -X POST \
  -H "Authorization: Bearer ${continuum_token}" \
  -H "Content-Type: application/json" \
  --data '{"phase":"friday"}' \
  "http://127.0.0.1:43117/v1/demo/replay" >/dev/null

echo
echo "Synthetic Friday replay loaded and Continuum launched."
echo "Mark the current Friday checkpoint caught up, then use Load Synthetic Catch-Up in Context Diff."
echo "Demo database: ${continuum_data_dir}/continuum.sqlite"
echo "Codex MCP configuration: npm run cli -- mcp-config"
