# Architecture

## Entry and lifecycle

`extensions/startup-entry.ts` registers the observability extensions through
`extensions/deferred-extension.ts`. The package manifest separately loads the
bundled Antigravity and Ponytail dependencies. Keep these entry paths stable.

`extensions/subscription-usage.ts` owns provider requests, the responsive usage
widget below the editor, commands, and session scheduling. The widget measures
terminal columns on each render, falls back from bars to percentages when narrow,
and wraps instead of truncating. Throughput remains in Pi's native footer. Its existing named exports remain available
for compatibility. `extensions/live-throughput-status.ts` owns streaming
measurements and their presentation independently.

## Usage data and persistence

The subscription-usage implementation has two internal modules:

- `extensions/subscription-usage/data.ts` defines the normalized usage payload
  and pure validation. It has no filesystem, network, or Pi dependencies.
- `extensions/subscription-usage/cache.ts` owns disk decoding, fallback snapshots,
  directory creation, serialized read/merge/write operations, atomic replacement,
  and temporary-file cleanup. Its interface is `createUsageCache(path)` returning
  `read()` and `write(providerId, data)`.

Dependency direction:

```text
subscription-usage extension → cache → data
subscription-usage extension ─────────→ data
```

The extension creates one cache instance at module scope so multiple extension
instances continue to share a write queue. It retains file watching and the
100 ms refresh debounce because those drive session rendering and scheduling,
not persistence. The cache never calls back into session state or UI.

Cache reads are best-effort: missing or malformed files retain the last valid
snapshot; valid JSON is normalized, dropping invalid records. Returned snapshots
must be treated as read-only. Writes log failures and resolve so observability
cannot interrupt an agent turn. Queue serialization applies within an instance,
not across processes: simultaneous sessions can still overwrite each other's
updates. File watching makes subsequent reads observe external updates; it is
not a locking mechanism.

## Verification

Run `npm run check` for type checking and all tests. Cache tests exercise the
module's read/write interface using temporary directories, including overlapping
updates, external updates, malformed files, recovery after write failure, and
replacement fallback. Existing provider and lifecycle tests exercise the
extension's unchanged interface and behavior.
