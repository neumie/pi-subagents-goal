import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	GOAL_STATUS_PROTOCOL_VERSION,
	createGoalStatusEnvelope,
	isGoalStatusRequest,
} from "../src/status-api.ts";
import { GoalMachine, createGoalSnapshot } from "../src/state.ts";

const NOW = 1_700_000_000_000;

function machine(): GoalMachine {
	return new GoalMachine(
		createGoalSnapshot({
			owner: {
				sessionId: "session-private",
				sessionFile: "/sessions/private.jsonl",
				lineageId: "lineage-private",
				goalId: "goal-private",
				epoch: 2,
			},
			objective: "Verify the status API",
			now: NOW,
		}),
	);
}

describe("goal status API", () => {
	it("publishes display-safe state without ownership capabilities", () => {
		const target = machine();
		target.admitWork({
			itemId: "private-item-id",
			mode: "single",
			role: "work",
			label: "Inspect compatibility",
			now: NOW + 1,
		});
		const status = createGoalStatusEnvelope({
			providerId: "provider-1",
			sequence: 3,
			sessionId: "session-private",
			objective: "Verify the status API",
			snapshot: target.snapshot,
		});

		assert.equal(status.version, GOAL_STATUS_PROTOCOL_VERSION);
		assert.equal(status.goal?.phase, "active");
		assert.equal(status.goal?.objective, "Verify the status API");
		assert.equal(status.goal?.work.active, 1);
		assert.equal(status.goal?.work.items[0]?.label, "Inspect compatibility");
		assert.equal(status.goal?.budget.limits.maxTokens, null);
		assert.equal(status.goal?.budget.limits.maxWallClockMs, null);
		const serialized = JSON.stringify(status);
		for (const secret of ["/sessions/private.jsonl", "lineage-private", "goal-private", "private-item-id"]) {
			assert.doesNotMatch(serialized, new RegExp(secret.replaceAll("/", "\\/"), "u"));
		}
	});

	it("bounds ledger rows and omits the internal progress digest", () => {
		const target = machine();
		for (let index = 0; index < 130; index += 1) {
			target.admitWork({
				itemId: `private-${index}`,
				mode: "parallel",
				role: "work",
				label: `Task ${index}`,
				now: NOW + index + 1,
			});
		}
		const snapshot = target.snapshot;
		snapshot.budgetUsage.lastProgressSignature = "private-progress-digest";
		const status = createGoalStatusEnvelope({
			providerId: "provider-1",
			sequence: 4,
			sessionId: "session-private",
			objective: "Bound the status",
			snapshot,
		});
		assert.equal(status.goal?.work.items.length, 128);
		assert.equal(status.goal?.work.itemsOmitted, 2);
		assert.doesNotMatch(JSON.stringify(status), /private-progress-digest/u);
	});

	it("keeps status v1 valid when an advisory review fails before completion", () => {
		const target = machine();
		target.admitWork({
			itemId: "advisory-review",
			mode: "single",
			role: "review",
			label: "Advisory review",
			now: NOW + 1,
		});
		target.startWork(target.snapshot.owner, "advisory-review", NOW + 2);
		const ackToken = "advisory-ack-token";
		target.terminalWork({
			owner: target.snapshot.owner,
			itemId: "advisory-review",
			outcome: "succeeded",
			output: "Found a concern",
			ackToken,
			now: NOW + 3,
		});
		target.recordReview({
			owner: target.snapshot.owner,
			itemId: "advisory-review",
			verdict: "fail",
			workGeneration: target.snapshot.workGeneration,
			findings: "Advisory concern",
			now: NOW + 4,
		});
		target.markOutputSurfaced(target.snapshot.owner, ["advisory-review"], NOW + 5);
		target.acknowledgeOutput({
			owner: target.snapshot.owner,
			itemId: "advisory-review",
			ackToken,
			consideration: "Considered the advisory concern",
			now: NOW + 6,
		});
		assert.equal(
			target.complete({
				owner: target.snapshot.owner,
				consideredItemIds: ["advisory-review"],
				now: NOW + 7,
			}).ok,
			true,
		);

		const status = createGoalStatusEnvelope({
			providerId: "provider-1",
			sequence: 5,
			sessionId: "session-private",
			objective: "Verify advisory status",
			snapshot: target.snapshot,
		});
		assert.equal(status.version, 1);
		assert.equal(status.goal?.phase, "completed");
		assert.equal(status.goal?.live, false);
		assert.equal(status.goal?.review, "fail");
	});

	it("represents an idle provider and bounds provider errors", () => {
		const status = createGoalStatusEnvelope({
			providerId: "provider-1",
			sequence: 1,
			sessionId: "session-1",
			providerError: "x".repeat(2_000),
		});
		assert.equal(status.goal, null);
		assert.equal(status.providerError?.length, 1_000);
	});

	it("accepts only bounded session-scoped replay requests", () => {
		assert.equal(isGoalStatusRequest({ version: 1, sessionId: "session-1" }), true);
		assert.equal(isGoalStatusRequest({ version: 2, sessionId: "session-1" }), false);
		assert.equal(isGoalStatusRequest({ version: 1, sessionId: "" }), false);
		assert.equal(isGoalStatusRequest({ version: 1, sessionId: "x".repeat(1_025) }), false);
		assert.equal(
			isGoalStatusRequest(
				new Proxy(
					{},
					{
						get: () => {
							throw new Error("hostile payload");
						},
					},
				),
			),
			false,
		);
	});
});
