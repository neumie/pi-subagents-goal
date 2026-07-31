import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	GOAL_STATE_ENTRY,
	GOAL_TOOL_DETAILS_VERSION,
	loadGoalFromBranch,
	type SessionEntryLike,
} from "../src/persistence.ts";
import { GOAL_STATUS_EVENT, GOAL_STATUS_REQUEST_EVENT, type GoalStatusEnvelope } from "../src/status-api.ts";
import {
	SUBAGENT_DELEGATION_RESPONSE,
	SUBAGENT_DELEGATION_STARTED,
	SUBAGENT_DELEGATION_VERSION,
} from "../src/subagents-bridge.ts";
import { createHarness, type Harness, type ToolResultLike } from "./helpers/extension-harness.ts";

interface GoalIdentity {
	goalId: string;
	epoch: number;
	lineageId: string;
}

interface GoalResultDetails extends GoalIdentity {
	version: 2;
	itemIds: string[];
	acknowledgements: Array<{ itemId: string; ackToken: string }>;
	verdict?: "pass" | "fail";
}

function record(value: unknown): Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

function identity(harness: Harness): GoalIdentity {
	const message = harness.sentMessages[0]?.message;
	assert.ok(message);
	const details = record(message.details);
	const { goalId, epoch, lineageId } = details;
	if (typeof goalId !== "string" || typeof epoch !== "number" || typeof lineageId !== "string") {
		throw new TypeError("Goal objective message did not carry a valid ownership tuple.");
	}
	return { goalId, epoch, lineageId };
}

function details(result: ToolResultLike): GoalResultDetails {
	const value = record(result.details);
	assert.equal(value.version, GOAL_TOOL_DETAILS_VERSION);
	assert.equal(typeof value.goalId, "string");
	assert.equal(typeof value.epoch, "number");
	assert.equal(typeof value.lineageId, "string");
	assert.ok(Array.isArray(value.itemIds));
	assert.ok(Array.isArray(value.acknowledgements));
	return value as unknown as GoalResultDetails;
}

async function startGoal(harness: Harness, objective = "Complete safely"): Promise<GoalIdentity> {
	await harness.start();
	await harness.command(objective);
	assert.equal(harness.sentMessages.length, 2);
	const owner = identity(harness);
	assert.equal(harness.sentMessages[0]?.options?.triggerTurn, undefined);
	assert.equal(harness.sentMessages[1]?.options?.triggerTurn, true);
	const content = String(harness.sentMessages[1]?.message.content);
	assert.ok(content.includes(`goalId: ${owner.goalId}`));
	assert.ok(content.includes(`epoch: ${owner.epoch}`));
	assert.match(content, /Work directly with ordinary tools/u);
	assert.match(content, /goal_review are optional/u);
	assert.doesNotMatch(content, /prose-free goal_ack_output-only turn/u);
	return owner;
}

async function markLatestGoalTurnRunning(harness: Harness): Promise<void> {
	const message = harness.sentMessages.at(-1)?.message;
	assert.ok(message);
	await harness.emit("agent_start", { type: "agent_start" });
	await harness.emit("message_start", {
		type: "message_start",
		message: { role: "custom", ...message },
	});
}

const markInitialTurnRunning = markLatestGoalTurnRunning;

async function acknowledge(harness: Harness, owner: GoalIdentity, result: GoalResultDetails): Promise<void> {
	await harness.callTool("goal_ack_output", {
		goalId: owner.goalId,
		epoch: owner.epoch,
		items: result.acknowledgements.map((item) => ({
			...item,
			consideration: `Considered ${item.itemId} and incorporated its evidence.`,
		})),
	});
}

function latestSnapshot(harness: Harness) {
	const loaded = loadGoalFromBranch(harness.branch as SessionEntryLike[], {
		sessionId: "session-harness",
		sessionFile: "/sessions/harness.jsonl",
	});
	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") throw new Error("Expected a loaded goal");
	return loaded.snapshot;
}

describe("Pi extension registration and ownership", () => {
	it("solely registers /goal and the five goal-owned tools", async () => {
		const harness = createHarness();
		assert.deepEqual([...harness.tools.keys()].sort(), [
			"goal_ack_output",
			"goal_done",
			"goal_resolve",
			"goal_review",
			"goal_subagent",
		]);
		assert.equal(harness.commands.filter((command) => command.name === "goal").length, 1);
		const doneSchema = record(record(harness.tools.get("goal_done")).parameters);
		const doneProperties = record(doneSchema.properties);
		assert.equal("reviewToken" in doneProperties, true);
		assert.equal(Array.isArray(doneSchema.required) && doneSchema.required.includes("reviewToken"), false);
		await harness.start();
	});

	it("surfaces exact identity and optional pi-subagents guidance to the parent", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness);
		const rewrites = await harness.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: String(harness.sentMessages.at(-1)?.message.content ?? ""),
			systemPrompt: "BASE",
		});
		const rewrite = record(rewrites.find((value) => value !== undefined));
		const prompt = String(rewrite.systemPrompt);
		assert.ok(prompt.includes(`Goal ID: ${owner.goalId}`));
		assert.ok(prompt.includes(`Goal epoch: ${owner.epoch}`));
		assert.match(prompt, /Work directly with ordinary tools/u);
		assert.match(prompt, /pi-subagents and its goal-owned tools are optional/u);
		assert.match(prompt, /No review token is required/u);
		assert.doesNotMatch(prompt, /Direct subagent calls are blocked/u);
	});

	it("fails closed on a preexisting command or tool namespace", async () => {
		const commandConflict = createHarness({ preexistingGoalCommand: true });
		await commandConflict.start();
		await assert.rejects(commandConflict.command("objective"), /namespace|Another extension/u);
		assert.equal(commandConflict.sentMessages.length, 0);
		assert.deepEqual(commandConflict.notifications, []);

		const toolConflict = createHarness({ preexistingGoalTool: "goal_done" });
		await toolConflict.start();
		await assert.rejects(toolConflict.command("objective"), /namespace.*(?:active|conflict)/u);
		assert.equal(toolConflict.sentMessages.length, 0);
		assert.deepEqual(toolConflict.notifications, []);
	});

	it("publishes session-scoped status without writing Pi UI", async () => {
		const harness = createHarness();
		const statuses: GoalStatusEnvelope[] = [];
		harness.events.on(GOAL_STATUS_EVENT, (value) => statuses.push(value as GoalStatusEnvelope));

		await harness.start();
		assert.equal(statuses.at(-1)?.goal, null);
		await harness.command("Status API smoke");
		const active = statuses.at(-1);
		assert.equal(active?.sessionId, "session-harness");
		assert.equal(active?.goal?.phase, "active");
		assert.equal(active?.goal?.objective, "Status API smoke");
		assert.equal(active?.goal?.budget.limits.maxTokens, null);
		assert.equal(active?.goal?.budget.limits.maxWallClockMs, null);

		const count = statuses.length;
		harness.events.emit(GOAL_STATUS_REQUEST_EVENT, { version: 1, sessionId: "foreign" });
		harness.events.emit(
			GOAL_STATUS_REQUEST_EVENT,
			new Proxy(
				{},
				{
					get: () => {
						throw new Error("bad");
					},
				},
			),
		);
		assert.equal(statuses.length, count);
		harness.events.emit(GOAL_STATUS_REQUEST_EVENT, { version: 1, sessionId: "session-harness" });
		assert.equal(statuses.length, count + 1);
		assert.equal(statuses.at(-1)?.sequence, active?.sequence);

		await harness.command("status");
		assert.ok((statuses.at(-1)?.sequence ?? 0) > (active?.sequence ?? 0));
		assert.deepEqual(harness.notifications, []);
		assert.equal(harness.statuses.size, 0);
	});

	it("does not intercept ordinary subagent or other tool calls", async () => {
		const harness = createHarness();
		await startGoal(harness);
		for (const toolName of ["subagent", "read"]) {
			const results = await harness.emit("tool_call", {
				type: "tool_call",
				toolCallId: `direct-${toolName}`,
				toolName,
				input: {},
			});
			assert.deepEqual(results, []);
		}
	});

	it("requires exact goal and epoch identity on goal_subagent", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness);
		await assert.rejects(
			() =>
				harness.callTool("goal_subagent", {
					goalId: `${owner.goalId}-stale`,
					epoch: owner.epoch,
					agent: "worker",
					task: "work",
				}),
			/Goal ID or epoch/u,
		);
		assert.equal(latestSnapshot(harness).work.length, 0);
	});
});

describe("foreground goal flow", () => {
	it("optionally runs owned work and review before completing", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness, "Implement and verify");
		await markInitialTurnRunning(harness);

		const work = details(
			await harness.callTool(
				"goal_subagent",
				{
					goalId: owner.goalId,
					epoch: owner.epoch,
					agent: "worker",
					task: "Implement the change",
				},
				"work-call",
			),
		);
		assert.equal(work.itemIds.length, 1);
		assert.equal(latestSnapshot(harness).work[0]?.outputState, "surfaced");
		await acknowledge(harness, owner, work);
		assert.equal(latestSnapshot(harness).work[0]?.outputState, "consumed");

		const review = details(
			await harness.callTool(
				"goal_review",
				{ goalId: owner.goalId, epoch: owner.epoch, focus: "correctness and races" },
				"review-call",
			),
		);
		assert.equal(review.verdict, "pass");
		assert.equal("reviewToken" in review, false);
		await acknowledge(harness, owner, review);

		const done = await harness.callTool(
			"goal_done",
			{
				goalId: owner.goalId,
				epoch: owner.epoch,
				summary: "Implemented with optional independent advice.",
				consideredItemIds: [...work.itemIds, ...review.itemIds],
			},
			"done-call",
		);
		assert.equal(done.terminate, true);
		assert.match(done.content[0]?.text ?? "", /Goal complete/u);
		assert.equal(latestSnapshot(harness).phase, "completed");

		const directAfterCompletion = await harness.emit("tool_call", {
			type: "tool_call",
			toolCallId: "after",
			toolName: "subagent",
			input: {},
		});
		assert.deepEqual(directAfterCompletion, []);
	});

	it("applies batched output acknowledgements atomically", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness);
		await markInitialTurnRunning(harness);
		const work = details(
			await harness.callTool("goal_subagent", {
				goalId: owner.goalId,
				epoch: owner.epoch,
				tasks: [
					{ agent: "one", task: "one" },
					{ agent: "two", task: "two" },
				],
			}),
		);
		await assert.rejects(
			() =>
				harness.callTool("goal_ack_output", {
					goalId: owner.goalId,
					epoch: owner.epoch,
					items: [
						{ ...work.acknowledgements[0], consideration: "first" },
						{ ...work.acknowledgements[1], ackToken: "wrong", consideration: "second" },
					],
				}),
			/acknowledgement was rejected/u,
		);
		assert.deepEqual(
			latestSnapshot(harness).work.map((item) => item.outputState),
			["surfaced", "surfaced"],
		);
		await acknowledge(harness, owner, work);
		assert.deepEqual(
			latestSnapshot(harness).work.map((item) => item.outputState),
			["consumed", "consumed"],
		);
	});

	it("persists an in-flight child cancellation as an explicit terminal goal", async () => {
		let pending = false;
		const harness = createHarness({
			provider: () => {
				pending = true;
			},
		});
		const owner = await startGoal(harness);
		await markInitialTurnRunning(harness);
		const workPromise = harness.callTool("goal_subagent", {
			goalId: owner.goalId,
			epoch: owner.epoch,
			agent: "worker",
			task: "wait for cancellation",
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(pending, true);
		await harness.command("cancel");
		const result = details(await workPromise);
		assert.equal(result.itemIds.length, 1);
		const snapshot = latestSnapshot(harness);
		assert.equal(snapshot.phase, "cancelled");
		assert.equal(snapshot.work[0]?.state, "interrupted");
		assert.equal(snapshot.work[0]?.outputState, "surfaced");
	});

	it("rejects detached work before admission against current pi-subagents", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness);
		await assert.rejects(
			() =>
				harness.callTool("goal_subagent", {
					goalId: owner.goalId,
					epoch: owner.epoch,
					execution: "detached",
					agent: "worker",
					task: "background",
				}),
			/goalCoordination v1/u,
		);
		assert.equal(latestSnapshot(harness).work.length, 0);
	});

	it("starts and completes without contacting pi-subagents or requiring review", async () => {
		let providerCalls = 0;
		const harness = createHarness({
			provider: () => {
				providerCalls += 1;
			},
		});
		const owner = await startGoal(harness, "Complete directly");
		await markInitialTurnRunning(harness);
		const done = await harness.callTool("goal_done", {
			goalId: owner.goalId,
			epoch: owner.epoch,
			summary: "Completed directly with ordinary tools.",
			consideredItemIds: [],
		});
		assert.equal(done.terminate, true);
		assert.equal(latestSnapshot(harness).phase, "completed");
		assert.equal(providerCalls, 0);
		assert.equal(harness.rpcRequestCount(), 0);
	});

	it("keeps an optional review advisory after later ordinary work", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness);
		await markInitialTurnRunning(harness);
		const review = details(
			await harness.callTool("goal_review", { goalId: owner.goalId, epoch: owner.epoch }, "review-call"),
		);
		await acknowledge(harness, owner, review);
		harness.branch.push({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "Use this later evidence too." }] },
		});
		harness.branch.push({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "late-read", name: "read", arguments: {} }],
			},
		});
		const done = await harness.callTool("goal_done", {
			goalId: owner.goalId,
			epoch: owner.epoch,
			summary: "Completed after considering optional review and later evidence.",
			consideredItemIds: review.itemIds,
		});
		assert.equal(done.terminate, true);
		assert.equal(latestSnapshot(harness).phase, "completed");
	});
});

describe("continuation races", () => {
	it("starts the exact custom continuation after an earlier foreign turn", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness);
		const continuationMessage = harness.sentMessages.at(-1)?.message;
		assert.ok(continuationMessage);
		assert.equal(latestSnapshot(harness).continuation?.status, "queued");

		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("message_start", {
			type: "message_start",
			message: { role: "custom", customType: "subagent-notify", content: "foreign" },
		});
		await harness.emit("turn_end", {
			type: "turn_end",
			message: { usage: { output: 99 }, content: [{ type: "text", text: "foreign" }] },
			toolResults: [],
		});
		assert.equal(latestSnapshot(harness).continuation?.status, "queued");
		assert.equal(latestSnapshot(harness).budgetUsage.tokens, 0);

		await harness.emit("message_start", {
			type: "message_start",
			message: { role: "custom", ...continuationMessage },
		});
		assert.equal(latestSnapshot(harness).continuation?.status, "running");

		const result = details(
			await harness.callTool("goal_subagent", {
				goalId: owner.goalId,
				epoch: owner.epoch,
				agent: "reviewer",
				task: "Return OWNED_OK without tools or edits.",
			}),
		);
		assert.equal(result.itemIds.length, 1);
	});

	it("does not let an ordinary foreign turn consume a queued goal continuation", async () => {
		const harness = createHarness();
		await startGoal(harness);
		const queued = latestSnapshot(harness).continuation;
		assert.equal(queued?.status, "queued");

		const rewrites = await harness.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "An ordinary detached subagent completed.",
			systemPrompt: "BASE",
		});
		assert.deepEqual(rewrites, [undefined]);
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("turn_end", {
			type: "turn_end",
			message: { usage: { output: 99 }, content: [{ type: "text", text: "foreign" }] },
			toolResults: [],
		});
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "custom", customType: "subagent-notify", content: "done" }],
		});
		await harness.emit("agent_settled", { type: "agent_settled" });

		const afterForeign = latestSnapshot(harness);
		assert.equal(afterForeign.phase, "active");
		assert.equal(afterForeign.continuation?.status, "queued");
		assert.equal(afterForeign.budgetUsage.tokens, 0);
		assert.equal(harness.sentMessages.length, 2);

		await markLatestGoalTurnRunning(harness);
		assert.equal(latestSnapshot(harness).continuation?.status, "running");
	});

	it("counts only new parent output and leaves the token cap disabled", async () => {
		const harness = createHarness();
		await startGoal(harness);
		await markInitialTurnRunning(harness);
		await harness.emit("turn_end", {
			type: "turn_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "initial work" }],
				usage: {
					input: 1_100_000,
					output: 17,
					cacheRead: 900_000,
					totalTokens: 2_000_017,
				},
			},
			toolResults: [],
		});
		const snapshot = latestSnapshot(harness);
		assert.equal(snapshot.budgetUsage.tokens, 17);
		assert.equal(snapshot.budgetUsage.automaticTurns, 0);
		assert.equal(snapshot.budgetLimits.maxTokens, null);
		assert.equal(snapshot.phase, "active");
	});

	it("queues exactly one continuation when terminal output arrives before settlement", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness);
		await markInitialTurnRunning(harness);
		await harness.callTool("goal_subagent", {
			goalId: owner.goalId,
			epoch: owner.epoch,
			agent: "worker",
			task: "finish first",
		});
		assert.equal(harness.sentMessages.length, 2);
		await harness.settle();
		assert.equal(harness.sentMessages.length, 3);
		await harness.settle();
		assert.equal(harness.sentMessages.length, 3);
	});

	it("faults on paired stale agent_end and settlement after the next continuation starts", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness);
		await markInitialTurnRunning(harness);
		const work = details(
			await harness.callTool("goal_subagent", {
				goalId: owner.goalId,
				epoch: owner.epoch,
				agent: "worker",
				task: "finish",
			}),
		);
		await acknowledge(harness, owner, work);
		const staleMessages = harness.branch.flatMap((entry) =>
			entry.type === "message" ? [record(entry.message)] : [],
		);
		await harness.settle();
		assert.equal(harness.sentMessages.length, 3);
		await markLatestGoalTurnRunning(harness);
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("agent_end", { type: "agent_end", messages: staleMessages });
		await harness.emit("agent_settled", { type: "agent_settled" });
		assert.equal(harness.sentMessages.length, 3);
		const snapshot = latestSnapshot(harness);
		assert.equal(snapshot.phase, "faulted");
		assert.match(snapshot.faultReason ?? "", /continuation nonce/u);
	});

	it("faults without retry when Pi rejects a committed continuation", async () => {
		const harness = createHarness({ sendMessageFailureAt: 3 });
		await startGoal(harness);
		await markInitialTurnRunning(harness);
		await harness.settle();
		assert.equal(harness.sentMessages.length, 2);
		const snapshot = latestSnapshot(harness);
		assert.equal(snapshot.phase, "faulted");
		assert.match(snapshot.faultReason ?? "", /synthetic send failure/u);
	});

	it("queues exactly one output-bearing continuation when settlement wins the race", async () => {
		let pending: Record<string, unknown> | undefined;
		const harness = createHarness({
			provider: (request) => {
				pending = request;
			},
		});
		const owner = await startGoal(harness);
		await markInitialTurnRunning(harness);
		const workPromise = harness.callTool("goal_subagent", {
			goalId: owner.goalId,
			epoch: owner.epoch,
			agent: "worker",
			task: "finish later",
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.ok(pending);
		await harness.settle();
		assert.equal(harness.sentMessages.length, 2);

		const requestId = pending.requestId;
		const ownerRunId = pending.ownerRunId;
		const nodeId = pending.nodeId;
		assert.equal(typeof requestId, "string");
		assert.equal(typeof ownerRunId, "string");
		assert.equal(typeof nodeId, "string");
		harness.events.emit(SUBAGENT_DELEGATION_STARTED, {
			version: SUBAGENT_DELEGATION_VERSION,
			requestId,
			ownerRunId,
			nodeId,
		});
		harness.events.emit(SUBAGENT_DELEGATION_RESPONSE, {
			version: SUBAGENT_DELEGATION_VERSION,
			requestId,
			ownerRunId,
			nodeId,
			status: "completed",
			result: { kind: "text", text: `late-output:${"😀".repeat(20_000)}` },
		});
		const work = details(await workPromise);
		assert.equal(harness.sentMessages.length, 3);
		const continuationContent = String(harness.sentMessages[2]?.message.content);
		assert.match(continuationContent, /late-output/u);
		assert.match(continuationContent, /Output truncated/u);
		assert.ok(Buffer.byteLength(continuationContent, "utf8") <= 48_000);
		assert.ok(
			String(harness.sentMessages[2]?.message.content).includes(
				work.acknowledgements[0]?.ackToken ?? "missing",
			),
		);
		await harness.settle();
		assert.equal(harness.sentMessages.length, 3);
	});
});

describe("session lifecycle", () => {
	it("blocks switch, fork, and tree navigation while goal authority is live", async () => {
		const harness = createHarness();
		await startGoal(harness);
		for (const eventName of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
			const results = await harness.emit(eventName, { type: eventName });
			assert.deepEqual(results, [{ cancel: true }]);
		}
	});

	it("allows safe compaction but blocks it with unread output", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness);
		assert.deepEqual(await harness.emit("session_before_compact", { type: "session_before_compact" }), [
			undefined,
		]);
		await markInitialTurnRunning(harness);
		await harness.callTool("goal_subagent", {
			goalId: owner.goalId,
			epoch: owner.epoch,
			agent: "worker",
			task: "produce unread output",
		});
		assert.deepEqual(await harness.emit("session_before_compact", { type: "session_before_compact" }), [
			{ cancel: true },
		]);
	});

	it("fails closed when restore cannot prove whether a queued continuation was delivered", async () => {
		const branch: Array<Record<string, unknown>> = [];
		const first = createHarness({ branch });
		await startGoal(first);

		const restored = createHarness({ branch });
		await restored.start("resume");
		assert.equal(latestSnapshot(restored).phase, "faulted");
		assert.match(latestSnapshot(restored).faultReason ?? "", /delivery cannot be proven/u);
		await assert.rejects(restored.command("resume"), /cannot resume|No live|current phase/u);
		assert.deepEqual(restored.notifications, []);
		assert.equal(restored.sentMessages.length, 0);
	});

	it("pauses on shutdown, restores paused in the same session, and rejects forked authority", async () => {
		const branch: Array<Record<string, unknown>> = [];
		const first = createHarness({ branch });
		await startGoal(first);
		await first.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		assert.equal(latestSnapshot(first).phase, "paused");

		const restored = createHarness({ branch });
		await restored.start("resume");
		const direct = await restored.emit("tool_call", {
			type: "tool_call",
			toolCallId: "direct",
			toolName: "subagent",
			input: {},
		});
		assert.deepEqual(direct, []);
		await restored.command("resume");
		assert.equal(restored.sentMessages.length, 1);

		const forked = createHarness({ branch, sessionId: "fork-session", sessionFile: "/sessions/fork.jsonl" });
		await forked.start("fork");
		const unblocked = await forked.emit("tool_call", {
			type: "tool_call",
			toolCallId: "fork-direct",
			toolName: "subagent",
			input: {},
		});
		assert.deepEqual(unblocked, []);
		assert.deepEqual(forked.notifications, []);
	});

	it("persists only value-free coordination snapshots", async () => {
		const harness = createHarness();
		await startGoal(harness, "a secret objective value");
		const stateEntries = harness.branch.filter(
			(entry) => entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY,
		);
		assert.ok(stateEntries.length > 0);
		for (const entry of stateEntries) {
			assert.doesNotMatch(JSON.stringify(entry.data), /secret objective value/u);
		}
	});
});
