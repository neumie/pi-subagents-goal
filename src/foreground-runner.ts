import { randomUUID } from "node:crypto";
import { GOAL_LIMITS } from "./limits.ts";
import {
	delegationStatusToWorkState,
	terminalOutput,
	type ForegroundCallbacks,
	type ForegroundRequest,
	type ForegroundTerminal,
} from "./subagents-bridge.ts";
import { MAX_MODEL_TEXT_BYTES, equalPreviewByteLimit, truncateUtf8, utf8ByteLength } from "./text-budget.ts";
import {
	GoalInvariantError,
	type GoalMachine,
	isActiveWorkState,
	isTerminalWorkState,
	newAckToken,
	type OwnerIdentity,
	type TerminalWorkState,
	type WorkMode,
	type WorkRole,
} from "./state.ts";

const DEFAULT_CHILD_TIMEOUT_MS = GOAL_LIMITS.defaultChildTimeoutMs;
const DEFAULT_CHILD_TURN_BUDGET = Object.freeze({
	maxTurns: GOAL_LIMITS.maxTurns,
	graceTurns: GOAL_LIMITS.defaultGraceTurns,
});
const MAX_GROUP_ITEMS = GOAL_LIMITS.maxGroupItems;
const MAX_PARALLEL_CONCURRENCY = GOAL_LIMITS.maxParallelConcurrency;
const MAX_RESULT_BYTES = GOAL_LIMITS.maxRetainedChildOutputBytes;
const OUTPUT_TRUNCATION_MARKER = `\n\n[Output truncated by pi-subagents-goal at ${MAX_RESULT_BYTES} UTF-8 bytes.]`;
const PREVIEW_TRUNCATION_MARKER =
	"\n[Child preview truncated; inspect its configured output/session when needed.]";

export interface ForegroundPort {
	runForeground(
		request: ForegroundRequest,
		signal: AbortSignal | undefined,
		callbacks?: ForegroundCallbacks,
	): Promise<ForegroundTerminal>;
}

interface GoalSubagentTask {
	agent: string;
	task: string;
	label?: string;
	model?: string;
	thinking?: ForegroundRequest["thinking"];
}

export interface GoalSubagentParams {
	agent?: string;
	task?: string;
	tasks?: GoalSubagentTask[];
	chain?: GoalSubagentTask[];
	context?: "fresh" | "fork";
	concurrency?: number;
	timeoutMs?: number;
	turnBudget?: { maxTurns: number; graceTurns?: number };
}

export interface GoalWorkResult {
	itemId: string;
	label: string;
	state: TerminalWorkState;
	ackToken: string;
	output: string;
	runId?: string;
	response: ForegroundTerminal;
}

export interface GoalRunResult {
	mode: WorkMode;
	items: GoalWorkResult[];
	text: string;
	details: {
		version: 2;
		goalId: string;
		epoch: number;
		lineageId: string;
		itemIds: string[];
		acknowledgements: Array<{ itemId: string; ackToken: string }>;
	};
}

export interface GoalReviewResult extends GoalWorkResult {
	verdict: "pass" | "fail";
	findings: unknown[];
}

export interface RunnerDependencies {
	port: ForegroundPort;
	machine: () => GoalMachine;
	onStateChange: () => void;
	onOutput?: (itemId: string, output: string) => void;
	now?: () => number;
	newId?: () => string;
	newToken?: () => string;
}

interface PreparedWork {
	itemId: string;
	mode: WorkMode;
	role: WorkRole;
	task: GoalSubagentTask;
	result: ForegroundRequest["result"];
	workGeneration: number;
}

function boundedInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	field: string,
): number {
	const candidate = value ?? fallback;
	if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
		throw new GoalInvariantError(`${field} must be an integer in ${minimum}-${maximum}.`);
	}
	return candidate;
}

function placeholderCount(task: string): number {
	let count = 0;
	let offset = 0;
	for (;;) {
		const found = task.indexOf("{previous}", offset);
		if (found === -1) return count;
		count += 1;
		offset = found + "{previous}".length;
		if (count > GOAL_LIMITS.maxPlaceholdersPerChainTask) return count;
	}
}

function checkedAdd(left: number, right: number, field: string): number {
	if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left > Number.MAX_SAFE_INTEGER - right) {
		throw new GoalInvariantError(`${field} exceeds safe arithmetic.`);
	}
	return left + right;
}

export function boundedChainExpansion(task: string, previous: string): string {
	const count = placeholderCount(task);
	if (count > GOAL_LIMITS.maxPlaceholdersPerChainTask) {
		throw new GoalInvariantError(
			`A chain task may contain at most ${GOAL_LIMITS.maxPlaceholdersPerChainTask} {previous} placeholders.`,
		);
	}
	const projected = checkedAdd(
		Buffer.byteLength(task, "utf8") - count * Buffer.byteLength("{previous}", "utf8"),
		count * Buffer.byteLength(previous, "utf8"),
		"Projected chain task",
	);
	if (projected > GOAL_LIMITS.maxExpandedTaskBytes) {
		throw new GoalInvariantError(
			`Projected chain task exceeds ${GOAL_LIMITS.maxExpandedTaskBytes} UTF-8 bytes.`,
		);
	}
	const expanded = task.replaceAll("{previous}", previous);
	if (Buffer.byteLength(expanded, "utf8") > GOAL_LIMITS.maxExpandedTaskBytes) {
		throw new GoalInvariantError(
			`Expanded chain task exceeds ${GOAL_LIMITS.maxExpandedTaskBytes} UTF-8 bytes.`,
		);
	}
	return expanded;
}

function nonEmpty(value: string | undefined, field: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new GoalInvariantError(`${field} must not be empty.`);
	return trimmed;
}

function ownerRunId(owner: OwnerIdentity): string {
	return `${owner.sessionId}:${owner.lineageId}:${owner.goalId}:${owner.epoch}`.slice(0, 256);
}

function clampOutput(output: string): string {
	if (utf8ByteLength(output) <= MAX_RESULT_BYTES) return output;
	const contentBudget = MAX_RESULT_BYTES - utf8ByteLength(OUTPUT_TRUNCATION_MARKER);
	return `${truncateUtf8(output, contentBudget).text}${OUTPUT_TRUNCATION_MARKER}`;
}

function terminalTokenUsage(response: ForegroundTerminal): number {
	const usage = response.usage;
	if (usage === undefined) return 0;
	if (!usage || typeof usage !== "object") {
		throw new GoalInvariantError("Malformed foreground terminal usage.");
	}
	let total = 0;
	for (const field of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"turns",
		"toolCalls",
		"durationMs",
	] as const) {
		const value = usage[field];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
			throw new GoalInvariantError("Malformed foreground terminal usage.");
		}
		if (field === "input" || field === "output" || field === "cacheRead" || field === "cacheWrite") {
			total = checkedAdd(total, value, "Foreground terminal token usage");
		}
	}
	if (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0) {
		throw new GoalInvariantError("Malformed foreground terminal usage.");
	}
	return total;
}

function ownReviewData(value: object, field: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, field);
	if (!descriptor || !("value" in descriptor))
		throw new GoalInvariantError("Malformed independent review evidence.");
	return descriptor.value;
}

function validReview(
	value: unknown,
): { verdict: "pass" | "fail"; findings: Array<Record<string, string>> } | undefined {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		const verdict = ownReviewData(value, "verdict");
		const rawFindings = ownReviewData(value, "findings");
		if ((verdict !== "pass" && verdict !== "fail") || !Array.isArray(rawFindings) || rawFindings.length > 50)
			return undefined;
		const findings: Array<Record<string, string>> = [];
		let evidenceBytes = 0;
		for (const finding of rawFindings) {
			if (!finding || typeof finding !== "object" || Array.isArray(finding)) return undefined;
			const entryPrototype = Object.getPrototypeOf(finding);
			if (entryPrototype !== Object.prototype && entryPrototype !== null) return undefined;
			const severity = ownReviewData(finding, "severity");
			const issue = ownReviewData(finding, "issue");
			const rationale = ownReviewData(finding, "rationale");
			if (
				(severity !== "blocker" && severity !== "non-blocking") ||
				typeof issue !== "string" ||
				typeof rationale !== "string"
			)
				return undefined;
			const normalized = Object.create(null) as Record<string, string>;
			for (const [field, text] of [
				["severity", severity],
				["issue", issue],
				["rationale", rationale],
			] as const) {
				if (Buffer.byteLength(text, "utf8") > 8_000) return undefined;
				evidenceBytes += Buffer.byteLength(text, "utf8");
				Object.defineProperty(normalized, field, { value: text, enumerable: true });
			}
			const file = Object.getOwnPropertyDescriptor(finding, "file");
			if (file) {
				if (
					!("value" in file) ||
					typeof file.value !== "string" ||
					Buffer.byteLength(file.value, "utf8") > 8_000
				)
					return undefined;
				evidenceBytes += Buffer.byteLength(file.value, "utf8");
				Object.defineProperty(normalized, "file", { value: file.value, enumerable: true });
			}
			if (evidenceBytes > MAX_RESULT_BYTES) return undefined;
			findings.push(normalized);
		}
		return { verdict, findings };
	} catch {
		return undefined;
	}
}

function reviewSchema(): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		required: ["verdict", "findings"],
		properties: {
			verdict: { type: "string", enum: ["pass", "fail"] },
			findings: {
				type: "array",
				maxItems: 50,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["severity", "issue", "rationale"],
					properties: {
						severity: { type: "string", enum: ["blocker", "non-blocking"] },
						file: { type: "string", maxLength: 8_000 },
						issue: { type: "string", maxLength: 8_000 },
						rationale: { type: "string", maxLength: 8_000 },
					},
				},
			},
		},
	};
}

export class GoalSubagentRunner {
	readonly #port: ForegroundPort;
	readonly #machine: () => GoalMachine;
	readonly #onStateChange: () => void;
	readonly #onOutput: (itemId: string, output: string) => void;
	readonly #now: () => number;
	readonly #newId: () => string;
	readonly #newToken: () => string;

	constructor(dependencies: RunnerDependencies) {
		this.#port = dependencies.port;
		this.#machine = dependencies.machine;
		this.#onStateChange = dependencies.onStateChange;
		this.#onOutput = dependencies.onOutput ?? (() => undefined);
		this.#now = dependencies.now ?? Date.now;
		this.#newId = dependencies.newId ?? randomUUID;
		this.#newToken = dependencies.newToken ?? newAckToken;
	}

	async run(
		params: GoalSubagentParams,
		signal: AbortSignal | undefined,
		cwd: string,
	): Promise<GoalRunResult> {
		const owner = this.#machine().snapshot.owner;
		const prepared = this.#prepare(params, "work");
		const execution = this.#executionLimits(params);
		// All bounds are checked by #prepare before this first ledger mutation.
		for (const item of prepared.items) this.#admit(item);
		const deadline = checkedAdd(this.#now(), execution.timeoutMs, "Goal subagent deadline");
		let results: GoalWorkResult[];
		if (prepared.mode === "parallel") {
			results = await this.#runParallel(
				prepared.items,
				prepared.concurrency,
				execution,
				signal,
				cwd,
				deadline,
			);
		} else if (prepared.mode === "chain") {
			results = await this.#runChain(prepared.items, execution, signal, cwd, deadline);
		} else {
			const single = prepared.items[0];
			if (!single) throw new GoalInvariantError("Single foreground work requires exactly one item.");
			results = [await this.#execute(single, execution, signal, cwd, undefined, deadline)];
		}
		return this.#aggregate(prepared.mode, results, owner);
	}

	async review(input: {
		focus: string;
		objective: string;
		signal: AbortSignal | undefined;
		cwd: string;
		agent?: string;
		timeoutMs?: number;
	}): Promise<GoalReviewResult> {
		const machine = this.#machine();
		const snapshot = machine.snapshot;
		const blocking = snapshot.work.filter(
			(item) =>
				isActiveWorkState(item.state) ||
				(isTerminalWorkState(item.state) && item.outputState !== "consumed") ||
				(isTerminalWorkState(item.state) && item.state !== "succeeded" && !item.resolutionDigest),
		);
		if (blocking.length > 0) {
			throw new GoalInvariantError(
				`Independent review is blocked by unresolved work: ${blocking.map((item) => `${item.itemId}:${item.state}/${item.outputState}`).join(", ")}.`,
			);
		}
		const workGeneration = snapshot.workGeneration;
		const item: PreparedWork = {
			itemId: this.#newId(),
			mode: "single",
			role: "review",
			task: {
				agent: input.agent?.trim() || "reviewer",
				task: [
					"Perform a fresh independent advisory review. Do not modify files.",
					`Goal: ${input.objective}`,
					`Focus: ${input.focus.trim() || "Correctness, races, compatibility, tests, and unresolved blockers."}`,
					"Inspect the repository and current diff directly. Return verdict=pass only when no blocker remains. Return every finding with severity, issue, rationale, and optional file.",
				].join("\n\n"),
				label: "Independent advisory review",
			},
			result: { kind: "structured", schema: reviewSchema() },
			workGeneration,
		};
		const execution = this.#executionLimits({
			context: "fresh",
			...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
		});
		this.#admit(item);
		const deadline = checkedAdd(this.#now(), execution.timeoutMs, "Goal review deadline");
		const result = await this.#execute(item, execution, input.signal, input.cwd, undefined, deadline);
		const structured =
			result.response.result?.kind === "structured" ? validReview(result.response.result.value) : undefined;
		const verdict = structured?.verdict ?? "fail";
		const findings = structured?.findings ?? [
			{
				severity: "blocker",
				issue: "Reviewer did not return schema-valid evidence.",
				rationale: result.output,
			},
		];
		if (result.state === "succeeded" && machine.snapshot.phase === "active") {
			machine.recordReview({
				owner: machine.snapshot.owner,
				itemId: item.itemId,
				verdict,
				workGeneration,
				findings: JSON.stringify(findings),
				now: this.#now(),
			});
			this.#onStateChange();
		}
		return { ...result, verdict, findings };
	}

	#executionLimits(params: Pick<GoalSubagentParams, "timeoutMs" | "turnBudget" | "context">): {
		timeoutMs: number;
		turnBudget: { maxTurns: number; graceTurns: number };
		context: "fresh" | "fork";
	} {
		return {
			timeoutMs: boundedInteger(
				params.timeoutMs,
				DEFAULT_CHILD_TIMEOUT_MS,
				1,
				GOAL_LIMITS.hardChildTimeoutMs,
				"timeoutMs",
			),
			turnBudget: {
				maxTurns: boundedInteger(
					params.turnBudget?.maxTurns,
					DEFAULT_CHILD_TURN_BUDGET.maxTurns,
					1,
					GOAL_LIMITS.maxTurns,
					"turnBudget.maxTurns",
				),
				graceTurns: boundedInteger(
					params.turnBudget?.graceTurns,
					DEFAULT_CHILD_TURN_BUDGET.graceTurns,
					0,
					GOAL_LIMITS.hardGraceTurns,
					"turnBudget.graceTurns",
				),
			},
			context: params.context ?? "fresh",
		};
	}

	#prepare(params: GoalSubagentParams, role: WorkRole) {
		const forms =
			Number(Boolean(params.agent || params.task)) +
			Number(Boolean(params.tasks)) +
			Number(Boolean(params.chain));
		if (forms !== 1) throw new GoalInvariantError("Provide exactly one of agent/task, tasks, or chain.");
		let mode: WorkMode;
		let tasks: GoalSubagentTask[];
		if (params.tasks) {
			mode = "parallel";
			tasks = params.tasks;
		} else if (params.chain) {
			mode = "chain";
			tasks = params.chain;
		} else {
			mode = "single";
			tasks = [{ agent: nonEmpty(params.agent, "agent"), task: nonEmpty(params.task, "task") }];
		}
		let sourceBytes = 0;
		let projectedGroupBytes = 0;
		for (const [index, raw] of tasks.entries()) {
			const task = nonEmpty(raw.task, `items[${index}].task`);
			const taskBytes = Buffer.byteLength(task, "utf8");
			if (taskBytes > GOAL_LIMITS.maxTaskBytes) {
				throw new GoalInvariantError(`Task ${index + 1} exceeds ${GOAL_LIMITS.maxTaskBytes} UTF-8 bytes.`);
			}
			sourceBytes = checkedAdd(sourceBytes, taskBytes, "Source task group");
			const placeholders = mode === "chain" ? placeholderCount(task) : 0;
			if (placeholders > GOAL_LIMITS.maxPlaceholdersPerChainTask) {
				throw new GoalInvariantError(
					`Chain task ${index + 1} has more than ${GOAL_LIMITS.maxPlaceholdersPerChainTask} {previous} placeholders.`,
				);
			}
			const projected = checkedAdd(
				taskBytes - placeholders * Buffer.byteLength("{previous}", "utf8"),
				placeholders * GOAL_LIMITS.maxRetainedChildOutputBytes,
				"Projected chain task",
			);
			if (projected > GOAL_LIMITS.maxExpandedTaskBytes) {
				throw new GoalInvariantError(
					`Projected chain task ${index + 1} exceeds ${GOAL_LIMITS.maxExpandedTaskBytes} UTF-8 bytes.`,
				);
			}
			projectedGroupBytes = checkedAdd(projectedGroupBytes, projected, "Projected chain group");
			if (sourceBytes > GOAL_LIMITS.maxSourceTaskGroupBytes) {
				throw new GoalInvariantError(
					`Source task group exceeds ${GOAL_LIMITS.maxSourceTaskGroupBytes} UTF-8 bytes.`,
				);
			}
		}
		if (tasks.length < 1 || tasks.length > MAX_GROUP_ITEMS) {
			throw new GoalInvariantError(`Subagent groups must contain 1-${MAX_GROUP_ITEMS} items.`);
		}
		if (sourceBytes > GOAL_LIMITS.maxSourceTaskGroupBytes) {
			throw new GoalInvariantError(
				`Source task group exceeds ${GOAL_LIMITS.maxSourceTaskGroupBytes} UTF-8 bytes.`,
			);
		}
		if (projectedGroupBytes > GOAL_LIMITS.maxExpandedChainGroupBytes) {
			throw new GoalInvariantError(
				`Projected chain group exceeds ${GOAL_LIMITS.maxExpandedChainGroupBytes} UTF-8 bytes.`,
			);
		}
		const workGeneration = this.#machine().snapshot.workGeneration;
		const items = tasks.map(
			(raw, index): PreparedWork => ({
				itemId: this.#newId(),
				mode,
				role,
				task: {
					agent: nonEmpty(raw.agent, `items[${index}].agent`),
					task: nonEmpty(raw.task, `items[${index}].task`),
					...(raw.label?.trim() ? { label: raw.label.trim() } : {}),
					...(raw.model?.trim() ? { model: raw.model.trim() } : {}),
					...(raw.thinking ? { thinking: raw.thinking } : {}),
				},
				result: { kind: "text" },
				workGeneration,
			}),
		);
		return {
			mode,
			items,
			concurrency: boundedInteger(
				params.concurrency,
				MAX_PARALLEL_CONCURRENCY,
				1,
				MAX_PARALLEL_CONCURRENCY,
				"concurrency",
			),
		};
	}

	#admit(item: PreparedWork): void {
		try {
			this.#machine().admitWork({
				itemId: item.itemId,
				mode: item.mode,
				role: item.role,
				label: item.task.label ?? item.task.agent,
				now: this.#now(),
			});
		} finally {
			this.#onStateChange();
		}
	}

	async #execute(
		item: PreparedWork,
		execution: {
			timeoutMs: number;
			turnBudget: { maxTurns: number; graceTurns: number };
			context: "fresh" | "fork";
		},
		signal: AbortSignal | undefined,
		cwd: string,
		taskOverride: string | undefined,
		deadline: number,
	): Promise<GoalWorkResult> {
		const machine = this.#machine();
		const owner = machine.snapshot.owner;
		const remaining = deadline - this.#now();
		let response: ForegroundTerminal;
		try {
			if (remaining < 1) {
				response = {
					requestId: "call-deadline",
					ownerRunId: ownerRunId(owner),
					nodeId: item.itemId,
					status: "timed_out",
					error: "Goal subagent call deadline elapsed before this item could start.",
				};
			} else {
				response = await this.#port.runForeground(
					{
						ownerRunId: ownerRunId(owner),
						nodeId: item.itemId,
						agent: item.task.agent,
						task: taskOverride ?? item.task.task,
						context: execution.context,
						cwd,
						...(item.task.model ? { model: item.task.model } : {}),
						...(item.task.thinking ? { thinking: item.task.thinking } : {}),
						timeoutMs: remaining,
						turnBudget: execution.turnBudget,
						result: item.result,
					},
					signal,
					{
						onStarted: () => {
							machine.startWork(owner, item.itemId, this.#now());
							this.#onStateChange();
						},
					},
				);
			}
			if (!response || typeof response !== "object" || typeof response.status !== "string") {
				throw new GoalInvariantError("Malformed foreground terminal response.");
			}
			delegationStatusToWorkState(response.status as ForegroundTerminal["status"]);
		} catch (error) {
			response = {
				requestId: "bridge-error",
				ownerRunId: ownerRunId(owner),
				nodeId: item.itemId,
				status: signal?.aborted ? "interrupted" : "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		let output: string;
		let state: TerminalWorkState;
		let externalTokens: number;
		try {
			output = clampOutput(terminalOutput(response));
			state = delegationStatusToWorkState(response.status);
			externalTokens = terminalTokenUsage(response);
			if (!Number.isSafeInteger(externalTokens) || externalTokens < 0) {
				throw new GoalInvariantError("Malformed foreground terminal usage.");
			}
		} catch (error) {
			response = {
				requestId: "runner-normalization-error",
				ownerRunId: ownerRunId(owner),
				nodeId: item.itemId,
				status: signal?.aborted ? "interrupted" : "failed",
				error: error instanceof Error ? error.message : String(error),
			};
			output = clampOutput(response.error ?? "Malformed foreground terminal response.");
			state = delegationStatusToWorkState(response.status);
			externalTokens = 0;
		}
		const ackToken = this.#newToken();
		machine.recordExternalTokens(externalTokens, this.#now());
		machine.terminalWork({
			owner,
			itemId: item.itemId,
			outcome: state,
			output,
			ackToken,
			now: this.#now(),
		});
		this.#onOutput(item.itemId, output);
		this.#onStateChange();
		return {
			itemId: item.itemId,
			label: item.task.label ?? item.task.agent,
			state,
			ackToken,
			output,
			...(response.runId ? { runId: response.runId } : {}),
			response,
		};
	}

	async #runParallel(
		items: PreparedWork[],
		concurrency: number,
		execution: {
			timeoutMs: number;
			turnBudget: { maxTurns: number; graceTurns: number };
			context: "fresh" | "fork";
		},
		signal: AbortSignal | undefined,
		cwd: string,
		deadline: number,
	): Promise<GoalWorkResult[]> {
		const results = new Array<GoalWorkResult>(items.length);
		const queue = items.entries();
		const worker = async () => {
			for (;;) {
				const next = queue.next();
				if (next.done) return;
				const [index, item] = next.value;
				results[index] = await this.#execute(item, execution, signal, cwd, undefined, deadline);
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
		return results;
	}

	async #runChain(
		items: PreparedWork[],
		execution: {
			timeoutMs: number;
			turnBudget: { maxTurns: number; graceTurns: number };
			context: "fresh" | "fork";
		},
		signal: AbortSignal | undefined,
		cwd: string,
		deadline: number,
	): Promise<GoalWorkResult[]> {
		const results: GoalWorkResult[] = [];
		let previous = "";
		for (const item of items) {
			if (results.some((result) => result.state !== "succeeded")) {
				const output = `Skipped because an earlier chain item did not succeed.`;
				const ackToken = this.#newToken();
				const response: ForegroundTerminal = {
					requestId: "chain-skip",
					ownerRunId: ownerRunId(this.#machine().snapshot.owner),
					nodeId: item.itemId,
					status: "cancelled",
					error: output,
				};
				this.#machine().terminalWork({
					owner: this.#machine().snapshot.owner,
					itemId: item.itemId,
					outcome: "stopped",
					output,
					ackToken,
					now: this.#now(),
				});
				this.#onOutput(item.itemId, output);
				this.#onStateChange();
				results.push({
					itemId: item.itemId,
					label: item.task.label ?? item.task.agent,
					state: "stopped",
					ackToken,
					output,
					response,
				});
				continue;
			}
			const task = boundedChainExpansion(item.task.task, previous);
			const result = await this.#execute(item, execution, signal, cwd, task, deadline);
			results.push(result);
			previous = result.output;
		}
		return results;
	}

	#aggregate(mode: WorkMode, items: GoalWorkResult[], owner: OwnerIdentity): GoalRunResult {
		const render = (previews: string[]) =>
			[
				`pi-subagents foreground ${mode} finished with ${items.length} item(s).`,
				...items.flatMap((item, index) => [
					"",
					`[${item.itemId}] ${item.label}: ${item.state}`,
					previews[index] ?? "",
				]),
				"",
				"Acknowledgement tokens (never truncated):",
				...items.map((item) => `- ${item.itemId}: ${item.ackToken}`),
				"",
				"After considering every output, call goal_ack_output with each exact item ID and acknowledgement token. Unsuccessful items also require goal_resolve before review.",
			].join("\n");
		const previewLimit = equalPreviewByteLimit({
			fixedText: render(items.map(() => "")),
			itemCount: items.length,
			perTruncatedItemMarker: PREVIEW_TRUNCATION_MARKER,
		});
		const previews = items.map((item) => {
			const preview = truncateUtf8(item.output, previewLimit);
			return preview.truncated ? `${preview.text}${PREVIEW_TRUNCATION_MARKER}` : preview.text;
		});
		const text = render(previews);
		if (utf8ByteLength(text) > MAX_MODEL_TEXT_BYTES) {
			throw new GoalInvariantError("Bounded foreground aggregate exceeded its UTF-8 safety budget.");
		}
		return {
			mode,
			items,
			text,
			details: {
				version: 2,
				goalId: owner.goalId,
				epoch: owner.epoch,
				lineageId: owner.lineageId,
				itemIds: items.map((item) => item.itemId),
				acknowledgements: items.map((item) => ({ itemId: item.itemId, ackToken: item.ackToken })),
			},
		};
	}
}
