import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	AgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadGoalFromBranch, type SessionEntryLike } from "../src/persistence.ts";

const cwd = resolve(import.meta.dirname, "..");
const model: Model<"openai-completions"> = {
	id: "faux-goal-model",
	name: "Faux goal model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "http://faux.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_000,
	maxTokens: 1_000,
};

function messageForGoal(source: unknown) {
	const text = JSON.stringify(source);
	const goalId = /goalId:\s*([a-f0-9-]{36})/u.exec(text)?.[1];
	const epoch = /epoch:\s*(\d+)/u.exec(text)?.[1];
	assert.ok(goalId);
	assert.ok(epoch);
	return {
		role: "assistant" as const,
		content: [
			{
				type: "toolCall" as const,
				id: "done-1",
				name: "goal_done",
				arguments: {
					goalId,
					epoch: Number(epoch),
					summary: "completed by faux provider",
					consideredItemIds: [],
				},
			},
		],
		api: "openai-completions" as const,
		provider: "openai" as const,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
}

describe("public Pi AgentSession goal lifecycle", () => {
	it("loads the real extension, completes one custom-trigger goal turn, and does not continue", async () => {
		let calls = 0;
		const temp = await mkdtemp(join(tmpdir(), "pi-goal-public-session-"));
		try {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir: temp,
				additionalExtensionPaths: [resolve(cwd, "index.ts")],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const manager = SessionManager.inMemory(cwd);
			const agent = new Agent({
				initialState: { systemPrompt: "", model, thinkingLevel: "off", tools: [] },
				streamFn: () => {
					calls += 1;
					const stream = createAssistantMessageEventStream();
					const message = messageForGoal(manager.getBranch());
					const partial = { ...message, content: [], stopReason: "pending" as const };
					const toolCall = message.content[0];
					if (toolCall?.type !== "toolCall") throw new Error("Missing faux goal_done call.");
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial });
					stream.push({
						type: "toolcall_end",
						contentIndex: 0,
						toolCall,
						partial: { ...message, stopReason: "pending" },
					});
					stream.push({ type: "done", reason: "toolUse", message });
					stream.end(message);
					return stream;
				},
			});
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settingsManager: SettingsManager.create(cwd, temp),
				cwd,
				resourceLoader: loader,
				modelRuntime: await ModelRuntime.create({ authPath: join(temp, "auth.json") }),
				initialActiveToolNames: [],
			});
			const events: Array<{ type: string; customType?: string; toolName?: string; isError?: boolean }> = [];
			session.subscribe((event) => {
				const candidate = event as unknown as {
					type: string;
					message?: { customType?: unknown };
					toolName?: unknown;
					isError?: unknown;
				};
				events.push({
					type: candidate.type,
					...(typeof candidate.message?.customType === "string"
						? { customType: candidate.message.customType }
						: {}),
					...(typeof candidate.toolName === "string" ? { toolName: candidate.toolName } : {}),
					...(typeof candidate.isError === "boolean" ? { isError: candidate.isError } : {}),
				});
			});
			await session.bindExtensions({ mode: "print" });
			await session.prompt("/goal finish directly");
			await session.waitForIdle();
			assert.equal(calls, 1);
			const agentStart = events.findIndex((event) => event.type === "agent_start");
			const continuationStart = events.findIndex(
				(event) => event.type === "message_start" && event.customType === "pi-subagents-goal/continuation-v1",
			);
			const goalDone = events.findIndex(
				(event) => event.type === "tool_execution_end" && event.toolName === "goal_done" && !event.isError,
			);
			const agentEnd = events.findIndex((event) => event.type === "agent_end");
			const settled = events.findIndex((event) => event.type === "agent_settled");
			assert.ok(agentStart >= 0, "agent_start was not emitted");
			assert.ok(
				continuationStart > agentStart,
				"the continuation custom message must start after agent_start",
			);
			assert.ok(goalDone > continuationStart, "goal_done must execute after the continuation message");
			assert.ok(agentEnd > goalDone, "agent_end must follow successful goal_done");
			assert.ok(settled > agentEnd, "agent_settled must follow agent_end");
			const loaded = loadGoalFromBranch(manager.getBranch() as SessionEntryLike[], {
				sessionId: manager.getSessionId(),
				sessionFile: manager.getSessionFile() ?? null,
			});
			assert.equal(loaded.kind, "loaded");
			if (loaded.kind === "loaded") {
				assert.equal(loaded.snapshot.phase, "completed", loaded.snapshot.faultReason ?? "no fault reason");
				assert.equal(loaded.snapshot.continuation, undefined);
			}
			assert.equal(session.isIdle, true);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(calls, 1, "no continuation or second model run may occur after goal_done");
			session.dispose();
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	});
});
