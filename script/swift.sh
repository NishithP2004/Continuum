#!/usr/bin/env bash
set -euo pipefail

continuum_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
swift_cache_root="${continuum_root}/.continuum-runtime/swift-cache"

mkdir -p "${swift_cache_root}/clang" "${swift_cache_root}/swiftpm"
export CLANG_MODULE_CACHE_PATH="${swift_cache_root}/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="${swift_cache_root}/swiftpm"

exec swift "$@"
