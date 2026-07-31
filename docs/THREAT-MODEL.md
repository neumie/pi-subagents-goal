# Threat model

## Scope

This model covers coordination safety for `pi-subagents-goal` running in one Pi process with Pi `0.83.0` and `pi-subagents` `0.38.1`. It does not sandbox child agents or make model output trustworthy.

## Assets

- **Continuation authority** — permission to enqueue the next autonomous turn.
- **Goal identity** — session, branch lineage, goal, and epoch ownership.
- **Work ledger integrity** — complete and accurate child lifecycle records.
- **Output-consumption evidence** — proof that terminal output entered context and was explicitly considered.
- **Completion evidence** — a current independent review tied to the latest work generation.
- **Budget integrity** — finite turn/no-progress accounting plus optional token and wall-clock limits.
- **Session confidentiality** — objective and child output values must not leak into hidden coordination metadata.

## Trust assumptions

1. Pi's in-process extension event bus delivers JavaScript values without transport corruption.
2. Pi's active `SessionManager` reports the correct session ID, file, and active branch.
3. `pi-subagents` delegation V2 emits one caller-correlated terminal response for foreground requests or the local timeout/abort path fires.
4. The filesystem, Pi process, and installed extension source are controlled by the local user.
5. SHA-256 is sufficient for integrity/deduplication digests; it is not used to encrypt values.
6. Random UUID/token generation from Node `crypto` is unpredictable enough for same-process correlation.

A malicious extension loaded into the same Pi process is inside the trust boundary: it can observe or forge public event-bus messages and mutate session state through Pi APIs.

## Adversaries and failures

- stale or duplicated lifecycle events;
- an event from another session, goal, epoch, item, or attempt;
- child timeout, interruption, process failure, or malformed result;
- provider disappearance or reload;
- parent settlement racing child terminal delivery;
- crash between persistence and continuation enqueue;
- model attempts to skip output acknowledgement or review;
- direct use of the ordinary `subagent` tool during a goal;
- session switch, fork, tree navigation, compaction, or shutdown at an unsafe point;
- namespace collisions with another goal extension;
- dependency drift or an unexpected upstream protocol;
- oversized child output intended to hide acknowledgement instructions.

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Stale event unblocks current goal | Exact owner plus globally unique item ID/attempt correlation; stale counter; no state advancement |
| Duplicate terminal event | Identical digest/outcome is idempotent; conflicting duplicate faults the goal |
| Parent settles before child | Nonterminal ledger blocks reservation; child state callback re-evaluates once terminal |
| Child terminates before parent | `parentSettled` remains false until an `agent_end` carrying the running continuation nonce arms settlement; one later reservation |
| New work races reservation | Admission deletes `reserved`; admission after `queued` faults |
| Two continuation sends | Monotonic ticket, random nonce, one continuation slot, commit comparison, no automatic retry |
| Crash makes send status unknowable | Any restored `reserved`, `queued`, or `running` continuation faults instead of resending |
| Child output omitted from context | `pending_surface` blocks consumption; output-bearing continuation or goal tool result must mark `surfaced` |
| Model invents acknowledgement | Timing-safe comparison with a random exact token and item ID |
| Failure treated as success | Terminal state is immutable; `goal_resolve` records rationale but does not rewrite outcome |
| Stale review reused | Work-generation binding, token binding, tool-call binding, and active-branch post-review scan |
| Review and completion issued as siblings | `goal_done` detects `goal_ack_output` in the same assistant message and rejects |
| Ordinary detached subagent bypasses ledger | Direct `subagent` calls are blocked while goal authority is live |
| Current detached completion races extension | `goal_subagent execution=detached` is rejected before admission |
| Fork inherits authority | Exact session ID/file validation; switch/fork/tree blocked while live |
| Unsafe compaction removes evidence | Compaction blocked with nonterminal work or unconsumed output |
| Reload loses foreground child | Restore with a nonterminal child faults |
| Unlimited autonomy | Parent automatic-turn/no-progress and child timeout/turn budgets remain finite by default; token and wall-clock caps are explicitly optional |
| Pre-existing context exhausts a goal cap | Parent accounting uses newly generated output only; delegated terminal usage is added before continuation eligibility, including while paused/cancelling |
| Oversized output hides tokens | Per-child and aggregate previews bounded; every token emitted in a separate untruncated list |
| Malformed persisted metadata | Field-by-field and cross-field lifecycle validation; no trusted cast |
| Objective leaks into hidden metadata | Snapshot stores only objective digest; objective value is a normal displayed session message |
| Goal namespace is shadowed | Session-start verification of `/goal` count and active tool source paths |
| Extension factory calls unbound Pi actions | Registration performs no runtime action calls; exact Pi loader smoke enforces this |
| Status API exposes coordination capabilities | Display payload omits owner/item IDs, session files, acknowledgement/review tokens, digests, prompts, findings, and child output |
| Hostile status consumer breaks coordination | Status requests are validated and listener failures are isolated from goal state transitions |
| Dependency/protocol drift | Exact peer/dev pins, lockfile, exact-version loader smoke, real-local contract smoke |

## Output and token handling

Acknowledgement and review tokens are capabilities, not authentication against hostile same-process code. They prevent accidental/stale model actions and cross-item confusion. They appear in normal session context because the model must return them; anyone with access to the session can read them.

Child output is bounded to 40,000 UTF-8 bytes per retained runner result, and every complete model-facing aggregate is bounded to 48,000 UTF-8 bytes including objective/framing/tokens. Truncation preserves Unicode boundaries and is explicit. A reviewer that needs omitted detail must inspect the configured child session/output through normal Pi interfaces before passing review.

## Independent review limitations

The review gate improves process independence but cannot prove semantic correctness:

- the reviewer is still a model;
- it reads the same local repository and may share provider/model biases;
- schema validity proves shape, not truth;
- malicious repository content can attempt prompt injection.

The prompt makes the reviewer read-only and asks for source-backed findings. Operators should require stronger external CI or human review for high-impact changes.

## Residual risks

1. **No transactional Pi enqueue.** `appendEntry` and `sendMessage` are separate calls. The extension persists `queued` first and faults ambiguous restore, yielding fail-closed at-most-one recovery rather than guaranteed progress after a crash.
2. **Same-process spoofing.** Another malicious Pi extension can forge public event-bus messages, shadow tools, or call session APIs. Source-path namespace checks do not sandbox extensions.
3. **Foreground child side effects.** Cancellation or timeout cannot roll back filesystem/network changes already made by a child.
4. **Usage accuracy.** Explicit token caps rely on Pi parent-output and `pi-subagents` usage reports. Missing usage counts as zero. Token and wall-clock caps are disabled by default; automatic-turn/no-progress and child limits remain independent backstops.
5. **Model-facing output bounds.** Preview truncation may require manual/session inspection before a truthful acknowledgement.
6. **Clean-shutdown semantics.** A clean shutdown pauses and permits explicit resume because Pi is expected to abort the active turn. If the host violates that assumption, a user should cancel rather than resume.
7. **Local upstream availability.** The smoke pins the local commit and requires a clean worktree, but reproducibility still depends on the configured absolute checkout being available (or `PI_SUBAGENTS_LOCAL_PATH` pointing to an equivalent clean checkout).
8. **Pi shrinkwrap advisory.** Pi 0.83.0 publishes a shrinkwrapped `brace-expansion@5.0.7`, affected by `GHSA-mh99-v99m-4gvg` (high-severity memory-exhaustion DoS). Clean-install testing shows root overrides and `npm audit fix` do not replace it. This extension does not accept brace/minimatch patterns and does not bundle that package, but a clean host Pi package installation retains the risk. Remediation requires a Pi release whose published shrinkwrap selects `brace-expansion>=5.0.8`.

## Security response

If an ownership, duplicate-continuation, or unconsumed-output invariant is uncertain, the correct response is to fault or pause—not infer success. Inspect the session branch and child session manually, cancel the old goal, then start a new epoch only after ambiguity is resolved.
