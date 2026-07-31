# Implementation plan

## Decision

Build a Git-distributed Pi 0.83.0 package that remains private on npm and has no production dependencies beyond Pi's required peers. The extension owns `/goal` and exposes `goal_subagent`, `goal_ack_output`, `goal_resolve`, `goal_review`, and `goal_done`. Parent automatic-turn/no-progress and child execution guards remain finite by default; goal token and wall-clock limits are opt-in, and explicit token limits count newly generated parent output plus delegated usage.

The current local `pi-subagents` 0.38.1 cannot safely hand detached completion ownership to another extension: it queues its own turn before emitting `subagent:async-complete`. Therefore:

- foreground single, parallel, and chain work uses stable delegation V2 and is fully supported;
- ordinary model-facing `subagent` calls are recoverably blocked while a goal is active;
- detached work is rejected unless a future versioned caller-owned completion capability is advertised;
- the pure state machine and contract tests cover detached races against the proposed capability, but the real-local smoke must prove current versions fail closed rather than pretending full support.

## Deep modules and seams

1. **`GoalMachine`** — pure state transitions behind a small command interface. Owns exact identity, work ledger, output acknowledgement, continuation tickets, review freshness, budgets, and stale-event rejection.
2. **`SubagentBridge`** — one adapter over the stable `pi.events` delegation/RPC seams. Foreground V2 is the production adapter; tests use an in-memory adapter. Detached coordination is capability-gated.
3. **`status-api`** — a bounded, capability-free, session-scoped event contract for presentation consumers. It excludes ownership IDs, acknowledgement/review tokens, digests, raw faults, and child output.
4. **Pi extension adapter** — translates `/goal`, tools, and lifecycle events into machine commands, persists value-free snapshots via `appendEntry`, performs continuation effects, and emits status without calling Pi UI APIs.

## Validation contract

- deterministic race tests for every acceptance scenario;
- bounded bridge tests for timeout, abort, duplicate/stale responses, parallel, and chain;
- extension harness tests for namespace collision, direct-subagent blocking, persistence, lifecycle guards, acknowledgement tokens, `goal_done` gates, output-only parent token accounting, status replay, and zero direct UI writes;
- exact Pi 0.83.0 typecheck and package-load smoke;
- local `pi-subagents` contract smoke against the sibling `../pi-subagents` checkout (or `PI_SUBAGENTS_LOCAL_PATH`), including foreground delegation V2 and detached fail-closed capability detection;
- format, lint, typecheck, unit/integration tests, `npm pack --dry-run`, and independent review.

## Completion record

Implemented and independently reviewed on the feature branch with:

- 82 deterministic tests spanning state, persistence, bridge, runner, status API, and extension behavior;
- warning-free Biome format/lint and strict TypeScript checks;
- exact Pi 0.83.0 Jiti loader smoke;
- clean local `pi-subagents` 0.38.1 smoke at commit `886bbad929134d7954a4fb34e532d82ac21e33e8`;
- UTF-8-bounded model-facing payloads and nonce-correlated parent lifecycle settlement;
- fresh read-only blocker re-review reporting PASS;
- package dry-run containing only intended source, docs, metadata, and license;
- cross-repository consumers in `pi-sidebar` for detailed state and `pi-footer` for minimal pulsing activity, each with hostile-payload and session-lifecycle tests.

The Pi 0.83.0 compatibility update also moves to TypeBox 1.3.7. Its published shrinkwrap still selects vulnerable `brace-expansion@5.0.7` (`GHSA-mh99-v99m-4gvg`), so that upstream audit residual remains. Detached goal-owned work also remains fail-closed pending the documented upstream provider/core coordination primitives.

## Ship boundary

Commit, push, and open a pull request. Do not merge or publish.
