#!/usr/bin/env bash
set -euo pipefail

continuum_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
master="${continuum_root}/assets/branding/continuum-app-icon-master.png"
native_resources="${continuum_root}/native/ContinuumApp/Resources"

if [[ ! -f "${master}" ]]; then
  echo "Missing icon master at ${master}" >&2
  exit 1
fi

mkdir -p "${native_resources}"
node "${continuum_root}/script/generate-native-icon.mjs" \
  "${master}" \
  "${native_resources}/ContinuumApp.icns"

(
  cd "${continuum_root}/apps/web"
  npm run icons
)

echo "Generated native and PWA icons from ${master}"
