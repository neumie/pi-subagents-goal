import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { GOAL_LIMITS } from "./limits.ts";
import {
	GOAL_CONTINUATION_MESSAGE,
	GOAL_OBJECTIVE_MESSAGE,
	GOAL_STATE_ENTRY,
	GOAL_TOOL_DETAILS_VERSION,
	loadGoalFromBranch,
	objectiveMessage,
	persistenceSnapshot,
	type SessionEntryLike,
} from "./persistence.ts";
import {
	GOAL_STATUS_EVENT,
	GOAL_STATUS_REQUEST_EVENT,
	createGoalStatusEnvelope,
	isGoalStatusRequest,
	type GoalStatusEnvelope,
} from "./status-api.ts";
import { SubagentBridge } from "./subagents-bridge.ts";
import { MAX_MODEL_TEXT_BYTES, equalPreviewByteLimit, truncateUtf8, utf8ByteLength } from "./text-budget.ts";
import {
	GoalInvariantError,
	GoalMachine,
	createGoalSnapshot,
	exactOwnerMatch,
	isActiveWorkState,
	isTerminalWorkState,
	sha256,
	type BudgetIncrease,
	type CompletionRequest,
	type ContinuationTicket,
	type GoalSnapshot,
	type OwnerIdentity,
} from "./state.ts";

const MAX_OBJECTIVE_BYTES = 10_000;
const GOAL_BUDGET_USAGE = "Usage: /goal budget +<turns> or /goal budget no-progress +<turns>.";
const CONTINUATION_TRUNCATION_MARKER =
	"\n[Child preview truncated; inspect its child session before acknowledgement if omitted evidence matters.]";
const CONTINUATION_NONCE_PREFIX = "Goal continuation nonce: ";
const EXTENSION_ENTRY_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
export const GOAL_TOOL_NAMES = [
	"goal_subagent",
	"goal_ack_output",
	"goal_resolve",
	"goal_review",
	"goal_done",
] as const;

const GOAL_CONTROL_COMPLETIONS = [
	{ value: "status", label: "status", description: "Show current goal state and budget" },
	{ value: "pause", label: "pause", description: "Pause safely; the goal remains resumable" },
	{ value: "resume", label: "resume", description: "Resume a paused goal" },
	{ value: "stop", label: "stop", description: "Permanently stop the current goal" },
	{ value: "budget +5", label: "budget +5", description: "Add automatic continuation turns" },
	{
		value: "budget no-progress +3",
		label: "budget no-progress +3",
		description: "Allow more unchanged automatic turns",
	},
] as const;

type GoalControl =
	| { kind: "status" }
	| { kind: "pause" }
	| { kind: "resume" }
	| { kind: "budgetStatus" }
	| { kind: "increaseBudget"; increase: BudgetIncrease }
	| { kind: "stop" };

const SIMPLE_GOAL_CONTROLS = new Map<string, GoalControl>([
	["", { kind: "status" }],
	["status", { kind: "status" }],
	["pause", { kind: "pause" }],
	["resume", { kind: "resume" }],
	["budget", { kind: "budgetStatus" }],
	["stop", { kind: "stop" }],
	["cancel", { kind: "stop" }],
	["clear", { kind: "stop" }],
]);

const TaskSchema = Type.Object(
	{
		agent: Type.String({ minLength: 1, maxLength: 128 }),
		task: Type.String({ minLength: 1, maxLength: 100_000 }),
		label: Type.Optional(Type.String({ maxLength: 200 })),
		model: Type.Optional(Type.String({ maxLength: 256 })),
		thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
	},
	{ additionalProperties: false },
);

const TurnBudgetSchema = Type.Object(
	{
		maxTurns: Type.Integer({ minimum: 1, maximum: GOAL_LIMITS.maxTurns }),
		graceTurns: Type.Optional(Type.Integer({ minimum: 0, maximum: GOAL_LIMITS.hardGraceTurns })),
	},
	{ additionalProperties: false },
);

const GoalSubagentSchema = Type.Object(
	{
		goalId: Type.String({ minLength: 1, maxLength: 256 }),
		epoch: Type.Integer({ minimum: 1 }),
		execution: Type.Optional(StringEnum(["foreground", "detached"] as const)),
		agent: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		task: Type.Optional(Type.String({ minLength: 1, maxLength: GOAL_LIMITS.maxTaskBytes })),
		tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: GOAL_LIMITS.maxGroupItems })),
		chain: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: GOAL_LIMITS.maxGroupItems })),
		context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
		concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: GOAL_LIMITS.maxParallelConcurrency })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: GOAL_LIMITS.hardChildTimeoutMs })),
		turnBudget: Type.Optional(TurnBudgetSchema),
	},
	{ additionalProperties: false },
);

const GoalAckSchema = Type.Object(
	{
		goalId: Type.String({ minLength: 1, maxLength: 256 }),
		epoch: Type.Integer({ minimum: 1 }),
		items: Type.Array(
			Type.Object(
				{
					itemId: Type.String({ minLength: 1, maxLength: 256 }),
					ackToken: Type.String({ minLength: 1, maxLength: 256 }),
					consideration: Type.String({ minLength: 1, maxLength: 2_000 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 100 },
		),
	},
	{ additionalProperties: false },
);

const GoalResolveSchema = Type.Object(
	{
		goalId: Type.String({ minLength: 1, maxLength: 256 }),
		epoch: Type.Integer({ minimum: 1 }),
		itemId: Type.String({ minLength: 1, maxLength: 256 }),
		rationale: Type.String({ minLength: 1, maxLength: 4_000 }),
	},
	{ additionalProperties: false },
);

const GoalReviewSchema = Type.Object(
	{
		goalId: Type.String({ minLength: 1, maxLength: 256 }),
		epoch: Type.Integer({ minimum: 1 }),
		focus: Type.Optional(Type.String({ maxLength: 4_000 })),
		agent: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: GOAL_LIMITS.hardChildTimeoutMs })),
	},
	{ additionalProperties: false },
);

const GoalDoneSchema = Type.Object(
	{
		goalId: Type.String({ minLength: 1, maxLength: 256 }),
		epoch: Type.Integer({ minimum: 1 }),
		summary: Type.String({ minLength: 1, maxLength: 10_000 }),
		reviewToken: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 256,
				description: "Deprecated compatibility field; accepted but ignored.",
			}),
		),
		consideredItemIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
			maxItems: 10_000,
		}),
	},
	{ additionalProperties: false },
);

type GoalSubagentInput = Static<typeof GoalSubagentSchema>;
type GoalAckInput = Static<typeof GoalAckSchema>;
type GoalResolveInput = Static<typeof GoalResolveSchema>;
type GoalReviewInput = Static<typeof GoalReviewSchema>;
type GoalDoneInput = Static<typeof GoalDoneSchema>;

interface GoalToolDetails {
	version: 2;
	goalId: string;
	epoch: number;
	lineageId: string;
	itemIds: string[];
	acknowledgements?: Array<{ itemId: string; ackToken: string }>;
	verdict?: "pass" | "fail";
}

interface RuntimeContextIdentity {
	sessionId: string;
	sessionFile: string | null;
}

interface PendingTurnUsage {
	tokens: number;
	progressSignature: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortedAssistantMessage(message: unknown): boolean {
	return isRecord(message) && message.role === "assistant" && message.stopReason === "aborted";
}

function parseBudgetIncreaseCommand(command: string): BudgetIncrease | undefined {
	const match = /^budget(?:\s+(turns|no-progress))?\s+\+([1-9]\d*)$/u.exec(command);
	if (!match) return undefined;
	const amount = Number(match[2]);
	if (!Number.isSafeInteger(amount)) {
		throw new GoalInvariantError("Budget increase must be a positive safe integer.");
	}
	return match[1] === "no-progress" ? { noProgressTurns: amount } : { automaticTurns: amount };
}

function parseGoalControl(command: string): GoalControl | undefined {
	const simple = SIMPLE_GOAL_CONTROLS.get(command);
	if (simple) return simple;
	if (!command.startsWith("budget ")) return undefined;
	const increase = parseBudgetIncreaseCommand(command);
	if (!increase) throw new GoalInvariantError(GOAL_BUDGET_USAGE);
	return { kind: "increaseBudget", increase };
}

function normalizeGoalObjective(rawObjective: string): string {
	const objective = rawObjective.startsWith("start ") ? rawObjective.slice(6).trim() : rawObjective;
	if (!objective) throw new GoalInvariantError("Usage: /goal <objective>");
	if (utf8ByteLength(objective) > MAX_OBJECTIVE_BYTES) {
		throw new GoalInvariantError(`Goal objective must be at most ${MAX_OBJECTIVE_BYTES} UTF-8 bytes.`);
	}
	return objective;
}

function sessionIdentity(ctx: ExtensionContext): RuntimeContextIdentity {
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionId) throw new GoalInvariantError("Pi did not provide a stable session ID.");
	return { sessionId, sessionFile: ctx.sessionManager.getSessionFile() ?? null };
}

function ownerForContext(ctx: ExtensionContext): OwnerIdentity {
	const session = sessionIdentity(ctx);
	return {
		...session,
		lineageId: randomUUID(),
		goalId: randomUUID(),
		epoch: 1,
	};
}

function isLivePhase(phase: GoalSnapshot["phase"]): boolean {
	return phase !== "completed" && phase !== "cancelled";
}

function outputText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
		)
		.join("\n");
}

function continuationNonceFromPrompt(prompt: unknown): string | undefined {
	if (typeof prompt !== "string") return undefined;
	const firstLine = prompt.split("\n", 1)[0];
	if (!firstLine?.startsWith(CONTINUATION_NONCE_PREFIX)) return undefined;
	const nonce = firstLine.slice(CONTINUATION_NONCE_PREFIX.length).trim();
	return nonce && nonce.length <= 256 ? nonce : undefined;
}

function exactContinuationMessageNonce(message: unknown, snapshot: GoalSnapshot): string | undefined {
	if (
		!isRecord(message) ||
		message.role !== "custom" ||
		message.customType !== GOAL_CONTINUATION_MESSAGE ||
		!isRecord(message.details) ||
		message.details.version !== 1 ||
		!isRecord(message.details.owner) ||
		!isRecord(message.details.ticket)
	) {
		return undefined;
	}
	const continuation = snapshot.continuation;
	if (continuation?.status !== "queued") return undefined;
	const owner = message.details.owner;
	const ticket = message.details.ticket;
	const expected = continuation.ticket;
	if (
		owner.sessionId !== snapshot.owner.sessionId ||
		owner.sessionFile !== snapshot.owner.sessionFile ||
		owner.lineageId !== snapshot.owner.lineageId ||
		owner.goalId !== snapshot.owner.goalId ||
		owner.epoch !== snapshot.owner.epoch ||
		ticket.goalId !== expected.goalId ||
		ticket.epoch !== expected.epoch ||
		ticket.sequence !== expected.sequence ||
		ticket.nonce !== expected.nonce ||
		ticket.expectedWorkGeneration !== expected.expectedWorkGeneration ||
		ticket.kind !== expected.kind ||
		!Array.isArray(ticket.outputItemIds) ||
		ticket.outputItemIds.length !== expected.outputItemIds.length ||
		!ticket.outputItemIds.every((itemId, index) => itemId === expected.outputItemIds[index]) ||
		continuationNonceFromPrompt(outputText(message.content)) !== expected.nonce
	) {
		return undefined;
	}
	return expected.nonce;
}

function agentEndContainsContinuation(messages: unknown[], expectedNonce: string): boolean {
	return messages.some((rawMessage) => {
		if (!isRecord(rawMessage) || rawMessage.role !== "custom" || !isRecord(rawMessage.details)) return false;
		if (rawMessage.customType === GOAL_OBJECTIVE_MESSAGE) {
			return rawMessage.details.continuationNonce === expectedNonce;
		}
		if (rawMessage.customType !== GOAL_CONTINUATION_MESSAGE || !isRecord(rawMessage.details.ticket))
			return false;
		return rawMessage.details.ticket.nonce === expectedNonce;
	});
}

function turnOutputTokens(event: TurnEndEvent): number {
	const message = event.message as unknown;
	if (!isRecord(message) || !isRecord(message.usage)) return 0;
	const output = message.usage.output;
	return typeof output === "number" && Number.isFinite(output) && output > 0 ? output : 0;
}

function turnProgressSignature(event: TurnEndEvent): string {
	const message = event.message as unknown;
	const assistant = isRecord(message) ? outputText(message.content) : "";
	const tools = event.toolResults.map((result) => ({
		toolName: result.toolName,
		isError: result.isError,
		text: outputText(result.content).slice(0, 1_000),
	}));
	return sha256(JSON.stringify({ assistant: assistant.slice(0, 4_000), tools }));
}

function completionError(blockers: string[]): GoalInvariantError {
	return new GoalInvariantError(`goal_done is blocked:\n- ${blockers.join("\n- ")}`);
}

export function boundedReviewText(input: {
	verdict: "pass" | "fail";
	findings: unknown[];
	itemId: string;
	ackToken: string;
}): string {
	const prefix = `Independent review verdict: ${input.verdict}\n\n`;
	const suffix = `\n\nReview item: ${input.itemId}\n\nAcknowledgement token: ${input.ackToken}`;
	const rawFindings = JSON.stringify(input.findings, null, 2);
	const marker = "\n[Review evidence truncated by pi-subagents-goal.]";
	const available = MAX_MODEL_TEXT_BYTES - utf8ByteLength(prefix) - utf8ByteLength(suffix);
	if (available < utf8ByteLength(marker)) {
		throw new GoalInvariantError("Review framing exceeds the model payload budget.");
	}
	const truncated = truncateUtf8(rawFindings, available - utf8ByteLength(marker));
	const text = `${prefix}${truncated.text}${truncated.truncated ? marker : ""}${suffix}`;
	if (utf8ByteLength(text) > MAX_MODEL_TEXT_BYTES) {
		throw new GoalInvariantError("Bounded review payload exceeded its UTF-8 safety budget.");
	}
	return text;
}

function assertGoalIdentity(machine: GoalMachine, goalId: string, epoch: number): void {
	const owner = machine.snapshot.owner;
	if (owner.goalId !== goalId || owner.epoch !== epoch) {
		throw new GoalInvariantError("Goal ID or epoch does not match the active goal.");
	}
}

const GOAL_OWNED_WORK_UNAVAILABLE =
	"Goal-owned subagent work and review are unavailable with the official pi-subagents provider: it does not enforce the hard child-turn limits required by this goal contract. Use ordinary subagent work outside the goal ledger, or continue directly with ordinary tools.";

function rejectGoalOwnedWork(): never {
	throw new GoalInvariantError(GOAL_OWNED_WORK_UNAVAILABLE);
}

function extensionSystemPrompt(objective: string, snapshot: GoalSnapshot): string {
	return [
		"PI GOAL MODE IS ACTIVE.",
		`Goal ID: ${snapshot.owner.goalId}`,
		`Goal epoch: ${snapshot.owner.epoch}`,
		`Objective: ${objective}`,
		"Work directly with ordinary tools whenever useful. Ordinary subagent calls remain available but are outside the goal-owned ledger.",
		"The goal-owned subagent and review tools are disabled for this upstream provider because it does not enforce the hard child-turn limits required by this goal contract; do not call them.",
		"Use the exact goal ID and epoch above in every enabled goal_* call; never search environment variables, session artifacts, or process state for them.",
		"goal_done completes direct-only goals with an empty consideredItemIds list; no review is required.",
		"Call goal_done with every exact considered goal-owned item ID; use an empty list when no goal-owned work was launched. No review token is required. Prose never completes the goal.",
		"Automatic-turn and no-progress budgets are enabled by default; token and wall-clock limits are optional.",
	].join("\n");
}

function initialContinuationContent(
	objective: string,
	snapshot: GoalSnapshot,
	initial: ContinuationTicket,
): string {
	return [
		`${CONTINUATION_NONCE_PREFIX}${initial.nonce}`,
		`Begin working autonomously toward: ${objective}`,
		"",
		"Exact identity for every goal_* call (do not search for it elsewhere):",
		`- goalId: ${snapshot.owner.goalId}`,
		`- epoch: ${snapshot.owner.epoch}`,
		"Work directly with ordinary tools. Ordinary subagent calls remain available outside the goal ledger.",
		"Goal-owned subagent work and review are disabled for this upstream provider because its child-turn limits cannot be enforced. Do not call goal_subagent or goal_review; use an empty consideredItemIds list with goal_done.",
	].join("\n");
}

export default function registerPiSubagentsGoal(pi: ExtensionAPI): void {
	let namespaceFault: string | undefined;
	let machine: GoalMachine | undefined;
	let objective: string | undefined;
	let currentCtx: ExtensionContext | undefined;
	let bridge = new SubagentBridge(pi.events);
	const outputCache = new Map<string, string>();
	const statusProviderId = randomUUID();
	let statusSequence = 0;
	let latestStatus: GoalStatusEnvelope | undefined;
	let runtimeEpoch = 0;
	let pendingContinuationNonce: string | undefined;
	let pendingInterruptedTurnUsage: PendingTurnUsage | undefined;
	let currentRunTracked = false;
	let currentRunInterrupted = false;
	let runningContinuationObserved = false;
	const expectedContinuationNonces = new Set<string>();
	let goalToolTail: Promise<void> = Promise.resolve();

	// Deliberately extension-local: Pi's sequential execution mode would also serialize ordinary tools.
	const serializeGoalTool = async <T>(operation: () => Promise<T>): Promise<T> => {
		const previous = goalToolTail.catch(() => undefined);
		let release!: () => void;
		goalToolTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	};

	const assertNamespace = () => {
		if (namespaceFault) throw new GoalInvariantError(namespaceFault);
	};
	const persist = () => {
		if (machine) pi.appendEntry(GOAL_STATE_ENTRY, persistenceSnapshot(machine.snapshot));
	};
	const emitStatus = (status: GoalStatusEnvelope) => {
		try {
			pi.events.emit(GOAL_STATUS_EVENT, structuredClone(status));
		} catch {
			// Status consumers are optional and cannot affect goal coordination.
		}
	};
	const publishStatus = (ctx: ExtensionContext) => {
		latestStatus = createGoalStatusEnvelope({
			providerId: statusProviderId,
			sequence: ++statusSequence,
			sessionId: ctx.sessionManager.getSessionId(),
			...(objective !== undefined ? { objective } : {}),
			...(machine ? { snapshot: machine.snapshot } : {}),
			...(namespaceFault
				? {
						providerError:
							"Goal provider unavailable because namespace or persisted state validation failed.",
					}
				: {}),
		});
		emitStatus(latestStatus);
	};
	pi.events.on(GOAL_STATUS_REQUEST_EVENT, (request) => {
		if (!isGoalStatusRequest(request) || request.sessionId !== latestStatus?.sessionId) return;
		emitStatus(latestStatus);
	});
	const requireMachine = (ctx?: ExtensionContext) => {
		assertNamespace();
		if (!machine || !objective || !isLivePhase(machine.snapshot.phase)) {
			throw new GoalInvariantError("No live /goal exists in this session.");
		}
		if (
			ctx &&
			!exactOwnerMatch(machine.snapshot.owner, { ...machine.snapshot.owner, ...sessionIdentity(ctx) })
		) {
			throw new GoalInvariantError("The active goal belongs to a different Pi session.");
		}
		return machine;
	};
	const sendContinuation = (content: string, owner: OwnerIdentity, ticket: ContinuationTicket) => {
		pi.sendMessage(
			{
				customType: GOAL_CONTINUATION_MESSAGE,
				content,
				display: true,
				details: { version: 1, owner, ticket },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};
	const dispatchContinuation = (
		ctx: ExtensionContext,
		suppliedTicket?: ReturnType<GoalMachine["reserveContinuation"]>,
	) => {
		if (!machine || !objective || machine.snapshot.phase !== "active") return false;
		const ticket =
			suppliedTicket ??
			(machine.snapshot.continuation?.status === "reserved"
				? machine.snapshot.continuation.ticket
				: machine.reserveContinuation(Date.now()));
		if (!ticket) {
			persist();
			publishStatus(ctx);
			return false;
		}
		// Pi may still be processing a tool result or abort. Keep the durable reservation until idle settlement.
		if (!ctx.isIdle()) {
			persist();
			publishStatus(ctx);
			return false;
		}
		const snapshot = machine.snapshot;
		const outputs: Array<{ header: string; output: string }> = [];
		const acknowledgementLines: string[] = [];
		for (const itemId of ticket.outputItemIds) {
			const item = snapshot.work.find((candidate) => candidate.itemId === itemId);
			const output = outputCache.get(itemId);
			if (!item?.ackToken || output === undefined) {
				machine.fault(`Terminal output for ${itemId} could not be re-surfaced safely.`, Date.now());
				persist();
				publishStatus(ctx);
				return false;
			}
			outputs.push({ header: `[${itemId}] ${item.label}: ${item.state}`, output });
			acknowledgementLines.push(`- ${itemId}: ${item.ackToken}`);
		}
		const render = (previews: string[]) =>
			[
				`${CONTINUATION_NONCE_PREFIX}${ticket.nonce}`,
				`Continue working autonomously toward: ${objective}`,
				"",
				"Exact identity for every goal_* call (do not search for it elsewhere):",
				`- goalId: ${snapshot.owner.goalId}`,
				`- epoch: ${snapshot.owner.epoch}`,
				...outputs.flatMap((output, index) => ["", output.header, previews[index] ?? ""]),
				...(acknowledgementLines.length > 0
					? ["", "Acknowledgement tokens (never truncated):", ...acknowledgementLines]
					: []),
				"Use goal_ack_output after considering every newly surfaced goal-owned output. Resolve unsuccessful owned work explicitly before completion.",
				"Goal-owned subagent work and review are disabled for this upstream provider. Preserve acknowledgement and explicit resolution for historical owned outputs, then call goal_done with exact considered item IDs (or an empty list for direct-only work).",
			].join("\n");
		const previewLimit =
			outputs.length > 0
				? equalPreviewByteLimit({
						fixedText: render(outputs.map(() => "")),
						itemCount: outputs.length,
						perTruncatedItemMarker: CONTINUATION_TRUNCATION_MARKER,
					})
				: 0;
		const continuationContent = render(
			outputs.map((output) => {
				const preview = truncateUtf8(output.output, previewLimit);
				return preview.truncated ? `${preview.text}${CONTINUATION_TRUNCATION_MARKER}` : preview.text;
			}),
		);
		if (utf8ByteLength(continuationContent) > MAX_MODEL_TEXT_BYTES) {
			machine.fault("Bounded continuation exceeded its UTF-8 safety budget.", Date.now());
			persist();
			publishStatus(ctx);
			return false;
		}
		if (!machine.commitContinuation(ticket, Date.now())) {
			persist();
			publishStatus(ctx);
			return false;
		}
		persist();
		publishStatus(ctx);
		expectedContinuationNonces.add(ticket.nonce);
		try {
			sendContinuation(continuationContent, snapshot.owner, ticket);
			return true;
		} catch (error) {
			expectedContinuationNonces.delete(ticket.nonce);
			machine.fault(
				`Pi rejected continuation ${ticket.sequence}; it will not be retried automatically: ${error instanceof Error ? error.message : String(error)}`,
				Date.now(),
			);
			persist();
			publishStatus(ctx);
			return false;
		}
	};

	const restore = (event: SessionStartEvent, ctx: ExtensionContext) => {
		currentCtx = ctx;
		namespaceFault = undefined;
		runtimeEpoch += 1;
		pendingContinuationNonce = undefined;
		pendingInterruptedTurnUsage = undefined;
		currentRunTracked = false;
		currentRunInterrupted = false;
		runningContinuationObserved = false;
		expectedContinuationNonces.clear();
		outputCache.clear();
		const commands = pi
			.getCommands()
			.filter((command) => command.name === "goal" || /^goal:\d+$/u.test(command.name));
		const displacedTools = pi.getAllTools().filter((tool) => {
			if (!(GOAL_TOOL_NAMES as readonly string[]).includes(tool.name)) return false;
			return resolve(tool.sourceInfo.path) !== resolve(EXTENSION_ENTRY_PATH);
		});
		const missingTools = GOAL_TOOL_NAMES.filter(
			(name) => !pi.getAllTools().some((tool) => tool.name === name),
		);
		if (commands.length !== 1 || commands[0]?.name !== "goal") {
			namespaceFault = "Another extension also owns /goal. Disable it and reload.";
		} else if (displacedTools.length > 0 || missingTools.length > 0) {
			namespaceFault = `Goal tool namespace is not exclusively active: ${[
				...displacedTools.map((tool) => tool.name),
				...missingTools,
			].join(", ")}. Disable the conflicting extension and reload.`;
		}
		const loaded = loadGoalFromBranch(
			ctx.sessionManager.getBranch() as SessionEntryLike[],
			sessionIdentity(ctx),
		);
		if (loaded.kind === "loaded") {
			machine = new GoalMachine(loaded.snapshot);
			objective = loaded.objective;
			const snapshot = machine.snapshot;
			if (snapshot.continuation) {
				machine.fault(
					`Session ${event.reason} restored an ambiguous ${snapshot.continuation.status} continuation; delivery cannot be proven, so it will not be retried. Cancel this goal and inspect the branch before starting another.`,
					Date.now(),
				);
				persist();
			} else if (snapshot.work.some((item) => isActiveWorkState(item.state))) {
				machine.fault(
					`Session ${event.reason} occurred with nonterminal foreground work; exact terminal state is unknown. Cancel this goal or inspect the original child session manually.`,
					Date.now(),
				);
				persist();
			} else if (snapshot.phase === "active") {
				machine.pause(
					`Session ${event.reason} restored the goal; explicit /goal resume is required.`,
					Date.now(),
				);
				persist();
			}
		} else {
			machine = undefined;
			objective = undefined;
			if (loaded.kind === "invalid") {
				namespaceFault = `Goal metadata failed closed: ${loaded.reason}`;
			}
		}
		publishStatus(ctx);
	};

	const startGoal = (rawObjective: string, ctx: ExtensionContext) => {
		if (machine && isLivePhase(machine.snapshot.phase)) {
			throw new GoalInvariantError("This session already has a live goal.");
		}
		if (!ctx.isIdle()) throw new GoalInvariantError("Wait for Pi to settle before starting /goal.");
		const goalObjective = normalizeGoalObjective(rawObjective);
		const now = Date.now();
		const next = new GoalMachine(
			createGoalSnapshot({ owner: ownerForContext(ctx), objective: goalObjective, now }),
		);
		machine = next;
		objective = goalObjective;
		const initial = next.queueInitialContinuation(now);
		persist();
		expectedContinuationNonces.add(initial.nonce);
		try {
			const snapshot = next.snapshot;
			pi.sendMessage(objectiveMessage(goalObjective, snapshot), { deliverAs: "followUp" });
			sendContinuation(initialContinuationContent(goalObjective, snapshot, initial), snapshot.owner, initial);
		} catch (error) {
			expectedContinuationNonces.delete(initial.nonce);
			next.fault(
				`Initial goal turn could not be queued: ${error instanceof Error ? error.message : String(error)}`,
				Date.now(),
			);
			persist();
			publishStatus(ctx);
			throw error;
		}
		publishStatus(ctx);
	};

	const handleGoalControl = (control: GoalControl, ctx: ExtensionContext) => {
		switch (control.kind) {
			case "status":
				publishStatus(ctx);
				return;
			case "pause": {
				const active = requireMachine(ctx);
				if (
					!active.pause(
						"Paused explicitly by the user. Resume with /goal resume or stop with /goal stop.",
						Date.now(),
					)
				) {
					throw new GoalInvariantError("Goal cannot be paused from its current phase.");
				}
				expectedContinuationNonces.clear();
				pendingContinuationNonce = undefined;
				persist();
				if (!ctx.isIdle()) ctx.abort();
				publishStatus(ctx);
				return;
			}
			case "resume": {
				if (!ctx.isIdle()) throw new GoalInvariantError("Wait for Pi to settle before resuming /goal.");
				const active = requireMachine(ctx);
				if (!active.resume(Date.now())) {
					throw new GoalInvariantError("Goal cannot resume while work is active or the phase is not paused.");
				}
				persist();
				publishStatus(ctx);
				dispatchContinuation(ctx);
				return;
			}
			case "budgetStatus":
				requireMachine(ctx);
				publishStatus(ctx);
				return;
			case "increaseBudget":
				requireMachine(ctx).increaseBudget(control.increase, Date.now());
				persist();
				publishStatus(ctx);
				return;
			case "stop":
				requireMachine(ctx).cancel(Date.now());
				expectedContinuationNonces.clear();
				pendingContinuationNonce = undefined;
				persist();
				if (!ctx.isIdle()) ctx.abort();
				publishStatus(ctx);
				return;
			default: {
				const unsupported: never = control;
				throw new GoalInvariantError(`Unsupported goal control: ${String(unsupported)}`);
			}
		}
	};

	pi.registerCommand("goal", {
		description: "Start or control a goal: status, pause, resume, stop, or increase its budget",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const matches = GOAL_CONTROL_COMPLETIONS.filter((item) => item.value.startsWith(query));
			return matches.length > 0 ? [...matches] : null;
		},
		handler: async (args, ctx) => {
			assertNamespace();
			const trimmed = args.trim();
			const control = parseGoalControl(trimmed.toLowerCase());
			if (control) {
				handleGoalControl(control, ctx);
				return;
			}
			startGoal(trimmed, ctx);
		},
	});

	pi.registerTool({
		name: "goal_subagent",
		label: "Goal Subagent",
		description:
			"Unavailable in this upstream-compatible release: goal-owned pi-subagents work requires hard child-turn limits that the official provider does not enforce.",
		promptSnippet:
			"Goal-owned subagent work is disabled; use ordinary tools or an untracked ordinary subagent.",
		promptGuidelines: [
			"Do not call goal_subagent: it rejects before ledger admission and provider dispatch.",
			"Ordinary subagent remains available but is not tracked by the goal-owned ledger.",
		],
		parameters: GoalSubagentSchema,
		async execute(_toolCallId, params: GoalSubagentInput, _signal, _onUpdate, ctx) {
			return serializeGoalTool(async () => {
				const active = requireMachine(ctx);
				assertGoalIdentity(active, params.goalId, params.epoch);
				rejectGoalOwnedWork();
			});
		},
	});

	pi.registerTool({
		name: "goal_ack_output",
		label: "Acknowledge Goal Output",
		description: "Acknowledge historical goal-owned output only after considering it.",
		promptGuidelines: [
			"Call goal_ack_output only for acknowledgement tokens from historical goal-owned output or a goal continuation; new goal_subagent and goal_review calls are disabled.",
		],
		parameters: GoalAckSchema,
		async execute(_toolCallId, params: GoalAckInput, _signal, _onUpdate, ctx) {
			return serializeGoalTool(async () => {
				const active = requireMachine(ctx);
				assertGoalIdentity(active, params.goalId, params.epoch);
				const candidate = new GoalMachine(active.snapshot);
				for (const item of params.items) {
					if (
						!candidate.acknowledgeOutput({
							owner: candidate.snapshot.owner,
							itemId: item.itemId,
							ackToken: item.ackToken,
							consideration: item.consideration,
							now: Date.now(),
						})
					) {
						throw new GoalInvariantError(`Output acknowledgement was rejected for ${item.itemId}.`);
					}
				}
				machine = candidate;
				persist();
				publishStatus(ctx);
				return {
					content: [{ type: "text", text: `Acknowledged ${params.items.length} goal-owned output item(s).` }],
					details: {
						version: GOAL_TOOL_DETAILS_VERSION,
						itemIds: params.items.map((item) => item.itemId),
					},
				};
			});
		},
	});

	pi.registerTool({
		name: "goal_resolve",
		label: "Resolve Goal Work",
		description:
			"Explicitly resolve an acknowledged unsuccessful child outcome; never converts it into success evidence.",
		parameters: GoalResolveSchema,
		async execute(_toolCallId, params: GoalResolveInput, _signal, _onUpdate, ctx) {
			return serializeGoalTool(async () => {
				const active = requireMachine(ctx);
				assertGoalIdentity(active, params.goalId, params.epoch);
				if (
					!active.resolveUnsuccessfulWork({
						owner: active.snapshot.owner,
						itemId: params.itemId,
						rationale: params.rationale,
						now: Date.now(),
					})
				) {
					throw new GoalInvariantError(
						"Only consumed, terminal, unsuccessful work can be explicitly resolved.",
					);
				}
				persist();
				publishStatus(ctx);
				return {
					content: [
						{
							type: "text",
							text: `Recorded explicit resolution for ${params.itemId}; its unsuccessful outcome remains in the ledger.`,
						},
					],
					details: { version: GOAL_TOOL_DETAILS_VERSION, itemId: params.itemId },
				};
			});
		},
	});

	pi.registerTool({
		name: "goal_review",
		label: "Goal Review",
		description:
			"Unavailable in this upstream-compatible release: goal-owned review requires hard child-turn limits that the official provider does not enforce.",
		promptGuidelines: [
			"Do not call goal_review: it rejects before ledger admission and provider dispatch.",
			"Direct-only goals do not require an independent review.",
		],
		parameters: GoalReviewSchema,
		async execute(_toolCallId, params: GoalReviewInput, _signal, _onUpdate, ctx) {
			return serializeGoalTool(async () => {
				const active = requireMachine(ctx);
				assertGoalIdentity(active, params.goalId, params.epoch);
				rejectGoalOwnedWork();
			});
		},
	});

	pi.registerTool({
		name: "goal_done",
		label: "Goal Done",
		description:
			"Complete the active direct-only goal when enabled budgets remain and every historical goal-owned item, if any, is terminal, consumed, resolved where needed, and considered.",
		promptGuidelines: [
			"No subagent or independent review is required for goal_done.",
			"Include every historical goal-owned item ID that is being considered; use an empty list for direct-only goals. New goal_subagent and goal_review calls are disabled.",
		],
		parameters: GoalDoneSchema,
		async execute(_toolCallId, params: GoalDoneInput, _signal, _onUpdate, ctx) {
			return serializeGoalTool(async () => {
				const active = requireMachine(ctx);
				assertGoalIdentity(active, params.goalId, params.epoch);
				const request: CompletionRequest = {
					owner: active.snapshot.owner,
					consideredItemIds: params.consideredItemIds,
					now: Date.now(),
				};
				const decision = active.complete(request);
				if (!decision.ok) throw completionError(decision.blockers);
				persist();
				publishStatus(ctx);
				return {
					content: [{ type: "text", text: `Goal complete.\n\n${params.summary}` }],
					details: {
						version: GOAL_TOOL_DETAILS_VERSION,
						goalId: params.goalId,
						epoch: params.epoch,
						status: "completed",
					},
					terminate: true,
				};
			});
		},
	});

	pi.on("tool_result", (event, ctx) => {
		if (
			(event.toolName !== "goal_subagent" && event.toolName !== "goal_review") ||
			!machine ||
			!isRecord(event.details)
		)
			return;
		// SAFETY: tool_result details are validated by the owner/version/lineage checks immediately below.
		const details = event.details as unknown as GoalToolDetails;
		const owner = machine.snapshot.owner;
		if (
			details.version !== GOAL_TOOL_DETAILS_VERSION ||
			details.goalId !== owner.goalId ||
			details.epoch !== owner.epoch ||
			details.lineageId !== owner.lineageId ||
			!Array.isArray(details.itemIds)
		) {
			return;
		}
		if (machine.markOutputSurfaced(owner, details.itemIds, Date.now())) {
			persist();
			publishStatus(ctx);
			dispatchContinuation(ctx);
		}
	});

	pi.on("message_start", (event, ctx) => {
		if (!machine || !objective || machine.snapshot.phase !== "active") return;
		const nonce = exactContinuationMessageNonce(event.message, machine.snapshot);
		if (!nonce) return;
		expectedContinuationNonces.delete(nonce);
		if (!machine.agentStarted(Date.now(), nonce)) return;
		pendingContinuationNonce = undefined;
		pendingInterruptedTurnUsage = undefined;
		currentRunTracked = true;
		currentRunInterrupted = false;
		runningContinuationObserved = true;
		persist();
		publishStatus(ctx);
	});

	pi.on("before_agent_start", (event) => {
		pendingContinuationNonce = continuationNonceFromPrompt(event.prompt);
		if (!machine || !objective || machine.snapshot.phase !== "active") return;
		const continuation = machine.snapshot.continuation;
		if (continuation?.status === "queued" && pendingContinuationNonce !== continuation.ticket.nonce) {
			return;
		}
		if (continuation?.status === "queued" && pendingContinuationNonce === continuation.ticket.nonce) {
			expectedContinuationNonces.delete(continuation.ticket.nonce);
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${extensionSystemPrompt(objective, machine.snapshot)}` };
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!machine) {
			pendingContinuationNonce = undefined;
			pendingInterruptedTurnUsage = undefined;
			currentRunTracked = false;
			currentRunInterrupted = false;
			runningContinuationObserved = false;
			return;
		}
		const before = machine.snapshot;
		const preserveTrackedRun =
			currentRunTracked &&
			(before.continuation?.status === "running" || (!before.continuation && !before.parentSettled));
		const started = machine.agentStarted(Date.now(), pendingContinuationNonce);
		pendingContinuationNonce = undefined;
		currentRunTracked = started || preserveTrackedRun;
		if (!started) return;
		pendingInterruptedTurnUsage = undefined;
		currentRunInterrupted = false;
		persist();
		publishStatus(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		if (!machine || !currentRunTracked) return;
		const snapshot = machine.snapshot;
		if (snapshot.currentRunEndObserved) return;
		const continuation = snapshot.continuation;
		const interrupted = currentRunInterrupted || event.messages.some(isAbortedAssistantMessage);
		const now = Date.now();
		// Pi can emit an empty agent_end for a custom-trigger turn. Only the exact locally observed
		// continuation message_start authorizes that empty-message fallback; nonempty ends still re-check identity.
		if (
			continuation?.status === "running" &&
			(!runningContinuationObserved || event.messages.length > 0) &&
			!agentEndContainsContinuation(event.messages, continuation.ticket.nonce)
		) {
			machine.fault(
				"Parent agent_end did not carry the running continuation nonce; lifecycle identity is ambiguous.",
				now,
			);
		} else if (interrupted) {
			machine.interrupt(
				"Parent turn was interrupted; goal paused. Resume with /goal resume or stop with /goal stop.",
				now,
			);
			if (pendingInterruptedTurnUsage) {
				machine.recordTurn({ ...pendingInterruptedTurnUsage, now });
			}
			expectedContinuationNonces.clear();
			pendingContinuationNonce = undefined;
		} else {
			machine.agentEnded(now, continuation?.status === "running" ? continuation.ticket.nonce : undefined);
		}
		pendingInterruptedTurnUsage = undefined;
		persist();
		publishStatus(ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		if (!machine || !currentRunTracked) return;
		const usage: PendingTurnUsage = {
			tokens: turnOutputTokens(event),
			progressSignature: turnProgressSignature(event),
		};
		if (isAbortedAssistantMessage(event.message)) {
			currentRunInterrupted = true;
			pendingInterruptedTurnUsage = usage;
			return;
		}
		machine.recordTurn({ ...usage, now: Date.now() });
		persist();
		publishStatus(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		// Check before any early return or newly-dispatched ticket: Pi sendMessage is void.
		const queuedNonce =
			machine?.snapshot.continuation?.status === "queued"
				? machine.snapshot.continuation.ticket.nonce
				: undefined;
		if (machine && queuedNonce && expectedContinuationNonces.has(queuedNonce)) {
			expectedContinuationNonces.delete(queuedNonce);
			machine.fault(
				"Pi did not start a queued continuation before settlement; delivery is unobserved and will not be retried.",
				Date.now(),
			);
			persist();
			publishStatus(ctx);
			return;
		}
		if (!machine || !currentRunTracked) {
			if (machine?.snapshot.continuation?.status === "reserved" && ctx.isIdle()) dispatchContinuation(ctx);
			return;
		}
		const ticket = machine.agentSettled(Date.now());
		pendingInterruptedTurnUsage = undefined;
		currentRunTracked = false;
		currentRunInterrupted = false;
		runningContinuationObserved = false;
		persist();
		publishStatus(ctx);
		if (ticket) dispatchContinuation(ctx, ticket);
	});

	pi.on("session_before_switch", () => {
		if (!machine || !isLivePhase(machine.snapshot.phase)) return;
		return { cancel: true };
	});

	pi.on("session_before_fork", () => {
		if (!machine || !isLivePhase(machine.snapshot.phase)) return;
		return { cancel: true };
	});

	pi.on("session_before_tree", () => {
		if (!machine || !isLivePhase(machine.snapshot.phase)) return;
		return { cancel: true };
	});

	pi.on("session_before_compact", () => {
		if (!machine || !isLivePhase(machine.snapshot.phase)) return;
		const unsafe = machine.snapshot.work.some(
			(item) =>
				isActiveWorkState(item.state) || (isTerminalWorkState(item.state) && item.outputState !== "consumed"),
		);
		if (!unsafe) return;
		return { cancel: true };
	});

	pi.on("session_start", (event, ctx) => {
		restore(event, ctx);
	});

	pi.on("session_shutdown", (event, ctx) => {
		const closingEpoch = runtimeEpoch;
		if (machine && machine.snapshot.phase === "active") {
			machine.pause(`Session shutdown (${event.reason}); explicit recovery is required.`, Date.now());
			persist();
		}
		publishStatus(ctx);
		if (closingEpoch === runtimeEpoch) {
			bridge.dispose();
			bridge = new SubagentBridge(pi.events);
			pendingContinuationNonce = undefined;
			pendingInterruptedTurnUsage = undefined;
			expectedContinuationNonces.clear();
			currentRunTracked = false;
			currentRunInterrupted = false;
			runningContinuationObserved = false;
			currentCtx = undefined;
			latestStatus = undefined;
		}
	});

	void currentCtx;
}
