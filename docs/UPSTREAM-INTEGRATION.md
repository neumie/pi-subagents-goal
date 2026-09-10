# Upstream compatibility and historical coordination design

## Audited versions

- Pi: `@earendil-works/pi-coding-agent` `0.83.0` (pinned development target) and exact `0.85.1` (production-loader/direct-lifecycle check with a deterministic stream on Node `24.18.0`; not interactive TUI or real-model evidence)
- official `pi-subagents` main: `0.67.0` (upstream compatibility target)

The repository was inspected read-only. No upstream or global Pi files are modified by this project. In the upstream-compatible release, `goal_subagent` and `goal_review` reject before ledger admission or provider dispatch because official `pi-subagents` does not enforce the hard child-turn limits required by this extension. The direct goal loop does not probe or require `pi-subagents`, and ordinary `subagent` calls, when installed, remain upstream-owned and subject to their own upstream controls.

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

## Current upstream-compatible behavior

The upstream provider's structured delegation contract is unversioned and deliberately rejects the `version` and `turnBudget` fields used by the historical goal-owned bridge. More importantly, upstream no longer enforces the hard child-turn limits required by this extension. Therefore this release does **not** launch goal-owned foreground, parallel, chain, or review work: both tools reject after goal/session identity validation and before ledger admission, provider probing, generation changes, or dispatch.

Direct-only goals remain supported without `pi-subagents`. Ordinary `subagent` calls remain upstream-owned and are not tracked by this extension. The dormant V2 bridge and its tests are retained as historical internal coverage only; they do not establish current upstream interoperability.

## Existing RPC evidence

`src/extension/rpc.ts` exposes RPC protocol v1 and methods:

```text
ping, status, spawn, steer, interrupt, stop, resume
```

`ping` reports session identity plus async/process-terminal observer event names. It does **not** advertise caller-owned goal coordination. Fleet status identities are intentionally opaque and cannot substitute for immutable goal/item ownership.

The historical local smoke record is not current-upstream compatibility evidence. It exercised a prior audited local revision and is retained only to document the old bridge behavior; it did not authorize enabling the goal-owned tools against upstream 0.67.0.

## Historical proposal: coordinated `pi-subagents` contract

The following proposal is retained as design history, not a requirement for this migration or an implemented auto-enablement path. Any future goal-owned runtime change requires separate review and enforcement of the required child limits.

The proposal would advertise the following from RPC `ping`:

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

## Historical adoption rule — not current runtime behavior

The earlier proposal required **both** conditions below. Current goal-owned tools reject unconditionally; advertising these capabilities cannot re-enable them:

1. `pi-subagents` advertises and satisfies `goalCoordination v1` with caller-owned notification, replay, cancellation, and output acknowledgement;
2. Pi offers an atomic/idempotent continuation enqueue or another mechanism proving exactly-one recovery.

Unknown versions, partial capabilities, malformed channels, mismatched sessions, or missing methods fail closed for the historical goal-owned adapter. The parent loop and ordinary tools remain available; goal-owned foreground delegation and review are disabled in the upstream-compatible release rather than silently weakening hard child-turn guarantees.
