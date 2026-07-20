#!/usr/bin/env bash
set -euo pipefail

continuum_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-}"

if [[ "${mode}" == "--demo" ]]; then
  echo "Continuum is live-only; --demo and runtime fixture loading have been removed." >&2
  exit 2
fi
if [[ -n "${mode}" ]] && [[ "${mode}" != "--skip-verify" ]]; then
  echo "Usage: ./script/bootstrap.sh [--skip-verify]" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Continuum collection requires macOS 14 or newer. The companion PWA can run on other platforms." >&2
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

if [[ "${mode}" != "--skip-verify" ]]; then
  npm run verify --prefix "${continuum_root}"
fi

if command -v ollama >/dev/null 2>&1; then
  if ! ollama list 2>/dev/null | awk '{print $1}' | grep -Fx 'gemma3n:e2b' >/dev/null; then
    echo "Note: Ollama is available, but gemma3n:e2b is not installed. Choose another installed model or run: npm run setup:models"
  fi
else
  echo "Note: Ollama is not installed. On macOS 26+, Apple Foundation Models can be selected when Apple Intelligence is ready."
fi
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "Note: OPENAI_API_KEY is not set. OpenAI remains unavailable until you explicitly configure it."
fi
if [[ -n "${CONTINUUM_SYNC_URL:-}" ]] && [[ -z "${CONTINUUM_SYNC_TOKEN:-}" ]]; then
  echo "Note: CONTINUUM_SYNC_URL is set without CONTINUUM_SYNC_TOKEN, so remote synchronization remains disconnected."
fi

"${continuum_root}/script/build_and_run.sh"

echo
echo "Continuum launched as an empty live system; no fixture events or checkpoints were loaded."
echo "Use Settings to choose a provider, configure privacy, approve folders, and approve the Chrome pairing request."
echo "Chrome extension: ${continuum_root}/collectors/chrome"
echo "Terminal setup: source ${continuum_root}/integrations/zsh/continuum.plugin.zsh"
echo "Git setup: from inside each repository, run ${continuum_root}/integrations/git/install.sh"
echo "Codex MCP configuration: npm run cli -- mcp-config"
