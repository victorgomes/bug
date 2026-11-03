#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

install_dir="$(mktemp -d)"
trap 'rm -rf -- "$install_dir"' EXIT

npm_bin="$(command -v npm)"
node_bin="$(command -v node)"
node_dir="$(dirname -- "$node_bin")"

"$npm_bin" pack --pack-destination "$install_dir"
archives=("$install_dir"/*.tgz)
if [[ ${#archives[@]} -ne 1 || ! -f "${archives[0]}" ]]; then
  echo "Expected exactly one npm package archive." >&2
  exit 1
fi

global_prefix="$("$npm_bin" prefix --global)"
global_root="$("$npm_bin" root --global)"

is_writable_dir() {
  local probe="$1"
  while [[ ! -e "$probe" && ! -L "$probe" ]]; do
    probe="$(dirname -- "$probe")"
  done
  if [[ -L "$probe" ]]; then
    probe="$(dirname -- "$probe")"
  fi
  [[ -w "$probe" ]]
}

needs_sudo=0
if [[ $EUID -ne 0 ]]; then
  for target in "$global_root" "$global_prefix/bin" "$global_root/bnz"; do
    if ! is_writable_dir "$target"; then
      needs_sudo=1
      break
    fi
  done
fi

if [[ $needs_sudo -eq 0 ]]; then
  global_npm=("$npm_bin")
else
  global_npm=(sudo env "PATH=$node_dir:$PATH" "$npm_bin")
fi

"${global_npm[@]}" install --global --prefix "$global_prefix" "${archives[0]}"
"$node_bin" --input-type=module - "$global_root/bnz/package.json" <<'JS'
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(process.argv[2]);
const packagePath = require.resolve('playwright/package.json');
const cli = join(dirname(packagePath), require(packagePath).bin.playwright);
const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
JS

echo "Installed bnz and bnz-mcp globally."
