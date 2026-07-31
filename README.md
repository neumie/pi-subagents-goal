# pi-subagents-goal

An autonomous goal loop for [Pi](https://github.com/badlogic/pi-mono) with optional, fail-closed coordination for goal-owned `pi-subagents` work.

The extension owns `/goal` and schedules continuation turns while the parent works directly with any ordinary tools. `pi-subagents`, `goal_subagent`, and independent review are optional; strict lifecycle, acknowledgement, and resolution gates apply only to work explicitly launched through the goal-owned tools.

> **Compatibility:** the core goal loop targets exactly Pi `0.83.0`, `typebox` `1.3.7`, and Node `>=22.19.0`. Optional goal-owned delegation targets `pi-subagents` `0.38.1` at audited commit `886bbad929134d7954a4fb34e532d82ac21e33e8`.

## Status

| Capability | Status |
| --- | --- |
| Direct work with ordinary Pi tools | Supported; default path |
| Ordinary `subagent` calls, when that tool is installed | Supported; outside the goal-owned ledger |
| Goal-owned single/parallel/chain delegation | Optional through delegation V2 |
| Structured independent review | Optional advisory evidence |
| Goal-owned detached/background delegation | Rejected fail-closed on current upstream |
| Session switch/fork/tree during a live goal | Blocked |
| Compaction with active or unread goal-owned work | Blocked |
| Reload with ambiguous goal-owned work/continuation state | Faulted, never retried automatically |

Only detached work launched through `goal_subagent` is intentionally unavailable. When installed, ordinary `subagent` remains untouched and follows its own upstream lifecycle outside this extension's guarantees. `pi-subagents` currently queues its own detached completion turn before publishing its observer event, so the optional goal-owned adapter cannot safely become sole continuation owner. See [`docs/UPSTREAM-INTEGRATION.md`](docs/UPSTREAM-INTEGRATION.md).

## Installation

Install the goal loop through Pi; it works without `pi-subagents`:

```bash
pi install git:github.com/neumie/pi-subagents-goal
```

Optionally install the audited [`pi-subagents`](https://github.com/neumie/pi-subagents) revision to enable `goal_subagent` and `goal_review`:

```bash
pi install git:github.com/neumie/pi-subagents@886bbad929134d7954a4fb34e532d82ac21e33e8
```

For development from a local checkout:

```bash
npm ci --ignore-scripts --no-audit --no-fund
pi -e /absolute/path/to/pi-subagents-goal/index.ts
```

Do not load another extension that owns `/goal` or any `goal_*` tool name; namespace conflicts fail closed at `session_start`. The npm package remains marked `private` to prevent accidental registry publication; the Git repository is the supported distribution source.

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

- **`goal_subagent`** — optional foreground single, parallel, or chain delegation with exact goal ownership. When installed, ordinary `subagent` remains available and untracked by the goal ledger.
- **`goal_ack_output`** — consumes output from `goal_subagent` or `goal_review` using its exact one-time acknowledgement token plus a non-empty consideration statement.
- **`goal_resolve`** — records an explicit rationale for an acknowledged unsuccessful goal-owned outcome. It never rewrites failure as success.
- **`goal_review`** — optionally launches a read-only structured reviewer after prior goal-owned work is terminal, consumed, and resolved. Its verdict is advisory rather than a completion gate.
- **`goal_done`** — completes when enabled budgets remain and every goal-owned item, if any, is included, terminal, consumed, and explicitly resolved when unsuccessful. No subagent or review is required.

Every continuation repeats the exact goal ID and epoch so the parent never needs to inspect environment variables, session artifacts, or ambient process state. A direct-only goal calls `goal_done` with an empty `consideredItemIds` list. If optional goal-owned tools are used, their exact item IDs and acknowledgement lifecycle remain mandatory.

### 0.2 migration

Version 0.2 removes mandatory delegation and review. `goal_done.reviewToken` is accepted as an optional deprecated field and ignored so 0.1-era calls do not fail schema validation; new callers should omit it. Model-facing goal tool-result details are version 2. The display-safe status DTO remains version 1 because its shape is unchanged; `review` is advisory, so `phase: "completed"` may now coexist with `review: "fail"`.

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

Default goal budgets are:

- 20 automatic continuation turns;
- no token limit;
- no wall-clock limit;
- 3 unchanged automatic turns.

When an explicit token limit is supplied through the state-machine API, usage counts only parent output generated after goal start plus delegated child usage; pre-existing parent context is not charged. Explicit token and wall-clock limits must be positive finite integers. Foreground children retain a 10-minute timeout and `24 + 2` turn/grace budget.

## Status API and presentation ownership

This extension performs no direct UI writes: it does not call `ctx.ui.setStatus()`, `ctx.ui.notify()`, `ctx.ui.setWidget()`, or `ctx.ui.setFooter()`. Slash-command errors propagate to Pi. Presentation belongs to optional consumers such as `pi-sidebar` and `pi-footer`.

The provider publishes a versioned, session-scoped, process-local protocol:

- request: `@neumie/pi-subagents-goal:v1:status-request` with `{ version: 1, sessionId }`;
- state: `@neumie/pi-subagents-goal:v1:status` with `{ version, providerId, sequence, sessionId, goal, providerError? }`.

Consumers receive objective, phase, timestamps, work counts, at most 128 recent bounded labels plus an omitted count, enabled limits and aggregate usage, continuation/review state, and a generic bounded reason. The payload deliberately omits session files, lineage and goal IDs, item IDs, acknowledgement tokens, internal progress signatures, digests, and child output. Requests are exact-session only, repeated state is monotonic per provider instance, malformed consumers cannot affect coordination, and package load order is handled through replay requests plus session-start publication.

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
