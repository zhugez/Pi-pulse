<p align="center">
  <img src="assets/banner.svg" alt="pi-pulse: Extensions that sharpen your Pi workflow." width="100%">
</p>

# pi-pulse

An evolving workshop for building sharp, lightweight extensions for the [Pi Coding Agent](https://pi.dev). Each extension is designed to solve one workflow problem well while remaining easy to inspect, test, and install.

The collection currently includes two observability extensions, an integrated model provider, and a coding-discipline mode:

- **Subscription usage** — provider quota, reset countdowns, and DeepSeek balance/peak pricing.
- **Live throughput** — streaming decode speed, final token rate, TTFT, and input/cache details.
- **Antigravity provider** — Google OAuth, Gemini/Claude/GPT-OSS model routing, quota diagnostics, linked-account failover, and image generation via [`pi-antigravity`](https://github.com/Rahularya01/pi-antigravity).
- **Ponytail mode** — "lazy senior dev" instructions that steer the agent toward the smallest working change, plus review/audit skills, via [`ponytail`](https://github.com/DietrichGebert/ponytail).

## Extension catalog

### Subscription usage

Supported providers:

- OpenAI Codex: 5-hour and weekly quota windows, plus banked resets
- Antigravity Pro: Gemini and third-party model quota windows
- OpenCode Go: rolling, weekly, and monthly limits
- DeepSeek API: account balance and local peak/off-peak timing
- codex-lb custom providers: effective API-key/pool limits from `/v1/usage`

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

`pi-antigravity` is installed as a runtime dependency and loaded by the `pi-pulse` package manifest. After installing or updating `pi-pulse`, authenticate and select a model:

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

Model availability depends on the signed-in Google account. `pi-antigravity` requires Pi/Pi AI 0.80.0 or later and Node.js 22.15.0 or later. It is an unofficial Google integration; review its requested OAuth permissions before approving access.

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

- `subscription-usage-cache.json`
- `subscription-usage-prefs.json`
- `live-throughput-prefs.json`
- `auth.json` (Antigravity OAuth credentials managed by Pi)
- `antigravity-accounts.json` (linked Antigravity accounts)

The last two files contain sensitive access and refresh tokens. Never commit, share, or paste their contents into issues.

## Attribution

The observability extensions are derived from [Th1nhNg0/pi-extensions](https://github.com/Th1nhNg0/pi-extensions). The integrated provider is supplied by [Rahularya01/pi-antigravity](https://github.com/Rahularya01/pi-antigravity), and Ponytail mode by [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail). All are used under the MIT License. See [NOTICE](NOTICE).

## License

MIT
