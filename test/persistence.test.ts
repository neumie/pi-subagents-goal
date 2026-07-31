import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	GOAL_OBJECTIVE_MESSAGE,
	GOAL_STATE_ENTRY,
	loadGoalFromBranch,
	objectiveMessage,
	persistenceSnapshot,
} from "../src/persistence.ts";
import {
	GoalInvariantError,
	GoalMachine,
	createGoalSnapshot,
	newAckToken,
	sha256,
	type GoalSnapshot,
	type OwnerIdentity,
} from "../src/state.ts";

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

function snapshot() {
	return createGoalSnapshot({ owner: owner(), objective: "Ship safely", now: 100 });
}

function consumedWorkSnapshot(): GoalSnapshot {
	const machine = new GoalMachine(snapshot());
	machine.admitWork({ itemId: "work-1", mode: "single", role: "work", label: "work", now: 101 });
	machine.startWork(owner(), "work-1", 102);
	const ackToken = newAckToken();
	machine.terminalWork({
		owner: owner(),
		itemId: "work-1",
		outcome: "succeeded",
		output: "done",
		ackToken,
		now: 103,
	});
	machine.markOutputSurfaced(owner(), ["work-1"], 104);
	machine.acknowledgeOutput({
		owner: owner(),
		itemId: "work-1",
		ackToken,
		consideration: "used",
		now: 105,
	});
	return machine.snapshot;
}

function firstWork(state: GoalSnapshot) {
	const item = state.work[0];
	if (!item) throw new Error("Test fixture is missing work.");
	return item;
}

function loadMutated(state: GoalSnapshot) {
	const objective = objectiveMessage("Ship safely", state);
	return loadGoalFromBranch(
		[
			{ type: "custom_message", ...objective },
			{ type: "custom", customType: GOAL_STATE_ENTRY, data: state },
		],
		{ sessionId: "session-1", sessionFile: "/sessions/one.jsonl" },
	);
}

describe("session-native goal persistence", () => {
	it("returns none when the active branch has no goal metadata", () => {
		assert.deepEqual(loadGoalFromBranch([], { sessionId: "session-1", sessionFile: "/sessions/one.jsonl" }), {
			kind: "none",
		});
	});

	it("restores value-free state and objective from separate session-native entries", () => {
		const state = snapshot();
		const objective = objectiveMessage("Ship safely", state);
		const result = loadGoalFromBranch(
			[
				{ type: "custom_message", ...objective },
				{ type: "custom", customType: GOAL_STATE_ENTRY, data: persistenceSnapshot(state) },
			],
			{ sessionId: "session-1", sessionFile: "/sessions/one.jsonl" },
		);
		assert.equal(result.kind, "loaded");
		if (result.kind !== "loaded") return;
		assert.equal(result.objective, "Ship safely");
		assert.equal(JSON.stringify(result.snapshot).includes("Ship safely"), false);
	});

	it("supports the message-entry representation returned by SessionManager", () => {
		const state = snapshot();
		const objective = objectiveMessage("Ship safely", state);
		const result = loadGoalFromBranch(
			[
				{
					type: "message",
					message: {
						role: "custom",
						customType: GOAL_OBJECTIVE_MESSAGE,
						content: objective.content,
						details: objective.details,
					},
				},
				{ type: "custom", customType: GOAL_STATE_ENTRY, data: state },
			],
			{ sessionId: "session-1", sessionFile: "/sessions/one.jsonl" },
		);
		assert.equal(result.kind, "loaded");
	});

	it("rejects tampered objectives and malformed metadata", () => {
		const state = snapshot();
		const tampered = loadGoalFromBranch(
			[
				{
					type: "custom_message",
					customType: GOAL_OBJECTIVE_MESSAGE,
					content: "Different objective",
					details: { goalId: state.owner.goalId, objectiveDigest: state.objectiveDigest },
				},
				{ type: "custom", customType: GOAL_STATE_ENTRY, data: state },
			],
			{ sessionId: "session-1", sessionFile: "/sessions/one.jsonl" },
		);
		assert.equal(tampered.kind, "invalid");

		const malformed = loadGoalFromBranch(
			[{ type: "custom", customType: GOAL_STATE_ENTRY, data: { version: 1, phase: "active" } }],
			{ sessionId: "session-1", sessionFile: "/sessions/one.jsonl" },
		);
		assert.equal(malformed.kind, "invalid");
	});

	it("does not inherit continuation authority across a fork or session switch", () => {
		const state = snapshot();
		const objective = objectiveMessage("Ship safely", state);
		const result = loadGoalFromBranch(
			[
				{ type: "custom_message", ...objective },
				{ type: "custom", customType: GOAL_STATE_ENTRY, data: state },
			],
			{ sessionId: "fork-session", sessionFile: "/sessions/fork.jsonl" },
		);
		assert.equal(result.kind, "foreign");
	});

	it("rejects malformed digests and cross-field lifecycle contradictions on save and restore", () => {
		const cases: Array<{ name: string; mutate(state: GoalSnapshot): void }> = [
			{
				name: "non-hex output digest",
				mutate: (state) => {
					firstWork(state).outputDigest = "not-a-digest";
				},
			},
			{
				name: "consumed output without consideration",
				mutate: (state) => {
					delete firstWork(state).considerationDigest;
				},
			},
			{
				name: "resolution attached to success",
				mutate: (state) => {
					firstWork(state).resolutionDigest = sha256("impossible");
				},
			},
			{
				name: "active work with consumed output",
				mutate: (state) => {
					firstWork(state).state = "running";
				},
			},
			{
				name: "duplicate item ID across attempts",
				mutate: (state) => {
					state.work.push({ ...structuredClone(firstWork(state)), attempt: 2 });
				},
			},
			{
				name: "review detached from ledger",
				mutate: (state) => {
					state.review = {
						itemId: "missing-review",
						verdict: "pass",
						workGeneration: state.workGeneration,
						findingsDigest: sha256("none"),
					};
				},
			},
			{
				name: "paused phase retains an impossible reservation",
				mutate: (state) => {
					state.phase = "paused";
					state.continuationSequence = 1;
					state.parentSettled = true;
					state.continuation = {
						status: "reserved",
						ticket: {
							goalId: state.owner.goalId,
							epoch: state.owner.epoch,
							sequence: 1,
							nonce: "continuation-token",
							expectedWorkGeneration: state.workGeneration,
							outputItemIds: [],
							kind: "automatic",
						},
					};
				},
			},
			{
				name: "queued continuation claims agent_end evidence",
				mutate: (state) => {
					state.continuationSequence = 1;
					state.parentSettled = false;
					state.currentRunEndObserved = true;
					state.continuation = {
						status: "queued",
						ticket: {
							goalId: state.owner.goalId,
							epoch: state.owner.epoch,
							sequence: 1,
							nonce: "continuation-token",
							expectedWorkGeneration: state.workGeneration,
							outputItemIds: [],
							kind: "automatic",
						},
					};
				},
			},
			{
				name: "continuation references missing output",
				mutate: (state) => {
					state.continuationSequence = 1;
					state.parentSettled = true;
					state.continuation = {
						status: "reserved",
						ticket: {
							goalId: state.owner.goalId,
							epoch: state.owner.epoch,
							sequence: 1,
							nonce: "continuation-token",
							expectedWorkGeneration: state.workGeneration,
							outputItemIds: ["missing-output"],
							kind: "automatic",
						},
					};
				},
			},
		];
		for (const entry of cases) {
			const state = consumedWorkSnapshot();
			entry.mutate(state);
			assert.throws(() => persistenceSnapshot(state), GoalInvariantError, `${entry.name}: save`);
			assert.equal(loadMutated(state).kind, "invalid", `${entry.name}: restore`);
		}
	});

	it("validates every persisted ledger field instead of trusting a cast", () => {
		const bad = structuredClone(snapshot()) as unknown as Record<string, unknown>;
		bad.work = [
			{
				itemId: "bad\nchannel",
				attempt: 1,
				provider: "pi-subagents",
				mode: "single",
				role: "work",
				label: "bad",
				state: "running",
				outputState: "awaiting",
				admittedAt: 100,
				workVersion: 1,
			},
		];
		assert.throws(() => persistenceSnapshot(bad as never), GoalInvariantError);
	});
});
