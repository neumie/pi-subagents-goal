# Architecture

## Design objective

`pi-subagents-goal` must continue an autonomous goal only after every owned child is terminal and its output can be surfaced exactly once for consideration. It must never treat silence, process exit, an uncorrelated event, or reviewer prose as completion.

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
- finite budget use;
- independent review evidence;
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

The runner translates supported single, parallel, chain, and review calls into ledger admissions plus delegation V2 requests.

Important ordering:

1. admit every parallel/chain item before starting any child;
2. emit the exact `ownerRunId`/`nodeId` tuple;
3. record `started` only from the correlated V2 event;
4. cache terminal output before notifying the continuation adapter;
5. map every response to an explicit terminal state;
6. account delegated token usage before continuation eligibility is checked;
7. return every acknowledgement token outside truncated previews.

Parallel concurrency is bounded at four. Chains replace `{previous}` with the preceding output and explicitly stop all unstarted suffix items after a failure.

### Pi adapter — `src/extension.ts`

The adapter owns side effects:

- one `/goal` command;
- five `goal_*` tools;
- direct-`subagent` blocking while goal authority is live;
- session-native persistence;
- lifecycle guards and recovery;
- namespace verification after Pi binds runtime actions;
- continuation `sendMessage()` calls;
- branch-local review freshness checks.

No other goal extension is required or supported.

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
- all finite budgets below their limits.

Reservation and dispatch are separate:

```text
eligible -> reserved -> queued -> running -> settled
```

New work invalidates a `reserved` ticket. New work after `queued` is a fault. `commitContinuation()` compares the nonce and expected work generation before changing the ledger to `queued`.

The adapter persists `queued` before calling Pi `sendMessage(..., { triggerTurn: true })`. A synchronous send failure faults the goal and is never retried. On restore, any persisted `reserved`, `queued`, or `running` continuation is ambiguous and faults. This prevents duplicate recovery sends at the cost of stopping after an unprovable crash window.

Duplicate `agent_start` is idempotent and cannot clear automatic-run accounting. A running continuation accepts `agent_end` only when that event's initiating prompt carries the exact continuation nonce; a stale mismatched end faults the goal. Later low-level retry ends are ignored after the run is armed. `agent_settled` is ignored until a nonce-correlated end has been observed, preventing a stale end/settlement pair from consuming a newly running continuation.

Both child/parent event orders are supported:

```text
child terminal -> parent settled -> reserve once
parent settled -> child terminal -> reserve once
```

The runner caches terminal output before its state-change callback, so the second order can build an output-bearing continuation without artifact polling. Every complete model-facing aggregate—including objective, labels, framing, previews, markers, and tokens—is capped at 48,000 UTF-8 bytes. Truncation walks Unicode code points, and acknowledgement tokens are appended separately and never truncated.

## Completion review

`goal_review` is itself a ledger item with role `review`. It is admitted only after all existing work is terminal, consumed, and resolved. The child must return a schema-valid object:

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

Review evidence is bound to:

- the review item;
- a random review token;
- current work generation;
- the exact `goal_review` tool-call ID;
- a digest of findings.

`goal_done` also scans the active session branch. After the matching review result, only `goal_ack_output` and `goal_done` calls/results are allowed. Any other tool work makes the review stale. A review acknowledgement and `goal_done` in the same assistant tool batch are rejected because sibling execution order is not completion evidence.

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
| foreign session/fork metadata | ignore authority and warn |

## Supported and unsupported coordination

Foreground delegation V2 is supported because the caller owns the request lifetime and receives the terminal response before deciding whether to continue.

Current detached RPC `spawn` is unsupported because `pi-subagents` owns its notification turn. The bridge contains a versioned future client, but the Pi adapter rejects detached requests even if only the provider capability appears: Pi also needs an atomic caller-owned enqueue/acknowledgement primitive. The exact proposal is in [`UPSTREAM-INTEGRATION.md`](UPSTREAM-INTEGRATION.md).
