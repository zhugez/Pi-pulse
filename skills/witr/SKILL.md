---
name: witr
description: Diagnose occupied ports, leftover dev servers, unknown processes, containers, and file locks with the witr CLI. Use to identify a process and trace what started or supervises it.
---

# witr

Check `witr --version`. If it is missing, use the platform's read-only diagnostics or offer the upstream installation instructions. Do not install it without approval.

Choose one local target: `--port 3000`, `--pid 1234`, `--exact node`, `--container web`, or `--file /path/to/lock`. Quote user-provided values as arguments. For a process name that starts with `-`, put `--` before the name and after the flags. Supply a target so the command does not start the interactive UI.

Use `--json` and project only the fields you need **before** output reaches the transcript. The full report can include environment variables and command-line secrets even without `--env`. Do not print raw output, environment variables, or full command lines. For example, in Bash with `jq`:

```bash
witr --port 3000 --json 2>/dev/null | jq '{process: (.Process | {PID, Command}), parents: [.Ancestry[]? | {PID, Command}], source: (.Source | {Type, Name}), container: .ContainerName, matches: [.Matches[]? | {PID, Command}]}'
status=${PIPESTATUS[0]}
printf 'witr exit: %s\n' "$status"
```

In PowerShell, capture the JSON with `Out-String`, save `$LASTEXITCODE`, then parse with `ConvertFrom-Json` and select the same fields before printing. If you cannot filter the report, use another read-only diagnostic.

- `0` or `1`: Found. The second status indicates warnings, not failure.
- `2`: No match visible in this environment. For WSL, check which side owns the listener before concluding the port is free.
- `3`: Permission denied. Ask before using elevated privileges.
- `4`: Invalid or ambiguous target. Correct the argument or choose a confirmed PID from the candidates.
- `5`: Internal error. Report the failure or use another diagnostic.
- `6`: Found, but the source could not be traced. Report what you know.

Report the owner, PID and supervisor when known. Do not stop, signal, restart, or reconfigure anything unless the user asks you to.
