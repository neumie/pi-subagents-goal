import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GoalSubagentRunner, boundedChainExpansion, type ForegroundPort } from "../src/foreground-runner.ts";
import { GOAL_LIMITS } from "../src/limits.ts";
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

function setup(port: ForegroundPort, providedNow?: () => number) {
	const machine = new GoalMachine(createGoalSnapshot({ owner: owner(), objective: "Finish", now: 100 }));
	let id = 0;
	let token = 0;
	let changes = 0;
	const now = providedNow ?? (() => 200 + changes);
	const runner = new GoalSubagentRunner({
		port,
		machine: () => machine,
		onStateChange: () => {
			changes += 1;
		},
		now,
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
	it("derives the aggregate allowance from the public eight-item and turn/grace maxima", () => {
		assert.equal(
			GOAL_LIMITS.aggregateGroupTurnAllowance,
			GOAL_LIMITS.maxGroupItems * (GOAL_LIMITS.maxTurns + GOAL_LIMITS.hardGraceTurns),
		);
	});

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

	it("notifies persistence when work admission faults against a queued continuation", async () => {
		const port: ForegroundPort = {
			runForeground: async (request) => completed(request),
		};
		const { machine, runner, changes } = setup(port);
		machine.queueInitialContinuation(150);

		await assert.rejects(
			() => runner.run({ agent: "worker", task: "Must not launch" }, undefined, "/repo"),
			/New work appeared after a continuation was queued/u,
		);
		assert.equal(machine.snapshot.phase, "faulted");
		assert.equal(changes(), 1);
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

	it("passes a valid expanded chain task above the source-task limit to the bridge port", async () => {
		let calls = 0;
		const seen: number[] = [];
		const port: ForegroundPort = {
			runForeground: async (request, _signal, callbacks) => {
				calls += 1;
				seen.push(Buffer.byteLength(request.task, "utf8"));
				callbacks?.onStarted?.(`chain-${calls}`);
				return completed(request, calls === 1 ? "x".repeat(40_000) : "expanded");
			},
		};
		const { runner } = setup(port);
		const result = await runner.run(
			{
				chain: [
					{ agent: "one", task: "seed" },
					{ agent: "two", task: "{previous}".repeat(4) },
				],
			},
			undefined,
			"/repo",
		);
		assert.deepEqual(seen, [4, 160_000]);
		assert.deepEqual(
			result.items.map((item) => item.state),
			["succeeded", "succeeded"],
		);
		assert.throws(() => boundedChainExpansion("{previous}".repeat(4), "x".repeat(65_001)), /260000/u);
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

	it("rejects an oversized placeholder projection before admitting or expanding work", async () => {
		const port: ForegroundPort = { runForeground: async (request) => completed(request) };
		const { machine, runner } = setup(port);
		const task = "{previous}".repeat(10_000);
		await assert.rejects(
			() => runner.run({ chain: [{ agent: "worker", task }] }, undefined, "/repo"),
			/more than 4|Projected/u,
		);
		assert.equal(machine.snapshot.work.length, 0);
		assert.throws(() => boundedChainExpansion("{previous}".repeat(5), "x"), /at most 4/u);
	});

	it("terminalizes malformed provider responses instead of leaving admitted work active", async () => {
		const port: ForegroundPort = {
			runForeground: async () => undefined as unknown as ForegroundTerminal,
		};
		const { machine, runner } = setup(port);
		const result = await runner.run({ agent: "worker", task: "work" }, undefined, "/repo");
		assert.equal(result.items[0]?.state, "failed");
		assert.equal(machine.snapshot.work[0]?.state, "failed");
	});

	it("enforces UTF-8 task, group, and execution admission limits before provider calls", async () => {
		let calls = 0;
		const port: ForegroundPort = {
			runForeground: async (request, _signal, callbacks) => {
				calls += 1;
				callbacks?.onStarted?.(`request-${calls}`);
				return completed(request);
			},
		};
		const exactTask = "😀".repeat(25_000);
		const exact = setup(port);
		await exact.runner.run({ agent: "worker", task: exactTask, timeoutMs: 1_800_000 }, undefined, "/repo");
		assert.equal(calls, 1);
		assert.equal(exact.machine.snapshot.work.length, 1);

		for (const [params, expression] of [
			[{ agent: "worker", task: `${exactTask}x` }, /Task 1 exceeds/u],
			[{ agent: "worker", task: "work", timeoutMs: 1_800_001 }, /timeoutMs/u],
			[{ agent: "worker", task: "work", turnBudget: { maxTurns: 25 } }, /turnBudget.maxTurns/u],
			[
				{ agent: "worker", task: "work", turnBudget: { maxTurns: 24, graceTurns: 3 } },
				/turnBudget.graceTurns/u,
			],
			[{ tasks: Array.from({ length: 9 }, () => ({ agent: "worker", task: "work" })) }, /1-8 items/u],
			[{ tasks: Array.from({ length: 10_000 }, () => ({ agent: "worker", task: "x" })) }, /1-8 items/u],
		] as const) {
			const rejected = setup(port);
			await assert.rejects(() => rejected.runner.run(params, undefined, "/repo"), expression);
			assert.equal(rejected.machine.snapshot.work.length, 0);
		}
		assert.equal(calls, 1);

		const grouped = setup(port);
		await grouped.runner.run(
			{ tasks: Array.from({ length: 4 }, () => ({ agent: "worker", task: "x".repeat(100_000) })) },
			undefined,
			"/repo",
		);
		assert.equal(grouped.machine.snapshot.work.length, 4);
		assert.equal(calls, 5);
		const eight = setup(port);
		await eight.runner.run(
			{ tasks: Array.from({ length: 8 }, () => ({ agent: "worker", task: "small" })) },
			undefined,
			"/repo",
		);
		assert.equal(eight.machine.snapshot.work.length, 8);
		assert.equal(calls, 13);
		const sourceOver = setup(port);
		await assert.rejects(
			() =>
				sourceOver.runner.run(
					{ tasks: Array.from({ length: 5 }, () => ({ agent: "worker", task: "x".repeat(80_001) })) },
					undefined,
					"/repo",
				),
			/Source task group/u,
		);
		assert.equal(sourceOver.machine.snapshot.work.length, 0);
		assert.equal(calls, 13);

		const grace = setup(port);
		await grace.runner.run(
			{ agent: "worker", task: "grace zero", turnBudget: { maxTurns: 24, graceTurns: 0 } },
			undefined,
			"/repo",
		);
		await grace.runner.run(
			{ agent: "worker", task: "grace two", turnBudget: { maxTurns: 24, graceTurns: 2 } },
			undefined,
			"/repo",
		);
		assert.equal(calls, 15);
	});

	it("passes decreasing remaining timeout through a shared deadline and skips expired siblings", async () => {
		let now = 0;
		const timeouts: number[] = [];
		const port: ForegroundPort = {
			runForeground: async (request, _signal, callbacks) => {
				timeouts.push(request.timeoutMs);
				callbacks?.onStarted?.(`request-${request.nodeId}`);
				now = request.nodeId === "item-1" ? 8 : 11;
				return completed(request);
			},
		};
		const { machine, runner } = setup(port, () => now);
		const result = await runner.run(
			{
				chain: [
					{ agent: "one", task: "one" },
					{ agent: "two", task: "two" },
					{ agent: "three", task: "three" },
				],
				timeoutMs: 10,
			},
			undefined,
			"/repo",
		);
		assert.deepEqual(timeouts, [10, 2]);
		assert.deepEqual(
			result.items.map((item) => item.state),
			["succeeded", "succeeded", "timed_out"],
		);
		assert.equal(machine.snapshot.work[2]?.state, "timed_out");
	});

	it("terminalizes malformed direct ports during guarded terminal conversion and settles parallel siblings", async () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		const malformed = [
			undefined,
			{ status: "not-a-status" },
			{ status: "completed", result: { kind: "structured", value: cycle } },
			{
				status: "completed",
				result: { kind: "text", text: "ok" },
				usage: {
					input: 1,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 1,
					toolCalls: 0,
					durationMs: 1.5,
				},
			},
		] as const;
		let next = 0;
		const port: ForegroundPort = {
			runForeground: async () => malformed[next++] as unknown as ForegroundTerminal,
		};
		const { machine, runner } = setup(port);
		const result = await runner.run(
			{
				tasks: malformed.map((_, index) => ({ agent: `worker-${index}`, task: `task-${index}` })),
				concurrency: 4,
			},
			undefined,
			"/repo",
		);
		assert.ok(result.items.every((item) => item.state === "failed"));
		assert.ok(machine.snapshot.work.every((item) => item.state === "failed"));
		for (const response of [
			{ status: "completed", result: { kind: "text", text: undefined } },
			{ status: "completed", result: { kind: "text", text: 1n } },
		]) {
			const single = setup({ runForeground: async () => response as unknown as ForegroundTerminal });
			const terminal = await single.runner.run({ agent: "worker", task: "bad" }, undefined, "/repo");
			assert.equal(terminal.items[0]?.state, "failed");
			assert.equal(single.machine.snapshot.work[0]?.state, "failed");
		}
	});

	it("rejects inherited or accessor-backed review fields without invoking getters", async () => {
		const inherited = Object.create({ verdict: "pass", findings: [] });
		const accessor = Object.create(null) as Record<string, unknown>;
		let invoked = false;
		Object.defineProperty(accessor, "verdict", {
			get: () => {
				invoked = true;
				return "pass";
			},
			enumerable: false,
		});
		Object.defineProperty(accessor, "findings", { value: [], enumerable: true });
		for (const value of [inherited, accessor]) {
			const port: ForegroundPort = {
				runForeground: async (request, _signal, callbacks) => {
					callbacks?.onStarted?.("review");
					return { ...completed(request), result: { kind: "structured", value } };
				},
			};
			const { machine, runner } = setup(port);
			const review = await runner.review({
				focus: "safety",
				objective: "Finish",
				signal: undefined,
				cwd: "/repo",
			});
			assert.equal(review.verdict, "fail");
			assert.equal(machine.snapshot.review?.verdict, "fail");
		}
		assert.equal(invoked, false);
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
			signal: undefined,
			cwd: "/repo",
		});
		assert.equal(review.verdict, "pass");
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
					signal: undefined,
					cwd: "/repo",
				}),
			/unresolved work/,
		);
	});
});
