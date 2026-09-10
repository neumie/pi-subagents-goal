import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	GOAL_STATE_ENTRY,
	loadGoalFromBranch,
	objectiveMessage,
	persistenceSnapshot,
	type SessionEntryLike,
} from "../src/persistence.ts";
import { GOAL_STATUS_EVENT, GOAL_STATUS_REQUEST_EVENT, type GoalStatusEnvelope } from "../src/status-api.ts";
import { boundedReviewText } from "../src/extension.ts";
import { GoalMachine, createGoalSnapshot, newAckToken, type OwnerIdentity } from "../src/state.ts";
import { createHarness, type Harness } from "./helpers/extension-harness.ts";

interface GoalIdentity {
	goalId: string;
	epoch: number;
	lineageId: string;
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
	assert.match(content, /Goal-owned subagent work and review are disabled/u);
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

function latestSnapshot(harness: Harness) {
	const loaded = loadGoalFromBranch(harness.branch as SessionEntryLike[], {
		sessionId: "session-harness",
		sessionFile: "/sessions/harness.jsonl",
	});
	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") throw new Error("Expected a loaded goal");
	return loaded.snapshot;
}

describe("bounded review rendering", () => {
	it("reserves item framing and acknowledgement tokens while truncating multibyte evidence safely", () => {
		const text = boundedReviewText({
			verdict: "fail",
			findings: [{ severity: "blocker", issue: "😀".repeat(20_000), rationale: "é".repeat(20_000) }],
			itemId: "review-item",
			ackToken: "review-token",
		});
		assert.ok(Buffer.byteLength(text, "utf8") <= 48_000);
		assert.match(text, /Review item: review-item/u);
		assert.match(text, /Acknowledgement token: review-token/u);
		assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
	});
});

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
		const completions = harness.commands
			.find((command) => command.name === "goal")
			?.getArgumentCompletions?.("");
		assert.ok(completions?.some((item) => item.value === "stop"));
		assert.ok(completions?.some((item) => item.value.startsWith("budget +")));
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
		assert.match(prompt, /goal-owned subagent and review tools are disabled/u);
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

	it("recovers /goal and clears providerError after a later clean session_start", async () => {
		const harness = createHarness({ preexistingGoalTool: "goal_done" });
		const statuses: GoalStatusEnvelope[] = [];
		harness.events.on(GOAL_STATUS_EVENT, (value) => statuses.push(value as GoalStatusEnvelope));
		await harness.start();
		assert.ok(statuses.at(-1)?.providerError);
		await assert.rejects(harness.command("blocked"), /namespace/u);

		harness.recoverManagedNamespace();
		harness.replaceBranch();
		await harness.start("resume");
		assert.equal(statuses.at(-1)?.providerError, undefined);
		await harness.command("recovered");
		assert.equal(latestSnapshot(harness).phase, "active");
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

	it("exposes explicit stop and persisted budget-increase controls", async () => {
		const harness = createHarness();
		await startGoal(harness);

		await harness.command("budget +5");
		assert.equal(latestSnapshot(harness).budgetLimits.maxAutomaticTurns, 25);
		await harness.command("budget turns +1");
		assert.equal(latestSnapshot(harness).budgetLimits.maxAutomaticTurns, 26);
		await harness.command("budget no-progress +2");
		assert.equal(latestSnapshot(harness).budgetLimits.maxNoProgressTurns, 5);
		await assert.rejects(harness.command("budget +0"), /Usage: \/goal budget/u);
		await assert.rejects(harness.command("budget +9007199254740991"), /maximum safe integer/u);
		assert.equal(latestSnapshot(harness).budgetLimits.maxAutomaticTurns, 26);

		await harness.command("stop");
		assert.equal(latestSnapshot(harness).phase, "cancelled");
		assert.equal(latestSnapshot(harness).continuation, undefined);
		await assert.rejects(harness.command("resume"), /No live \/goal/u);
		assert.equal(harness.sentMessages.length, 2);
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

	it("rejects owned subagent work and review before compatibility or ledger changes", async () => {
		const harness = createHarness({ provider: null });
		const owner = await startGoal(harness);
		const sentBefore = harness.sentMessages.length;
		for (const [toolName, params] of [
			["goal_subagent", { agent: "worker", task: "work" }],
			["goal_review", { focus: "correctness" }],
		] as const) {
			await assert.rejects(
				harness.callTool(toolName, { ...params, goalId: owner.goalId, epoch: owner.epoch }),
				/hard child-turn limits|required by this goal contract/u,
			);
		}
		assert.equal(harness.sentMessages.length, sentBefore);
		assert.equal(latestSnapshot(harness).work.length, 0);
		assert.equal(latestSnapshot(harness).workGeneration, 0);
		assert.equal(harness.rpcRequestCount(), 0);
		assert.equal(harness.providerRequestCount(), 0);
	});
});

describe("disabled goal-owned execution", () => {
	it("rejects repeated valid subagent and review calls without changing authority", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness, "Direct-only goal");
		const before = latestSnapshot(harness);
		const sentBefore = harness.sentMessages.length;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			for (const [toolName, extra] of [
				["goal_subagent", { agent: "worker", task: "must not launch" }],
				["goal_review", { focus: "must not launch" }],
			] as const) {
				await assert.rejects(
					harness.callTool(toolName, { goalId: owner.goalId, epoch: owner.epoch, ...extra }),
					/hard child-turn limits/u,
				);
			}
		}
		const after = latestSnapshot(harness);
		assert.deepEqual(after.work, before.work);
		assert.deepEqual(after.budgetUsage, before.budgetUsage);
		assert.deepEqual(after.budgetLimits, before.budgetLimits);
		assert.deepEqual(after.continuation, before.continuation);
		assert.equal(after.owner.epoch, before.owner.epoch);
		assert.equal(after.phase, before.phase);
		assert.equal(after.workGeneration, before.workGeneration);
		assert.equal(harness.sentMessages.length, sentBefore);
		assert.equal(harness.rpcRequestCount(), 0);
		assert.equal(harness.providerRequestCount(), 0);
	});

	it("rejects foreign calls and malformed direct execution before provider probing", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness);
		const before = latestSnapshot(harness);
		for (const input of [
			{ goalId: `${owner.goalId}-foreign`, epoch: owner.epoch, agent: "worker", task: "no" },
			{ goalId: owner.goalId, epoch: owner.epoch + 1, agent: "worker", task: "no" },
			{ goalId: owner.goalId, epoch: owner.epoch, task: 42 },
		]) {
			await assert.rejects(
				harness.callTool("goal_subagent", input as never),
				/Goal ID|hard child-turn|invalid/u,
			);
		}
		assert.deepEqual(latestSnapshot(harness).work, before.work);
		assert.deepEqual(latestSnapshot(harness).budgetUsage, before.budgetUsage);
		assert.equal(latestSnapshot(harness).workGeneration, before.workGeneration);
		assert.equal(harness.sentMessages.length, 2);
		assert.equal(harness.rpcRequestCount(), 0);
		assert.equal(harness.providerRequestCount(), 0);
	});

	it("keeps direct goals fully usable without pi-subagents", async () => {
		const harness = createHarness();
		await startGoal(harness, "Complete directly");
		await markInitialTurnRunning(harness);
		await harness.settle();
		assert.equal(harness.sentMessages.length, 3);
		await markLatestGoalTurnRunning(harness);
		await harness.callTool("goal_done", {
			goalId: identity(harness).goalId,
			epoch: identity(harness).epoch,
			summary: "Completed directly",
			consideredItemIds: [],
		});
		assert.equal(latestSnapshot(harness).phase, "completed");
	});
});

function historicalLedgerBranch(): {
	branch: Array<Record<string, unknown>>;
	owner: OwnerIdentity;
	tokens: string[];
} {
	const owner: OwnerIdentity = {
		sessionId: "session-harness",
		sessionFile: "/sessions/harness.jsonl",
		lineageId: "historical-lineage",
		goalId: "historical-goal",
		epoch: 1,
	};
	const machine = new GoalMachine(createGoalSnapshot({ owner, objective: "Historical goal", now: 1 }));
	const tokens: string[] = [];
	for (const [itemId, outcome] of [
		["historical-success", "succeeded"],
		["historical-failure", "failed"],
	] as const) {
		machine.admitWork({ itemId, mode: "single", role: "work", label: itemId, now: 2 });
		machine.startWork(owner, itemId, 3);
		const ackToken = newAckToken();
		tokens.push(ackToken);
		machine.terminalWork({ owner, itemId, outcome, output: `${itemId} output`, ackToken, now: 4 });
	}
	machine.markOutputSurfaced(owner, ["historical-success", "historical-failure"], 5);
	const state = machine.snapshot;
	return {
		owner,
		tokens,
		branch: [
			{ type: "custom_message", ...objectiveMessage("Historical goal", state) },
			{ type: "custom", customType: GOAL_STATE_ENTRY, data: persistenceSnapshot(state) },
		],
	};
}

// Owned launch/review calls remain intentionally unexercised: the current public provider
// boundary rejects them before adapter dispatch. These tests use legitimate historical
// persisted fixtures and current lifecycle APIs to cover retained adapter behavior.
describe("historical owned-output adapter behavior", () => {
	it("persists a valid acknowledgement batch and explicit historical resolution", async () => {
		const fixture = historicalLedgerBranch();
		const harness = createHarness({ branch: fixture.branch, provider: null });
		await harness.start("resume");
		await assert.rejects(
			harness.callTool("goal_ack_output", {
				goalId: fixture.owner.goalId,
				epoch: fixture.owner.epoch,
				items: [
					{ itemId: "historical-success", ackToken: fixture.tokens[0], consideration: "kept" },
					{ itemId: "historical-failure", ackToken: "wrong", consideration: "rejected" },
				],
			}),
			/acknowledgement was rejected/u,
		);
		assert.deepEqual(
			latestSnapshot(harness).work.map((item) => item.outputState),
			["surfaced", "surfaced"],
		);
		await harness.callTool("goal_ack_output", {
			goalId: fixture.owner.goalId,
			epoch: fixture.owner.epoch,
			items: [
				{ itemId: "historical-success", ackToken: fixture.tokens[0], consideration: "kept" },
				{ itemId: "historical-failure", ackToken: fixture.tokens[1], consideration: "reviewed" },
			],
		});
		await harness.callTool("goal_resolve", {
			goalId: fixture.owner.goalId,
			epoch: fixture.owner.epoch,
			itemId: "historical-failure",
			rationale: "Failure is recorded and not treated as success.",
		});
		const snapshot = latestSnapshot(harness);
		assert.deepEqual(
			snapshot.work.map((item) => item.outputState),
			["consumed", "consumed"],
		);
		assert.equal(snapshot.work[1]?.resolutionDigest !== undefined, true);
		assert.equal(snapshot.workGeneration, 3);
		assert.equal(harness.providerRequestCount(), 0);
		assert.equal(harness.rpcRequestCount(), 0);
	});

	it("blocks compaction while persisted output remains unread", async () => {
		const fixture = historicalLedgerBranch();
		const harness = createHarness({ branch: fixture.branch, provider: null });
		await harness.start("resume");
		assert.deepEqual(await harness.emit("session_before_compact", { type: "session_before_compact" }), [
			{ cancel: true },
		]);
		assert.equal(latestSnapshot(harness).work[0]?.outputState, "surfaced");
	});
});

describe("continuation delivery and completion races", () => {
	it("ignores a foreign turn before starting the exact queued continuation", async () => {
		const harness = createHarness({ provider: null });
		await startGoal(harness);
		const continuation = harness.sentMessages.at(-1)?.message;
		assert.ok(continuation);
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("message_start", {
			type: "message_start",
			message: { role: "custom", customType: "foreign", content: "foreign" },
		});
		await harness.emit("turn_end", { type: "turn_end", message: { usage: { output: 99 } }, toolResults: [] });
		assert.equal(latestSnapshot(harness).continuation?.status, "queued");
		assert.equal(latestSnapshot(harness).budgetUsage.tokens, 0);
		await harness.emit("message_start", {
			type: "message_start",
			message: { role: "custom", ...continuation },
		});
		assert.equal(latestSnapshot(harness).continuation?.status, "running");
		assert.equal(harness.providerRequestCount(), 0);
	});

	it("rejects a foreign goal_done before the queued continuation message starts", async () => {
		const harness = createHarness();
		const owner = await startGoal(harness);
		await assert.rejects(
			() =>
				harness.callTool("goal_done", {
					goalId: owner.goalId,
					epoch: owner.epoch,
					summary: "foreign",
					consideredItemIds: [],
				}),
			/reserved or queued/u,
		);
		assert.equal(latestSnapshot(harness).phase, "active");
	});

	it("faults once when a void sendMessage delivery is dropped without throwing", async () => {
		const harness = createHarness();
		await startGoal(harness);
		await harness.emit("agent_settled", { type: "agent_settled" });
		const snapshot = latestSnapshot(harness);
		assert.equal(snapshot.phase, "faulted");
		assert.match(snapshot.faultReason ?? "", /unobserved/u);
		assert.equal(harness.sentMessages.length, 2);
	});

	it("permits an empty agent_end only after locally observing the exact continuation message", async () => {
		const harness = createHarness();
		await startGoal(harness);
		await markInitialTurnRunning(harness);
		await harness.emit("agent_end", { type: "agent_end", messages: [] });
		assert.notEqual(latestSnapshot(harness).phase, "faulted");
		await harness.emit("agent_settled", { type: "agent_settled" });
		assert.notEqual(latestSnapshot(harness).phase, "faulted");
	});

	it("faults rather than treating an ordinary foreign settlement as delivery of a queued continuation", async () => {
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
		assert.equal(afterForeign.phase, "faulted");
		assert.match(afterForeign.faultReason ?? "", /unobserved/u);
		assert.equal(afterForeign.budgetUsage.tokens, 0);
		assert.equal(harness.sentMessages.length, 2);
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

	it("pauses an interrupted parent turn instead of dispatching another continuation", async () => {
		const harness = createHarness();
		await startGoal(harness);
		await markInitialTurnRunning(harness);
		const interrupted = {
			role: "assistant",
			content: [],
			stopReason: "aborted",
			usage: { output: 0 },
		};
		await harness.emit("turn_end", {
			type: "turn_end",
			message: interrupted,
			toolResults: [],
		});
		const messages = harness.branch.flatMap((entry) =>
			entry.type === "message" ? [record(entry.message)] : [],
		);
		await harness.emit("agent_end", { type: "agent_end", messages: [...messages, interrupted] });
		await harness.emit("agent_settled", { type: "agent_settled" });

		const snapshot = latestSnapshot(harness);
		assert.equal(snapshot.phase, "paused");
		assert.match(snapshot.pauseReason ?? "", /interrupted/u);
		assert.equal(snapshot.continuation, undefined);
		assert.equal(harness.sentMessages.length, 2, "an interrupted goal must not continue itself");
	});

	it("lets an interrupt pause before the aborted turn can exhaust the no-progress budget", async () => {
		const harness = createHarness();
		await startGoal(harness);
		await markInitialTurnRunning(harness);
		await harness.settle();
		assert.equal(harness.sentMessages.length, 3);
		await markLatestGoalTurnRunning(harness);

		const unchanged = {
			role: "assistant",
			content: [{ type: "text", text: "still waiting" }],
			usage: { output: 1 },
		};
		for (let turn = 0; turn < 3; turn += 1) {
			await harness.emit("turn_end", { type: "turn_end", message: unchanged, toolResults: [] });
		}
		assert.equal(latestSnapshot(harness).budgetUsage.noProgressTurns, 2);

		const interrupted = {
			role: "assistant",
			content: [],
			stopReason: "aborted",
			usage: { output: 0 },
		};
		await harness.emit("turn_end", { type: "turn_end", message: interrupted, toolResults: [] });
		const messages = harness.branch.flatMap((entry) =>
			entry.type === "message" ? [record(entry.message)] : [],
		);
		await harness.emit("agent_end", { type: "agent_end", messages: [...messages, interrupted] });
		await harness.emit("agent_settled", { type: "agent_settled" });

		const snapshot = latestSnapshot(harness);
		assert.equal(snapshot.phase, "paused");
		assert.equal(snapshot.budgetUsage.automaticTurns, 3);
		assert.equal(snapshot.budgetUsage.noProgressTurns, 2);
		assert.equal(harness.sentMessages.length, 3);
	});

	it("does not let an uncorrelated abort bypass continuation identity", async () => {
		const harness = createHarness();
		await startGoal(harness);
		await markInitialTurnRunning(harness);
		const interrupted = {
			role: "assistant",
			content: [],
			stopReason: "aborted",
			usage: { output: 0 },
		};
		await harness.emit("turn_end", {
			type: "turn_end",
			message: interrupted,
			toolResults: [],
		});
		await harness.emit("agent_end", { type: "agent_end", messages: [interrupted] });
		await harness.emit("agent_settled", { type: "agent_settled" });

		const snapshot = latestSnapshot(harness);
		assert.equal(snapshot.phase, "faulted");
		assert.match(snapshot.faultReason ?? "", /continuation nonce/u);
		assert.equal(harness.sentMessages.length, 2);
	});

	it("faults paired stale end and settlement after the next continuation starts", async () => {
		const harness = createHarness({ provider: null });
		await startGoal(harness);
		const first = harness.sentMessages.at(-1)?.message;
		assert.ok(first);
		await markLatestGoalTurnRunning(harness);
		await harness.emit("agent_end", { type: "agent_end", messages: [] });
		await harness.emit("agent_settled", { type: "agent_settled" });
		const second = harness.sentMessages.at(-1)?.message;
		assert.ok(second);
		await markLatestGoalTurnRunning(harness);
		await harness.emit("agent_end", { type: "agent_end", messages: [{ role: "custom", ...first }] });
		await harness.emit("agent_settled", { type: "agent_settled" });
		assert.equal(latestSnapshot(harness).phase, "faulted");
		assert.match(latestSnapshot(harness).faultReason ?? "", /continuation nonce/u);
		assert.equal(harness.sentMessages.length, 3);
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

	it("clears delivery nonces on pause, cancel, and shutdown so stale settlements cannot fault recovery", async () => {
		for (const action of ["pause", "cancel", "shutdown"] as const) {
			const harness = createHarness();
			await startGoal(harness);
			if (action === "shutdown") {
				await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
			} else {
				await harness.command(action);
			}
			await harness.emit("agent_settled", { type: "agent_settled" });
			const snapshot = latestSnapshot(harness);
			assert.notEqual(snapshot.phase, "faulted", `${action} left a stale delivery nonce`);
		}
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
