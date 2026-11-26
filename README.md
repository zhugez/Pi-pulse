<p align="center">
  <img src="assets/banner.svg" alt="pi-pulse: Extensions that sharpen your Pi workflow." width="100%">
</p>

# pi-pulse

An evolving workshop for building sharp, lightweight extensions for the [Pi Coding Agent](https://pi.dev). Each extension is designed to solve one workflow problem well while remaining easy to inspect, test, and install.

The collection currently includes two observability extensions, integrated model providers, and a coding-discipline mode:

- **Code Lens (`code_inspect`)** — real-time in-flight diagnostics, read-guard protection against unread file edits, and symbol outline extraction.
- **Code Mode (`code_exec`)** — programmatically orchestrate file reads, shell commands, and data processing in an async sandbox without context bloat.
- **Codex Pool** — native multi-account pooling for OpenAI Codex (ChatGPT Plus/Pro), session stickiness, bounded failover, and private 0600 persistence.
- **Subscription usage** — provider quota, reset countdowns, and DeepSeek balance/peak pricing.
- **Live throughput** — streaming decode speed, final token rate, TTFT, and input/cache details.
- **Antigravity provider** — Google OAuth, Gemini/Claude/GPT-OSS model routing, quota diagnostics, linked-account failover, and image generation.
- **Gemini Web provider** — native zero-bridge access to Gemini Web with cookie rotation, slot routing, dynamic model discovery, and prompt-based tool calling.
- **Ponytail mode** — "lazy senior dev" instructions that steer the agent toward the smallest working change, plus review/audit skills, via [`ponytail`](https://github.com/DietrichGebert/ponytail).

## Extension catalog

### Code Lens (`code_inspect`)

Native in-flight code intelligence and diagnostics for Pi without external heavyweight binaries:

- **In-flight diagnostics feedback**: Automatically validates syntax and diagnostics immediately upon file edits (`JSON`, `JS`, `TS`, `Python`) and attaches actionable findings into the tool result.
- **Read-guard**: Tracks session file reads and alerts the agent whenever an existing file is modified without being read first, eliminating blind overwrites.
- **Symbol inspection**: The `code_inspect` tool extracts top-level functions, classes, interfaces, and methods with line numbers across TypeScript, JavaScript, Python, Go, and Rust without dumping the entire file into context.
- **Slash commands**: `/lens check <file>`, `/lens symbols <file>`, `/lens stats`.

### Code Mode (`code_exec`)

A programmable execution tool for Pi. Instead of making multiple sequential tool calls that flood the conversation context with raw data dumps, `code_exec` runs an asynchronous JavaScript snippet in an isolated sandbox and returns only the final result and console output.

- **Available globals**: `fs` (`readFile`, `writeFile`, `readdir`, `stat`, `exists`), `exec(cmd, args)`, `console.log(...)`, `cwd`, `path`, `Promise`, `JSON`.
- **Slash command**: `/code-exec <code...>` for testing code snippets directly from the prompt editor.
- **Safety**: Execution timeouts (`timeoutMs`), output truncation guard, and signal-aware cancellation.

### Codex Pool

Native multi-account pooling for OpenAI Codex (ChatGPT Plus/Pro subscription) directly integrated into Pi. No external proxy daemon, local proxy server, or `codex-lb` dependency needed.

Features:
- **Multiple accounts**: Link multiple ChatGPT Plus/Pro subscriptions using Pi's standard native OAuth flow.
- **Automatic failover**: Bounded failover across available accounts when hitting quota limits (HTTP 429, `usage_limit_reached`, `rate_limit_exceeded`) or authentication failures (HTTP 401/403), respecting upstream `Retry-After` headers and `resets_at` timestamps.
- **Replay suppression**: Replay is strictly suppressed once any meaningful stream output (text, thinking, or tool calls) has been emitted, preventing duplicate actions.
- **Session stickiness**: Requests in a session stay pinned to the same account until it enters cooldown or requires login.
- **Private atomic persistence**: Stored in `~/.pi/agent/codex-accounts.json` with owner-only `0600` permissions, atomic temporary-file replacement, and cross-process lock protection.
- **Fail-closed token rotation**: Refresh-in-progress state is persisted before OAuth token exchange to ensure interrupted updates or crashes fail closed rather than reusing spent refresh tokens.

See [Codex Pool reference](extensions/codex-pool/README.md) for crash recovery, locking, and cancellation semantics.

Commands:

```text
/login codex-pool
/codex-pool.accounts [list]
/codex-pool.accounts add
/codex-pool.accounts switch <id>
/codex-pool.accounts remove <id>
```

After adding accounts, select any `codex-pool` model in `/model` (e.g., `codex-pool/gpt-5.3-codex`).

### Subscription usage

Supported providers:

- OpenAI Codex: 5-hour and weekly quota windows, plus banked resets
- Antigravity Pro: Gemini and third-party model quota windows
- OpenCode Go: rolling, weekly, and monthly limits
- DeepSeek API: account balance and local peak/off-peak timing
- codex-lb custom providers: effective API-key/pool limits from `/v1/usage`

Usage appears in its own responsive strip below the editor, separate from the throughput footer. Wide terminals retain progress bars; narrow terminals switch to percentages and wrap without dropping quota windows or reset countdowns. Resizing back restores your selected style automatically.

The extension refreshes around quota resets, coalesces overlapping requests, rejects stale results, and retries failures with exponential backoff. Built-in providers share a disk cache; custom codex-lb quotas stay session-local so identical provider names on different hosts/accounts cannot share quota data.

Commands:

```text
/usage
/usage toggle [bars|percent|off]
/usage refresh [active|<provider>|all]
```

`/usage refresh` defaults to the **active provider**, not unrelated saved accounts. Use `/usage refresh all` explicitly to check every configured usage provider. API failures include the server's reason and credential/permission guidance; missing credentials are reported separately.

#### codex-lb setup

Add the provider IDs to `~/.pi/agent/subscription-usage-prefs.json` (preserve any existing preferences), then reload Pi:

```json
{
  "mode": "bars",
  "codexLbProviders": ["macmini-codex"]
}
```

The IDs must match providers already configured in Pi. No key or URL duplication is needed: Pi resolves the selected model's base URL, API key, and headers at request time, including environment variables and credential commands. The base URL must end in `/v1` (proxy path prefixes are preserved); usage is fetched from the same URL plus `/usage`, without following redirects. Only explicitly listed providers are queried—an OpenAI-compatible API alone does not imply codex-lb support.

Percentages are labeled explicitly and rounded to one decimal: **Pool 5h/W used** is `100 - account_pool_usage.primary/secondary` (the API reports remaining capacity); **Limit … used** is `limits.current_value / limits.max_value × 100`. These are different metrics, not interchangeable. Pool capacity is scoped to accounts assigned to the API key and may differ from a dashboard showing all accounts. Pool data carries no reset timestamp, so only limits show reset countdowns. Key-specific limits take precedence as supplied by codex-lb; different units and model filters remain separately labeled. Null/hidden pool values are omitted, not treated as zero. `/api/codex/usage` is not used because it can return `rate_limit: null` for a valid API key. If neither pool nor limit data is available, an explicit diagnostic is shown.

### Live throughput

The footer displays a compact decode-rate reading:

```text
⚡ ~42.1 tok/s
⚡ 39.8 tok/s
```

Live values use a `characters / 4` estimate. When the provider reports output usage, the settled value uses the reported token count. `/throughput` also shows TTFT, uncached/cached input, decode duration, and measurement freshness.

Commands:

```text
/throughput
/throughput toggle [on|off]
/throughput help
```

### Antigravity provider

The Antigravity provider is built directly into `pi-pulse`. After installing or updating `pi-pulse`, authenticate and select a model:

```text
/login antigravity
/model antigravity/gemini-3.8-flash
```

Useful commands:

```text
/antigravity.models
/antigravity.usage
/antigravity.accounts
/antigravity.refresh
/antigravity.doctor
/antigravity.image <prompt>
```

Model availability depends on the signed-in Google account. It is an unofficial Google integration; review its requested OAuth permissions before approving access.

### Gemini Web provider

Native zero-bridge provider connecting Pi directly to Gemini Web via Google Web RPC. Does not require Go, external bridge processes, or browser automation.

Features:
- **Private cookie auth**: Import cookie headers directly from a `0600` private file for any Google account slot (`/u/N/`).
- **Dynamic model discovery**: Discovers available account models dynamically from Gemini Web catalog RPCs.
- **Prompt-based tool calling**: Translates Pi tool declarations into structured prompts and parses responses with Pi's TypeBox schema validation.
- **Fail-safe isolation**: Plaintext cookie storage in `~/.pi/agent/gemini-web/credentials.json` (`0700` directory, `0600` file); zero leaks to transcripts or logs.
- **Buffered output & safe limits**: Discloses buffered response delivery, unmeasured usage placeholders, and planning token limits.

Commands:

```text
/gemini-web.import <path> --auth-user <N>
/gemini-web.refresh
/gemini-web.logout
/gemini-web.status
```

See the [Gemini Web Provider Reference](extensions/gemini-web/README.md) for complete setup steps, cookie extraction instructions, limitations, and manual smoke test procedures.

### Ponytail mode

`@dietrichgebert/ponytail` is installed as a runtime dependency; the `pi-pulse` manifest loads its Pi extension and skills. Ponytail injects its instructions before each agent turn (default mode: `full`).

```text
/ponytail [off|lite|full|ultra]
/ponytail status
/ponytail default <mode>
/ponytail-review
/ponytail-audit
/ponytail-gain
/ponytail-debt
/ponytail-help
```

The persisted default mode is stored in `~/.config/ponytail/config.json` (or `$XDG_CONFIG_HOME/ponytail/`).

## Install

From GitHub:

```bash
pi install git:github.com/zhugez/pi-pulse
```

For local development:

```bash
pi install /home/dev/pi-pulse
```

Reload an active Pi session with:

```text
/reload
```

## Development

Requires Node.js 22.15.0 or newer.

```bash
npm install
npm run check
```

## Security and privacy

Pi extensions execute with the same operating-system permissions as Pi. The usage extension reads built-in provider credentials from environment variables or `~/.pi/agent/auth.json`. Opted-in codex-lb providers use Pi's resolved model credentials and headers. Requests go only to the corresponding quota/balance endpoints; codex-lb requests reject redirects. Review the source before installation.

Runtime state is stored under `~/.pi/agent/`:

- `codex-accounts.json` (pooled OpenAI Codex OAuth credentials, mode 0600)
- `subscription-usage-cache.json`
- `subscription-usage-prefs.json`
- `live-throughput-prefs.json`
- `auth.json` (Antigravity and Codex Pool OAuth marker credentials managed by Pi)
- `antigravity-accounts.json` (linked Antigravity accounts)
- `gemini-web/credentials.json` (stored Gemini Web cookie credentials, mode 0600 in 0700 dir)

The `codex-accounts.json`, `auth.json`, `antigravity-accounts.json`, and `gemini-web/credentials.json` files contain sensitive credentials. Never commit, share, or paste their contents into issues.

## License

MIT
