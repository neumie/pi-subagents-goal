import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	GOAL_COORDINATION_VERSION,
	SUBAGENT_DELEGATION_CANCEL,
	SUBAGENT_DELEGATION_REQUEST,
	SUBAGENT_DELEGATION_RESPONSE,
	SUBAGENT_DELEGATION_STARTED,
	SUBAGENT_DELEGATION_UPDATE,
	SUBAGENT_RPC_REPLY_PREFIX,
	SUBAGENT_RPC_REQUEST,
	SubagentBridge,
	SubagentBridgeError,
	delegationStatusToWorkState,
	terminalOutput,
	type EventBus,
	type ForegroundRequest,
	type SubagentCompatibility,
} from "../src/subagents-bridge.ts";
import type { OwnerIdentity } from "../src/state.ts";

class FakeEvents implements EventBus {
	readonly emitted: Array<{ channel: string; data: unknown }> = [];
	readonly #handlers = new Map<string, Set<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		const handlers = this.#handlers.get(channel) ?? new Set();
		handlers.add(handler);
		this.#handlers.set(channel, handlers);
		return () => handlers.delete(handler);
	}

	emit(channel: string, data: unknown): void {
		this.emitted.push({ channel, data });
		for (const handler of [...(this.#handlers.get(channel) ?? [])]) handler(data);
	}
}

function foregroundRequest(): ForegroundRequest {
	return {
		ownerRunId: "session-1:lineage-1:goal-1:1",
		nodeId: "node-1",
		agent: "reviewer",
		task: "Review the implementation",
		context: "fresh",
		cwd: "/repo",
		timeoutMs: 1_000,
		turnBudget: { maxTurns: 10, graceTurns: 2 },
		result: { kind: "text" },
	};
}

function owner(): OwnerIdentity {
	return {
		sessionId: "session-1",
		sessionFile: "/sessions/one.jsonl",
		lineageId: "lineage-1",
		goalId: "goal-1",
		epoch: 1,
	};
}

describe("pi-subagents compatibility probe", () => {
	it("validates the exact session and reports absent goal coordination", async () => {
		const events = new FakeEvents();
		events.on(SUBAGENT_RPC_REQUEST, (raw) => {
			const request = raw as { requestId: string };
			events.emit(`${SUBAGENT_RPC_REPLY_PREFIX}${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				method: "ping",
				success: true,
				data: {
					version: 1,
					methods: ["ping", "status", "spawn"],
					events: {
						asyncComplete: "subagent:async-complete",
						processTerminal: "subagent:process-terminal",
					},
					capabilities: { asyncSpawn: true },
					session: { sessionId: "session-1", sessionFile: "/sessions/one.jsonl" },
				},
			});
		});
		const bridge = new SubagentBridge(events);

		const compatibility = await bridge.probe({ sessionId: "session-1", sessionFile: "/sessions/one.jsonl" });

		assert.equal(compatibility.available, true);
		assert.equal(compatibility.sessionMatches, true);
		assert.equal(compatibility.goalCoordination, undefined);
		assert.equal(compatibility.asyncCompleteEvent, "subagent:async-complete");
		bridge.dispose();
	});

	it("fails closed when ping belongs to another session", async () => {
		const events = new FakeEvents();
		events.on(SUBAGENT_RPC_REQUEST, (raw) => {
			const request = raw as { requestId: string };
			events.emit(`${SUBAGENT_RPC_REPLY_PREFIX}${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				success: true,
				data: {
					version: 1,
					methods: ["ping"],
					capabilities: {},
					events: {},
					session: { sessionId: "other", sessionFile: "/sessions/other.jsonl" },
				},
			});
		});
		const bridge = new SubagentBridge(events);
		const compatibility = await bridge.probe({ sessionId: "session-1", sessionFile: "/sessions/one.jsonl" });
		assert.equal(compatibility.sessionMatches, false);
		assert.match(compatibility.reason ?? "", /different Pi session/);
		bridge.dispose();
	});

	it("uses a bounded timeout when pi-subagents is absent", async () => {
		const bridge = new SubagentBridge(new FakeEvents());
		const compatibility = await bridge.probe({ sessionId: "session-1", sessionFile: null }, 10);
		assert.equal(compatibility.available, false);
		assert.match(compatibility.reason ?? "", /timed out/);
		bridge.dispose();
	});
});

describe("foreground delegation V2", () => {
	it("correlates started, updates, and terminal output by the full tuple", async () => {
		const events = new FakeEvents();
		const updates: string[] = [];
		events.on(SUBAGENT_DELEGATION_REQUEST, (raw) => {
			const request = raw as Record<string, unknown>;
			const identity = {
				version: 2,
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				nodeId: request.nodeId,
			};
			events.emit(SUBAGENT_DELEGATION_STARTED, identity);
			events.emit(SUBAGENT_DELEGATION_UPDATE, { ...identity, runId: "run-1", currentTool: "read" });
			events.emit(SUBAGENT_DELEGATION_RESPONSE, {
				...identity,
				status: "completed",
				runId: "run-1",
				result: { kind: "text", text: "review complete" },
			});
		});
		const bridge = new SubagentBridge(events);

		const terminal = await bridge.runForeground(foregroundRequest(), undefined, {
			onStarted: () => updates.push("started"),
			onUpdate: (update) => updates.push(`${update.runId}:${update.currentTool}`),
		});

		assert.deepEqual(updates, ["started", "run-1:read"]);
		assert.equal(terminal.status, "completed");
		assert.equal(terminalOutput(terminal), "review complete");
		assert.equal(delegationStatusToWorkState(terminal.status), "succeeded");
		bridge.dispose();
	});

	it("ignores stale responses with only a matching request ID", async () => {
		const events = new FakeEvents();
		events.on(SUBAGENT_DELEGATION_REQUEST, (raw) => {
			const request = raw as Record<string, unknown>;
			events.emit(SUBAGENT_DELEGATION_RESPONSE, {
				version: 2,
				requestId: request.requestId,
				ownerRunId: "stale-owner",
				nodeId: request.nodeId,
				status: "completed",
				result: { kind: "text", text: "stale" },
			});
			queueMicrotask(() =>
				events.emit(SUBAGENT_DELEGATION_RESPONSE, {
					version: 2,
					requestId: request.requestId,
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
					status: "completed",
					result: { kind: "text", text: "owned" },
				}),
			);
		});
		const bridge = new SubagentBridge(events);
		const terminal = await bridge.runForeground(foregroundRequest(), undefined);
		assert.equal(terminalOutput(terminal), "owned");
		bridge.dispose();
	});

	it("rejects terminal responses that omit either owned V2 identity", async () => {
		const events = new FakeEvents();
		events.on(SUBAGENT_DELEGATION_REQUEST, (raw) => {
			const request = raw as Record<string, unknown>;
			events.emit(SUBAGENT_DELEGATION_RESPONSE, {
				version: 2,
				requestId: request.requestId,
				nodeId: request.nodeId,
				status: "completed",
				result: { kind: "text", text: "missing-owner" },
			});
			events.emit(SUBAGENT_DELEGATION_RESPONSE, {
				version: 2,
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				status: "completed",
				result: { kind: "text", text: "missing-node" },
			});
			queueMicrotask(() =>
				events.emit(SUBAGENT_DELEGATION_RESPONSE, {
					version: 2,
					requestId: request.requestId,
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
					status: "completed",
					result: { kind: "text", text: "owned" },
				}),
			);
		});
		const bridge = new SubagentBridge(events);
		const terminal = await bridge.runForeground(foregroundRequest(), undefined);
		assert.equal(terminalOutput(terminal), "owned");
		bridge.dispose();
	});

	it("normalizes upstream invalid_request responses that omit unavailable identities", async () => {
		const events = new FakeEvents();
		events.on(SUBAGENT_DELEGATION_REQUEST, (raw) => {
			const request = raw as Record<string, unknown>;
			events.emit(SUBAGENT_DELEGATION_RESPONSE, {
				version: 2,
				requestId: request.requestId,
				status: "invalid_request",
				error: "invalid",
			});
		});
		const request = foregroundRequest();
		const bridge = new SubagentBridge(events);
		const terminal = await bridge.runForeground(request, undefined);
		assert.equal(terminal.status, "invalid_request");
		assert.equal(terminal.ownerRunId, request.ownerRunId);
		assert.equal(terminal.nodeId, request.nodeId);
		bridge.dispose();
	});

	it("rejects unknown terminal statuses before they can orphan runner work", async () => {
		const events = new FakeEvents();
		events.on(SUBAGENT_DELEGATION_REQUEST, (raw) => {
			const request = raw as Record<string, unknown>;
			events.emit(SUBAGENT_DELEGATION_RESPONSE, {
				version: 2,
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				nodeId: request.nodeId,
				status: "future_status",
			});
		});
		const bridge = new SubagentBridge(events);
		await assert.rejects(() => bridge.runForeground(foregroundRequest(), undefined), /unknown delegation/u);
		bridge.dispose();
	});

	it("cancels the exact V2 tuple when the parent signal aborts", async () => {
		const events = new FakeEvents();
		const controller = new AbortController();
		events.on(SUBAGENT_DELEGATION_REQUEST, () => controller.abort());
		const bridge = new SubagentBridge(events);
		await assert.rejects(
			() => bridge.runForeground(foregroundRequest(), controller.signal),
			SubagentBridgeError,
		);
		const cancel = events.emitted.find((entry) => entry.channel === SUBAGENT_DELEGATION_CANCEL)
			?.data as Record<string, unknown>;
		assert.equal(cancel.ownerRunId, foregroundRequest().ownerRunId);
		assert.equal(cancel.nodeId, foregroundRequest().nodeId);
		bridge.dispose();
	});

	it("maps every non-success terminal family explicitly", () => {
		assert.equal(delegationStatusToWorkState("failed"), "failed");
		assert.equal(delegationStatusToWorkState("timed_out"), "timed_out");
		assert.equal(delegationStatusToWorkState("cancelled"), "stopped");
		assert.equal(delegationStatusToWorkState("interrupted"), "interrupted");
		assert.equal(delegationStatusToWorkState("turn_budget_exhausted"), "budget_exhausted");
		assert.equal(delegationStatusToWorkState("structured_output_failed"), "failed");
	});
});

describe("future caller-owned completion capability", () => {
	it("rejects detached spawn when the installed contract does not advertise coordination", async () => {
		const bridge = new SubagentBridge(new FakeEvents());
		const compatibility: SubagentCompatibility = {
			available: true,
			sessionMatches: true,
			methods: ["spawn"],
		};
		await assert.rejects(
			() =>
				bridge.spawnCoordinated(compatibility, { owner: owner(), itemId: "async-1", attempt: 1, params: {} }),
			/missing|does not advertise|requires/u,
		);
		bridge.dispose();
	});

	it("uses only the advertised versioned channel when coordination exists", async () => {
		const events = new FakeEvents();
		const compatibility: SubagentCompatibility = {
			available: true,
			sessionMatches: true,
			methods: ["spawn"],
			goalCoordination: {
				version: GOAL_COORDINATION_VERSION,
				requestEvent: "custom:request",
				replyPrefix: "custom:reply:",
				event: "custom:event",
			},
		};
		events.on("custom:request", (raw) => {
			const request = raw as Record<string, unknown>;
			events.emit(`custom:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				success: true,
				data: {
					runId: "run-1",
					sessionId: "session-1",
					branchAnchorId: "leaf-1",
					lifecycleCursor: "cursor-1",
					generation: 1,
				},
			});
		});
		const bridge = new SubagentBridge(events);
		const reply = await bridge.spawnCoordinated(compatibility, {
			owner: owner(),
			itemId: "async-1",
			attempt: 1,
			params: { agent: "worker", task: "work" },
		});
		assert.equal(reply.runId, "run-1");
		assert.equal(
			events.emitted.some((entry) => entry.channel === SUBAGENT_RPC_REQUEST),
			false,
		);
		bridge.dispose();
	});
});
