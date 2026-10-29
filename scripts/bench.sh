#!/usr/bin/env bash
# Benchmark gate: compares the current run against bench/baseline.json.
#
#   ./scripts/bench.sh           # compare (exit 1 on a regression beyond tolerance)
#   ./scripts/bench.sh --write   # refresh the baseline after an intended change
set -euo pipefail

if [[ "${1:-}" == "--write" ]]; then
  node --experimental-strip-types bench/perf.mts --write
  exit 0
fi

current="$(mktemp "${TMPDIR:-/tmp}/pi-pulse-bench.XXXXXX.json")"
trap 'rm -f "$current"' EXIT
node --experimental-strip-types bench/perf.mts >"$current"

node -e '
const fs = require("node:fs");
const current = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const baseline = JSON.parse(fs.readFileSync("bench/baseline.json", "utf8"));
const tolerance = baseline.noiseTolerance ?? 0.05;
// Microsecond-scale samples jitter by whole percentages; only a change that is
// both relatively and absolutely large counts as a regression.
const floorMs = baseline.absoluteFloorMs ?? 1;
const failures = [];
const rows = [];

for (const sample of current.samples) {
  const base = baseline.samples.find((entry) => entry.name === sample.name);
  if (!base) {
    rows.push(`${sample.name}: no baseline (run --write)`);
    continue;
  }
  for (const metric of ["medianMs", "p95Ms"]) {
    const delta = (sample[metric] - base[metric]) / base[metric];
    const absolute = sample[metric] - base[metric];
    const regressed = delta > tolerance && absolute > floorMs;
    const flag = regressed ? "REGRESSION" : "ok";
    if (regressed) failures.push(`${sample.name} ${metric} +${(delta * 100).toFixed(1)}% (+${absolute.toFixed(3)}ms)`);
    rows.push(
      `${flag.padEnd(10)} ${sample.name} ${metric}: ${base[metric]} -> ${sample[metric]} (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%)`,
    );
  }
}

console.log(rows.join("\n"));
if (failures.length > 0) {
  console.error(`\n${failures.length} regression(s) beyond ${(tolerance * 100).toFixed(0)}% noise tolerance`);
  process.exit(1);
}
' "$current"
