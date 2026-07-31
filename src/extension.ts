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
import { GoalSubagentRunner, type GoalSubagentParams } from "./foreground-runner.ts";
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
import { SubagentBridge, SubagentBridgeError, type SubagentCompatibility } from "./subagents-bridge.ts";
import { MAX_MODEL_TEXT_BYTES, equalPreviewByteLimit, truncateUtf8, utf8ByteLength } from "./text-budget.ts";
import {
	GoalInvariantError,
	GoalMachine,
	createGoalSnapshot,
	exactOwnerMatch,
	isActiveWorkState,
	isTerminalWorkState,
	sha256,
	type CompletionRequest,
	type ContinuationTicket,
	type GoalSnapshot,
	type OwnerIdentity,
} from "./state.ts";

const MAX_OBJECTIVE_BYTES = 10_000;
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
		maxTurns: Type.Integer({ minimum: 1, maximum: 10_000 }),
		graceTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
	},
	{ additionalProperties: false },
);

const GoalSubagentSchema = Type.Object(
	{
		goalId: Type.String({ minLength: 1, maxLength: 256 }),
		epoch: Type.Integer({ minimum: 1 }),
		execution: Type.Optional(StringEnum(["foreground", "detached"] as const)),
		agent: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		task: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
		tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: 8 })),
		chain: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: 8 })),
		context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
		concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
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
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function assertGoalIdentity(machine: GoalMachine, goalId: string, epoch: number): void {
	const owner = machine.snapshot.owner;
	if (owner.goalId !== goalId || owner.epoch !== epoch) {
		throw new GoalInvariantError("Goal ID or epoch does not match the active goal.");
	}
}

function extensionSystemPrompt(objective: string, snapshot: GoalSnapshot): string {
	return [
		"PI GOAL MODE IS ACTIVE.",
		`Goal ID: ${snapshot.owner.goalId}`,
		`Goal epoch: ${snapshot.owner.epoch}`,
		`Objective: ${objective}`,
		"Work directly with ordinary tools whenever useful. Both pi-subagents and its goal-owned tools are optional.",
		"When an ordinary subagent tool is installed, its calls remain available but are outside the goal-owned ledger. Use goal_subagent only when exact child ownership and output acknowledgement are useful.",
		"Use the exact goal ID and epoch above in every goal_* call; never search environment variables, session artifacts, or process state for them.",
		"If goal_subagent or goal_review is used, consider and acknowledge every surfaced output, and explicitly resolve unsuccessful owned outcomes with goal_resolve.",
		"goal_review is optional advisory evidence, not a completion prerequisite.",
		"Call goal_done with every exact considered goal-owned item ID; use an empty list when no goal-owned work was launched. No review token is required. Prose never completes the goal.",
		"Automatic-turn and no-progress budgets are enabled by default; token and wall-clock limits are optional.",
	].join("\n");
}

export default function registerPiSubagentsGoal(pi: ExtensionAPI): void {
	let namespaceFault: string | undefined;
	let machine: GoalMachine | undefined;
	let objective: string | undefined;
	let currentCtx: ExtensionContext | undefined;
	let bridge = new SubagentBridge(pi.events);
	let compatibility: SubagentCompatibility | undefined;
	let compatibilitySessionId: string | undefined;
	const outputCache = new Map<string, string>();
	const statusProviderId = randomUUID();
	let statusSequence = 0;
	let latestStatus: GoalStatusEnvelope | undefined;
	let runtimeEpoch = 0;
	let pendingContinuationNonce: string | undefined;
	let currentRunTracked = false;

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
	const ensureCompatibility = async (ctx: ExtensionContext) => {
		const identity = sessionIdentity(ctx);
		if (
			compatibility?.available &&
			compatibility.sessionMatches &&
			compatibilitySessionId === identity.sessionId
		) {
			return compatibility;
		}
		compatibility = await bridge.probe(identity);
		compatibilitySessionId = identity.sessionId;
		if (!compatibility.available || !compatibility.sessionMatches) {
			throw new SubagentBridgeError(
				compatibility.reason ?? "The local pi-subagents extension did not answer its stable RPC ping.",
			);
		}
		return compatibility;
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
		const ticket = suppliedTicket ?? machine.reserveContinuation(Date.now());
		if (!ticket) {
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
				"goal_review remains optional. Call goal_done once all goal-owned items are consumed, resolved where needed, and included in consideredItemIds.",
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
		try {
			sendContinuation(continuationContent, snapshot.owner, ticket);
			return true;
		} catch (error) {
			machine.fault(
				`Pi rejected continuation ${ticket.sequence}; it will not be retried automatically: ${error instanceof Error ? error.message : String(error)}`,
				Date.now(),
			);
			persist();
			publishStatus(ctx);
			return false;
		}
	};

	const runner = () =>
		new GoalSubagentRunner({
			port: bridge,
			machine: () => requireMachine(),
			onOutput: (itemId, output) => outputCache.set(itemId, output),
			onStateChange: () => {
				persist();
				if (currentCtx) dispatchContinuation(currentCtx);
			},
		});

	const restore = (event: SessionStartEvent, ctx: ExtensionContext) => {
		currentCtx = ctx;
		runtimeEpoch += 1;
		pendingContinuationNonce = undefined;
		currentRunTracked = false;
		outputCache.clear();
		compatibility = undefined;
		compatibilitySessionId = undefined;
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

	pi.registerCommand("goal", {
		description: "Start or control an autonomous goal loop with optional pi-subagents coordination",
		handler: async (args, ctx) => {
			assertNamespace();
			const trimmed = args.trim();
			const command = trimmed.toLowerCase();
			if (!trimmed || command === "status") {
				publishStatus(ctx);
				return;
			}
			if (command === "pause") {
				const active = requireMachine(ctx);
				if (!active.pause("Paused explicitly by the user.", Date.now()))
					throw new GoalInvariantError("Goal cannot be paused from its current phase.");
				persist();
				if (!ctx.isIdle()) ctx.abort();
				publishStatus(ctx);
				return;
			}
			if (command === "resume") {
				const active = requireMachine(ctx);
				if (!active.resume(Date.now()))
					throw new GoalInvariantError("Goal cannot resume while work is active or the phase is not paused.");
				persist();
				publishStatus(ctx);
				dispatchContinuation(ctx);
				return;
			}
			if (command === "cancel" || command === "clear") {
				const active = requireMachine(ctx);
				active.cancel(Date.now());
				persist();
				if (!ctx.isIdle()) ctx.abort();
				publishStatus(ctx);
				return;
			}
			if (machine && isLivePhase(machine.snapshot.phase))
				throw new GoalInvariantError("This session already has a live goal.");
			if (!ctx.isIdle()) throw new GoalInvariantError("Wait for Pi to settle before starting /goal.");
			const goalObjective = trimmed.startsWith("start ") ? trimmed.slice(6).trim() : trimmed;
			if (!goalObjective) throw new GoalInvariantError("Usage: /goal <objective>");
			if (utf8ByteLength(goalObjective) > MAX_OBJECTIVE_BYTES) {
				throw new GoalInvariantError(`Goal objective must be at most ${MAX_OBJECTIVE_BYTES} UTF-8 bytes.`);
			}
			machine = new GoalMachine(
				createGoalSnapshot({ owner: ownerForContext(ctx), objective: goalObjective, now: Date.now() }),
			);
			objective = goalObjective;
			const initial = machine.queueInitialContinuation(Date.now());
			persist();
			try {
				const snapshot = machine.snapshot;
				pi.sendMessage(objectiveMessage(goalObjective, snapshot), { deliverAs: "followUp" });
				sendContinuation(
					[
						`${CONTINUATION_NONCE_PREFIX}${initial.nonce}`,
						`Begin working autonomously toward: ${goalObjective}`,
						"",
						"Exact identity for every goal_* call (do not search for it elsewhere):",
						`- goalId: ${snapshot.owner.goalId}`,
						`- epoch: ${snapshot.owner.epoch}`,
						"Work directly with ordinary tools. pi-subagents, goal_subagent, and goal_review are optional.",
						"If goal-owned work is used, acknowledge every surfaced output and resolve unsuccessful outcomes before goal_done. An empty consideredItemIds list is valid when no goal-owned work was launched.",
					].join("\n"),
					snapshot.owner,
					initial,
				);
			} catch (error) {
				machine.fault(
					`Initial goal turn could not be queued: ${error instanceof Error ? error.message : String(error)}`,
					Date.now(),
				);
				persist();
				publishStatus(ctx);
				throw error;
			}
			publishStatus(ctx);
		},
	});

	pi.registerTool({
		name: "goal_subagent",
		label: "Goal Subagent",
		description:
			"Launch exactly goal-owned pi-subagents work. Foreground single, parallel, and chain modes are supported. Detached mode fails closed until pi-subagents exposes caller-owned completion and atomic continuation coordination.",
		promptSnippet:
			"Launch goal-owned foreground pi-subagents work with exact ownership and output acknowledgement",
		promptGuidelines: [
			"goal_subagent is optional; use it only when exact goal ownership and acknowledgement are useful.",
			"When installed, ordinary subagent remains available but is not tracked by the goal-owned ledger.",
			"After goal_subagent returns, consider every child output and call goal_ack_output with every exact acknowledgement token.",
		],
		parameters: GoalSubagentSchema,
		async execute(_toolCallId, params: GoalSubagentInput, signal, _onUpdate, ctx) {
			const active = requireMachine(ctx);
			assertGoalIdentity(active, params.goalId, params.epoch);
			const installed = await ensureCompatibility(ctx);
			if ((params.execution ?? "foreground") === "detached") {
				throw new SubagentBridgeError(
					installed.goalCoordination
						? "Detached coordination was advertised, but Pi 0.83.0 still lacks the atomic continuation enqueue needed for the required exactly-once guarantee. Use foreground mode."
						: "Detached goal-owned work is unavailable: pi-subagents 0.38.1 does not advertise goalCoordination v1 and otherwise queues its own continuation before completion is observable. Use foreground mode.",
				);
			}
			const runParams: GoalSubagentParams = {
				...(params.agent !== undefined ? { agent: params.agent } : {}),
				...(params.task !== undefined ? { task: params.task } : {}),
				...(params.tasks !== undefined ? { tasks: params.tasks } : {}),
				...(params.chain !== undefined ? { chain: params.chain } : {}),
				...(params.context !== undefined ? { context: params.context } : {}),
				...(params.concurrency !== undefined ? { concurrency: params.concurrency } : {}),
				...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
				...(params.turnBudget !== undefined ? { turnBudget: params.turnBudget } : {}),
			};
			const result = await runner().run(runParams, signal, ctx.cwd);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.registerTool({
		name: "goal_ack_output",
		label: "Acknowledge Goal Output",
		description: "Acknowledge exact goal-owned child output only after considering it.",
		promptGuidelines: [
			"Call goal_ack_output only with acknowledgement tokens visible in goal_subagent, goal_review, or goal continuation output.",
		],
		parameters: GoalAckSchema,
		async execute(_toolCallId, params: GoalAckInput, _signal, _onUpdate, ctx) {
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
		},
	});

	pi.registerTool({
		name: "goal_resolve",
		label: "Resolve Goal Work",
		description:
			"Explicitly resolve an acknowledged unsuccessful child outcome; never converts it into success evidence.",
		parameters: GoalResolveSchema,
		async execute(_toolCallId, params: GoalResolveInput, _signal, _onUpdate, ctx) {
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
		},
	});

	pi.registerTool({
		name: "goal_review",
		label: "Goal Review",
		description:
			"Optionally run a structured, independent pi-subagents review bound to the current work generation.",
		promptGuidelines: [
			"goal_review is optional advisory evidence, not a prerequisite for goal_done.",
			"Use it only after prior goal-owned output is acknowledged and unsuccessful owned work is explicitly resolved.",
			"Its output is goal-owned and must be acknowledged before completion.",
		],
		parameters: GoalReviewSchema,
		async execute(_toolCallId, params: GoalReviewInput, signal, _onUpdate, ctx) {
			const active = requireMachine(ctx);
			assertGoalIdentity(active, params.goalId, params.epoch);
			await ensureCompatibility(ctx);
			if (!objective) throw new GoalInvariantError("The active goal objective is unavailable.");
			const review = await runner().review({
				focus:
					params.focus ??
					"Correctness, deterministic races, Pi compatibility, test adequacy, and unresolved blockers.",
				objective,
				signal,
				cwd: ctx.cwd,
				...(params.agent !== undefined ? { agent: params.agent } : {}),
				...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
			});
			const findings = JSON.stringify(review.findings, null, 2).slice(0, 30_000);
			const owner = active.snapshot.owner;
			const details: GoalToolDetails = {
				version: GOAL_TOOL_DETAILS_VERSION,
				goalId: owner.goalId,
				epoch: owner.epoch,
				lineageId: owner.lineageId,
				itemIds: [review.itemId],
				acknowledgements: [{ itemId: review.itemId, ackToken: review.ackToken }],
				verdict: review.verdict,
			};
			return {
				content: [
					{
						type: "text",
						text: [
							`Independent review verdict: ${review.verdict}`,
							findings,
							`Review item: ${review.itemId}`,
							`Acknowledgement token: ${review.ackToken}`,
						].join("\n\n"),
					},
				],
				details,
			};
		},
	});

	pi.registerTool({
		name: "goal_done",
		label: "Goal Done",
		description:
			"Complete the active goal when enabled budgets remain and every goal-owned item, if any, is terminal, consumed, resolved where needed, and considered. Subagents and review are optional.",
		promptGuidelines: [
			"No subagent or independent review is required for goal_done.",
			"Include every goal-owned item ID returned by goal_subagent or goal_review; use an empty list if neither was used.",
		],
		parameters: GoalDoneSchema,
		async execute(_toolCallId, params: GoalDoneInput, _signal, _onUpdate, ctx) {
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
		},
	});

	pi.on("tool_result", (event, ctx) => {
		if (
			(event.toolName !== "goal_subagent" && event.toolName !== "goal_review") ||
			!machine ||
			!isRecord(event.details)
		)
			return;
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
		if (!nonce || !machine.agentStarted(Date.now(), nonce)) return;
		pendingContinuationNonce = undefined;
		currentRunTracked = true;
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
		return { systemPrompt: `${event.systemPrompt}\n\n${extensionSystemPrompt(objective, machine.snapshot)}` };
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!machine) {
			pendingContinuationNonce = undefined;
			currentRunTracked = false;
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
		persist();
		publishStatus(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		if (!machine || !currentRunTracked) return;
		const snapshot = machine.snapshot;
		if (snapshot.currentRunEndObserved) return;
		const continuation = snapshot.continuation;
		if (
			continuation?.status === "running" &&
			!agentEndContainsContinuation(event.messages, continuation.ticket.nonce)
		) {
			machine.fault(
				"Parent agent_end did not carry the running continuation nonce; lifecycle identity is ambiguous.",
				Date.now(),
			);
		} else {
			machine.agentEnded(
				Date.now(),
				continuation?.status === "running" ? continuation.ticket.nonce : undefined,
			);
		}
		persist();
		publishStatus(ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		if (!machine || !currentRunTracked) return;
		machine.recordTurn({
			tokens: turnOutputTokens(event),
			progressSignature: turnProgressSignature(event),
			now: Date.now(),
		});
		persist();
		publishStatus(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!machine || !currentRunTracked) return;
		const ticket = machine.agentSettled(Date.now());
		currentRunTracked = false;
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
			compatibility = undefined;
			compatibilitySessionId = undefined;
			pendingContinuationNonce = undefined;
			currentRunTracked = false;
			currentCtx = undefined;
			latestStatus = undefined;
		}
	});

	void currentCtx;
}
