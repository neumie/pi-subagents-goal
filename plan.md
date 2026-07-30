# Implementation plan

## Decision

Build a private Pi 0.82.1 package with no production dependencies beyond Pi's required peers. The extension owns `/goal` and exposes `goal_subagent`, `goal_ack_output`, `goal_resolve`, `goal_review`, and `goal_done`.

The current local `pi-subagents` 0.38.1 cannot safely hand detached completion ownership to another extension: it queues its own turn before emitting `subagent:async-complete`. Therefore:

- foreground single, parallel, and chain work uses stable delegation V2 and is fully supported;
- ordinary model-facing `subagent` calls are recoverably blocked while a goal is active;
- detached work is rejected unless a future versioned caller-owned completion capability is advertised;
- the pure state machine and contract tests cover detached races against the proposed capability, but the real-local smoke must prove current versions fail closed rather than pretending full support.

## Deep modules and seams

1. **`GoalMachine`** — pure state transitions behind a small command interface. Owns exact identity, work ledger, output acknowledgement, continuation tickets, review freshness, budgets, and stale-event rejection.
2. **`SubagentBridge`** — one adapter over the stable `pi.events` delegation/RPC seams. Foreground V2 is the production adapter; tests use an in-memory adapter. Detached coordination is capability-gated.
3. **Pi extension adapter** — translates `/goal`, tools, and lifecycle events into machine commands, persists value-free snapshots via `appendEntry`, and performs continuation effects.

## Validation contract

- deterministic race tests for every acceptance scenario;
- bounded bridge tests for timeout, abort, duplicate/stale responses, parallel, and chain;
- extension harness tests for namespace collision, direct-subagent blocking, persistence, lifecycle guards, acknowledgement tokens, and `goal_done` gates;
- exact Pi 0.82.1 typecheck and package-load smoke;
- local `pi-subagents` contract smoke against `/Users/jakubneumann/Documents/code/neumie/pi-subagents`, including foreground delegation V2 and detached fail-closed capability detection;
- format, lint, typecheck, unit/integration tests, `npm pack --dry-run`, and independent review.

## Completion record

Implemented and independently reviewed on the feature branch with:

- 75 deterministic tests spanning state, persistence, bridge, runner, and extension behavior;
- warning-free Biome format/lint and strict TypeScript checks;
- exact Pi 0.82.1 Jiti loader smoke;
- clean local `pi-subagents` 0.38.1 smoke at commit `886bbad929134d7954a4fb34e532d82ac21e33e8`;
- UTF-8-bounded model-facing payloads and nonce-correlated parent lifecycle settlement;
- fresh read-only blocker re-review reporting PASS;
- package dry-run containing only intended source, docs, metadata, and license.

Known residual: Pi 0.82.1 shrinkwraps vulnerable `brace-expansion@5.0.7` (`GHSA-mh99-v99m-4gvg`); root overrides cannot replace it. Detached goal-owned work also remains fail-closed pending the documented upstream provider/core coordination primitives.

## Ship boundary

Commit, push, and open a pull request. Do not merge or publish.
