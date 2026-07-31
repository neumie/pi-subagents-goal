# pi-subagents-goal

A fail-closed autonomous goal loop for [Pi](https://github.com/badlogic/pi-mono) that delegates only through `pi-subagents` work carrying explicit goal ownership.

The extension owns `/goal`, schedules continuation turns, tracks every delegated item, requires explicit output consumption, and gates completion on a fresh independent review. Its safety properties live in a deterministic state machine rather than prompt convention.

> **Compatibility:** this revision targets exactly Pi `0.83.0`, `typebox` `1.3.7`, Node `>=22.19.0`, and the local `pi-subagents` `0.38.1` contract audited at commit `886bbad929134d7954a4fb34e532d82ac21e33e8`.

## Status

| Capability | Status |
| --- | --- |
| Foreground single delegation | Supported through delegation V2 |
| Foreground parallel delegation | Supported, maximum concurrency 4 |
| Foreground chain delegation | Supported, `{previous}` substitution |
| Structured independent review | Supported through delegation V2 |
| Detached/background delegation | Rejected fail-closed on current upstream |
| Session switch/fork/tree during a live goal | Blocked |
| Compaction with active or unread child work | Blocked |
| Reload with ambiguous child/continuation state | Faulted, never retried automatically |

Detached work is intentionally unavailable. `pi-subagents` currently queues its own completion turn before publishing its observer event, so a downstream extension cannot be the sole continuation owner. See [`docs/UPSTREAM-INTEGRATION.md`](docs/UPSTREAM-INTEGRATION.md).

## Installation for development

Install `pi-subagents` separately, then load this checkout as a Pi extension:

```bash
npm ci --ignore-scripts --no-audit --no-fund
pi -e /absolute/path/to/pi-subagents-goal/index.ts
```

For persistent installation, add the repository as a Pi package using Pi's normal package configuration. Do not load another extension that owns `/goal` or any `goal_*` tool name; namespace conflicts fail closed at `session_start`.

This repository is marked `private` and is not intended to be published by the delivery workflow.

## Usage

Start an ordinary goal:

```text
/goal Implement the requested feature, verify it, and report residual risks
```

Control it explicitly:

```text
/goal status
/goal pause
/goal resume
/goal cancel
```

Starting a goal appends a digest-bound objective message and a value-free state snapshot to the current Pi session. The model receives goal instructions through `before_agent_start` on every active turn.

### Goal-owned tools

- **`goal_subagent`** — foreground single, parallel, or chain delegation. Requires the exact `goalId` and `epoch` shown in the goal prompt. Ordinary `subagent` calls are blocked while goal authority is live.
- **`goal_ack_output`** — consumes child output using its exact one-time acknowledgement token plus a non-empty consideration statement.
- **`goal_resolve`** — records an explicit rationale for an acknowledged unsuccessful terminal outcome. It never rewrites failure as success.
- **`goal_review`** — launches a fresh read-only structured reviewer after all prior work is terminal, consumed, and resolved.
- **`goal_done`** — completes only when all ledger items are included, all output is consumed, unsuccessful work is resolved, budgets remain, and current independent review evidence passes.

Example foreground call shape:

```json
{
  "goalId": "<current goal id>",
  "epoch": 1,
  "tasks": [
    { "agent": "worker", "task": "Implement the narrow change" },
    { "agent": "reviewer", "task": "Inspect compatibility assumptions" }
  ],
  "concurrency": 2,
  "context": "fresh"
}
```

Every result prints acknowledgement tokens in a separate, never-truncated section. Each complete model-facing payload is bounded to 48,000 UTF-8 bytes (including framing and tokens), with truncation only at Unicode code-point boundaries.

## Safety model

Every owned event is correlated by:

```text
session ID + session file + lineage ID + goal ID + epoch + item ID + attempt
```

Item IDs are globally unique within a goal and are never reused across attempts. A continuation uses a random nonce, a monotonic sequence, and the expected work generation. It can move only through `reserved -> queued -> running`, and new work invalidates a reservation. A queued continuation cannot admit more work.

The extension commits the continuation ledger before calling Pi's `sendMessage(..., { triggerTurn: true })`. A synchronous enqueue failure faults the goal and is not retried. If a process reload restores a `reserved`, `queued`, or `running` continuation, delivery is ambiguous and the goal faults instead of risking a duplicate. This is exactly-once within an unambiguous live runtime and fail-closed across the remaining Pi crash window.

Default finite budgets are:

- 20 automatic continuation turns;
- 1,000,000 tokens across every parent turn plus delegated usage;
- 120 minutes wall clock;
- 3 unchanged automatic turns.

Foreground children default to a 10-minute timeout and `24 + 2` turn/grace budget. Limits are validated and cannot be unlimited.

## Persistence and recovery

- Coordination snapshots use Pi `appendEntry()` custom entries and contain no objective or child-output values.
- The objective is stored separately in a displayed custom message and verified by SHA-256 digest.
- Child output remains in normal tool-result/session context; snapshots retain only its digest and acknowledgement state.
- Foreign session or fork metadata has no authority.
- Clean shutdown pauses the goal and requires explicit `/goal resume`.
- Nonterminal child state or ambiguous continuation state on restore faults the goal.

## Verification

```bash
npm run check
npm run test:integration
npm run test:smoke
npm pack --dry-run
```

`test:smoke` performs two bounded checks without invoking a model:

1. loads the extension with Pi `0.83.0`'s real Jiti loader and verifies its registered surface;
2. loads the real local `pi-subagents` checkout, proves exact-session RPC and delegation V2 tuple correlation using an intentionally unknown agent, and proves detached coordination is not advertised.

Hosted CI uses Node `22.19.0` to run the locked install, full quality gate, and the first check through `test:smoke:pi`. The second check intentionally remains local because it requires the separately audited checkout identified in `test/smoke/local-pi-subagents-smoke.ts`.

### Known upstream audit residual

`npm audit` reports `GHSA-mh99-v99m-4gvg` (high severity, unbounded brace expansion) in Pi 0.83.0's shrinkwrapped nested `brace-expansion@5.0.7`. A clean-install experiment confirmed that root overrides and `npm audit fix` cannot replace the nested package. This extension accepts no brace/minimatch input itself and ships no production dependency copy, but a clean host Pi package installation retains the advisory. Resolution requires a Pi release whose published shrinkwrap selects `brace-expansion>=5.0.8`.

See also:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)
- [`docs/UPSTREAM-INTEGRATION.md`](docs/UPSTREAM-INTEGRATION.md)

## License

MIT
