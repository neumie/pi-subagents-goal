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
	type GoalSnapshot,
	type OwnerIdentity,
} from "./state.ts";

const STATUS_KEY = "pi-subagents-goal";
const MAX_OBJECTIVE_BYTES = 10_000;
const CONTINUATION_TRUNCATION_MARKER =
	"\n[Child preview truncated; inspect its child session before acknowledgement if omitted evidence matters.]";
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
		reviewToken: Type.String({ minLength: 1, maxLength: 256 }),
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
	version: 1;
	goalId: string;
	epoch: number;
	lineageId: string;
	itemIds: string[];
	acknowledgements?: Array<{ itemId: string; ackToken: string }>;
	reviewToken?: string;
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

function messageFromEntry(entry: SessionEntryLike): Record<string, unknown> | undefined {
	if (entry.type === "message" && isRecord(entry.message)) return entry.message;
	if (entry.type === "custom_message" && typeof entry.customType === "string") {
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			...(entry.details !== undefined ? { details: entry.details } : {}),
		};
	}
	return undefined;
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

function toolCalls(message: Record<string, unknown>): Array<{ id?: string; name: string }> {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.flatMap((block) => {
		if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") return [];
		const call: { id?: string; name: string } = { name: block.name };
		if (typeof block.id === "string") call.id = block.id;
		return [call];
	});
}

function isAllowedAfterReview(message: Record<string, unknown>): boolean {
	const allowed = new Set(["goal_ack_output", "goal_done"]);
	if (message.role === "toolResult") {
		return typeof message.toolName === "string" && allowed.has(message.toolName);
	}
	if (message.role === "custom") return message.customType === GOAL_CONTINUATION_MESSAGE;
	if (message.role !== "assistant" || !Array.isArray(message.content) || message.content.length === 0)
		return false;
	let allowedCalls = 0;
	const onlyCompletionContent = message.content.every((block) => {
		if (!isRecord(block)) return false;
		if (block.type === "thinking") return true;
		if (block.type !== "toolCall" || typeof block.name !== "string" || !allowed.has(block.name)) return false;
		allowedCalls += 1;
		return true;
	});
	return onlyCompletionContent && allowedCalls > 0;
}

function isAllowedEntryAfterReview(entry: SessionEntryLike): boolean {
	if (entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY) return true;
	const message = messageFromEntry(entry);
	return Boolean(message && isAllowedAfterReview(message));
}

function reviewIsCurrent(ctx: ExtensionContext, reviewToken: string, reviewToolCallId: string): boolean {
	const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
	let reviewResultIndex = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const message = messageFromEntry(branch[index] ?? {});
		if (message?.role !== "toolResult" || message.toolName !== "goal_review") continue;
		if (message.toolCallId !== reviewToolCallId || !isRecord(message.details)) continue;
		if (message.details.reviewToken === reviewToken) {
			reviewResultIndex = index;
			break;
		}
	}
	if (reviewResultIndex < 0) return false;
	for (const entry of branch.slice(reviewResultIndex + 1)) {
		if (!isAllowedEntryAfterReview(entry)) return false;
	}
	return true;
}

function currentAssistantHasAckSibling(ctx: ExtensionContext, currentToolCallId: string): boolean {
	const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const message = messageFromEntry(branch[index] ?? {});
		if (message?.role !== "assistant") continue;
		const calls = toolCalls(message);
		if (!calls.some((call) => call.id === currentToolCallId)) continue;
		return calls.some((call) => call.id !== currentToolCallId && call.name === "goal_ack_output");
	}
	return true;
}

function turnTokens(event: TurnEndEvent): number {
	const message = event.message as unknown;
	if (!isRecord(message) || !isRecord(message.usage)) return 0;
	if (typeof message.usage.totalTokens === "number") return message.usage.totalTokens;
	return [
		message.usage.input,
		message.usage.output,
		message.usage.cacheRead,
		message.usage.cacheWrite,
	].reduce<number>(
		(total, value) => total + (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0),
		0,
	);
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

function formatStatus(snapshot: GoalSnapshot | undefined): string {
	if (!snapshot) return "No goal is active.";
	const active = snapshot.work.filter((item) => isActiveWorkState(item.state)).length;
	const unread = snapshot.work.filter(
		(item) => isTerminalWorkState(item.state) && item.outputState !== "consumed",
	).length;
	return [
		`Goal ${snapshot.owner.goalId} epoch ${snapshot.owner.epoch}: ${snapshot.phase}`,
		`Work: ${snapshot.work.length} total, ${active} nonterminal, ${unread} unconsumed`,
		`Budget: ${snapshot.budgetUsage.automaticTurns}/${snapshot.budgetLimits.maxAutomaticTurns} automatic turns, ${snapshot.budgetUsage.tokens}/${snapshot.budgetLimits.maxTokens} tokens, ${snapshot.budgetUsage.noProgressTurns}/${snapshot.budgetLimits.maxNoProgressTurns} unchanged turns`,
		...(snapshot.pauseReason ? [`Reason: ${snapshot.pauseReason}`] : []),
		...(snapshot.faultReason ? [`Fault: ${snapshot.faultReason}`] : []),
	].join("\n");
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
		"PI SUBAGENTS GOAL MODE IS ACTIVE.",
		`Goal ID: ${snapshot.owner.goalId}`,
		`Goal epoch: ${snapshot.owner.epoch}`,
		`Objective: ${objective}`,
		"Use goal_subagent—not subagent—for all delegated work. Direct subagent calls are blocked because they cannot carry exact goal ownership.",
		"After each child result, consider it and call goal_ack_output with its exact acknowledgement token. Explicitly resolve unsuccessful child outcomes with goal_resolve.",
		"Before completion, call goal_review for a fresh independent structured review, acknowledge that review output, and address every blocker.",
		"Call goal_done only with every exact considered item ID and the current passing review token. Prose never completes the goal.",
		"Finite automatic-turn, token, wall-clock, and no-progress budgets are enforced by the extension.",
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
	let runtimeEpoch = 0;

	const assertNamespace = () => {
		if (namespaceFault) throw new GoalInvariantError(namespaceFault);
	};
	const persist = () => {
		if (machine) pi.appendEntry(GOAL_STATE_ENTRY, persistenceSnapshot(machine.snapshot));
	};
	const updateStatus = (ctx: ExtensionContext) => {
		const snapshot = machine?.snapshot;
		ctx.ui.setStatus(
			STATUS_KEY,
			snapshot && isLivePhase(snapshot.phase)
				? `${snapshot.phase} · ${snapshot.work.filter((item) => isActiveWorkState(item.state)).length} child`
				: undefined,
		);
	};
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
	const dispatchContinuation = (
		ctx: ExtensionContext,
		suppliedTicket?: ReturnType<GoalMachine["reserveContinuation"]>,
	) => {
		if (!machine || !objective || machine.snapshot.phase !== "active") return false;
		const ticket = suppliedTicket ?? machine.reserveContinuation(Date.now());
		if (!ticket) {
			persist();
			updateStatus(ctx);
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
				updateStatus(ctx);
				return false;
			}
			outputs.push({ header: `[${itemId}] ${item.label}: ${item.state}`, output });
			acknowledgementLines.push(`- ${itemId}: ${item.ackToken}`);
		}
		const render = (previews: string[]) =>
			[
				`Continue working autonomously toward: ${objective}`,
				...outputs.flatMap((output, index) => ["", output.header, previews[index] ?? ""]),
				...(acknowledgementLines.length > 0
					? ["", "Acknowledgement tokens (never truncated):", ...acknowledgementLines]
					: []),
				"Use goal_ack_output after considering newly surfaced output. Do not call goal_done until all runtime gates and independent review pass.",
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
			updateStatus(ctx);
			return false;
		}
		if (!machine.commitContinuation(ticket, Date.now())) {
			persist();
			updateStatus(ctx);
			return false;
		}
		persist();
		try {
			pi.sendMessage(
				{
					customType: GOAL_CONTINUATION_MESSAGE,
					content: continuationContent,
					display: true,
					details: {
						version: 1,
						owner: snapshot.owner,
						ticket,
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return true;
		} catch (error) {
			machine.fault(
				`Pi rejected continuation ${ticket.sequence}; it will not be retried automatically: ${error instanceof Error ? error.message : String(error)}`,
				Date.now(),
			);
			persist();
			updateStatus(ctx);
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
			if (loaded.kind === "foreign") {
				ctx.ui.notify(
					"Inherited goal metadata belongs to another session/fork and has no authority here.",
					"warning",
				);
			} else if (loaded.kind === "invalid") {
				namespaceFault = `Goal metadata failed closed: ${loaded.reason}`;
				ctx.ui.notify(namespaceFault, "error");
			}
		}
		updateStatus(ctx);
		void ensureCompatibility(ctx).catch(() => {
			// Foreground tools report the actionable compatibility error when called.
		});
	};

	pi.registerCommand("goal", {
		description: "Start or control the native pi-subagents-aware goal loop",
		handler: async (args, ctx) => {
			try {
				assertNamespace();
				const trimmed = args.trim();
				const command = trimmed.toLowerCase();
				if (!trimmed || command === "status") {
					ctx.ui.notify(formatStatus(machine?.snapshot), "info");
					return;
				}
				if (command === "pause") {
					const active = requireMachine(ctx);
					if (!active.pause("Paused explicitly by the user.", Date.now()))
						throw new GoalInvariantError("Goal cannot be paused from its current phase.");
					persist();
					if (!ctx.isIdle()) ctx.abort();
					updateStatus(ctx);
					return;
				}
				if (command === "resume") {
					const active = requireMachine(ctx);
					if (!active.resume(Date.now()))
						throw new GoalInvariantError(
							"Goal cannot resume while work is active or the phase is not paused.",
						);
					persist();
					updateStatus(ctx);
					dispatchContinuation(ctx);
					return;
				}
				if (command === "cancel" || command === "clear") {
					const active = requireMachine(ctx);
					active.cancel(Date.now());
					persist();
					if (!ctx.isIdle()) ctx.abort();
					updateStatus(ctx);
					ctx.ui.notify(
						"Goal cancellation recorded. Active children must reach an explicit terminal state.",
						"warning",
					);
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
					const message = objectiveMessage(goalObjective, machine.snapshot);
					pi.sendMessage(
						{ ...message, details: { ...message.details, continuationNonce: initial.nonce } },
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				} catch (error) {
					machine.fault(
						`Initial goal turn could not be queued: ${error instanceof Error ? error.message : String(error)}`,
						Date.now(),
					);
					persist();
					throw error;
				}
				updateStatus(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
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
			"Use goal_subagent instead of subagent whenever /goal is active.",
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
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: `Acknowledged ${params.items.length} goal-owned output item(s).` }],
				details: { version: 1, itemIds: params.items.map((item) => item.itemId) },
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
			return {
				content: [
					{
						type: "text",
						text: `Recorded explicit resolution for ${params.itemId}; its unsuccessful outcome remains in the ledger.`,
					},
				],
				details: { version: 1, itemId: params.itemId },
			};
		},
	});

	pi.registerTool({
		name: "goal_review",
		label: "Goal Review",
		description:
			"Run a fresh, structured, independent pi-subagents review bound to the current work generation.",
		promptGuidelines: [
			"Use goal_review only after all prior child outputs are acknowledged and all unsuccessful work is explicitly resolved.",
		],
		parameters: GoalReviewSchema,
		async execute(toolCallId, params: GoalReviewInput, signal, _onUpdate, ctx) {
			const active = requireMachine(ctx);
			assertGoalIdentity(active, params.goalId, params.epoch);
			await ensureCompatibility(ctx);
			if (!objective) throw new GoalInvariantError("The active goal objective is unavailable.");
			const review = await runner().review({
				focus:
					params.focus ??
					"Correctness, deterministic races, Pi compatibility, test adequacy, and unresolved blockers.",
				objective,
				toolCallId,
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
				reviewToken: review.reviewToken,
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
							`Review token for goal_done after acknowledgement: ${review.reviewToken}`,
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
			"Complete the active goal only when every owned child is terminal, every output is acknowledged, failures are explicitly resolved, finite budgets remain, and a current independent review passed.",
		promptGuidelines: [
			"Call goal_done only after goal_review passes and its output has been acknowledged in an earlier tool batch.",
		],
		parameters: GoalDoneSchema,
		async execute(toolCallId, params: GoalDoneInput, _signal, _onUpdate, ctx) {
			const active = requireMachine(ctx);
			assertGoalIdentity(active, params.goalId, params.epoch);
			const review = active.snapshot.review;
			const request: CompletionRequest = {
				owner: active.snapshot.owner,
				reviewToken: params.reviewToken,
				consideredItemIds: params.consideredItemIds,
				reviewIsCurrent:
					Boolean(review) &&
					!currentAssistantHasAckSibling(ctx, toolCallId) &&
					reviewIsCurrent(ctx, params.reviewToken, review?.toolCallId ?? ""),
				now: Date.now(),
			};
			const decision = active.complete(request);
			if (!decision.ok) throw completionError(decision.blockers);
			persist();
			updateStatus(ctx);
			ctx.ui.notify("Goal completed after all coordination and review gates passed.", "info");
			return {
				content: [{ type: "text", text: `Goal complete.\n\n${params.summary}` }],
				details: { version: 1, goalId: params.goalId, epoch: params.epoch, status: "completed" },
				terminate: true,
			};
		},
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent" || !machine || !isLivePhase(machine.snapshot.phase)) return;
		return {
			block: true,
			reason:
				"Direct subagent calls are blocked during /goal because the current pi-subagents contract cannot atomically bind them to this session/lineage/goal/epoch. Use goal_subagent foreground mode.",
		};
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
			updateStatus(ctx);
			dispatchContinuation(ctx);
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!machine || !objective || machine.snapshot.phase !== "active") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${extensionSystemPrompt(objective, machine.snapshot)}` };
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!machine) return;
		machine.agentStarted(Date.now());
		persist();
		updateStatus(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		if (!machine) return;
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
		updateStatus(ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		if (!machine) return;
		machine.recordTurn({
			tokens: turnTokens(event),
			progressSignature: turnProgressSignature(event),
			now: Date.now(),
		});
		persist();
		updateStatus(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!machine) return;
		const ticket = machine.agentSettled(Date.now());
		persist();
		updateStatus(ctx);
		if (ticket) dispatchContinuation(ctx, ticket);
	});

	pi.on("session_before_switch", (_event, ctx) => {
		if (!machine || !isLivePhase(machine.snapshot.phase)) return;
		ctx.ui.notify(
			"Session switch blocked while /goal has live or unresolved state. Complete or cancel it first.",
			"warning",
		);
		return { cancel: true };
	});

	pi.on("session_before_fork", (_event, ctx) => {
		if (!machine || !isLivePhase(machine.snapshot.phase)) return;
		ctx.ui.notify(
			"Fork/clone blocked while /goal has live or unresolved state. Complete or cancel it first.",
			"warning",
		);
		return { cancel: true };
	});

	pi.on("session_before_tree", (_event, ctx) => {
		if (!machine || !isLivePhase(machine.snapshot.phase)) return;
		ctx.ui.notify(
			"Tree navigation blocked while /goal has live or unresolved state. Complete or cancel it first.",
			"warning",
		);
		return { cancel: true };
	});

	pi.on("session_before_compact", (_event, ctx) => {
		if (!machine || !isLivePhase(machine.snapshot.phase)) return;
		const unsafe = machine.snapshot.work.some(
			(item) =>
				isActiveWorkState(item.state) || (isTerminalWorkState(item.state) && item.outputState !== "consumed"),
		);
		if (!unsafe) return;
		ctx.ui.notify(
			"Compaction blocked until all goal-owned work is terminal and its output acknowledged.",
			"warning",
		);
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
		if (closingEpoch === runtimeEpoch) {
			bridge.dispose();
			bridge = new SubagentBridge(pi.events);
			compatibility = undefined;
			compatibilitySessionId = undefined;
			currentCtx = undefined;
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	void currentCtx;
}
