import { randomUUID } from "node:crypto";
import type { OwnerIdentity, TerminalWorkState } from "./state.ts";

export const SUBAGENT_RPC_VERSION = 1 as const;
export const SUBAGENT_RPC_REQUEST = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

export const SUBAGENT_DELEGATION_VERSION = 2 as const;
export const SUBAGENT_DELEGATION_REQUEST = "prompt-template:subagent:request";
export const SUBAGENT_DELEGATION_STARTED = "prompt-template:subagent:started";
export const SUBAGENT_DELEGATION_UPDATE = "prompt-template:subagent:update";
export const SUBAGENT_DELEGATION_RESPONSE = "prompt-template:subagent:response";
export const SUBAGENT_DELEGATION_CANCEL = "prompt-template:subagent:cancel";

export const GOAL_COORDINATION_VERSION = 1 as const;
export const GOAL_COORDINATION_REQUEST = "subagents:goal-coordination:v1:request";
export const GOAL_COORDINATION_REPLY_PREFIX = "subagents:goal-coordination:v1:reply:";
export const GOAL_COORDINATION_EVENT = "subagents:goal-coordination:v1:event";

const MAX_WIRE_ID_LENGTH = 256;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const MAX_BRIDGE_TIMEOUT_MS = 2_147_483_647;
const FOREGROUND_TERMINAL_STATUSES = new Set<ForegroundTerminal["status"]>([
	"completed",
	"failed",
	"timed_out",
	"cancelled",
	"interrupted",
	"turn_budget_exhausted",
	"tool_budget_exhausted",
	"structured_output_failed",
	"acceptance_failed",
	"invalid_request",
	"unavailable_context",
	"duplicate_node",
]);

export interface EventBus {
	on(channel: string, handler: (data: unknown) => void): (() => void) | undefined;
	emit(channel: string, data: unknown): void;
}

export interface BridgeTimers {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface SubagentCompatibility {
	available: boolean;
	protocolVersion?: number;
	sessionMatches: boolean;
	methods: string[];
	asyncCompleteEvent?: string;
	processTerminalEvent?: string;
	goalCoordination?: {
		version: 1;
		requestEvent: string;
		replyPrefix: string;
		event: string;
	};
	reason?: string;
}

export interface ForegroundRequest {
	ownerRunId: string;
	nodeId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	cwd: string;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	timeoutMs: number;
	turnBudget: { maxTurns: number; graceTurns?: number };
	result:
		| { kind: "text" }
		| {
				kind: "structured";
				schema: Record<string, unknown>;
		  };
}

export interface ForegroundUpdate {
	runId?: string;
	currentTool?: string;
	recentOutput?: string;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
}

export interface ForegroundTerminal {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	status:
		| "completed"
		| "failed"
		| "timed_out"
		| "cancelled"
		| "interrupted"
		| "turn_budget_exhausted"
		| "tool_budget_exhausted"
		| "structured_output_failed"
		| "acceptance_failed"
		| "invalid_request"
		| "unavailable_context"
		| "duplicate_node";
	runId?: string;
	agent?: string;
	model?: string;
	thinking?: string;
	exitCode?: number;
	error?: string;
	result?: { kind: "text"; text: string } | { kind: "structured"; value: unknown };
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
		toolCalls: number;
		durationMs: number;
	};
}

export interface ForegroundCallbacks {
	onStarted?(requestId: string): void;
	onUpdate?(update: ForegroundUpdate): void;
}

export interface CoordinatedSpawnRequest {
	owner: OwnerIdentity;
	itemId: string;
	attempt: number;
	params: Record<string, unknown>;
}

export interface CoordinatedSpawnReply {
	runId: string;
	sessionId: string;
	branchAnchorId: string;
	lifecycleCursor: string;
	generation: number;
}

export interface CoordinatedLifecycleEvent {
	version: 1;
	owner: OwnerIdentity;
	itemId: string;
	attempt: number;
	generation: number;
	cursor: string;
	state: "queued" | "running" | "paused" | "needs_attention" | "stopping" | TerminalWorkState;
	outputTicket?: string;
	output?: string;
}

export class SubagentBridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentBridgeError";
	}
}

function defaultTimers(): BridgeTimers {
	return {
		setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isForegroundTerminalStatus(value: unknown): value is ForegroundTerminal["status"] {
	return typeof value === "string" && FOREGROUND_TERMINAL_STATUSES.has(value as ForegroundTerminal["status"]);
}

function validWireId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_WIRE_ID_LENGTH &&
		value.trim() === value &&
		!/[\r\n\0]/u.test(value)
	);
}

function unsubscribe(disposer: (() => void) | undefined): void {
	if (typeof disposer === "function") disposer();
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function boundedTimeout(timeoutMs: number, overheadMs = 5_000): number {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
		throw new SubagentBridgeError("timeoutMs must be an integer >= 1.");
	return Math.min(MAX_BRIDGE_TIMEOUT_MS, timeoutMs + overheadMs);
}

export function delegationStatusToWorkState(status: ForegroundTerminal["status"]): TerminalWorkState {
	switch (status) {
		case "completed":
			return "succeeded";
		case "timed_out":
			return "timed_out";
		case "cancelled":
			return "stopped";
		case "interrupted":
			return "interrupted";
		case "turn_budget_exhausted":
		case "tool_budget_exhausted":
			return "budget_exhausted";
		case "failed":
		case "structured_output_failed":
		case "acceptance_failed":
		case "invalid_request":
		case "unavailable_context":
		case "duplicate_node":
			return "failed";
		default: {
			const exhaustive: never = status;
			throw new SubagentBridgeError(`Unknown foreground terminal status: ${String(exhaustive)}`);
		}
	}
}

export function terminalOutput(response: ForegroundTerminal): string {
	if (response.result?.kind === "text") return response.result.text;
	if (response.result?.kind === "structured") return JSON.stringify(response.result.value);
	return response.error ?? `pi-subagents ended with status ${response.status}`;
}

export class SubagentBridge {
	readonly #events: EventBus;
	readonly #timers: BridgeTimers;
	readonly #activeCancels = new Set<() => void>();
	#disposed = false;

	constructor(events: EventBus, timers: BridgeTimers = defaultTimers()) {
		this.#events = events;
		this.#timers = timers;
	}

	async probe(
		expected: { sessionId: string; sessionFile: string | null },
		timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
	): Promise<SubagentCompatibility> {
		this.#assertLive();
		const requestId = randomUUID();
		const replyChannel = `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`;
		return new Promise<SubagentCompatibility>((resolve) => {
			let settled = false;
			const finish = (result: SubagentCompatibility) => {
				if (settled) return;
				settled = true;
				this.#timers.clearTimeout(timer);
				unsubscribe(disposer);
				this.#activeCancels.delete(cancel);
				resolve(result);
			};
			const cancel = () =>
				finish({ available: false, sessionMatches: false, methods: [], reason: "Bridge disposed." });
			this.#activeCancels.add(cancel);
			const disposer = this.#events.on(replyChannel, (raw) => {
				if (!isRecord(raw) || raw.version !== SUBAGENT_RPC_VERSION || raw.requestId !== requestId) return;
				if (raw.success !== true || !isRecord(raw.data)) {
					finish({
						available: false,
						sessionMatches: false,
						methods: [],
						reason: "pi-subagents RPC ping failed.",
					});
					return;
				}
				const data = raw.data;
				const session = isRecord(data.session) ? data.session : {};
				const sessionMatches =
					session.sessionId === expected.sessionId && (session.sessionFile ?? null) === expected.sessionFile;
				const capabilities = isRecord(data.capabilities) ? data.capabilities : {};
				const events = isRecord(data.events) ? data.events : {};
				const coordination = isRecord(capabilities.goalCoordination)
					? capabilities.goalCoordination
					: undefined;
				const goalCoordination =
					coordination?.version === GOAL_COORDINATION_VERSION &&
					validWireId(coordination.requestEvent) &&
					validWireId(coordination.replyPrefix) &&
					validWireId(coordination.event)
						? {
								version: GOAL_COORDINATION_VERSION,
								requestEvent: coordination.requestEvent,
								replyPrefix: coordination.replyPrefix,
								event: coordination.event,
							}
						: undefined;
				finish({
					available: true,
					...(typeof data.version === "number" ? { protocolVersion: data.version } : {}),
					sessionMatches,
					methods: asStringArray(data.methods),
					...(typeof events.asyncComplete === "string" ? { asyncCompleteEvent: events.asyncComplete } : {}),
					...(typeof events.processTerminal === "string"
						? { processTerminalEvent: events.processTerminal }
						: {}),
					...(goalCoordination ? { goalCoordination } : {}),
					...(!sessionMatches ? { reason: "pi-subagents RPC belongs to a different Pi session." } : {}),
				});
			});
			const timer = this.#timers.setTimeout(
				() =>
					finish({
						available: false,
						sessionMatches: false,
						methods: [],
						reason: "pi-subagents RPC ping timed out.",
					}),
				timeoutMs,
			);
			this.#events.emit(SUBAGENT_RPC_REQUEST, {
				version: SUBAGENT_RPC_VERSION,
				requestId,
				method: "ping",
				source: { extension: "pi-subagents-goal" },
			});
		});
	}

	async runForeground(
		request: ForegroundRequest,
		signal: AbortSignal | undefined,
		callbacks: ForegroundCallbacks = {},
	): Promise<ForegroundTerminal> {
		this.#assertLive();
		for (const [field, value] of [
			["ownerRunId", request.ownerRunId],
			["nodeId", request.nodeId],
		] as const) {
			if (!validWireId(value)) throw new SubagentBridgeError(`${field} is not a valid wire identity.`);
		}
		const requestId = randomUUID();
		return new Promise<ForegroundTerminal>((resolve, reject) => {
			let settled = false;
			let started = false;
			const disposers: Array<(() => void) | undefined> = [];
			const cleanup = () => {
				for (const disposer of disposers) unsubscribe(disposer);
				this.#timers.clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.#activeCancels.delete(cancel);
			};
			const finish = (response: ForegroundTerminal) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(response);
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const identityMatches = (raw: Record<string, unknown>) =>
				raw.requestId === requestId && raw.ownerRunId === request.ownerRunId && raw.nodeId === request.nodeId;
			const cancel = () => {
				this.#events.emit(SUBAGENT_DELEGATION_CANCEL, {
					version: SUBAGENT_DELEGATION_VERSION,
					requestId,
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
				});
				fail(new SubagentBridgeError("Foreground delegation was disposed."));
			};
			this.#activeCancels.add(cancel);
			disposers.push(
				this.#events.on(SUBAGENT_DELEGATION_STARTED, (raw) => {
					if (
						!isRecord(raw) ||
						raw.version !== SUBAGENT_DELEGATION_VERSION ||
						!identityMatches(raw) ||
						started
					)
						return;
					started = true;
					callbacks.onStarted?.(requestId);
				}),
				this.#events.on(SUBAGENT_DELEGATION_UPDATE, (raw) => {
					if (!isRecord(raw) || raw.version !== SUBAGENT_DELEGATION_VERSION || !identityMatches(raw)) return;
					callbacks.onUpdate?.({
						...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
						...(typeof raw.currentTool === "string" ? { currentTool: raw.currentTool } : {}),
						...(typeof raw.recentOutput === "string" ? { recentOutput: raw.recentOutput } : {}),
						...(typeof raw.model === "string" ? { model: raw.model } : {}),
						...(typeof raw.toolCount === "number" ? { toolCount: raw.toolCount } : {}),
						...(typeof raw.durationMs === "number" ? { durationMs: raw.durationMs } : {}),
						...(typeof raw.tokens === "number" ? { tokens: raw.tokens } : {}),
					});
				}),
				this.#events.on(SUBAGENT_DELEGATION_RESPONSE, (raw) => {
					if (!isRecord(raw) || raw.version !== SUBAGENT_DELEGATION_VERSION || raw.requestId !== requestId)
						return;
					if (!isForegroundTerminalStatus(raw.status)) {
						fail(new SubagentBridgeError("pi-subagents returned an unknown delegation terminal status."));
						return;
					}
					const fullIdentity = raw.ownerRunId === request.ownerRunId && raw.nodeId === request.nodeId;
					const omittedInvalidRequestIdentity =
						raw.status === "invalid_request" &&
						(raw.ownerRunId === undefined || raw.ownerRunId === request.ownerRunId) &&
						(raw.nodeId === undefined || raw.nodeId === request.nodeId);
					if (!fullIdentity && !omittedInvalidRequestIdentity) return;
					finish({
						...(raw as unknown as ForegroundTerminal),
						ownerRunId: request.ownerRunId,
						nodeId: request.nodeId,
					});
				}),
			);
			const onAbort = () => {
				this.#events.emit(SUBAGENT_DELEGATION_CANCEL, {
					version: SUBAGENT_DELEGATION_VERSION,
					requestId,
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
				});
				fail(new SubagentBridgeError("Foreground delegation was aborted."));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const timer = this.#timers.setTimeout(() => {
				this.#events.emit(SUBAGENT_DELEGATION_CANCEL, {
					version: SUBAGENT_DELEGATION_VERSION,
					requestId,
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
				});
				fail(new SubagentBridgeError("Foreground delegation response timed out."));
			}, boundedTimeout(request.timeoutMs));
			if (signal?.aborted) {
				onAbort();
				return;
			}
			this.#events.emit(SUBAGENT_DELEGATION_REQUEST, {
				version: SUBAGENT_DELEGATION_VERSION,
				requestId,
				...request,
			});
		});
	}

	async spawnCoordinated(
		compatibility: SubagentCompatibility,
		request: CoordinatedSpawnRequest,
		timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
	): Promise<CoordinatedSpawnReply> {
		const coordination = compatibility.goalCoordination;
		if (!coordination || !compatibility.sessionMatches) {
			throw new SubagentBridgeError(
				"Detached goal-owned work requires pi-subagents goalCoordination v1; the installed extension does not advertise it.",
			);
		}
		return this.#coordinationRequest<CoordinatedSpawnReply>(coordination, "spawn", request, timeoutMs);
	}

	onCoordinatedLifecycle(
		compatibility: SubagentCompatibility,
		handler: (event: CoordinatedLifecycleEvent) => void,
	): () => void {
		const coordination = compatibility.goalCoordination;
		if (!coordination) return () => {};
		const disposer = this.#events.on(coordination.event, (raw) => {
			if (!isRecord(raw) || raw.version !== GOAL_COORDINATION_VERSION || !isRecord(raw.owner)) return;
			if (!validWireId(raw.itemId) || !validWireId(raw.cursor) || typeof raw.state !== "string") return;
			handler(raw as unknown as CoordinatedLifecycleEvent);
		});
		return typeof disposer === "function" ? disposer : () => {};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const cancel of [...this.#activeCancels]) cancel();
		this.#activeCancels.clear();
	}

	async #coordinationRequest<T>(
		coordination: NonNullable<SubagentCompatibility["goalCoordination"]>,
		method: string,
		params: unknown,
		timeoutMs: number,
	): Promise<T> {
		this.#assertLive();
		const requestId = randomUUID();
		const replyChannel = `${coordination.replyPrefix}${requestId}`;
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				this.#timers.clearTimeout(timer);
				unsubscribe(disposer);
				this.#activeCancels.delete(cancel);
			};
			const cancel = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new SubagentBridgeError("Goal coordination request was disposed."));
			};
			this.#activeCancels.add(cancel);
			const disposer = this.#events.on(replyChannel, (raw) => {
				if (!isRecord(raw) || raw.version !== GOAL_COORDINATION_VERSION || raw.requestId !== requestId)
					return;
				if (settled) return;
				settled = true;
				cleanup();
				if (raw.success !== true) {
					const message =
						isRecord(raw.error) && typeof raw.error.message === "string"
							? raw.error.message
							: "Goal coordination request failed.";
					reject(new SubagentBridgeError(message));
					return;
				}
				resolve(raw.data as T);
			});
			const timer = this.#timers.setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new SubagentBridgeError("Goal coordination request timed out."));
			}, timeoutMs);
			this.#events.emit(coordination.requestEvent, {
				version: GOAL_COORDINATION_VERSION,
				requestId,
				method,
				params,
			});
		});
	}

	#assertLive(): void {
		if (this.#disposed) throw new SubagentBridgeError("Subagent bridge is disposed.");
	}
}
