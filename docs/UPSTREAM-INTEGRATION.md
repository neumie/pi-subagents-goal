# Required upstream coordination hook

## Audited versions

- Pi: `@earendil-works/pi-coding-agent` `0.83.0`
- local `pi-subagents`: `0.38.1`
- local commit: `886bbad929134d7954a4fb34e532d82ac21e33e8`

The repository was inspected read-only. No upstream or global Pi files are modified by this project. This contract applies only when the parent opts into `goal_subagent` or `goal_review`; the core goal loop does not probe or require `pi-subagents`, and ordinary `subagent` calls, when the tool is installed, remain upstream-owned and unrestricted.

## Why current goal-owned detached work is rejected

Current `pi-subagents` detached completion has two channels with different authority:

1. the completion notifier is the delivery authority;
2. `subagent:async-complete` is an observer event.

At the audited commit:

- `src/runs/background/result-watcher.ts` calls `await notifier.deliver(...)`;
- `src/runs/background/notify.ts::sendCompletion()` calls:

  ```ts
  pi.sendMessage(
    { customType: "subagent-notify", content, display: true },
    { triggerTurn: items.some((item) => item.triggerTurn) },
  );
  ```

- only after the notifier accepts that send does `result-watcher.ts` emit `SUBAGENT_ASYNC_COMPLETE_EVENT`;
- the file header in `notify.ts` explicitly says the event bus is an observation channel, not a delivery acknowledgement.

Therefore a downstream observer cannot:

- suppress the already queued turn;
- atomically claim continuation ownership;
- prove that the completion output was consumed;
- prevent two continuation drivers from acting;
- replay a missed event from a durable cursor.

The RPC `spawn` method does not fix this. It starts detached work but does not transfer completion/notification ownership to the caller.

## What works today

Foreground delegation V2 uses these established channels from `src/api/delegation.ts`:

```text
prompt-template:subagent:request
prompt-template:subagent:started
prompt-template:subagent:update
prompt-template:subagent:response
prompt-template:subagent:cancel
```

V2 adds `ownerRunId` and `nodeId`. `pi-subagents-goal` additionally correlates the generated request ID, so the accepted tuple is:

```text
protocol version + request ID + ownerRunId + nodeId
```

The caller waits for the terminal response and remains the only component deciding whether to enqueue another parent turn. That is why optional goal-owned single, parallel, chain, and review foreground paths are supported.

## Existing RPC evidence

`src/extension/rpc.ts` exposes RPC protocol v1 and methods:

```text
ping, status, spawn, steer, interrupt, stop, resume
```

`ping` reports session identity plus async/process-terminal observer event names. It does **not** advertise caller-owned goal coordination. Fleet status identities are intentionally opaque and cannot substitute for immutable goal/item ownership.

The real-local smoke verifies:

```json
{
  "piSubagentsVersion": "0.38.1",
  "piSubagentsCommit": "886bbad929134d7954a4fb34e532d82ac21e33e8",
  "localWorktreeClean": true,
  "rpcSessionMatched": true,
  "delegationV2TupleMatched": true,
  "foregroundTerminal": "failed",
  "detachedGoalCoordinationAdvertised": false
}
```

The foreground terminal is deliberately `failed` with `Unknown agent`; this proves the real V2 request/start/response path and exact tuple without invoking a model.

## Minimal `pi-subagents` contract

A future version can advertise the following from RPC `ping`:

```json
{
  "capabilities": {
    "goalCoordination": {
      "version": 1,
      "requestEvent": "subagents:goal-coordination:v1:request",
      "replyPrefix": "subagents:goal-coordination:v1:reply:",
      "event": "subagents:goal-coordination:v1:event"
    }
  }
}
```

### Spawn request

```ts
interface GoalCoordinatedSpawnRequestV1 {
  version: 1;
  requestId: string;
  method: "spawn";
  owner: {
    sessionId: string;
    sessionFile: string | null;
    lineageId: string;
    goalId: string;
    epoch: number;
  };
  itemId: string;
  attempt: number;
  params: Record<string, unknown>;
}
```

Semantics:

1. `pi-subagents` durably stores the owner tuple with the run before acknowledging.
2. It suppresses all automatic parent `triggerTurn` notifications for that run.
3. It rejects duplicate `(owner, itemId, attempt)` admissions unless they are idempotent replay.
4. The reply includes immutable run/session identity, branch anchor, generation, and lifecycle cursor.

### Spawn reply

```ts
interface GoalCoordinatedSpawnReplyV1 {
  version: 1;
  requestId: string;
  success: true;
  data: {
    runId: string;
    sessionId: string;
    branchAnchorId: string;
    lifecycleCursor: string;
    generation: number;
  };
}
```

### Lifecycle event

```ts
interface GoalCoordinatedLifecycleV1 {
  version: 1;
  owner: OwnerIdentity;
  itemId: string;
  attempt: number;
  generation: number;
  cursor: string;
  state:
    | "queued"
    | "running"
    | "paused"
    | "needs_attention"
    | "stopping"
    | "succeeded"
    | "failed"
    | "timed_out"
    | "stopped"
    | "interrupted"
    | "budget_exhausted"
    | "unknown";
  outputTicket?: string;
  output?: string;
}
```

Required semantics:

- event storage is durable and replayable from `lifecycleCursor`;
- cursor and generation are monotonic per item attempt;
- terminal state is immutable;
- identical duplicates are idempotent;
- conflicting duplicates are protocol faults;
- output remains available until the caller acknowledges `outputTicket`;
- process exit without a known result maps to `unknown`, never success;
- cancellation targets the exact owner/item/attempt/run tuple.

### Output acknowledgement

A method such as:

```ts
ackOutput({ owner, itemId, attempt, outputTicket, outputDigest })
```

must durably mark provider output consumed and permit artifact cleanup only after a successful acknowledgement. Reading a file or observing an event is not acknowledgement.

### Reconciliation

The caller needs:

```ts
replay({ owner, afterCursor }) -> GoalCoordinatedLifecycleV1[]
status({ owner, itemId, attempt }) -> current immutable item state
```

This closes event loss during reload and lets the caller decide whether to pause, fault, or continue without ambient artifact scanning.

## Minimal Pi core primitive

Provider coordination alone is insufficient for crash-safe exactly-once continuation. Pi `0.83.0` exposes separate `appendEntry()` and `sendMessage()` calls, leaving a crash window between ledger persistence and enqueue.

A minimal core API could be:

```ts
pi.enqueueMessageOnce({
  key: `${sessionId}:${goalId}:${epoch}:${sequence}:${nonce}`,
  expectedLeafId,
  stateEntry: { customType, data },
  message: { customType, content, display, details },
  triggerTurn: true,
  deliverAs: "followUp"
}) -> { status: "queued" | "already-queued"; entryId: string }
```

Required semantics:

- transactionally append the state transition and message;
- deduplicate by `key` in the target session;
- compare the active leaf/branch anchor;
- report an existing enqueue after restart;
- never execute extension callbacks between state commit and message registration.

An equivalent reserve/commit/lookup API is acceptable if it gives the same atomicity and idempotent recovery.

## Adoption rule in this extension

Detached mode remains rejected until **both** are true:

1. `pi-subagents` advertises and satisfies `goalCoordination v1` with caller-owned notification, replay, cancellation, and output acknowledgement;
2. Pi offers an atomic/idempotent continuation enqueue or another mechanism proving exactly-one recovery.

Unknown versions, partial capabilities, malformed channels, mismatched sessions, or missing methods fail closed for the optional goal-owned adapter. The parent loop and ordinary tools remain available; optional goal-owned foreground delegation is the supported coordinated path in the meantime.
