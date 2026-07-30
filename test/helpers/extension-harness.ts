import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerPiSubagentsGoal from "../../src/extension.ts";
import {
	SUBAGENT_DELEGATION_REQUEST,
	SUBAGENT_DELEGATION_RESPONSE,
	SUBAGENT_DELEGATION_STARTED,
	SUBAGENT_DELEGATION_VERSION,
	SUBAGENT_RPC_REPLY_PREFIX,
	SUBAGENT_RPC_REQUEST,
	SUBAGENT_RPC_VERSION,
	type EventBus,
	type ForegroundRequest,
	type ForegroundTerminal,
} from "../../src/subagents-bridge.ts";

export interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	terminate?: boolean;
}

interface RegisteredToolLike {
	name: string;
	sourcePath?: string;
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		ctx: ExtensionContext,
	): Promise<ToolResultLike>;
}

interface RegisteredCommandLike {
	name: string;
	handler(args: string, ctx: ExtensionContext): Promise<void> | void;
}

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

type ProviderHandler = (request: Record<string, unknown>, events: FakeEventBus) => void;

export class FakeEventBus implements EventBus {
	readonly #handlers = new Map<string, Set<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		const handlers = this.#handlers.get(channel) ?? new Set<(data: unknown) => void>();
		handlers.add(handler);
		this.#handlers.set(channel, handlers);
		return () => handlers.delete(handler);
	}

	emit(channel: string, data: unknown): void {
		for (const handler of [...(this.#handlers.get(channel) ?? [])]) handler(data);
	}
}

export interface HarnessOptions {
	sessionId?: string;
	sessionFile?: string | null;
	branch?: Array<Record<string, unknown>>;
	preexistingGoalCommand?: boolean;
	preexistingGoalTool?: string;
	sendMessageFailureAt?: number;
	provider?: ProviderHandler;
}

export interface Harness {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	events: FakeEventBus;
	branch: Array<Record<string, unknown>>;
	sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	notifications: Array<{ message: string; level: string }>;
	statuses: Map<string, string | undefined>;
	tools: Map<string, RegisteredToolLike>;
	commands: RegisteredCommandLike[];
	abortCount: () => number;
	emit(name: string, event: Record<string, unknown>): Promise<unknown[]>;
	start(reason?: "startup" | "resume" | "switch" | "fork" | "tree"): Promise<void>;
	settle(): Promise<void>;
	command(args: string): Promise<void>;
	callTool(name: string, params: unknown, toolCallId?: string): Promise<ToolResultLike>;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function defaultProvider(): ProviderHandler {
	return (request, events) => {
		const requestId = request.requestId;
		const ownerRunId = request.ownerRunId;
		const nodeId = request.nodeId;
		if (typeof requestId !== "string" || typeof ownerRunId !== "string" || typeof nodeId !== "string") return;
		const result = record(request.result);
		const terminalResult: ForegroundTerminal["result"] =
			result?.kind === "structured"
				? { kind: "structured", value: { verdict: "pass", findings: [] } }
				: { kind: "text", text: `completed:${String(request.task)}` };
		events.emit(SUBAGENT_DELEGATION_STARTED, {
			version: SUBAGENT_DELEGATION_VERSION,
			requestId,
			ownerRunId,
			nodeId,
			runId: `run-${nodeId}`,
		});
		const terminal: ForegroundTerminal = {
			requestId,
			ownerRunId,
			nodeId,
			status: "completed",
			runId: `run-${nodeId}`,
			result: terminalResult,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turns: 1,
				toolCalls: 0,
				durationMs: 1,
			},
		};
		events.emit(SUBAGENT_DELEGATION_RESPONSE, {
			version: SUBAGENT_DELEGATION_VERSION,
			...terminal,
		});
	};
}

export function createHarness(options: HarnessOptions = {}): Harness {
	const sessionId = options.sessionId ?? "session-harness";
	const sessionFile = options.sessionFile === undefined ? "/sessions/harness.jsonl" : options.sessionFile;
	const branch = options.branch ?? [];
	const events = new FakeEventBus();
	const sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const tools = new Map<string, RegisteredToolLike>();
	const commands: RegisteredCommandLike[] = [];
	const handlers = new Map<string, ExtensionHandler[]>();
	let aborts = 0;
	let idle = true;
	let toolSequence = 0;
	let sendAttempts = 0;
	let activeController: AbortController | undefined;

	if (options.preexistingGoalCommand) {
		commands.push({ name: "goal", handler: () => undefined });
	}
	if (options.preexistingGoalTool) {
		tools.set(options.preexistingGoalTool, {
			name: options.preexistingGoalTool,
			sourcePath: "/other/goal-extension.ts",
			execute: async () => ({ content: [{ type: "text", text: "preexisting" }] }),
		});
	}

	const ctx = {
		cwd: "/repo",
		hasUI: false,
		ui: {
			notify: (message: string, level = "info") => notifications.push({ message, level }),
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getBranch: () => branch,
		},
		isIdle: () => idle,
		abort: () => {
			aborts += 1;
			activeController?.abort();
		},
	} as unknown as ExtensionContext;

	const piObject = {
		events,
		registerTool: (tool: unknown) => {
			const candidate = tool as RegisteredToolLike;
			if (!tools.has(candidate.name))
				tools.set(candidate.name, { ...candidate, sourcePath: resolve("index.ts") });
		},
		registerCommand: (name: string, command: unknown) => {
			commands.push({ name, ...(command as Omit<RegisteredCommandLike, "name">) });
		},
		on: (name: string, handler: ExtensionHandler) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getAllTools: () =>
			[...tools.values()].map((tool) => ({
				name: tool.name,
				sourceInfo: { path: tool.sourcePath ?? resolve("index.ts") },
			})),
		getCommands: () => commands.map((command) => ({ name: command.name })),
		appendEntry: (customType: string, data: unknown) => {
			branch.push({ type: "custom", customType, data });
		},
		sendMessage: (message: Record<string, unknown>, sendOptions?: Record<string, unknown>) => {
			sendAttempts += 1;
			if (sendAttempts === options.sendMessageFailureAt) throw new Error("synthetic send failure");
			sentMessages.push({ message, ...(sendOptions ? { options: sendOptions } : {}) });
			branch.push({ type: "message", message: { role: "custom", ...message } });
		},
	} as unknown as ExtensionAPI;

	registerPiSubagentsGoal(piObject);

	events.on(SUBAGENT_RPC_REQUEST, (raw) => {
		const request = record(raw);
		if (!request || request.version !== SUBAGENT_RPC_VERSION || typeof request.requestId !== "string") return;
		events.emit(`${SUBAGENT_RPC_REPLY_PREFIX}${request.requestId}`, {
			version: SUBAGENT_RPC_VERSION,
			requestId: request.requestId,
			success: true,
			data: {
				version: SUBAGENT_RPC_VERSION,
				session: { sessionId, sessionFile },
				methods: ["ping", "spawn"],
				capabilities: {},
				events: {
					asyncComplete: "subagent:async-complete",
					processTerminal: "subagent:process-terminal",
				},
			},
		});
	});

	const provider = options.provider ?? defaultProvider();
	events.on(SUBAGENT_DELEGATION_REQUEST, (raw) => {
		const request = record(raw);
		if (request) provider(request, events);
	});

	const emit = async (name: string, event: Record<string, unknown>) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(name) ?? []) {
			results.push(await handler(event, ctx));
		}
		return results;
	};

	return {
		pi: piObject,
		ctx,
		events,
		branch,
		sentMessages,
		notifications,
		statuses,
		tools,
		commands,
		abortCount: () => aborts,
		emit,
		start: async (reason = "startup") => {
			await emit("session_start", { type: "session_start", reason });
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
		settle: async () => {
			const messages = branch.flatMap((entry) => {
				const message = entry.type === "message" ? record(entry.message) : undefined;
				return message ? [message] : [];
			});
			await emit("agent_end", { type: "agent_end", messages });
			await emit("agent_settled", { type: "agent_settled" });
		},
		command: async (args: string) => {
			const command = [...commands].reverse().find((candidate) => candidate.name === "goal");
			if (!command) throw new Error("/goal was not registered");
			await command.handler(args, ctx);
		},
		callTool: async (name: string, params: unknown, toolCallId = `tool-${++toolSequence}`) => {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Tool ${name} is not registered`);
			const input = record(params) ?? {};
			branch.push({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: toolCallId, name, arguments: input }],
				},
			});
			idle = false;
			activeController = new AbortController();
			try {
				const result = await tool.execute(toolCallId, params, activeController.signal, () => undefined, ctx);
				const event = {
					type: "tool_result",
					toolCallId,
					toolName: name,
					input,
					content: result.content,
					details: result.details,
					isError: false,
				};
				branch.push({ type: "message", message: { role: "toolResult", ...event } });
				await emit("tool_result", event);
				return result;
			} finally {
				activeController = undefined;
				idle = true;
			}
		},
	};
}

export function foregroundRequest(raw: Record<string, unknown>): ForegroundRequest {
	return raw as unknown as ForegroundRequest;
}
