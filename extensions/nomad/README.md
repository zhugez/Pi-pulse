# Nomad

Nomad now uses Pi's built-in OpenCode provider unchanged. It does not start a gateway, copy the model catalog, override credentials, inject prompts/tools, or rotate identities/IPs.

- Select an available model with `/model`.
- Configure OpenCode credentials with `/login` (or `OPENCODE_API_KEY`).
- `/opencode status` explains the connection. The old `rotate` action is no longer supported.
- A genuine upstream quota error (429) remains an error. Use an authorized provider or wait for the provider's quota reset; local rotation does not grant quota.

Reload Pi (`/reload`) or restart it after updating. Existing sessions may still hold their previous model metadata; reselect the model after reload. Only model IDs published by the built-in provider/catalog are supported, not arbitrary custom IDs.

Regression checks: `bun test tests/nomad.test.mts` from the repository root. Transport checks use mock responses; they do not prove that an upstream account has quota.
