---
name: witr
description: Diagnose occupied ports and unknown local processes with witr. Use to identify the OS owner and trace what started or supervises a process.
---

# witr

This procedure requires Bash, `witr`, and `jq`. If a prerequisite is missing, report that you cannot produce a safe result. Do not install tools without approval.

Choose one local target: `--port 3000`, `--pid 1234`, or `--exact -- node`. Quote user-provided values as arguments. Keep `--` before the process name and after all flags. Supply a target to avoid starting the interactive UI.

Run this Bash block with the chosen target in place of `--port 3000`. Use only the filtered report. Raw output and parser errors can expose environment values or full arguments.

```bash
if ! command -v witr >/dev/null || ! command -v jq >/dev/null; then
  printf 'Cannot produce a safe witr report: witr and jq are required.\n' >&2
  exit 1
fi

if report=$(
  set +e
  witr --json --port 3000 2>/dev/null | jq -es '
    def checked($kind): if . == null or type == $kind then . else error("invalid report field") end;
    def identity: {PID: (.PID | checked("number")), Command: (.Command | checked("string"))};
    def owned: identity + {User: (.User | checked("string"))};
    select(length == 1) | .[0] | objects
    | select((.Process | type) == "object" or (.Matches | type) == "array" or (.Error | type) == "string")
    | {process: (.Process | checked("object") | objects | owned) // null,
       ancestry: [.Ancestry | checked("array") | .[]? | identity],
       source: (.Source | checked("object") | objects | {Type: (.Type | checked("string")), Name: (.Name | checked("string"))}) // null,
       matches: [.Matches | checked("array") | .[]? | identity]}' 2>/dev/null
  status=("${PIPESTATUS[@]}")
  if (( status[1] != 0 )); then
    printf 'Cannot produce a safe witr report (witr exit: %s).\n' "${status[0]}" >&2
    exit 1
  fi
  printf 'witr exit: %s\n' "${status[0]}"
); then
  printf '%s\n' "$report"
else
  exit 1
fi
```

The ancestry chain can include the selected process. A report without a selected process has `process: null`. Interpret the witr status separately from a filter failure:

- `0` or `1`: Found. The second status indicates warnings, not failure.
- `2`: No match visible in this environment. This does not prove that a port is free.
- `3`: Permission denied. Ask before using elevated privileges.
- `4`: Invalid or ambiguous target. Correct an invalid argument. For an ambiguous target, report the candidate PIDs and commands. Run the same Bash block with `--pid` for each chosen candidate. Report `process.User` for the process found at lookup time. If the lookup cannot identify the owner, report it as unknown.
- `5`: Internal error. Report the failure.
- `6`: Found, but the source could not be traced. Report what you know.

Report the PID, user, and supervisor of the process witr selected, when known. A port lookup alone does not prove that the selected process holds the socket. Do not stop, signal, restart, or reconfigure anything without user approval.
