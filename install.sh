#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

install_dir="$(mktemp -d)"
trap 'rm -rf -- "$install_dir"' EXIT

npm pack --pack-destination "$install_dir"
archives=("$install_dir"/*.tgz)
if [[ ${#archives[@]} -ne 1 || ! -f "${archives[0]}" ]]; then
  echo "Expected exactly one npm package archive." >&2
  exit 1
fi

if [[ $EUID -eq 0 ]]; then
  global_npm=(npm)
else
  global_npm=(sudo npm)
fi

"${global_npm[@]}" install --global "${archives[0]}"
global_root="$("${global_npm[@]}" root --global)"
node --input-type=module - "$global_root/bnz/package.json" <<'JS'
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
