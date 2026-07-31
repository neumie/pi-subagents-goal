import { randomUUID } from "node:crypto";
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

const DEFAULT_CHILD_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_CHILD_TURN_BUDGET = Object.freeze({ maxTurns: 24, graceTurns: 2 });
const MAX_GROUP_ITEMS = 8;
const MAX_PARALLEL_CONCURRENCY = 4;
const MAX_RESULT_BYTES = 40_000;
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

function finitePositiveInteger(value: number | undefined, fallback: number, field: string): number {
	const candidate = value ?? fallback;
	if (!Number.isSafeInteger(candidate) || candidate < 1)
		throw new GoalInvariantError(`${field} must be an integer >= 1.`);
	return candidate;
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
	if (!usage) return 0;
	return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce(
		(total, value) => total + (Number.isFinite(value) && value > 0 ? value : 0),
		0,
	);
}

function validReview(value: unknown): { verdict: "pass" | "fail"; findings: unknown[] } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as { verdict?: unknown; findings?: unknown };
	if ((candidate.verdict !== "pass" && candidate.verdict !== "fail") || !Array.isArray(candidate.findings))
		return undefined;
	return { verdict: candidate.verdict, findings: candidate.findings };
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
						file: { type: "string" },
						issue: { type: "string" },
						rationale: { type: "string" },
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
		for (const item of prepared.items) this.#admit(item);
		let results: GoalWorkResult[];
		if (prepared.mode === "parallel") {
			results = await this.#runParallel(prepared.items, prepared.concurrency, params, signal, cwd);
		} else if (prepared.mode === "chain") {
			results = await this.#runChain(prepared.items, params, signal, cwd);
		} else {
			const single = prepared.items[0];
			if (!single) throw new GoalInvariantError("Single foreground work requires exactly one item.");
			results = [await this.#execute(single, params, signal, cwd)];
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
		this.#admit(item);
		const result = await this.#execute(
			item,
			{ context: "fresh", ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) },
			input.signal,
			input.cwd,
		);
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
		if (tasks.length < 1 || tasks.length > MAX_GROUP_ITEMS) {
			throw new GoalInvariantError(`Subagent groups must contain 1-${MAX_GROUP_ITEMS} items.`);
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
			concurrency: Math.min(
				MAX_PARALLEL_CONCURRENCY,
				finitePositiveInteger(params.concurrency, MAX_PARALLEL_CONCURRENCY, "concurrency"),
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
		params: Pick<GoalSubagentParams, "context" | "timeoutMs" | "turnBudget">,
		signal: AbortSignal | undefined,
		cwd: string,
		taskOverride?: string,
	): Promise<GoalWorkResult> {
		const machine = this.#machine();
		const owner = machine.snapshot.owner;
		const timeoutMs = finitePositiveInteger(params.timeoutMs, DEFAULT_CHILD_TIMEOUT_MS, "timeoutMs");
		const turnBudget = {
			maxTurns: finitePositiveInteger(
				params.turnBudget?.maxTurns,
				DEFAULT_CHILD_TURN_BUDGET.maxTurns,
				"turnBudget.maxTurns",
			),
			graceTurns: finitePositiveInteger(
				params.turnBudget?.graceTurns,
				DEFAULT_CHILD_TURN_BUDGET.graceTurns,
				"turnBudget.graceTurns",
			),
		};
		let response: ForegroundTerminal;
		try {
			response = await this.#port.runForeground(
				{
					ownerRunId: ownerRunId(owner),
					nodeId: item.itemId,
					agent: item.task.agent,
					task: taskOverride ?? item.task.task,
					context: params.context ?? "fresh",
					cwd,
					...(item.task.model ? { model: item.task.model } : {}),
					...(item.task.thinking ? { thinking: item.task.thinking } : {}),
					timeoutMs,
					turnBudget,
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
		} catch (error) {
			response = {
				requestId: "bridge-error",
				ownerRunId: ownerRunId(owner),
				nodeId: item.itemId,
				status: signal?.aborted ? "interrupted" : "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		const output = clampOutput(terminalOutput(response));
		const state = delegationStatusToWorkState(response.status);
		const ackToken = this.#newToken();
		machine.recordExternalTokens(terminalTokenUsage(response), this.#now());
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
		params: GoalSubagentParams,
		signal: AbortSignal | undefined,
		cwd: string,
	): Promise<GoalWorkResult[]> {
		const results = new Array<GoalWorkResult>(items.length);
		const queue = items.entries();
		const worker = async () => {
			for (;;) {
				const next = queue.next();
				if (next.done) return;
				const [index, item] = next.value;
				results[index] = await this.#execute(item, params, signal, cwd);
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
		return results;
	}

	async #runChain(
		items: PreparedWork[],
		params: GoalSubagentParams,
		signal: AbortSignal | undefined,
		cwd: string,
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
			const task = item.task.task.replaceAll("{previous}", previous);
			const result = await this.#execute(item, params, signal, cwd, task);
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
