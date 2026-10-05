#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

npm ci
npx --no-install playwright install chromium

install_dir="$(mktemp -d)"
trap 'rm -rf -- "$install_dir"' EXIT

npm pack --pack-destination "$install_dir"
archives=("$install_dir"/*.tgz)
if [[ ${#archives[@]} -ne 1 || ! -f "${archives[0]}" ]]; then
  echo "Expected exactly one npm package archive." >&2
  exit 1
fi

if [[ $EUID -eq 0 ]]; then
  npm install --global "${archives[0]}"
else
  sudo npm install --global "${archives[0]}"
fi

echo "Installed bnz and bnz-mcp globally."
