import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GoalSubagentRunner, type ForegroundPort } from "../src/foreground-runner.ts";
import type { ForegroundRequest, ForegroundTerminal } from "../src/subagents-bridge.ts";
import { GoalMachine, createGoalSnapshot, type OwnerIdentity } from "../src/state.ts";

function owner(): OwnerIdentity {
	return {
		sessionId: "session-1",
		sessionFile: "/sessions/one.jsonl",
		lineageId: "lineage-1",
		goalId: "goal-1",
		epoch: 1,
	};
}

function setup(port: ForegroundPort) {
	const machine = new GoalMachine(createGoalSnapshot({ owner: owner(), objective: "Finish", now: 100 }));
	let id = 0;
	let token = 0;
	let changes = 0;
	const runner = new GoalSubagentRunner({
		port,
		machine: () => machine,
		onStateChange: () => {
			changes += 1;
		},
		now: () => 200 + changes,
		newId: () => `item-${++id}`,
		newToken: () => `token-${++token}`,
	});
	return { machine, runner, changes: () => changes };
}

function completed(request: ForegroundRequest, text = request.task): ForegroundTerminal {
	return {
		requestId: `request-${request.nodeId}`,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
		status: "completed",
		runId: `run-${request.nodeId}`,
		result: { kind: "text", text },
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 1,
			toolCalls: 1,
			durationMs: 10,
		},
	};
}

describe("GoalSubagentRunner", () => {
	it("runs a foreground single through delegation V2 and returns acknowledgement evidence", async () => {
		const port: ForegroundPort = {
			runForeground: async (request, _signal, callbacks) => {
				callbacks?.onStarted?.("request-1");
				return completed(request, "implemented safely");
			},
		};
		const { machine, runner } = setup(port);
		const result = await runner.run({ agent: "worker", task: "Implement" }, undefined, "/repo");

		assert.equal(result.mode, "single");
		assert.equal(result.items[0]?.state, "succeeded");
		assert.equal(result.items[0]?.ackToken, "token-1");
		assert.match(result.text, /implemented safely/);
		assert.match(result.text, /Acknowledgement tokens \(never truncated\):\n- item-1: token-1/u);
		assert.equal(machine.snapshot.work[0]?.outputState, "pending_surface");
		assert.equal(machine.snapshot.budgetUsage.tokens, 15);
	});

	it("bounds multibyte aggregate output by UTF-8 bytes without truncating acknowledgement tokens", async () => {
		const port: ForegroundPort = {
			runForeground: async (request, _signal, callbacks) => {
				callbacks?.onStarted?.("request-emoji");
				return completed(request, "😀".repeat(20_000));
			},
		};
		const { runner } = setup(port);
		const result = await runner.run({ agent: "worker", task: "unicode" }, undefined, "/repo");
		assert.ok(Buffer.byteLength(result.text, "utf8") <= 48_000);
		assert.match(result.text, /item-1: token-1/u);
		assert.match(result.text, /Output truncated/u);
	});

	it("admits every parallel child before any execution and respects bounded concurrency", async () => {
		let active = 0;
		let maxActive = 0;
		let machineRef: GoalMachine | undefined;
		const port: ForegroundPort = {
			runForeground: async (request, _signal, callbacks) => {
				assert.equal(machineRef?.snapshot.work.length, 3);
				active += 1;
				maxActive = Math.max(maxActive, active);
				callbacks?.onStarted?.(`request-${request.nodeId}`);
				await new Promise<void>((resolve) => setImmediate(resolve));
				active -= 1;
				return completed(request, request.agent);
			},
		};
		const { machine, runner } = setup(port);
		machineRef = machine;
		const result = await runner.run(
			{
				tasks: [
					{ agent: "a", task: "A" },
					{ agent: "b", task: "B" },
					{ agent: "c", task: "C" },
				],
				concurrency: 2,
			},
			undefined,
			"/repo",
		);
		assert.equal(result.items.length, 3);
		assert.equal(maxActive, 2);
		assert.ok(result.items.every((item) => item.state === "succeeded"));
	});

	it("substitutes chain output and marks later steps stopped after failure", async () => {
		const seenTasks: string[] = [];
		let calls = 0;
		const port: ForegroundPort = {
			runForeground: async (request, _signal, callbacks) => {
				calls += 1;
				seenTasks.push(request.task);
				callbacks?.onStarted?.(`request-${calls}`);
				if (calls === 1) return completed(request, "first-output");
				return {
					requestId: "request-2",
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
					status: "failed",
					error: "second failed",
				};
			},
		};
		const { machine, runner } = setup(port);
		const result = await runner.run(
			{
				chain: [
					{ agent: "one", task: "first" },
					{ agent: "two", task: "use {previous}" },
					{ agent: "three", task: "never starts" },
				],
			},
			undefined,
			"/repo",
		);
		assert.deepEqual(seenTasks, ["first", "use first-output"]);
		assert.deepEqual(
			result.items.map((item) => item.state),
			["succeeded", "failed", "stopped"],
		);
		assert.equal(machine.snapshot.work[2]?.state, "stopped");
		assert.match(result.items[2]?.output ?? "", /Skipped/);
	});

	it("turns bridge failures into explicit failed terminal work instead of orphaning it", async () => {
		const port: ForegroundPort = {
			runForeground: async () => {
				throw new Error("bridge broke");
			},
		};
		const { machine, runner } = setup(port);
		const result = await runner.run({ agent: "worker", task: "work" }, undefined, "/repo");
		assert.equal(result.items[0]?.state, "failed");
		assert.match(result.items[0]?.output ?? "", /bridge broke/);
		assert.equal(machine.snapshot.work[0]?.state, "failed");
	});

	it("records schema-valid independent review bound to the current work generation", async () => {
		const port: ForegroundPort = {
			runForeground: async (request, _signal, callbacks) => {
				callbacks?.onStarted?.("request-review");
				return {
					...completed(request),
					result: {
						kind: "structured",
						value: { verdict: "pass", findings: [] },
					},
				};
			},
		};
		const { machine, runner } = setup(port);
		const review = await runner.review({
			focus: "races",
			objective: "Finish",
			toolCallId: "tool-review",
			signal: undefined,
			cwd: "/repo",
		});
		assert.equal(review.verdict, "pass");
		assert.equal(review.reviewToken, "token-2");
		assert.equal(machine.snapshot.review?.itemId, "item-1");
		assert.equal(machine.snapshot.review?.workGeneration, 0);
	});

	it("refuses review until prior output is consumed and unsuccessful work is resolved", async () => {
		const port: ForegroundPort = {
			runForeground: async (request) => completed(request),
		};
		const { runner } = setup(port);
		await runner.run({ agent: "worker", task: "work" }, undefined, "/repo");
		await assert.rejects(
			() =>
				runner.review({
					focus: "all",
					objective: "Finish",
					toolCallId: "review",
					signal: undefined,
					cwd: "/repo",
				}),
			/unresolved work/,
		);
	});
});
