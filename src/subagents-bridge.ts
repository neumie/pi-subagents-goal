import { randomUUID } from "node:crypto";
import { GOAL_LIMITS } from "./limits.ts";
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
const MAX_OPTIONAL_STRING_BYTES = GOAL_LIMITS.maxTerminalResultBytes;
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

function boundedTimeout(timeoutMs: number, overheadMs = GOAL_LIMITS.bridgeCleanupMs): number {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
		throw new SubagentBridgeError("timeoutMs must be an integer >= 1.");
	return Math.min(MAX_BRIDGE_TIMEOUT_MS, timeoutMs + overheadMs);
}

function ownData(value: object, field: string): unknown {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		if (!descriptor) return undefined;
		if (!("value" in descriptor)) throw new SubagentBridgeError(`Malformed foreground terminal ${field}.`);
		return descriptor.value;
	} catch (error) {
		throw error instanceof SubagentBridgeError
			? error
			: new SubagentBridgeError(`Malformed foreground terminal ${field}.`);
	}
}

function boundedString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_OPTIONAL_STRING_BYTES) {
		throw new SubagentBridgeError(`Malformed foreground terminal ${field}.`);
	}
	return value;
}

function jsonStringBytes(value: string): number {
	let bytes = 2; // quotes
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (
			code === 0x22 ||
			code === 0x5c ||
			code === 0x08 ||
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0c ||
			code === 0x0d
		) {
			bytes += 2;
		} else if (
			code < 0x20 ||
			(code >= 0xd800 &&
				code <= 0xdbff &&
				!(value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff)) ||
			(code >= 0xdc00 && code <= 0xdfff)
		) {
			bytes += 6;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			index += 1;
		} else if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else {
			bytes += 3;
		}
		if (bytes > GOAL_LIMITS.maxTerminalResultBytes) return bytes;
	}
	return bytes;
}

function safeJsonValue(value: unknown): unknown {
	const seen = new Set<object>();
	const entries = { count: 0 };
	const bytes = { count: 0 };
	const addBytes = (amount: number) => {
		if (
			!Number.isSafeInteger(amount) ||
			amount < 0 ||
			bytes.count > GOAL_LIMITS.maxTerminalResultBytes - amount
		) {
			throw new SubagentBridgeError("Structured terminal result exceeds the UTF-8 limit.");
		}
		bytes.count += amount;
	};
	const copy = (candidate: unknown, depth: number): unknown => {
		if (depth > GOAL_LIMITS.maxJsonDepth)
			throw new SubagentBridgeError("Structured terminal result is too deep.");
		if (candidate === null) {
			addBytes(4);
			return null;
		}
		if (typeof candidate === "string") {
			addBytes(jsonStringBytes(candidate));
			return candidate;
		}
		if (typeof candidate === "boolean") {
			addBytes(candidate ? 4 : 5);
			return candidate;
		}
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate))
				throw new SubagentBridgeError("Structured terminal result contains a non-finite number.");
			addBytes(Buffer.byteLength(String(candidate), "utf8"));
			return candidate;
		}
		if (typeof candidate !== "object" || seen.has(candidate)) {
			throw new SubagentBridgeError("Structured terminal result is not plain JSON.");
		}
		seen.add(candidate);
		try {
			if (Array.isArray(candidate)) {
				const length = ownData(candidate, "length");
				if (
					typeof length !== "number" ||
					!Number.isSafeInteger(length) ||
					length < 0 ||
					length > GOAL_LIMITS.maxJsonEntries
				) {
					throw new SubagentBridgeError("Structured terminal result array length is unsafe.");
				}
				// JSON ignores named and symbol array properties; never enumerate them.
				addBytes(2);
				const result: unknown[] = [];
				for (let index = 0; index < length; index += 1) {
					const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
					if (!descriptor?.enumerable || !("value" in descriptor)) {
						throw new SubagentBridgeError("Structured terminal result contains a sparse array or accessor.");
					}
					if (++entries.count > GOAL_LIMITS.maxJsonEntries)
						throw new SubagentBridgeError("Structured terminal result has too many entries.");
					if (index > 0) addBytes(1);
					result.push(copy(descriptor.value, depth + 1));
				}
				return result;
			}
			const prototype = Object.getPrototypeOf(candidate);
			if (prototype !== Object.prototype && prototype !== null)
				throw new SubagentBridgeError("Structured terminal result has an exotic prototype.");
			addBytes(2);
			const result = Object.create(null) as Record<string, unknown>;
			let index = 0;
			for (const key of Reflect.ownKeys(candidate)) {
				if (typeof key !== "string")
					throw new SubagentBridgeError("Structured terminal result has symbol keys.");
				const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
				if (!descriptor?.enumerable || !("value" in descriptor)) {
					throw new SubagentBridgeError("Structured terminal result contains hidden data or an accessor.");
				}
				if (++entries.count > GOAL_LIMITS.maxJsonEntries)
					throw new SubagentBridgeError("Structured terminal result has too many entries.");
				if (index++ > 0) addBytes(1);
				addBytes(jsonStringBytes(key) + 1);
				Object.defineProperty(result, key, {
					value: copy(descriptor.value, depth + 1),
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
			return result;
		} finally {
			seen.delete(candidate);
		}
	};
	return copy(value, 0);
}

function normalizeUsage(value: unknown): ForegroundTerminal["usage"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new SubagentBridgeError("Malformed foreground terminal usage.");
	const names = [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"cost",
		"turns",
		"toolCalls",
		"durationMs",
	] as const;
	const normalized = {} as NonNullable<ForegroundTerminal["usage"]>;
	let tokenSum = 0;
	for (const name of names) {
		const entry = ownData(value, name);
		const count = name !== "cost";
		if (
			typeof entry !== "number" ||
			!Number.isFinite(entry) ||
			entry < 0 ||
			(count && !Number.isSafeInteger(entry))
		) {
			throw new SubagentBridgeError("Malformed foreground terminal usage.");
		}
		if (name === "input" || name === "output" || name === "cacheRead" || name === "cacheWrite") {
			if (!Number.isSafeInteger(tokenSum + entry))
				throw new SubagentBridgeError("Foreground terminal token total is unsafe.");
			tokenSum += entry;
		}
		normalized[name] = entry;
	}
	return normalized;
}

function normalizeTerminal(
	raw: Record<string, unknown>,
	request: ForegroundRequest,
	requestId: string,
): ForegroundTerminal {
	const statusValue = ownData(raw, "status");
	if (!isForegroundTerminalStatus(statusValue)) {
		throw new SubagentBridgeError("pi-subagents returned an unknown delegation terminal status.");
	}
	const status = statusValue;
	const rawResult = ownData(raw, "result");
	let result: ForegroundTerminal["result"] | undefined;
	if (rawResult !== undefined) {
		if (!isRecord(rawResult)) throw new SubagentBridgeError("Malformed foreground terminal result.");
		const resultKind = ownData(rawResult, "kind");
		if (resultKind !== "text" && resultKind !== "structured") {
			throw new SubagentBridgeError("Malformed foreground terminal result.");
		}
		if (resultKind !== request.result.kind) {
			throw new SubagentBridgeError("Foreground terminal result kind does not match the request.");
		}
		if (resultKind === "text") {
			const text = ownData(rawResult, "text");
			if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > GOAL_LIMITS.maxTerminalResultBytes) {
				throw new SubagentBridgeError("Malformed foreground terminal text result.");
			}
			result = { kind: "text", text };
		} else {
			result = { kind: "structured", value: safeJsonValue(ownData(rawResult, "value")) };
		}
	}
	if (status === "completed" && !result) {
		throw new SubagentBridgeError("Completed foreground terminal lacks the requested result kind.");
	}
	const exitCode = ownData(raw, "exitCode");
	if (exitCode !== undefined && (!Number.isSafeInteger(exitCode) || typeof exitCode !== "number")) {
		throw new SubagentBridgeError("Malformed foreground terminal exitCode.");
	}
	const runId = boundedString(ownData(raw, "runId"), "runId");
	const agent = boundedString(ownData(raw, "agent"), "agent");
	const model = boundedString(ownData(raw, "model"), "model");
	const thinking = boundedString(ownData(raw, "thinking"), "thinking");
	const error = boundedString(ownData(raw, "error"), "error");
	const usage = normalizeUsage(ownData(raw, "usage"));
	return {
		requestId,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
		status,
		...(runId !== undefined ? { runId } : {}),
		...(agent !== undefined ? { agent } : {}),
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(exitCode !== undefined ? { exitCode } : {}),
		...(error !== undefined ? { error } : {}),
		...(result ? { result } : {}),
		...(usage ? { usage } : {}),
	};
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
		if (
			typeof request.task !== "string" ||
			Buffer.byteLength(request.task, "utf8") > GOAL_LIMITS.maxExpandedTaskBytes
		) {
			throw new SubagentBridgeError(`task exceeds ${GOAL_LIMITS.maxExpandedTaskBytes} UTF-8 bytes.`);
		}
		if (
			!Number.isSafeInteger(request.timeoutMs) ||
			request.timeoutMs < 1 ||
			request.timeoutMs > GOAL_LIMITS.hardChildTimeoutMs
		) {
			throw new SubagentBridgeError(`timeoutMs must be an integer in 1-${GOAL_LIMITS.hardChildTimeoutMs}.`);
		}
		const graceTurns = request.turnBudget.graceTurns ?? GOAL_LIMITS.defaultGraceTurns;
		if (
			!Number.isSafeInteger(request.turnBudget.maxTurns) ||
			request.turnBudget.maxTurns < 1 ||
			request.turnBudget.maxTurns > GOAL_LIMITS.maxTurns ||
			!Number.isSafeInteger(graceTurns) ||
			graceTurns < 0 ||
			graceTurns > GOAL_LIMITS.hardGraceTurns
		) {
			throw new SubagentBridgeError("turnBudget exceeds the hard foreground delegation limits.");
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
			const failMalformedEvent = (error: unknown) =>
				fail(new SubagentBridgeError(error instanceof Error ? error.message : String(error)));
			const exactEventIdentity = (raw: Record<string, unknown>): boolean => {
				const eventRequestId = ownData(raw, "requestId");
				if (eventRequestId === undefined)
					throw new SubagentBridgeError("Malformed foreground delegation event requestId.");
				if (eventRequestId !== requestId) return false;
				if (ownData(raw, "version") !== SUBAGENT_DELEGATION_VERSION)
					throw new SubagentBridgeError("Malformed foreground delegation event version.");
				const eventOwnerRunId = ownData(raw, "ownerRunId");
				const eventNodeId = ownData(raw, "nodeId");
				if (eventOwnerRunId === undefined || eventNodeId === undefined)
					throw new SubagentBridgeError("Malformed foreground delegation event identity.");
				return eventOwnerRunId === request.ownerRunId && eventNodeId === request.nodeId;
			};
			const optionalUpdateNumber = (value: unknown, field: string): number | undefined => {
				if (value === undefined) return undefined;
				if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
					throw new SubagentBridgeError(`Malformed foreground update ${field}.`);
				return value;
			};
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
					try {
						if (!isRecord(raw) || !exactEventIdentity(raw) || started) return;
						started = true;
						callbacks.onStarted?.(requestId);
					} catch (error) {
						failMalformedEvent(error);
					}
				}),
				this.#events.on(SUBAGENT_DELEGATION_UPDATE, (raw) => {
					try {
						if (!isRecord(raw) || !exactEventIdentity(raw)) return;
						const runId = boundedString(ownData(raw, "runId"), "update runId");
						const currentTool = boundedString(ownData(raw, "currentTool"), "update currentTool");
						const recentOutput = boundedString(ownData(raw, "recentOutput"), "update recentOutput");
						const model = boundedString(ownData(raw, "model"), "update model");
						const toolCount = optionalUpdateNumber(ownData(raw, "toolCount"), "toolCount");
						const durationMs = optionalUpdateNumber(ownData(raw, "durationMs"), "durationMs");
						const tokens = optionalUpdateNumber(ownData(raw, "tokens"), "tokens");
						callbacks.onUpdate?.({
							...(runId !== undefined ? { runId } : {}),
							...(currentTool !== undefined ? { currentTool } : {}),
							...(recentOutput !== undefined ? { recentOutput } : {}),
							...(model !== undefined ? { model } : {}),
							...(toolCount !== undefined ? { toolCount } : {}),
							...(durationMs !== undefined ? { durationMs } : {}),
							...(tokens !== undefined ? { tokens } : {}),
						});
					} catch (error) {
						failMalformedEvent(error);
					}
				}),
				this.#events.on(SUBAGENT_DELEGATION_RESPONSE, (raw) => {
					try {
						if (!isRecord(raw)) return;
						const version = ownData(raw, "version");
						const responseRequestId = ownData(raw, "requestId");
						if (version !== SUBAGENT_DELEGATION_VERSION || responseRequestId !== requestId) return;
						// Correlate before interpreting payload fields: foreign malformed tuples are noise.
						const responseOwnerRunId = ownData(raw, "ownerRunId");
						const responseNodeId = ownData(raw, "nodeId");
						const status = ownData(raw, "status");
						const fullIdentity =
							responseOwnerRunId === request.ownerRunId && responseNodeId === request.nodeId;
						const omittedInvalidRequestIdentity =
							status === "invalid_request" &&
							(responseOwnerRunId === undefined || responseOwnerRunId === request.ownerRunId) &&
							(responseNodeId === undefined || responseNodeId === request.nodeId);
						if (!fullIdentity && !omittedInvalidRequestIdentity) return;
						finish(normalizeTerminal(raw, request, requestId));
					} catch (error) {
						fail(new SubagentBridgeError(error instanceof Error ? error.message : String(error)));
					}
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
