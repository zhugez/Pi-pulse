<p align="center">
  <img src="assets/banner.svg" alt="pi-pulse: Extensions that sharpen your Pi workflow." width="100%">
</p>

# pi-pulse

An evolving workshop for building sharp, lightweight extensions for the [Pi Coding Agent](https://pi.dev). Each extension is designed to solve one workflow problem well while remaining easy to inspect, test, and install.

The collection currently includes two observability extensions, integrated model providers, and a coding-discipline mode:

- **Loop guard** — blocks byte-identical tool calls before they grind, with an actionable reason instead of a silent repeat.
- **Mutation gate** — `/mutator` finds behavior no test checks, via [unclebob/mutator](https://github.com/unclebob/mutator).
- **Invar** — `/invar setup` captures commands for your review, then checks exit code, stdout, and stderr against the approved baseline.
- **CRAP gate** — `/crap` scores every function with [unclebob/crapper](https://github.com/unclebob/crapper) and reports the ones over CRAP 10.
- **Comment checker** — runs `@code-yeongyu/comment-checker` after `write`/`edit`/`multiedit`/`apply_patch` and appends its warnings to the tool result.
- **Code Lens (`code_inspect`)** — real-time in-flight diagnostics, read-guard protection against unread file edits, and symbol outline extraction.
- **Code Mode (`code_exec`)** — programmatically orchestrate file reads, shell commands, and data processing in an async sandbox without context bloat.
- **Codex Pool** — native multi-account pooling for OpenAI Codex (ChatGPT Plus/Pro), session stickiness, bounded failover, and private 0600 persistence.
- **[Numes Pool](#numes-pool)** — rotate local Numes API keys, skip keys rejected with HTTP 401, and respect shared rate limits.
- **Subscription usage** — provider quota, reset countdowns, and DeepSeek balance/peak pricing.
- **Live throughput** — streaming decode speed, final token rate, TTFT, and input/cache details.
- **Fast mode** — `/fast [on|off|toggle]` requests Fast processing for allowlisted OpenAI Responses models, including `xingchiapi/gpt-6.1-sol`, without an external `pi-fast` package.
- **[Antigravity Pool](#antigravity-pool)** — Google OAuth, Gemini/Claude/GPT-OSS model routing, quota diagnostics, linked-account failover, and image generation.
- **Claude Code CLI provider** — use your Claude Pro/Max subscription from Pi coding agent via the local authenticated `claude` CLI with MCP tool bridge.
- **ExoMind Second Brain** — persistent long-term memory runtime with hybrid graph recall, typed relations, and auto-capture across sessions.
- **Gemini Web provider** — native zero-bridge access to Gemini Web with cookie rotation, slot routing, dynamic model discovery, and prompt-based tool calling.
- **Ponytail mode** — "lazy senior dev" instructions that steer the agent toward the smallest working change, plus review/audit skills, via [`ponytail`](https://github.com/DietrichGebert/ponytail).
- **Stella** — `/skill:stella` rewrites ambiguous technical English using ASD-STE100-inspired rules, with a bundled linter for structural checks.
- **witr** — `/skill:witr` looks up local processes and occupied ports. It reports the user of the process witr selects and traces what started that process. Requires Bash, `jq`, and the [witr CLI](https://github.com/pranshuparmar/witr#2-installation) on `PATH`.
- **Goal** — `/goal` conversational goal planning with tasks, subtasks, persistent progress, and an independent completion auditor.
- **Todo** — a persistent `todo` tool, `/todos`, and a live task panel above the editor.
- **Advisor** — an on-demand second opinion through `ask_advisor` and configurable review gates, on a separate model.

## Extension catalog

### Loop guard

A model that repeats the same call with identical arguments is not making progress — the result cannot change. Pi has no loop detection of its own, so this blocks the repeat and returns the block reason to the model as the reminder.

- **Thresholds**: the 4th consecutive identical call is refused; after a block the threshold drops to 2 so a stuck agent escalates instead of grinding.
- **No deadlock**: a blocked call always lets the next attempt through, so the guard can never wedge a run.
- **Signature**: canonicalized JSON (key order cannot hide a repeat), hashed with SHA-256.
- **Never blocks nested calls** (`ctx.executeTool` / codemode subcalls), which cannot re-plan mid-script.
- **Toggle**: `PI_LOOP_GUARD=0`.

### CRAP gate (`/crap`)

The numeric half of [ub-mode](https://github.com/unclebob/ub-mode): `CRAP = CC² × (1 − coverage)³ + CC`, and every function should stay under **10**. Because CRAP is never lower than CC, the gate also rejects any function whose cyclomatic complexity is above 10 — even fully covered.

```bash
/crap                  # complexity only, fast: --no-coverage
/crap --changed        # git additions and edits, with coverage
/crap src/core         # a path or path fragment
/crap --threshold 30   # exit 2 when the worst score exceeds 30
```

- **A command, not a tool.** A coverage run takes minutes and the first invocation bootstraps a Python venv, so this never sits in the per-edit path.
- **Discovery**: `PI_CRAPPER`, then `crapper` on `PATH`, then the project's own `./crapper` launcher.
- **Bounded**: 64 KiB output, 300 s timeout. Exit 2 (threshold exceeded) is reported as a result, not an error.
- **Fails open**: no binary → a warning with the install hint, never a blocked edit.

### Mutation gate (`/mutator`)

The other half of [ub-mode](https://github.com/unclebob/ub-mode): a mutant survives when the tests still pass, so survivors are exactly the behavior nothing checks. Runs [unclebob/mutator](https://github.com/unclebob/mutator), which needs `crapper` checked out next to it (it reads namespaces from `../crapper`).

```bash
/mutator                      # --changed: git additions and edits
/mutator --scan src/core      # list mutation sites, run no tests (instant)
/mutator src/core             # one file or directory
/mutator --test-command "pnpm test" src/core
```

- **Slower than `/crap` by an order of magnitude** — each mutant re-runs the tests. Start with one file or `--scan`.
- **Differential after the first run**: mutator keeps `.metrics/mutate/`, so later runs only re-run survivors and functions whose text changed.
- **Exit codes are results**: `0` all killed, `2` baseline tests failed, `3` a mutant survived. Only other codes are errors.
- **Bounded**: 64 KiB output, 15 min default (`PI_MUTATOR_TIMEOUT_MS`), discovery via `PI_MUTATOR` → `PATH` → `./mutator`.

### Invar (`/invar`)

[Invar](https://github.com/zhugez/invar) records command behavior before code changes. Verification compares exit code, stdout, and stderr byte for byte. A pass covers the configured examples. Use existing tests alongside Invar.

[Pi Capsule](https://github.com/zhugez/pi-capsule) installs the Invar CLI during restore and package installation or updates on Linux/WSL x86_64. Standalone Pulse users can follow Invar's [installation instructions](https://github.com/zhugez/invar#install). The adapter defaults to `~/.local/bin/invar`. Set `INVAR_BIN` to an absolute executable path before starting Pi to override it. Pi 0.87.0 or later is required.

```text
/invar setup    # review commands, capture behavior, review bytes, approve the baseline
/invar verify   # verify now; /invar alone does the same
/invar status   # show whether this project is enabled
/invar off      # disable automatic verification; preserve baseline files
```

When the CLI is installed, opening a trusted project in interactive or RPC mode automatically offers setup. No setup command is required. Declining the offer or using `/invar off` persists your choice for that project. Use `/invar setup` to enable it later. Set `PI_INVAR_AUTO_SETUP=0` before starting Pi to suppress startup offers globally.

Setup opens an existing `invar.json`, or asks for a JSON argument array such as `["node", "report.mjs"]`. Review the commands before capture. Review the captured bytes before approval. Cancelling or editing the byte preview leaves the candidate unapproved. No configured commands run before you approve capture.

After approval and an initial passing check, the adapter verifies before the agent settles after potentially modifying tool calls, including shell and unannotated custom tools. Built-in reads and tools annotated as read-only do not trigger checks. A failure requests one automatic repair continuation. A second failure is reported without another automatic retry. The agent receives instructions to preserve the baseline and report unresolved failures.

The adapter pins the executable, configuration, and accepted baseline by SHA-256 in the active Pi agent directory under `invar/`. Changed pins stop execution until you restore the reviewed files or explicitly review them again with `/invar setup`. No commands run automatically in untrusted or unregistered projects. `/invar off` removes the registration and records a disabled marker so startup does not offer setup again.

Commit `invar.json`, `.invar/.gitignore`, and `.invar/accepted.json` for review. Commands run with your filesystem and network access. Use deterministic commands: timestamps, random values, or unstable output can cause regressions. Verification does not approve new behavior or replace the baseline.

### CRAP gate (`/crap`)

Port of [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) (MIT, see `NOTICE`). After a file edit it feeds the change to the native `@code-yeongyu/comment-checker` tree-sitter binary and appends the verdict to the tool result, so redundant comments get flagged in the same turn they are written.

- **Inputs**: `write`, `edit`, `multiedit`, and `apply_patch` (text hunks and OMO/Codex `details.files` metadata).
- **Exit codes**: `0` pass, `2` warning (appended to the result), anything else is an error that leaves the result untouched.
- **Bounded**: 64 KiB output cap per stream, 30 s timeout, SIGTERM then SIGKILL.
- **Fails open**: a missing binary disables the check instead of blocking edits. `/comment-checker` reports status.
- **Widget**: hidden by design — warnings ride the tool result instead of a TUI panel.

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

### Numes Pool

Numes Pool uses keys you already own. It does not create or revoke keys. Set it up on Linux or macOS:

1. In your active Pi agent directory (default `~/.pi/agent`), create `numes-pool.keys` with `umask 077` and an editor. Put one Numes key on each line. The file must belong to you and have mode `0600`. Keep it outside Git.
2. Add this entry under `providers` in the same directory's `models.json`. Keep the other providers. Replace `YOUR_NUMES_MODEL_ID` with an ID from your Numes model catalog. `numes-pool-managed` is a marker, not a key.

   ```json
   {
     "providers": {
       "numes-pool": {
         "baseUrl": "https://api.numes.ai/api/v1",
         "api": "openai-completions",
         "apiKey": "numes-pool-managed",
         "models": [{ "id": "YOUR_NUMES_MODEL_ID" }]
       }
     }
   }
   ```

3. Reload Pi and select the Numes model with `/model`. Reload again after editing the key file.

The pool rotates keys per request. An HTTP 401 marks that key as rejected until reload and tries the next key. An HTTP 429 pauses the whole pool in the current Pi process. The pool honors `Retry-After` and waits 60 seconds if the header is absent or invalid. An HTTP 403 does not trigger failover.

### Subscription usage

Supported providers:

- OpenAI Codex: 5-hour and weekly quota windows, plus banked resets
- Antigravity Pool: Gemini and third-party model quota windows
- OpenCode Go: rolling, weekly, and monthly limits
- DeepSeek API: account balance and local peak/off-peak timing
- codex-lb custom providers: effective API-key/pool limits from `/v1/usage`
- HMS: daily token quota from model-list headers
- xingchiapi: account balance and today's request count

Usage appears in its own responsive strip below the editor, separate from the throughput footer. Wide terminals retain progress bars; narrow terminals switch to percentages and wrap without dropping quota windows or reset countdowns. Resizing back restores your selected style automatically.

Compact and Fast share the model-health dock’s two-row layout, column spacing, and status colors. With Capsule compact checkpoints enabled, `COMPACT @30%` shows the configured trigger above the remaining token budget. Whole columns wrap together when the terminal narrows. If the dock is hidden or unavailable, each extension restores its footer label.

The extension refreshes around quota resets, coalesces overlapping requests, rejects stale results, and retries failures with exponential backoff. OpenAI Codex uses a shared disk cache. Antigravity Pool and custom codex-lb quotas stay session-local so separate profiles, hosts, or accounts do not share cached quota data.

HMS and xingchiapi models also receive automatic inference checks in every Pi session, regardless of the active provider. The extension checks each configured chat model with an isolated `Reply OK.` request, with at most two concurrent checks and a 30-second timeout per model. It starts the next sweep 60 seconds after the previous sweep completes. These requests can consume tokens and credits. A compact two-column HMS/XINGCHI toolbar shows short model labels, status symbols, and successful response times below the editor. Full model IDs, result age, and polling details remain in `/usage`. An `OK` means the model returned non-empty text during that check, not guaranteed future availability. A failed check means no usable response arrived within the check's limits.

Checks remain session-local. Multiple Pi sessions each send their own checks. `/usage toggle off` stops checks and hides usage. Restoring bars or percentages restarts checks. Closing or reloading Pi cancels the session's checks. No checks run while Pi is closed.

Commands:

```text
/usage
/usage check
/usage toggle [bars|percent|off]
/usage refresh [active|<provider>|all]
```

`/usage refresh` defaults to the **active provider**, not unrelated saved accounts. Use `/usage refresh antigravity-pool` to check Antigravity Pool directly. Use `/usage refresh all` explicitly to check every configured usage provider. API failures include the server's reason and credential/permission guidance; missing credentials are reported separately.

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

### Antigravity Pool

Antigravity Pool is built into `pi-pulse`. For a new installation, sign in and select a model:

```text
/login antigravity-pool
/model antigravity-pool/gemini-3.8-flash
```

Startup does not migrate credentials. To keep a legacy OAuth login, close older Pi processes. In the profile you want to upgrade, run `/antigravity.migrate` once. The command moves the `antigravity` entry to `antigravity-pool` in the private `auth.json`. If both entries exist, the command reports the conflict and leaves both unchanged. Linked accounts stay intact. Do not run the command after logout unless you intend to restore the retained legacy login.

After migration, restart Pi and select a model under `antigravity-pool`. Update saved `antigravity/...` model patterns and overrides to use `antigravity-pool/...`.

To roll back, close Pi and restore the old extension. If the private `auth.json` has no `antigravity` entry, rename `antigravity-pool` to `antigravity`. Do not overwrite an existing `antigravity` entry.

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
/pnt-opt
/ponytail-gain
/ponytail-debt
/ponytail-help
```

`/pnt-opt` is not a plain alias: before running the audit it takes a `crapper --no-coverage` snapshot of the scope and hands the audit the worst five functions by cyclomatic complexity, so "this is too complex" starts from a number instead of an opinion. Without `crapper` on `PATH` (or `PI_CRAPPER`), the command behaves exactly as before. The snapshot costs ~1.5 s on this repo's `extensions/`.

The persisted default mode is stored in `~/.config/ponytail/config.json` (or `$XDG_CONFIG_HOME/ponytail/`).

### Stella

`/skill:stella` rewrites ambiguous or dense English for technical instructions, tool descriptions, error messages, prompts, and agent-to-agent text. It preserves the source meaning and uncertainty. It does not claim certified ASD-STE100 compliance or include the restricted official dictionary.

Run the bundled structural linter with `python3 <skill-dir>/scripts/ste-lint.py <file>`.

### Goal

The agent drafts an objective and task plan with you, then keeps working while the goal is active; progress survives sessions. An optional completion auditor reviews the result against your completion requirements.

```text
/goal <objective>
/goal-direct <objective>
/sisyphus <ordered steps>
/sisyphus-direct <objective>
/goal-list  /goal-status  /goal-focus  /goal-unfocus
/goal-pause  /goal-resume  /goal-tweak  /goal-clear  /goal-cancel
/goal-refresh  /goal-recovery  /goal-settings
```

Tools: `get_goal`, `create_goal`, `update_goal`, `set_goal_tasks`, `update_goal_task`, `goal_question`, `goal_questionnaire`, `propose_goal_draft`.

### Todo

Adds a `todo` tool, `/todos`, and a live panel above the editor. The list is rebuilt from the conversation, so it survives `/reload` and compaction.

### Advisor

The Executor owns the work; the Advisor challenges assumptions, exposes risks, and suggests verification — it never runs tools. Configure a separate Advisor model before first use.

```text
/advisor  /advisor-manual  /advisor-models  /advisor-off
/advisor-settings  /advisor-stats
```

Tools: `ask_advisor`, `record_advisor_outcome`.

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

Performance changes go through the benchmark gate, which compares median **and** p95 against `bench/baseline.json` (5% relative tolerance, 1 ms absolute floor):

```bash
./scripts/bench.sh           # compare, exit 1 on a regression
./scripts/bench.sh --write   # refresh the baseline after an intended change
```

## Security and privacy

Pi extensions execute with the same operating-system permissions as Pi. The usage extension can use environment variables or local credential files. For Antigravity Pool, it reads local credentials from `auth.json` and `antigravity-accounts.json` in the active Pi profile. Opted-in codex-lb providers use Pi's resolved model credentials and headers. Requests go only to the corresponding quota/balance endpoints; codex-lb requests reject redirects. Review the source before installation.

The default location for runtime state is `~/.pi/agent/`:

- `codex-accounts.json` (pooled OpenAI Codex OAuth credentials, mode 0600)
- `subscription-usage-cache.json`
- `subscription-usage-prefs.json`
- `live-throughput-prefs.json`
- `auth.json` (Antigravity Pool OAuth login and Codex Pool OAuth marker managed by Pi)
- `antigravity-accounts.json` (linked accounts)
- `gemini-web/credentials.json` (stored Gemini Web cookie credentials, mode 0600 in 0700 dir)

The `codex-accounts.json`, `auth.json`, `antigravity-accounts.json`, and `gemini-web/credentials.json` files contain sensitive credentials. Never commit, share, or paste their contents into issues.

## License

MIT
