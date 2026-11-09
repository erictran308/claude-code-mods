#!/usr/bin/env bash
# Validates the marketplace and every mod, and runs every mod's tests.
set -euo pipefail
cd "$(dirname "$0")/.."

for tool in claude jq; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

status=0
fail() { echo "FAIL: $*" >&2; status=1; }

manifest=.claude-plugin/marketplace.json

claude plugin validate . || fail "marketplace"

for dir in plugins/*/; do
  dir=${dir%/}
  name=$(jq -r .name "$dir/.claude-plugin/plugin.json")
  version=$(jq -r .version "$dir/.claude-plugin/plugin.json")
  echo "== $name $version"

  [ "$name" = "$(basename "$dir")" ] || fail "$dir: plugin.json is named $name"
  [ -f "$dir/README.md" ] || fail "$name: no README.md"

  listed=$(jq -r --arg name "$name" '.plugins[] | select(.name == $name) | "\(.source) \(.version)"' "$manifest")
  [ "$listed" = "./$dir $version" ] || fail "$name: $manifest says '$listed', expected './$dir $version'"

  claude plugin validate "$dir" || fail "$name: validate"
  if compgen -G "$dir/hooks/*.test.*" >/dev/null; then
    claude plugin test "$dir" || fail "$name: tests"
  else
    fail "$name: no tests in hooks/"
  fi
done

while read -r source; do
  [ -d "$source" ] || fail "$manifest lists $source, which does not exist"
done < <(jq -r '.plugins[].source' "$manifest")

[ "$status" -eq 0 ] && echo "All checks passed."
exit "$status"
