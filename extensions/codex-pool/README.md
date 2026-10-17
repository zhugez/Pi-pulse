# Codex Pool for Pi

Native multi-account pooling for OpenAI Codex (ChatGPT Plus/Pro subscriptions) built directly into Pi. Requires no external proxy, daemon, or `codex-lb` installation.

## Features

- **Native Codex OAuth Delegation**: Links ChatGPT Plus/Pro accounts using Pi's standard browser or headless device-code authentication.
- **Stable Identity**: Uses SHA-256 over `chatgpt_account_id` and JWT `sub` for deterministic, cross-process account identification without logging or exposing credentials.
- **Failover & Cooldown Policy**: Bounded to at most one attempt per account in the pool. When an account encounters a rate limit (HTTP 429) or quota errors (`usage_limit_reached`, `rate_limit_exceeded`, `usage_not_included`), it is placed on cooldown based on upstream `Retry-After-Ms`, `Retry-After`, or JSON `resets_at` hints (defaulting to 60s minimum 1s). When an account encounters authentication failure (HTTP 401/403), it is marked `needsLogin: true` to prevent reuse until re-authenticated. In both cases, the next available account is selected automatically.
- **Replay Suppression**: Never replays requests once meaningful output (text deltas, thinking deltas, or tool calls) has been emitted. Once output starts, errors terminate the stream immediately with a non-retryable message to prevent duplicate tool execution or fragmented agent context. Generic network errors and context-overflow errors never trigger account hopping.
- **Session Stickiness**: Remembers the chosen account per session until that account cools down, is switched, or requires re-login.
- **Private Atomic Persistence**: Stores account credentials in `~/.pi/agent/codex-accounts.json` with strict `0600` owner-only file permissions, atomic temporary-file replacement, and directory sync. Malformed, world-readable, or symlinked files are rejected.
- **Token Rotation Safety**: Refresh tokens are rotated inside an exclusive lock. Before initiating token exchange with the OAuth provider, the account is durably persisted on disk in a fail-closed `needsLogin: true` state. If the process is terminated during exchange or disk save fails, the stale token will never be re-used.
- **Structured Error Diagnostics**: Pool exhaustion reports the total number of accounts and earliest cooldown reset duration without exposing API keys, access tokens, or sensitive headers.

## Commands

```text
/login codex-pool
/codex-pool.accounts [list]
/codex-pool.accounts add
/codex-pool.accounts switch <id>
/codex-pool.accounts remove <id>
```

- `/login codex-pool` or `/codex-pool.accounts add`: Prompts for browser or device-code OAuth login and adds or updates the account in the pool.
- `/codex-pool.accounts list`: Shows all pooled accounts with their ID prefix, status (`ready`, `cooldown until ...`, `login required`), and marks the preferred account (`*`).
- `/codex-pool.accounts switch <id>`: Sets the preferred account by ID prefix (unambiguous prefix required).
- `/codex-pool.accounts remove <id>`: Removes an account from the pool by ID prefix. If the preferred account is removed, the next remaining account becomes preferred.

## Model Selection

After adding accounts, select any Codex model under the `codex-pool` provider in `/model`:
```text
/model codex-pool/gpt-5.3-codex
```

## Cancellation Handling

- **Command cancellation**: Aborting a command (e.g. via `ctx.signal` or pressing Ctrl+C) cancels ongoing store operations, lock waiting, and account management cleanly.
- **Prompt cancellation**: Distinguishes per-prompt cancellation from user cancellation. When the SDK closes the manual authorization code prompt because the browser callback succeeded, the parent login flow continues without interruption. Genuine user cancellation of the prompt dialog aborts the login flow.
- **Streaming cancellation**: Aborting a stream cancels the underlying fetch/SSE connection immediately and emits an aborted terminal event.

## Cross-Process Locking and Crash Recovery

Store operations and token refresh use an exclusive lock directory at `<path>.lock` (e.g., `~/.pi/agent/codex-accounts.json.lock`).
- Locks are never stolen automatically to prevent corrupting concurrent processes or causing token rotation races.
- If a process terminates abruptly (such as an unhandled SIGKILL or system crash) while holding the lock, subsequent operations will wait for the lock timeout (35 seconds) and fail with:
  ```text
  Codex account store is locked. See codex-pool README for crash recovery.
  ```
- **Recovery Procedure**:
  1. Verify no other Pi process or background job is running.
  2. Remove the lock directory manually:
     ```bash
     rm -rf ~/.pi/agent/codex-accounts.json.lock
     ```

## Logout Semantics

Running `/logout codex-pool` removes Pi's ambient marker credential from `~/.pi/agent/auth.json`. However, pooled accounts in `codex-accounts.json` remain available to the provider. To permanently unlink or remove accounts, use:
```text
/codex-pool.accounts remove <id>
```
Or delete the private account store file `~/.pi/agent/codex-accounts.json`.

## Supported Pi Versions

Requires Pi SDK with native OpenAI Codex provider and OAuth support (`@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `>=0.80.0`, tested with Pi 1.3.0 and Node.js `>=22.15.0`).
