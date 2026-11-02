# Changelog

## [1.1.0] - 2026-11-02

### Changed

- Tool schemas import `Type` and `Static` from `typebox` instead of `@earendil-works/pi-ai`, which no longer re-exports them in its published types. Runtime behaviour is unchanged: pi resolves both to its own TypeBox.
- `StringEnum` is now a local helper (`extensions/shared/string-enum.ts`) returning a TypeBox `TUnsafe`, so `Static` keeps inferring the literal union. pi-ai 1.5.0 types its `StringEnum` as a pi-schema `Schema<T>`, which collapsed those properties to `unknown` under `tsc`.
- Development dependencies target pi 1.5.0.

### Added

- `code_exec` caps each command's buffered output at 64 MiB and reports truncation in stderr instead of returning silently incomplete output.
- Tests covering pi 1.5.0 tool-argument coercion (`tests/gemini-web-coercion.test.mts`).

### Fixed

- The `/goal-settings` controls dialog now reports pi as blocked on user input, so terminals that show program status no longer display pi as idle while the dialog waits.
