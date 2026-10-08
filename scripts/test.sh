#!/usr/bin/env bash
set -euo pipefail

check_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-pulse-test.XXXXXX")"
trap 'rm -rf "$check_dir"' EXIT
printf '{"type":"module"}\n' >"$check_dir/package.json"
ln -s "$PWD/node_modules" "$check_dir/node_modules"

./node_modules/.bin/tsc \
  --ignoreConfig \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --lib ES2022 \
  --strict \
  --esModuleInterop \
  --skipLibCheck \
  --outDir "$check_dir" \
  --noEmit false \
  --allowImportingTsExtensions \
  --rewriteRelativeImportExtensions \
  --rootDir . \
  extensions/startup-entry.ts \
  extensions/deferred-extension.ts \
  extensions/subscription-usage.ts \
  extensions/live-throughput-status.ts \
  tests/*.mts

node --test "$check_dir"/tests/*.mjs
