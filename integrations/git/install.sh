#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "Continuum Git hooks must be installed from inside a repository." >&2
  exit 1
}
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
hooks_dir="$git_dir/hooks"
support_dir="$git_dir/continuum"

for hook in post-commit post-checkout post-merge post-rewrite; do
  target="$hooks_dir/$hook"
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "Refusing to overwrite existing hook: $target" >&2
    exit 1
  fi
done

for support in collector.mjs privacy.mjs project-identity.mjs queue-policy.mjs; do
  target="$support_dir/$support"
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "Refusing to overwrite existing Continuum support file: $target" >&2
    exit 1
  fi
done

mkdir -p "$hooks_dir" "$support_dir"
install -m 700 "$script_dir/collector.mjs" "$support_dir/collector.mjs"
install -m 600 "$script_dir/privacy.mjs" "$support_dir/privacy.mjs"
install -m 600 "$script_dir/project-identity.mjs" "$support_dir/project-identity.mjs"
install -m 600 "$script_dir/queue-policy.mjs" "$support_dir/queue-policy.mjs"
for hook in post-commit post-checkout post-merge post-rewrite; do
  install -m 700 "$script_dir/hooks/$hook" "$hooks_dir/$hook"
done

echo "Installed privacy-first Continuum hooks in $hooks_dir"
