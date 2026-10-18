# Gemini Web Provider for Pi Coding Agent

A native, zero-bridge provider extension that connects Pi Coding Agent directly to Gemini Web via reverse-engineered Google Web RPC.

> **Important Disclosure & Terms Notice**:
> This extension reverse-engineers internal Google Gemini Web endpoints (`gemini.google.com`). It is intended strictly for personal research and workflow prototyping on your own account. Use of this extension may be subject to Google Terms of Service and anti-bot measures (such as CAPTCHA challenges or geographic restrictions). The authors make no representations regarding uptime, service availability, or account standing.

---

## Key Characteristics & Limitations

1. **Buffered Responses (Implementation Limitation)**:
   - Output from Gemini Web is collected and buffered in full before emission to Pi as an implementation limitation of this provider in Pi (not because the Web RPC fundamentally cannot stream).
   - Real incremental token streaming is not surfaced by this provider; speed indicators in the footer will reflect buffered block delivery.
2. **Prompt-Based Tool Calling (Not Native)**:
   - Gemini Web does not expose a native function calling API. Tool definitions are injected as structured prompt instructions, and candidate responses are parsed from exact JSON envelopes.
   - All tool arguments are strictly validated against Pi's TypeBox tool schemas using `validateToolCall`. Malformed or unadvertised tool calls fail safely.
3. **Unmeasured Usage & Cost**:
   - Web responses do not provide token counts or pricing metadata.
   - All usage metrics (`input`, `output`, `cacheRead`, `totalTokens`) and costs are reported as literal `0` placeholders. These indicate **unmeasured and unknown consumption, not free service**.
4. **Planning Limits vs. Real Web Limits**:
   - Default context planning limits are set to 32,768 input tokens and 8,192 output tokens.
   - Real internal Gemini Web limits are undocumented by Google and may vary dynamically. To customize planning bounds, define overrides in `~/.pi/agent/models.json`.
5. **Ephemerality & Privacy**:
   - Requests set Google's internal temporary conversation flag (`index 45 = 1`).
   - Pi owns conversation history: each turn replays the current Pi transcript as a fresh temporary context. No Google conversation IDs or server chat state are persisted across requests or branches.
   - Google Web endpoints receive the conversation transcript and system prompt on each request.
6. **No Redirects or CAPTCHA Solving**:
   - All HTTP redirects (301, 302, 303, 307, 308) are rejected immediately to prevent credential forwarding to unexpected endpoints or login loops.
   - If Google triggers a CAPTCHA or security verification, requests will fail with an authentication error; solve the challenge in your browser.

---

## Credential Setup & Management

### 1. Identify Your Google Account Slot (`--auth-user <N>`)
Open your browser where you are logged into Google and visit [https://gemini.google.com](https://gemini.google.com).
Look at the address bar:
- If the URL is `https://gemini.google.com/app`, your slot is `0`.
- If the URL contains `/u/1/` (e.g., `https://gemini.google.com/u/1/app`), your slot is `1`.
- If the URL contains `/u/2/`, your slot is `2`, and so forth.

### 2. Export Your Cookie Header to a Private File
1. In your browser Developer Tools (F12) -> Network tab, inspect any request to `gemini.google.com`.
2. Copy the complete `Cookie:` request header value (must include `__Secure-1PSID` and `__Secure-1PSIDTS`).
3. Create a private directory and file restricted from creation using `mktemp` or `umask 077`:
   ```bash
   cookie_dir="$(mktemp -d "${TMPDIR:-/tmp}/gemini-cookies.XXXXXX")"
   chmod 0700 "$cookie_dir"
   cookie_file="$cookie_dir/cookies.txt"
   touch "$cookie_file"
   chmod 0600 "$cookie_file"
   ```
4. Open `$cookie_file` in your text editor (e.g. `nano "$cookie_file"` or `vim "$cookie_file"`) and paste the single-line cookie string into it. Avoid pasting credentials into terminal shell command arguments or history.

### 3. Import Credentials into Pi
Inside Pi, execute the import command with the private file path and your account slot:
```text
/gemini-web.import /path/to/private/cookies.txt --auth-user 0
```
- The extension securely normalizes and stores the credentials into `~/.pi/agent/gemini-web/credentials.json` with an owned `0700` directory and `0600` file permissions.
- Dynamic models are discovered immediately and registered into Pi's `/model` selector.
- **Delete your source file and directory** manually after import:
  ```bash
  rm -rf "$cookie_dir"
  ```

---

## Commands

- `/gemini-web.import <path> --auth-user <N>`:
  Import credentials from a `0600` file for the specified Google account slot.
- `/gemini-web.refresh`:
  Reread stored credentials, perform dynamic model discovery, and attempt opportunistic cookie rotation (cadence: at most once every 24 hours, backoff 10 minutes on failure).
- `/gemini-web.logout`:
  Close any active client, delete stored credentials from disk under lock, and unregister all `gemini-web` models.
- `/gemini-web.status`:
  Display configuration status, configured slot, catalog freshness, and conspicuous disclosures without revealing secrets or cookie fragments.

---

## Model Selection in Pi

Discovered Web models are exposed with Pi-friendly IDs and clear display names derived directly from their Web catalog labels:
- `gemini-web/gemini-3.5-flash-lite` (`Gemini 3.5 Flash-Lite`)
- `gemini-web/gemini-3.8-flash` (`Gemini 3.8 Flash`)
- `gemini-web/gemini-3.1-pro` (`Gemini 3.1 Pro`)
- `gemini-web/gemini-4-argon` (`Gemini 4 Argon`)

*Backward Compatibility*: Legacy raw routing hash IDs (e.g. `8c46e95b1a07cecc`) remain fully supported for existing sessions. If your session was previously referencing an old raw hash ID, run `/reload`, then `/gemini-web.refresh`, and select the friendly model name in `/model`. Existing stored credentials remain valid; no re-import is needed.

---

## Reasoning Effort Control (/thinking)

Discovered models declare reasoning support for Pi's standard `/thinking` command:
- Supported levels: `/thinking low` (wire value 1, default), `/thinking medium` (wire value 4), `/thinking high` (wire value 2).
- How to enable after update: run `/reload`, then `/gemini-web.refresh`, reselect your model in `/model`, then use `/thinking high` (or `medium` / `low`).
- Unsupported levels: `/thinking off`, `minimal`, `xhigh`, `max` and custom token budgets (`thinkingBudgets`) are rejected safely (Gemini Web does not expose a disable toggle or token budget controls).
- Reverse-engineered protocol: Reasoning effort is transmitted via Google's internal Web RPC headers and body fields; this does not constitute proof or guarantee that Google's backend servers honor every requested level on every model.
- Thoughts extraction: Web responses deliver buffered final answers; thoughts content/UI extraction is not surfaced, and token consumption remains unmeasured.
- Existing cookies remain in store; no re-import is needed.

---

## Manual Smoke Test Steps (Real Account Verification)

*Note: Automated tests in this repository use synthetic fixtures and mocked HTTP; build verification does not query live Google endpoints.*

### Tested Live Scope
- **Verified transport & generation**: One live text generation request was verified end-to-end on Google account slot `3` using the isolated 64KiB transport agent (bootstrap HTTP 200 -> model discovery HTTP 200 -> StreamGenerate HTTP 200 -> balanced Pi assistant events).
- **Unproven scope**: Native-tool behavior, other account slots, and account-general continuous availability remain unproven. No live model inventory or uptime guarantees are provided.

### Manual Verification Steps
1. Perform `/gemini-web.import <path> --auth-user 0`. Verify output reports discovered models.
2. Run `/gemini-web.status`. Confirm slot `0` and discovered models count are reported.
3. Switch to a discovered model with `/model`.
4. Send an ordinary message (e.g. `Hello!`). Verify the full response text appears.
5. In a session with tools enabled, ask a question requiring tool use (e.g. `Read package.json`). Verify the tool call is dispatched, validated, and executed.
6. Run `/gemini-web.logout`. Verify stored credentials are deleted and the provider becomes unavailable in `/model`.
