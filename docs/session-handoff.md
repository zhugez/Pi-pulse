# Automatic session handoff

The `session-handoff` extension prepares a fresh Pi session before XingchiAPI reaches its reported limit of 100 model replies. It defaults to 80 persisted XingchiAPI assistant responses. Tool-only replies count. Errors and responses on abandoned branches also count conservatively. Compaction does not reset the local counter.

The extension is included in the Pi Pulse package manifest. Run `/reload` in an existing Pi instance to load it, or start a new Pi process. No commit or package publication is required for this local installation.

## Commands and configuration

```text
/session-handoff status
/session-handoff now
/session-handoff off
```

`status` shows the current count and threshold. `now` requests a handoff after the current run settles. `off` disables automatic handoff until reload and releases the goal scheduler if a failed handoff held it.

Set the threshold for a process:

```sh
pi --session-handoff-turns 80
PI_SESSION_HANDOFF_TURNS=70 pi
PI_SESSION_HANDOFF_TURNS=0 pi
```

The CLI flag takes precedence over the environment variable. Allowed values are whole numbers from 0 to 90. Zero disables automatic handoff. To keep an environment setting across launches, export it from your shell configuration. Invalid configuration disables automatic handoff and reports a warning.

Only the `xingchiapi` provider is supported. The threshold measures local persisted replies, not a server-provided turn counter. Provider retries or requests from other clients are not visible to it.

## What happens at the threshold

The extension defers tool calls that have not started and marks their results as not executed. It waits for the entire run and tool batch to settle. It does not abort a running tool. Pending user messages must finish before replacement.

A separate model request summarizes the projected conversation as text. It sends no old session affinity or historical assistant messages. The summary preserves the request, corrections, constraints, decisions, files, observed check results, completed actions and remaining work. Its instructions exclude credentials and distinguish deferred calls from completed side effects. Model summaries can omit details, so the replacement agent must verify artifacts before changing them.

Pi saves the summary under `~/.pi/agent/session-handoffs/`, using a directory mode of `0700` and file mode of `0600` when supported. The original session remains available. The replacement session records its parent and uses a new UUID. Its first request has a new provider session key and no old assistant turns.

The latest goal focus, todo snapshot and Ponytail mode transfer as native state entries. The replacement restores the source model, thinking level and active tools during the new-session lifecycle. A later manual model selection or tool configuration remains effective on reload and resume.

An active focused goal transfers scheduler ownership only when the saved predecessor matches its existing owner. Its spent autonomous-run allowance, wait state and task data remain intact. The scheduler holds new dispatches while the summary is prepared. Paused goals remain paused. A session without a focused goal continues deferred work automatically. When a final answer reaches the threshold, Pi prepares an idle replacement session without inventing another task.

Existing `session_before_switch` guards can cancel replacement, including guards for background work. The extension does not transfer arbitrary extension process state or claim that background processes can migrate.

## Failure and recovery

A failed summary, cancelled switch or changed source transcript stops automatic retries for that session. The source remains available. The warning includes its path and any saved checkpoint.

Retry with `/session-handoff now`. Use `/session-handoff off` to release the goal scheduler and continue in the source session. To recover after a failed runtime replacement, reopen the source with `pi --session <source.jsonl>` and use the saved checkpoint. Disabling handoff allows the original provider limit to be reached again.

The summary request has a deadline and is cancelled when its source runtime shuts down. A truncated or empty summary cannot replace the session. If user input changes the source during summarization, the prepared summary is rejected.

## Verification

Run from the Pi Pulse repository:

```sh
pnpm test
node scripts/verify-session-handoff.mjs
node scripts/verify-session-handoff.mjs --live
```

The local CLI check uses a temporary OpenAI Responses endpoint. It forces handoff at a low threshold and verifies that two file writes happen once each, the original session remains, and the first replacement request contains no old assistant items. Unit tests cover threshold validation, goal/todo state, goal ownership and spent allowance, summary failure, and cancelled replacement.

The live check uses the existing XingchiAPI configuration in a private temporary agent directory. It asks for a canary, hands off, reopens the saved replacement, and checks that XingchiAPI returns the preserved canary using a new provider affinity key with no old assistant history. All temporary credentials, sessions and files are removed afterward.

Reverified after crash recovery on November 27, 2026: the local CLI check passed with two provider session keys and four agent requests. The live XingchiAPI check passed with two keys and two agent requests. Both replacement requests started with zero old assistant items, and both source sessions remained available. The native suite reported 373 passing tests, no failures and one existing skip, followed by four passing extension-load tests. Typechecks passed. Both repository-wide lint commands completed with 87 existing warnings in other files; the changed implementation and tests produced no lint warnings.

The original 100-turn failure was not recreated by making 100 live requests. Request evidence confirms that the replacement uses a fresh UUID/affinity and a fresh assistant history. The exact server-side counting algorithm is not available locally. Pi's `/compact` shortens context while keeping the session UUID; this change does not rely on it resetting XingchiAPI's limit.
