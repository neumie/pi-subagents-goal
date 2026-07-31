# Architecture

## Design objective

`pi-subagents-goal` runs an autonomous parent loop that may work entirely through ordinary Pi tools. When the parent explicitly opts into goal-owned child work, the loop continues only after every owned child is terminal and its output can be surfaced exactly once for consideration. It never treats silence, process exit, or an uncorrelated event as completion evidence for that optional owned work.

The implementation is intentionally split into three deep modules and one thin Pi adapter.

## Modules

### `GoalMachine` — `src/state.ts`

A pure, serializable state machine owns all safety invariants:

- exact owner identity;
- per-item work ledger and attempts;
- explicit nonterminal and terminal state families;
- output digests, surfacing state, and acknowledgement tokens;
- unsuccessful-outcome resolutions;
- continuation reservation/commit state;
- enabled budget use and optional token/time limits;
- optional advisory review evidence;
- runtime validation of restored snapshots.

The machine performs no I/O. Every method accepts an explicit timestamp, and tests use deterministic identities and clocks.

### `SubagentBridge` — `src/subagents-bridge.ts`

A narrow adapter over stable `pi.events` channels:

- RPC v1 compatibility/session probe;
- foreground delegation V2 request, started, update, response, and cancel;
- bounded response timeouts and abort propagation;
- full tuple correlation for every accepted event;
- explicit mapping of every upstream terminal status;
- capability-gated future `goalCoordination v1` client.

It does not inspect `.pi-subagents` artifacts or poll ambient process state. The artifact directory is deliberately outside the trust boundary.

### `GoalSubagentRunner` — `src/foreground-runner.ts`

The runner translates optional single, parallel, chain, and review calls into ledger admissions plus delegation V2 requests. The core parent loop does not probe or invoke the provider unless a goal-owned subagent tool is called.

Important ordering:

1. admit every parallel/chain item before starting any child;
2. emit the exact `ownerRunId`/`nodeId` tuple;
3. record `started` only from the correlated V2 event;
4. cache terminal output before notifying the continuation adapter;
5. map every response to an explicit terminal state;
6. account delegated token usage before continuation eligibility is checked;
7. count parent token usage from newly generated output only, never pre-existing context;
8. return every acknowledgement token outside truncated previews.

Parallel concurrency is bounded at four. Chains replace `{previous}` with the preceding output and explicitly stop all unstarted suffix items after a failure.

### Pi adapter — `src/extension.ts`

The adapter owns side effects:

- one `/goal` command;
- five optional `goal_*` coordination tools;
- lazy `pi-subagents` compatibility probing only when `goal_subagent` or `goal_review` is called;
- session-native persistence;
- lifecycle guards and recovery;
- namespace verification after Pi binds runtime actions;
- continuation `sendMessage()` calls;
- a versioned, session-scoped, display-safe status API.

It does not intercept ordinary tools, including `subagent` when another extension provides it. Those calls remain outside the goal-owned ledger and its completion guarantees.

The adapter performs no direct UI writes. `pi-sidebar` and `pi-footer` own optional presentation by consuming status events. No other goal extension is required or supported.

## Ownership

Every goal snapshot contains:

```text
OwnerIdentity = {
  sessionId,
  sessionFile,
  lineageId,
  goalId,
  epoch
}
```

Each item adds a globally unique `itemId` plus immutable `attempt` metadata. An item ID cannot be reused for a later attempt; retries need a new item ID. Delegation V2 transports the goal owner as `ownerRunId` and the item as `nodeId`; the bridge accepts every ordinary terminal response only when protocol version, request ID, owner run ID, and node ID all match. Upstream `invalid_request` may omit identities it could not decode; that response is accepted only by the generated request ID and normalized back to the caller-owned tuple.

Session/fork restore additionally requires exact session ID and session file. A foreign branch can contain historical goal entries but cannot acquire their authority.

## Work lifecycle

```text
queued ──> running ──> succeeded
   │          │       failed
   │          │       timed_out
   │          │       stopped
   │          │       interrupted
   │          │       budget_exhausted
   │          │       unknown
   │          ├──> needs_attention ──> running | paused | stopping
   └──────────────────────────────────────────> stopping
```

The machine treats `queued`, `running`, `needs_attention`, `paused`, and `stopping` as nonterminal. No continuation is eligible while any item is in that set.

A terminal item moves through:

```text
awaiting -> pending_surface -> surfaced -> consumed
```

- `pending_surface` means output exists but has not yet entered visible Pi context.
- `surfaced` is set only by the correlated goal tool-result handler or an output-bearing continuation.
- `consumed` requires the exact acknowledgement token and a non-empty consideration statement.

Failed, timed-out, stopped, interrupted, budget-exhausted, and unknown outcomes remain unsuccessful forever. After consumption they require `goal_resolve`; that stores only a rationale digest and invalidates prior review evidence.

## Continuation barrier

A continuation ticket contains:

```text
goalId + epoch + sequence + random nonce + expected work generation + output item IDs
```

Eligibility requires:

- goal phase `active`;
- parent `agent_end` observed and then parent agent settled;
- no existing continuation;
- no nonterminal child;
- no output still `awaiting`;
- all enabled budgets below their limits.

Reservation and dispatch are separate:

```text
eligible -> reserved -> queued -> running -> settled
```

New work invalidates a `reserved` ticket. New work after `queued` is a fault. `commitContinuation()` compares the nonce and expected work generation before changing the ledger to `queued`.

The adapter persists `queued` before calling Pi `sendMessage(..., { triggerTurn: true })`. Each queued message begins with its random continuation nonce. Pi 0.83 custom trigger turns bypass `before_agent_start` and may become a follow-up inside a run started by another extension, so only `message_start` for the exact custom continuation—matching its full owner, ticket, output references, and first-line nonce—can change `queued -> running`. Explicit nonce-tagged prompts are checked independently at `agent_start`. A preceding foreign turn—such as an installed ordinary subagent's detached completion—is excluded from goal budget/settlement accounting; tracking begins only when the exact goal continuation message starts.

A synchronous send failure faults the goal and is never retried. On restore, any persisted `reserved`, `queued`, or `running` continuation is ambiguous and faults. This prevents duplicate recovery sends at the cost of stopping after an unprovable crash window.

Duplicate `agent_start` is idempotent and cannot clear automatic-run accounting. A running continuation accepts `agent_end` only when that event's initiating prompt carries the exact continuation nonce; a stale mismatched end faults the goal. Later low-level retry ends are ignored after the run is armed. `agent_settled` is ignored until a nonce-correlated end has been observed, preventing a stale end/settlement pair from consuming a newly running continuation.

Both child/parent event orders are supported:

```text
child terminal -> parent settled -> reserve once
parent settled -> child terminal -> reserve once
```

The runner caches terminal output before its state-change callback, so the second order can build an output-bearing continuation without artifact polling. Every complete model-facing aggregate—including objective, labels, framing, previews, markers, and tokens—is capped at 48,000 UTF-8 bytes. Truncation walks Unicode code points, and acknowledgement tokens are appended separately and never truncated.

## Completion and optional review

A goal with no goal-owned work can complete directly with `goal_done` and an empty `consideredItemIds` list. If `goal_subagent` or `goal_review` was used, completion still requires every admitted item to be terminal, surfaced, consumed, explicitly resolved when unsuccessful, and included exactly once in `consideredItemIds`.

`goal_review` is optional advisory evidence. It is itself a ledger item with role `review` and is admitted only after existing goal-owned work is terminal, consumed, and resolved. The child must return a schema-valid object:

```json
{
  "verdict": "pass | fail",
  "findings": [
    {
      "severity": "blocker | non-blocking",
      "file": "optional path",
      "issue": "description",
      "rationale": "evidence"
    }
  ]
}
```

The machine binds advisory review evidence to the review item and current work generation and retains only a digest of findings. The review output must be acknowledged because it was explicitly admitted as goal-owned work, but neither a review nor a passing verdict is a prerequisite for `goal_done`. Ordinary work performed after a review does not trigger a special branch scan or invalidate completion.

## Persistence

Two session-native records are used:

1. displayed objective custom message: objective value plus owner and digest;
2. hidden custom entry: value-free `GoalSnapshot`.

Restore walks only the active branch, validates every field and cross-field lifecycle invariant, verifies the objective digest, and requires exact current session identity. Validation includes timestamp ordering, digest formats, active/terminal output evidence, consumption/resolution consistency, unique item IDs, continuation output references, completed/cancelled phase consistency, and review-to-ledger binding.

State snapshots intentionally omit:

- objective text;
- child output;
- prompts and reviewer findings;
- child session artifacts.

Those values remain in normal Pi messages/tool results. Snapshot fields retain only bounded labels, digests, states, timestamps, identities, and tokens needed for coordination.

## Lifecycle policy

| Event | Policy |
| --- | --- |
| `session_before_switch` | block live/unresolved goal |
| `session_before_fork` | block live/unresolved goal |
| `session_before_tree` | block live/unresolved goal |
| `session_before_compact` | block if child is nonterminal or output unconsumed |
| `session_shutdown` | pause active goal and persist |
| `session_start` clean paused state | restore; explicit resume required |
| `session_start` nonterminal child | fault |
| `session_start` ambiguous continuation | fault |
| foreign session/fork metadata | ignore authority |

## Status API

`src/status-api.ts` publishes `@neumie/pi-subagents-goal:v1:status` and accepts exact-session replay requests on `@neumie/pi-subagents-goal:v1:status-request`. Every envelope carries a provider-instance ID and monotonic sequence so consumers can reject stale updates and survive extension load-order changes.

The display-safe payload includes objective, phase, timestamps, work aggregates, at most 128 recent bounded labels plus an omitted count, optional limits and aggregate usage, continuation/review state, and a generic bounded reason. It omits session files, lineage/goal/item IDs, acknowledgement tokens, internal progress signatures, digests, prompts, findings, raw faults, and child output. Emission is isolated from coordination: malformed requests and throwing listeners are ignored. The goal extension never calls Pi status, widget, footer, or notification APIs.

## Supported and unsupported coordination

When an ordinary `subagent` tool is installed, its use is allowed and retains its upstream behavior; it is deliberately outside goal ownership, acknowledgement, and completion checks.

Optional goal-owned foreground delegation V2 is supported because the caller owns the request lifetime and receives the terminal response before deciding whether to continue.

Current goal-owned detached RPC `spawn` is unsupported because `pi-subagents` owns its notification turn. The bridge contains a versioned future client, but the Pi adapter rejects detached requests even if only the provider capability appears: Pi also needs an atomic caller-owned enqueue/acknowledgement primitive. The exact proposal is in [`UPSTREAM-INTEGRATION.md`](UPSTREAM-INTEGRATION.md).
