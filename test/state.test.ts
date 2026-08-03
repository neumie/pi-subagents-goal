import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	GoalInvariantError,
	GoalMachine,
	createGoalSnapshot,
	newAckToken,
	type OwnerIdentity,
	type TerminalWorkState,
} from "../src/state.ts";

const NOW = 1_000;

function owner(overrides: Partial<OwnerIdentity> = {}): OwnerIdentity {
	return {
		sessionId: "session-1",
		sessionFile: "/sessions/one.jsonl",
		lineageId: "lineage-1",
		goalId: "goal-1",
		epoch: 1,
		...overrides,
	};
}

function machine(overrides: Parameters<typeof createGoalSnapshot>[0]["budgetLimits"] = {}): GoalMachine {
	return new GoalMachine(
		createGoalSnapshot({
			owner: owner(),
			objective: "Finish the feature safely",
			now: NOW,
			budgetLimits: overrides,
		}),
	);
}

function admit(target: GoalMachine, itemId: string, mode: "single" | "parallel" | "chain" = "single") {
	return target.admitWork({ itemId, mode, label: itemId, now: NOW + 1 });
}

function finish(
	target: GoalMachine,
	itemId: string,
	outcome: TerminalWorkState = "succeeded",
	time = NOW + 3,
) {
	const ackToken = newAckToken();
	assert.equal(
		target.terminalWork({
			owner: owner(),
			itemId,
			outcome,
			output: `output:${itemId}:${outcome}`,
			ackToken,
			now: time,
		}),
		true,
	);
	return ackToken;
}

function settleParent(target: GoalMachine, time: number) {
	if (target.snapshot.parentSettled) target.agentStarted(time);
	const continuation = target.snapshot.continuation;
	target.agentEnded(time, continuation?.status === "running" ? continuation.ticket.nonce : undefined);
	return target.agentSettled(time);
}

function surfaceAndAck(target: GoalMachine, itemId: string, ackToken: string, time = NOW + 4) {
	assert.equal(target.markOutputSurfaced(owner(), [itemId], time), true);
	assert.equal(
		target.acknowledgeOutput({
			owner: owner(),
			itemId,
			ackToken,
			consideration: `Considered ${itemId}`,
			now: time + 1,
		}),
		true,
	);
}

function reviewedMachine(verdict: "pass" | "fail" = "pass") {
	const target = machine();
	admit(target, "work-1");
	target.startWork(owner(), "work-1", NOW + 2);
	const workAck = finish(target, "work-1");
	surfaceAndAck(target, "work-1", workAck);
	const workGeneration = target.snapshot.workGeneration;
	target.admitWork({
		itemId: "review-1",
		mode: "single",
		role: "review",
		label: "Independent review",
		now: NOW + 6,
	});
	target.startWork(owner(), "review-1", NOW + 7);
	const reviewAck = finish(target, "review-1", "succeeded", NOW + 8);
	assert.equal(
		target.recordReview({
			owner: owner(),
			itemId: "review-1",
			verdict,
			workGeneration,
			findings: "No blockers",
			now: NOW + 9,
		}),
		true,
	);
	surfaceAndAck(target, "review-1", reviewAck, NOW + 10);
	return target;
}

describe("continuation barrier", () => {
	it("does not reserve a continuation after async spawn while owned work is active", () => {
		const target = machine();
		admit(target, "async-1");
		target.startWork(owner(), "async-1", NOW + 2);

		assert.equal(settleParent(target, NOW + 3), undefined);
		assert.equal(target.snapshot.parentSettled, true);
		assert.equal(target.snapshot.continuation, undefined);
	});

	it("reserves and commits exactly one continuation after all output is available", () => {
		const target = machine();
		admit(target, "async-1");
		target.startWork(owner(), "async-1", NOW + 2);
		const ackToken = finish(target, "async-1");
		const ticket = settleParent(target, NOW + 4);

		assert.ok(ticket);
		assert.deepEqual(ticket.outputItemIds, ["async-1"]);
		assert.equal(target.reserveContinuation(NOW + 5), undefined);
		assert.equal(target.commitContinuation(ticket, NOW + 6), true);
		assert.equal(target.snapshot.continuation?.status, "queued");
		assert.equal(target.snapshot.work[0]?.outputState, "surfaced");
		assert.equal(target.reserveContinuation(NOW + 7), undefined);
		assert.equal(
			target.acknowledgeOutput({
				owner: owner(),
				itemId: "async-1",
				ackToken,
				consideration: "I considered the terminal output",
				now: NOW + 8,
			}),
			true,
		);
	});

	it("handles settled-before-terminal and terminal-before-settled identically", () => {
		const terminalFirst = machine();
		admit(terminalFirst, "run");
		terminalFirst.startWork(owner(), "run", NOW + 2);
		finish(terminalFirst, "run");
		const firstTicket = settleParent(terminalFirst, NOW + 4);

		const settledFirst = machine();
		admit(settledFirst, "run");
		settledFirst.startWork(owner(), "run", NOW + 2);
		assert.equal(settleParent(settledFirst, NOW + 3), undefined);
		finish(settledFirst, "run", "succeeded", NOW + 4);
		const secondTicket = settledFirst.reserveContinuation(NOW + 5);

		assert.ok(firstTicket);
		assert.ok(secondTicket);
		assert.deepEqual(firstTicket.outputItemIds, secondTicket.outputItemIds);
		assert.equal(firstTicket.sequence, secondTicket.sequence);
	});

	it("invalidates a reservation when new work starts during scheduling", () => {
		const target = machine();
		assert.equal(settleParent(target, NOW + 1)?.sequence, 1);
		const ticket = target.snapshot.continuation?.ticket;
		assert.ok(ticket);

		admit(target, "late-run");
		assert.equal(target.snapshot.continuation, undefined);
		assert.equal(target.commitContinuation(ticket, NOW + 3), false);
	});

	it("faults if work appears after a continuation is already queued", () => {
		const target = machine();
		const ticket = settleParent(target, NOW + 1);
		assert.ok(ticket);
		assert.equal(target.commitContinuation(ticket, NOW + 2), true);
		assert.throws(() => admit(target, "too-late"), GoalInvariantError);
		assert.equal(target.snapshot.phase, "faulted");
	});

	it("ignores duplicate starts and settlements until the current run has ended", () => {
		const target = machine();
		const initial = target.queueInitialContinuation(NOW + 1);
		assert.equal(target.agentStarted(NOW + 2, initial.nonce), true);
		assert.equal(target.agentStarted(NOW + 2, initial.nonce), false);
		settleParent(target, NOW + 3);
		const automatic = target.snapshot.continuation?.ticket;
		assert.ok(automatic);
		assert.equal(target.commitContinuation(automatic, NOW + 4), true);
		assert.equal(target.agentStarted(NOW + 5, automatic.nonce), true);
		assert.equal(target.snapshot.currentRunAutomatic, true);
		assert.equal(target.agentStarted(NOW + 5, automatic.nonce), false);
		assert.equal(target.snapshot.currentRunAutomatic, true);
		assert.equal(target.agentEnded(NOW + 6, initial.nonce), false);
		assert.equal(target.agentSettled(NOW + 6), undefined);
		assert.equal(target.snapshot.continuation?.status, "running");
		assert.equal(target.snapshot.continuation?.ticket.sequence, automatic.sequence);
	});

	it("does not let an unrelated parent run consume a queued continuation", () => {
		const target = machine();
		const initial = target.queueInitialContinuation(NOW + 1);
		assert.equal(target.agentStarted(NOW + 2), false);
		assert.equal(target.agentStarted(NOW + 3, "wrong"), false);
		assert.equal(target.snapshot.continuation?.status, "queued");
		assert.equal(target.agentStarted(NOW + 4, initial.nonce), true);
		assert.equal(target.snapshot.continuation?.status, "running");
	});

	it("rejects reused item IDs even when the attempt differs", () => {
		const target = machine();
		target.admitWork({ itemId: "same", attempt: 1, mode: "single", label: "one", now: NOW + 1 });
		assert.throws(
			() => target.admitWork({ itemId: "same", attempt: 2, mode: "single", label: "two", now: NOW + 2 }),
			/Duplicate work item ID/u,
		);
	});

	it("tracks every parallel and chain item before allowing one aggregate continuation", () => {
		const target = machine();
		for (const item of ["parallel-a", "parallel-b", "chain-1", "chain-2"]) {
			admit(target, item, item.startsWith("chain") ? "chain" : "parallel");
			target.startWork(owner(), item, NOW + 2);
		}
		for (const item of ["parallel-a", "parallel-b", "chain-1"]) finish(target, item);
		assert.equal(settleParent(target, NOW + 4), undefined);
		finish(target, "chain-2", "succeeded", NOW + 5);
		const ticket = target.reserveContinuation(NOW + 6);
		assert.ok(ticket);
		assert.deepEqual(
			new Set(ticket.outputItemIds),
			new Set(["parallel-a", "parallel-b", "chain-1", "chain-2"]),
		);
	});
});

describe("work outcomes and output acknowledgement", () => {
	for (const outcome of [
		"failed",
		"timed_out",
		"stopped",
		"interrupted",
		"budget_exhausted",
		"unknown",
	] satisfies TerminalWorkState[]) {
		it(`keeps ${outcome} explicit and unresolved`, () => {
			const target = machine();
			admit(target, "run");
			target.startWork(owner(), "run", NOW + 2);
			const ackToken = finish(target, "run", outcome);
			surfaceAndAck(target, "run", ackToken);
			const decision = target.completionDecision({
				owner: owner(),
				consideredItemIds: ["run"],
				now: NOW + 6,
			});
			assert.equal(decision.ok, false);
			assert.match(decision.blockers.join("\n"), /unresolved unsuccessful work/);
			assert.equal(target.snapshot.work[0]?.state, outcome);
		});
	}

	it("requires exact acknowledgement tokens and explicit consideration", () => {
		const target = machine();
		admit(target, "run");
		const ackToken = finish(target, "run");
		assert.equal(target.markOutputSurfaced(owner(), ["run"], NOW + 4), true);
		assert.equal(
			target.acknowledgeOutput({
				owner: owner(),
				itemId: "run",
				ackToken: "wrong",
				consideration: "read",
				now: NOW + 5,
			}),
			false,
		);
		assert.equal(
			target.acknowledgeOutput({ owner: owner(), itemId: "run", ackToken, consideration: "", now: NOW + 6 }),
			false,
		);
		assert.equal(target.snapshot.work[0]?.outputState, "surfaced");
	});

	it("holds needs-attention, paused, and stopping work as nonterminal", () => {
		const target = machine();
		admit(target, "run");
		target.startWork(owner(), "run", NOW + 2);
		assert.equal(target.markNeedsAttention(owner(), "run", NOW + 3), true);
		assert.equal(target.reserveContinuation(NOW + 4), undefined);
		assert.equal(target.startWork(owner(), "run", NOW + 5), true);
		assert.equal(target.pauseWork(owner(), "run", NOW + 6), true);
		assert.equal(target.reserveContinuation(NOW + 7), undefined);
		assert.equal(target.requestStop(owner(), "run", NOW + 8), true);
		assert.equal(target.reserveContinuation(NOW + 9), undefined);
	});

	it("accepts idempotent terminal duplicates but faults on conflicting terminal facts", () => {
		const target = machine();
		admit(target, "run");
		const ackToken = newAckToken();
		const event = {
			owner: owner(),
			itemId: "run",
			outcome: "succeeded" as const,
			output: "same",
			ackToken,
			now: NOW + 2,
		};
		assert.equal(target.terminalWork(event), true);
		assert.equal(target.terminalWork({ ...event, now: NOW + 3 }), true);
		assert.equal(target.terminalWork({ ...event, outcome: "failed", now: NOW + 4 }), false);
		assert.equal(target.snapshot.phase, "faulted");
	});
});

describe("ownership and lifecycle", () => {
	it("rejects stale session, lineage, goal, and epoch events without unblocking", () => {
		for (const staleOwner of [
			owner({ sessionId: "other" }),
			owner({ sessionFile: "/sessions/other.jsonl" }),
			owner({ lineageId: "other" }),
			owner({ goalId: "other" }),
			owner({ epoch: 2 }),
		]) {
			const target = machine();
			admit(target, "run");
			assert.equal(
				target.terminalWork({
					owner: staleOwner,
					itemId: "run",
					outcome: "succeeded",
					output: "stale",
					ackToken: newAckToken(),
					now: NOW + 2,
				}),
				false,
			);
			assert.equal(target.snapshot.work[0]?.state, "queued");
			assert.equal(target.snapshot.staleEventCount, 1);
		}
	});

	it("pauses and resumes only when no owned work remains active", () => {
		const target = machine();
		admit(target, "run");
		assert.equal(target.pause("user pause", NOW + 2), true);
		assert.equal(target.resume(NOW + 3), false);
		finish(target, "run", "stopped", NOW + 4);
		assert.equal(target.resume(NOW + 5), true);
	});

	it("cancellation remains cancelling until every item is terminal", () => {
		const target = machine();
		admit(target, "a");
		admit(target, "b");
		assert.equal(target.cancel(NOW + 2), "cancelling");
		finish(target, "a", "stopped", NOW + 3);
		assert.equal(target.snapshot.phase, "cancelling");
		finish(target, "b", "stopped", NOW + 4);
		assert.equal(target.snapshot.phase, "cancelled");
	});
});

describe("finite budgets", () => {
	it("leaves token and wall-clock limits disabled by default", () => {
		const target = machine();
		assert.equal(target.snapshot.budgetLimits.maxTokens, null);
		assert.equal(target.snapshot.budgetLimits.maxWallClockMs, null);
		target.recordTurn({ tokens: 2_000_000, progressSignature: "large-existing-context", now: NOW + 1 });
		assert.equal(target.snapshot.budgetUsage.tokens, 2_000_000);
		assert.equal(target.snapshot.phase, "active");
		target.admitWork({
			itemId: "late-work",
			mode: "single",
			role: "work",
			label: "late",
			now: NOW + 365 * 24 * 60 * 60 * 1_000,
		});
		assert.equal(target.snapshot.phase, "active");
	});

	it("exhausts the automatic turn budget exactly at the limit", () => {
		const target = machine({ maxAutomaticTurns: 2, maxNoProgressTurns: 10 });
		const initial = target.queueInitialContinuation(NOW + 1);
		target.agentStarted(NOW + 2, initial.nonce);
		settleParent(target, NOW + 3);
		const ticket = target.snapshot.continuation?.ticket;
		assert.ok(ticket);
		target.commitContinuation(ticket, NOW + 4);
		target.agentStarted(NOW + 5, ticket.nonce);
		target.recordTurn({ tokens: 1, progressSignature: "one", now: NOW + 6 });
		target.recordTurn({ tokens: 1, progressSignature: "two", now: NOW + 7 });
		assert.equal(target.snapshot.phase, "budget_exhausted");
		assert.equal(target.reserveContinuation(NOW + 8), undefined);
	});

	it("saturates parent and external token accounting before persistence-safe overflow", () => {
		const target = machine({ maxTokens: Number.MAX_SAFE_INTEGER - 1 });
		target.recordTurn({
			tokens: Number.MAX_SAFE_INTEGER,
			progressSignature: "parent-overflow",
			now: NOW + 1,
		});
		assert.equal(target.snapshot.budgetUsage.tokens, Number.MAX_SAFE_INTEGER);
		assert.equal(target.snapshot.phase, "budget_exhausted");

		const external = machine({ maxTokens: Number.MAX_SAFE_INTEGER - 1 });
		external.recordExternalTokens(Number.MAX_SAFE_INTEGER - 2, NOW + 1);
		external.recordExternalTokens(10, NOW + 2);
		assert.equal(external.snapshot.budgetUsage.tokens, Number.MAX_SAFE_INTEGER);
		assert.equal(external.snapshot.phase, "budget_exhausted");
		assert.doesNotThrow(() => new GoalMachine(external.snapshot));
	});

	it("enforces token, wall-clock, and no-progress limits", () => {
		const initialTokenTarget = machine({ maxTokens: 5, maxNoProgressTurns: 10 });
		const initialTokenTicket = initialTokenTarget.queueInitialContinuation(NOW + 1);
		initialTokenTarget.agentStarted(NOW + 2, initialTokenTicket.nonce);
		initialTokenTarget.recordTurn({ tokens: 5, progressSignature: "initial", now: NOW + 3 });
		assert.equal(initialTokenTarget.snapshot.budgetUsage.tokens, 5);
		assert.equal(initialTokenTarget.snapshot.budgetUsage.automaticTurns, 0);
		assert.equal(initialTokenTarget.snapshot.phase, "budget_exhausted");

		const tokenTarget = machine({ maxTokens: 5, maxNoProgressTurns: 10 });
		const initialTokenRun = tokenTarget.queueInitialContinuation(NOW + 1);
		tokenTarget.agentStarted(NOW + 2, initialTokenRun.nonce);
		settleParent(tokenTarget, NOW + 3);
		const tokenTicket = tokenTarget.snapshot.continuation?.ticket;
		assert.ok(tokenTicket);
		tokenTarget.commitContinuation(tokenTicket, NOW + 4);
		tokenTarget.agentStarted(NOW + 5, tokenTicket.nonce);
		tokenTarget.recordTurn({ tokens: 5, progressSignature: "token", now: NOW + 6 });
		assert.equal(tokenTarget.snapshot.phase, "budget_exhausted");

		const wallTarget = machine({ maxWallClockMs: 10 });
		assert.throws(
			() =>
				wallTarget.admitWork({
					itemId: "too-late",
					mode: "single",
					role: "work",
					label: "late",
					now: NOW + 10,
				}),
			/budget_exhausted/u,
		);
		assert.equal(wallTarget.snapshot.phase, "budget_exhausted");

		const externalTarget = machine({ maxTokens: 5 });
		externalTarget.recordExternalTokens(5, NOW + 1);
		assert.equal(externalTarget.snapshot.phase, "budget_exhausted");

		const pausedTarget = machine({ maxTokens: 5 });
		admit(pausedTarget, "paused-child");
		pausedTarget.startWork(owner(), "paused-child", NOW + 2);
		pausedTarget.pause("wait", NOW + 3);
		pausedTarget.recordExternalTokens(5, NOW + 4);
		finish(pausedTarget, "paused-child", "succeeded", NOW + 5);
		assert.equal(pausedTarget.snapshot.budgetUsage.tokens, 5);
		assert.equal(pausedTarget.resume(NOW + 6), false);
		assert.equal(pausedTarget.snapshot.phase, "budget_exhausted");

		const noProgressTarget = machine({ maxNoProgressTurns: 2, maxAutomaticTurns: 10 });
		const initialNoProgressRun = noProgressTarget.queueInitialContinuation(NOW + 1);
		noProgressTarget.agentStarted(NOW + 2, initialNoProgressRun.nonce);
		settleParent(noProgressTarget, NOW + 3);
		const noProgressTicket = noProgressTarget.snapshot.continuation?.ticket;
		assert.ok(noProgressTicket);
		noProgressTarget.commitContinuation(noProgressTicket, NOW + 4);
		noProgressTarget.agentStarted(NOW + 5, noProgressTicket.nonce);
		noProgressTarget.recordTurn({ tokens: 1, progressSignature: "same", now: NOW + 6 });
		noProgressTarget.recordTurn({ tokens: 1, progressSignature: "same", now: NOW + 7 });
		noProgressTarget.recordTurn({ tokens: 1, progressSignature: "same", now: NOW + 8 });
		assert.equal(noProgressTarget.snapshot.phase, "budget_exhausted");
	});
});

describe("completion continuation guard", () => {
	it("blocks completion while a continuation is reserved or queued, but permits the exact running turn", () => {
		const target = machine();
		const reserved = target.reserveContinuation(NOW + 1);
		assert.ok(reserved);
		assert.match(
			target.completionDecision({ owner: owner(), consideredItemIds: [], now: NOW + 2 }).blockers.join("\n"),
			/reserved or queued/u,
		);
		assert.equal(target.commitContinuation(reserved, NOW + 3), true);
		assert.match(
			target.completionDecision({ owner: owner(), consideredItemIds: [], now: NOW + 4 }).blockers.join("\n"),
			/reserved or queued/u,
		);
		assert.equal(target.agentStarted(NOW + 5, reserved.nonce), true);
		assert.equal(target.completionDecision({ owner: owner(), consideredItemIds: [], now: NOW + 6 }).ok, true);
	});
});

describe("optional goal-owned work and completion", () => {
	it("denies goal_done while goal-owned work is active or output is unread", () => {
		const target = machine();
		admit(target, "run");
		let decision = target.completionDecision({
			owner: owner(),
			consideredItemIds: [],
			now: NOW + 2,
		});
		assert.match(decision.blockers.join("\n"), /nonterminal work/);
		finish(target, "run");
		decision = target.completionDecision({
			owner: owner(),
			consideredItemIds: ["run"],
			now: NOW + 4,
		});
		assert.match(decision.blockers.join("\n"), /unconsumed output/);
	});

	it("completes without pi-subagents work or independent review", () => {
		const target = machine();
		const decision = target.complete({ owner: owner(), consideredItemIds: [], now: NOW + 1 });
		assert.deepEqual(decision, { ok: true, blockers: [] });
		assert.equal(target.snapshot.phase, "completed");
	});

	it("treats an invoked review as advisory after its owned output is consumed", () => {
		const target = reviewedMachine("fail");
		const decision = target.complete({
			owner: owner(),
			consideredItemIds: ["work-1", "review-1"],
			now: NOW + 12,
		});
		assert.deepEqual(decision, { ok: true, blockers: [] });
		assert.equal(target.snapshot.phase, "completed");
	});

	it("still rejects omitted, unknown, or repeated goal-owned item IDs", () => {
		const target = reviewedMachine();
		for (const consideredItemIds of [
			["work-1"],
			["work-1", "review-1", "unknown"],
			["work-1", "review-1", "review-1"],
		]) {
			const decision = target.completionDecision({
				owner: owner(),
				consideredItemIds,
				now: NOW + 13,
			});
			assert.equal(decision.ok, false);
		}
	});

	it("requires unsuccessful work to be acknowledged and explicitly resolved before review", () => {
		const target = machine();
		admit(target, "failed-advice");
		const ackToken = finish(target, "failed-advice", "failed");
		surfaceAndAck(target, "failed-advice", ackToken);
		assert.equal(
			target.resolveUnsuccessfulWork({
				owner: owner(),
				itemId: "failed-advice",
				rationale: "The advisory child failed; equivalent evidence was verified independently.",
				now: NOW + 6,
			}),
			true,
		);
		assert.ok(target.snapshot.work[0]?.resolutionDigest);
	});
});

describe("ordinary goals", () => {
	it("queues exactly one initial turn and one continuation after settlement", () => {
		const target = machine();
		const initial = target.queueInitialContinuation(NOW + 1);
		assert.equal(initial.kind, "initial");
		target.agentStarted(NOW + 2, initial.nonce);
		const continuation = settleParent(target, NOW + 3);
		assert.ok(continuation);
		assert.equal(continuation.kind, "automatic");
		assert.equal(target.reserveContinuation(NOW + 4), undefined);
	});
});
