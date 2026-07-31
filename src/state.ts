import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export const GOAL_STATE_VERSION = 1 as const;

export const DEFAULT_BUDGET_LIMITS = Object.freeze({
	maxAutomaticTurns: 20,
	maxTokens: null,
	maxWallClockMs: null,
	maxNoProgressTurns: 3,
} satisfies BudgetLimits);

export type GoalPhase =
	| "active"
	| "paused"
	| "cancelling"
	| "cancelled"
	| "completed"
	| "budget_exhausted"
	| "faulted";

export type WorkState =
	| "queued"
	| "running"
	| "needs_attention"
	| "paused"
	| "stopping"
	| "succeeded"
	| "failed"
	| "timed_out"
	| "stopped"
	| "interrupted"
	| "budget_exhausted"
	| "unknown";

export type TerminalWorkState = Extract<
	WorkState,
	"succeeded" | "failed" | "timed_out" | "stopped" | "interrupted" | "budget_exhausted" | "unknown"
>;

export type OutputState = "awaiting" | "pending_surface" | "surfaced" | "consumed";
export type WorkMode = "single" | "parallel" | "chain";
export type WorkRole = "work" | "review";

export interface OwnerIdentity {
	sessionId: string;
	sessionFile: string | null;
	lineageId: string;
	goalId: string;
	epoch: number;
}

export interface BudgetLimits {
	maxAutomaticTurns: number;
	maxTokens: number | null;
	maxWallClockMs: number | null;
	maxNoProgressTurns: number;
}

export interface BudgetUsage {
	automaticTurns: number;
	tokens: number;
	noProgressTurns: number;
	lastProgressSignature?: string;
}

export interface WorkItem {
	itemId: string;
	attempt: number;
	provider: "pi-subagents";
	mode: WorkMode;
	role: WorkRole;
	label: string;
	state: WorkState;
	outputState: OutputState;
	ackToken?: string;
	outputDigest?: string;
	considerationDigest?: string;
	resolutionDigest?: string;
	admittedAt: number;
	startedAt?: number;
	terminalAt?: number;
	workVersion: number;
}

export interface ContinuationTicket {
	goalId: string;
	epoch: number;
	sequence: number;
	nonce: string;
	expectedWorkGeneration: number;
	outputItemIds: string[];
	kind: "initial" | "automatic";
}

export interface ContinuationState {
	status: "reserved" | "queued" | "running";
	ticket: ContinuationTicket;
}

export interface ReviewEvidence {
	itemId: string;
	verdict: "pass" | "fail";
	workGeneration: number;
	findingsDigest: string;
}

export interface GoalSnapshot {
	version: typeof GOAL_STATE_VERSION;
	owner: OwnerIdentity;
	objectiveDigest: string;
	phase: GoalPhase;
	pauseReason?: string;
	faultReason?: string;
	startedAt: number;
	updatedAt: number;
	revision: number;
	workGeneration: number;
	continuationSequence: number;
	parentSettled: boolean;
	currentRunAutomatic: boolean;
	currentRunEndObserved: boolean;
	budgetLimits: BudgetLimits;
	budgetUsage: BudgetUsage;
	work: WorkItem[];
	continuation?: ContinuationState;
	review?: ReviewEvidence;
	staleEventCount: number;
}

export interface WorkAdmission {
	itemId: string;
	attempt?: number;
	mode: WorkMode;
	role?: WorkRole;
	label: string;
	now: number;
}

export interface WorkTerminal {
	owner: OwnerIdentity;
	itemId: string;
	attempt?: number;
	outcome: TerminalWorkState;
	output: string;
	ackToken: string;
	now: number;
}

export interface CompletionRequest {
	owner: OwnerIdentity;
	consideredItemIds: string[];
	now: number;
}

export interface CompletionDecision {
	ok: boolean;
	blockers: string[];
}

const ACTIVE_WORK_STATES = new Set<WorkState>(["queued", "running", "needs_attention", "paused", "stopping"]);
const TERMINAL_WORK_STATES = new Set<WorkState>([
	"succeeded",
	"failed",
	"timed_out",
	"stopped",
	"interrupted",
	"budget_exhausted",
	"unknown",
]);
const GOAL_PHASES = new Set<GoalPhase>([
	"active",
	"paused",
	"cancelling",
	"cancelled",
	"completed",
	"budget_exhausted",
	"faulted",
]);
const OUTPUT_STATES = new Set<OutputState>(["awaiting", "pending_surface", "surfaced", "consumed"]);
const WORK_MODES = new Set<WorkMode>(["single", "parallel", "chain"]);
const WORK_ROLES = new Set<WorkRole>(["work", "review"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validWireValue(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value &&
		!/[\r\n\0]/u.test(value)
	);
}

function validSessionFile(value: unknown): value is string | null {
	return (
		value === null ||
		(typeof value === "string" && value.length > 0 && value.length <= 4_096 && !/[\r\n\0]/u.test(value))
	);
}

export class GoalInvariantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalInvariantError";
	}
}

export function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function newAckToken(): string {
	return randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
}

export function exactOwnerMatch(left: OwnerIdentity, right: OwnerIdentity): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.sessionFile === right.sessionFile &&
		left.lineageId === right.lineageId &&
		left.goalId === right.goalId &&
		left.epoch === right.epoch
	);
}

export function isTerminalWorkState(state: WorkState): state is TerminalWorkState {
	return TERMINAL_WORK_STATES.has(state);
}

export function isActiveWorkState(state: WorkState): boolean {
	return ACTIVE_WORK_STATES.has(state);
}

function safeTokenEqual(left: string | undefined, right: string): boolean {
	if (!left) return false;
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function cloneSnapshot(snapshot: GoalSnapshot): GoalSnapshot {
	return structuredClone(snapshot);
}

function assertFinitePositiveInteger(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new GoalInvariantError(`${field} must be a finite integer >= 1.`);
	}
}

function validateBudgetLimits(limits: BudgetLimits): void {
	assertFinitePositiveInteger(limits.maxAutomaticTurns, "maxAutomaticTurns");
	if (limits.maxTokens !== null) assertFinitePositiveInteger(limits.maxTokens, "maxTokens");
	if (limits.maxWallClockMs !== null) assertFinitePositiveInteger(limits.maxWallClockMs, "maxWallClockMs");
	assertFinitePositiveInteger(limits.maxNoProgressTurns, "maxNoProgressTurns");
}

export function createGoalSnapshot(input: {
	owner: OwnerIdentity;
	objective: string;
	now: number;
	budgetLimits?: Partial<BudgetLimits>;
}): GoalSnapshot {
	const limits = { ...DEFAULT_BUDGET_LIMITS, ...input.budgetLimits };
	validateBudgetLimits(limits);
	if (!input.objective.trim()) throw new GoalInvariantError("Goal objective must not be empty.");
	if (!input.owner.sessionId || !input.owner.lineageId || !input.owner.goalId || input.owner.epoch < 1) {
		throw new GoalInvariantError("Goal owner identity is incomplete.");
	}
	return {
		version: GOAL_STATE_VERSION,
		owner: structuredClone(input.owner),
		objectiveDigest: sha256(input.objective),
		phase: "active",
		startedAt: input.now,
		updatedAt: input.now,
		revision: 0,
		workGeneration: 0,
		continuationSequence: 0,
		parentSettled: true,
		currentRunAutomatic: false,
		currentRunEndObserved: false,
		budgetLimits: limits,
		budgetUsage: { automaticTurns: 0, tokens: 0, noProgressTurns: 0 },
		work: [],
		staleEventCount: 0,
	};
}

export class GoalMachine {
	readonly #state: GoalSnapshot;

	constructor(snapshot: GoalSnapshot) {
		this.#state = cloneSnapshot(snapshot);
		this.#assertSnapshot();
	}

	get snapshot(): GoalSnapshot {
		return cloneSnapshot(this.#state);
	}

	queueInitialContinuation(now: number): ContinuationTicket {
		if (this.#state.phase !== "active" || this.#state.continuation) {
			throw new GoalInvariantError("Initial continuation cannot be queued in the current state.");
		}
		const ticket = this.#newTicket("initial", []);
		this.#state.continuation = { status: "queued", ticket };
		this.#state.parentSettled = false;
		this.#state.currentRunEndObserved = false;
		this.#touch(now);
		return structuredClone(ticket);
	}

	agentStarted(now: number, continuationNonce?: string): boolean {
		if (this.#state.phase !== "active") return false;
		const continuation = this.#state.continuation;
		if (continuation?.status === "running" || (!continuation && !this.#state.parentSettled)) {
			return false;
		}
		if (continuation?.status === "reserved") return false;
		if (continuation?.status === "queued" && !safeTokenEqual(continuationNonce, continuation.ticket.nonce)) {
			return false;
		}
		const queued = this.#state.continuation;
		if (queued?.status === "queued") {
			queued.status = "running";
			this.#state.currentRunAutomatic = queued.ticket.kind === "automatic";
		} else {
			this.#state.currentRunAutomatic = false;
		}
		this.#state.parentSettled = false;
		this.#state.currentRunEndObserved = false;
		this.#touch(now);
		return true;
	}

	agentEnded(now: number, continuationNonce?: string): boolean {
		const continuation = this.#state.continuation;
		if (
			this.#state.phase !== "active" ||
			this.#state.parentSettled ||
			this.#state.currentRunEndObserved ||
			continuation?.status === "queued" ||
			continuation?.status === "reserved" ||
			(continuation?.status === "running" && continuationNonce !== continuation.ticket.nonce)
		) {
			return false;
		}
		this.#state.currentRunEndObserved = true;
		this.#touch(now);
		return true;
	}

	recordTurn(input: { tokens: number; progressSignature: string; now: number }): void {
		if (!this.#canAccountUsage()) return;
		const tokens = Number.isFinite(input.tokens) && input.tokens > 0 ? Math.floor(input.tokens) : 0;
		const usage = this.#state.budgetUsage;
		usage.tokens += tokens;
		if (this.#state.currentRunAutomatic) {
			usage.automaticTurns += 1;
			if (usage.lastProgressSignature === input.progressSignature) usage.noProgressTurns += 1;
			else {
				usage.lastProgressSignature = input.progressSignature;
				usage.noProgressTurns = 0;
			}
		}
		this.#enforceBudgets(input.now);
		this.#touch(input.now);
	}

	recordExternalTokens(tokens: number, now: number): void {
		if (!this.#canAccountUsage()) return;
		if (Number.isFinite(tokens) && tokens > 0) this.#state.budgetUsage.tokens += Math.floor(tokens);
		this.#enforceBudgets(now);
		this.#touch(now);
	}

	agentSettled(now: number): ContinuationTicket | undefined {
		if (
			this.#state.phase !== "active" ||
			this.#state.parentSettled ||
			!this.#state.currentRunEndObserved ||
			this.#state.continuation?.status === "queued" ||
			this.#state.continuation?.status === "reserved"
		) {
			return undefined;
		}
		if (this.#state.continuation?.status === "running") delete this.#state.continuation;
		this.#state.currentRunAutomatic = false;
		this.#state.currentRunEndObserved = false;
		this.#state.parentSettled = true;
		this.#enforceBudgets(now);
		this.#touch(now);
		return this.reserveContinuation(now);
	}

	admitWork(input: WorkAdmission): WorkItem {
		this.#enforceBudgets(input.now);
		this.#assertActive("admit work");
		const continuation = this.#state.continuation;
		if (continuation?.status === "queued") {
			return this.#faultAndThrow("New work appeared after a continuation was queued.", input.now);
		}
		if (continuation?.status === "reserved") delete this.#state.continuation;
		if (this.#state.work.some((item) => item.itemId === input.itemId)) {
			throw new GoalInvariantError(`Duplicate work item ID: ${input.itemId}.`);
		}
		const role = input.role ?? "work";
		if (role === "work") {
			this.#state.workGeneration += 1;
			delete this.#state.review;
		}
		const item: WorkItem = {
			itemId: input.itemId,
			attempt: input.attempt ?? 1,
			provider: "pi-subagents",
			mode: input.mode,
			role,
			label: input.label.slice(0, 200),
			state: "queued",
			outputState: "awaiting",
			admittedAt: input.now,
			workVersion: this.#state.workGeneration,
		};
		this.#state.work.push(item);
		this.#state.parentSettled = false;
		this.#touch(input.now);
		return structuredClone(item);
	}

	startWork(owner: OwnerIdentity, itemId: string, now: number): boolean {
		const item = this.#ownedItem(owner, itemId);
		if (!item) return false;
		if (item.state === "running") return true;
		if (item.state !== "queued" && item.state !== "needs_attention" && item.state !== "paused") {
			this.#fault(`Invalid work start transition for ${itemId}: ${item.state}.`, now);
			return false;
		}
		item.state = "running";
		item.startedAt ??= now;
		this.#touch(now);
		return true;
	}

	markNeedsAttention(owner: OwnerIdentity, itemId: string, now: number): boolean {
		const item = this.#ownedItem(owner, itemId);
		if (!item) return false;
		if (item.state !== "queued" && item.state !== "running") {
			this.#fault(`Invalid needs-attention transition for ${itemId}: ${item.state}.`, now);
			return false;
		}
		item.state = "needs_attention";
		this.#touch(now);
		return true;
	}

	pauseWork(owner: OwnerIdentity, itemId: string, now: number): boolean {
		const item = this.#ownedItem(owner, itemId);
		if (!item) return false;
		if (item.state !== "running" && item.state !== "needs_attention") {
			this.#fault(`Invalid work pause transition for ${itemId}: ${item.state}.`, now);
			return false;
		}
		item.state = "paused";
		this.#touch(now);
		return true;
	}

	requestStop(owner: OwnerIdentity, itemId: string, now: number): boolean {
		const item = this.#ownedItem(owner, itemId);
		if (!item) return false;
		if (!isActiveWorkState(item.state)) return false;
		item.state = "stopping";
		this.#touch(now);
		return true;
	}

	terminalWork(input: WorkTerminal): boolean {
		const item = this.#ownedItem(input.owner, input.itemId);
		if (!item) return false;
		if (item.attempt !== (input.attempt ?? 1)) return this.#recordStale();
		if (isTerminalWorkState(item.state)) {
			if (item.state === input.outcome && item.outputDigest === sha256(input.output)) return true;
			this.#fault(`Conflicting terminal event for ${item.itemId}.`, input.now);
			return false;
		}
		item.state = input.outcome;
		item.outputState = "pending_surface";
		item.outputDigest = sha256(input.output);
		item.ackToken = input.ackToken;
		item.terminalAt = input.now;
		this.#touch(input.now);
		if (
			this.#state.phase === "cancelling" &&
			this.#state.work.every((candidate) => !isActiveWorkState(candidate.state))
		) {
			this.#state.phase = "cancelled";
		}
		return true;
	}

	markOutputSurfaced(owner: OwnerIdentity, itemIds: readonly string[], now: number): boolean {
		if (!exactOwnerMatch(owner, this.#state.owner)) return this.#recordStale();
		for (const itemId of itemIds) {
			const item = this.#state.work.find((candidate) => candidate.itemId === itemId);
			if (!item || !isTerminalWorkState(item.state)) return false;
			if (item.outputState === "pending_surface") item.outputState = "surfaced";
		}
		this.#touch(now);
		return true;
	}

	acknowledgeOutput(input: {
		owner: OwnerIdentity;
		itemId: string;
		ackToken: string;
		consideration: string;
		now: number;
	}): boolean {
		const item = this.#ownedItem(input.owner, input.itemId);
		if (!item || !isTerminalWorkState(item.state) || item.outputState !== "surfaced") return false;
		if (!safeTokenEqual(item.ackToken, input.ackToken)) return false;
		if (!input.consideration.trim()) return false;
		item.outputState = "consumed";
		item.considerationDigest = sha256(input.consideration);
		this.#touch(input.now);
		return true;
	}

	resolveUnsuccessfulWork(input: {
		owner: OwnerIdentity;
		itemId: string;
		rationale: string;
		now: number;
	}): boolean {
		const item = this.#ownedItem(input.owner, input.itemId);
		if (!item || !isTerminalWorkState(item.state) || item.state === "succeeded") return false;
		if (item.outputState !== "consumed" || !input.rationale.trim()) return false;
		item.resolutionDigest = sha256(input.rationale);
		this.#state.workGeneration += 1;
		delete this.#state.review;
		this.#touch(input.now);
		return true;
	}

	recordReview(input: {
		owner: OwnerIdentity;
		itemId: string;
		verdict: "pass" | "fail";
		workGeneration: number;
		findings: string;
		now: number;
	}): boolean {
		const item = this.#ownedItem(input.owner, input.itemId);
		if (
			item?.role !== "review" ||
			item.state !== "succeeded" ||
			input.workGeneration !== this.#state.workGeneration
		) {
			return false;
		}
		this.#state.review = {
			itemId: input.itemId,
			verdict: input.verdict,
			workGeneration: input.workGeneration,
			findingsDigest: sha256(input.findings),
		};
		this.#touch(input.now);
		return true;
	}

	reserveContinuation(now: number): ContinuationTicket | undefined {
		if (!this.#eligibleForContinuation(now)) return undefined;
		const outputItemIds = this.#state.work.flatMap((item) =>
			item.outputState === "pending_surface" ? [item.itemId] : [],
		);
		const ticket = this.#newTicket("automatic", outputItemIds);
		this.#state.continuation = { status: "reserved", ticket };
		this.#touch(now);
		return structuredClone(ticket);
	}

	commitContinuation(ticket: ContinuationTicket, now: number): boolean {
		const current = this.#state.continuation;
		if (current?.status !== "reserved" || current.ticket.nonce !== ticket.nonce) return false;
		if (
			current.ticket.expectedWorkGeneration !== this.#state.workGeneration ||
			!this.#eligibleForCommit(now)
		) {
			delete this.#state.continuation;
			this.#touch(now);
			return false;
		}
		if (!this.markOutputSurfaced(this.#state.owner, current.ticket.outputItemIds, now)) return false;
		current.status = "queued";
		this.#state.parentSettled = false;
		this.#touch(now);
		return true;
	}

	releaseContinuation(ticket: ContinuationTicket, now: number): boolean {
		const current = this.#state.continuation;
		if (current?.status !== "reserved" || current.ticket.nonce !== ticket.nonce) return false;
		delete this.#state.continuation;
		this.#touch(now);
		return true;
	}

	completionDecision(input: CompletionRequest): CompletionDecision {
		const blockers: string[] = [];
		if (!exactOwnerMatch(input.owner, this.#state.owner)) blockers.push("owner identity does not match");
		if (this.#state.phase !== "active") blockers.push(`goal phase is ${this.#state.phase}`);
		this.#enforceBudgets(input.now);
		if (this.#state.phase === "budget_exhausted") blockers.push("a finite goal budget is exhausted");
		const active = this.#state.work.filter((item) => isActiveWorkState(item.state));
		if (active.length > 0) blockers.push(`nonterminal work: ${active.map((item) => item.itemId).join(", ")}`);
		const unread = this.#state.work.filter(
			(item) => isTerminalWorkState(item.state) && item.outputState !== "consumed",
		);
		if (unread.length > 0)
			blockers.push(`unconsumed output: ${unread.map((item) => item.itemId).join(", ")}`);
		const unresolved = this.#state.work.filter(
			(item) => isTerminalWorkState(item.state) && item.state !== "succeeded" && !item.resolutionDigest,
		);
		if (unresolved.length > 0)
			blockers.push(`unresolved unsuccessful work: ${unresolved.map((item) => item.itemId).join(", ")}`);
		const expectedIds = new Set(this.#state.work.map((item) => item.itemId));
		const considered = new Set(input.consideredItemIds);
		const omitted = [...expectedIds].filter((itemId) => !considered.has(itemId));
		const unexpected = [...considered].filter((itemId) => !expectedIds.has(itemId));
		if (omitted.length > 0) blockers.push(`completion omitted work items: ${omitted.join(", ")}`);
		if (unexpected.length > 0)
			blockers.push(`completion included unknown work items: ${unexpected.join(", ")}`);
		if (considered.size !== input.consideredItemIds.length)
			blockers.push("completion repeated work item IDs");
		return { ok: blockers.length === 0, blockers };
	}

	complete(input: CompletionRequest): CompletionDecision {
		const decision = this.completionDecision(input);
		if (!decision.ok) return decision;
		this.#state.phase = "completed";
		delete this.#state.continuation;
		this.#state.parentSettled = true;
		this.#state.currentRunAutomatic = false;
		this.#state.currentRunEndObserved = false;
		this.#touch(input.now);
		return decision;
	}

	pause(reason: string, now: number): boolean {
		if (this.#state.phase !== "active") return false;
		this.#state.phase = "paused";
		this.#state.pauseReason = reason.slice(0, 500);
		this.#state.currentRunAutomatic = false;
		this.#state.currentRunEndObserved = false;
		delete this.#state.continuation;
		this.#touch(now);
		return true;
	}

	resume(now: number): boolean {
		if (this.#state.phase !== "paused") return false;
		if (this.#state.work.some((item) => isActiveWorkState(item.state))) return false;
		this.#state.phase = "active";
		delete this.#state.pauseReason;
		this.#state.parentSettled = true;
		this.#state.currentRunAutomatic = false;
		this.#state.currentRunEndObserved = false;
		this.#enforceBudgets(now);
		this.#touch(now);
		return this.#state.phase === "active";
	}

	cancel(now: number): GoalPhase {
		if (this.#state.phase === "completed" || this.#state.phase === "cancelled") return this.#state.phase;
		delete this.#state.continuation;
		this.#state.currentRunAutomatic = false;
		this.#state.currentRunEndObserved = false;
		this.#state.phase = this.#state.work.some((item) => isActiveWorkState(item.state))
			? "cancelling"
			: "cancelled";
		this.#touch(now);
		return this.#state.phase;
	}

	fault(reason: string, now: number): void {
		this.#fault(reason, now);
	}

	#ownedItem(owner: OwnerIdentity, itemId: string): WorkItem | undefined {
		if (!exactOwnerMatch(owner, this.#state.owner)) {
			this.#recordStale();
			return undefined;
		}
		return this.#state.work.find((item) => item.itemId === itemId);
	}

	#recordStale(): false {
		this.#state.staleEventCount += 1;
		this.#state.revision += 1;
		return false;
	}

	#newTicket(kind: ContinuationTicket["kind"], outputItemIds: string[]): ContinuationTicket {
		this.#state.continuationSequence += 1;
		return {
			goalId: this.#state.owner.goalId,
			epoch: this.#state.owner.epoch,
			sequence: this.#state.continuationSequence,
			nonce: newAckToken(),
			expectedWorkGeneration: this.#state.workGeneration,
			outputItemIds,
			kind,
		};
	}

	#eligibleForContinuation(now: number): boolean {
		if (!this.#eligibleForCommit(now) || this.#state.continuation) return false;
		return this.#state.parentSettled;
	}

	#eligibleForCommit(now: number): boolean {
		this.#enforceBudgets(now);
		if (this.#state.phase !== "active") return false;
		if (this.#state.work.some((item) => isActiveWorkState(item.state))) return false;
		return this.#state.work.every((item) => item.outputState !== "awaiting");
	}

	#enforceBudgets(now: number): void {
		if (this.#state.phase !== "active") return;
		const limits = this.#state.budgetLimits;
		const usage = this.#state.budgetUsage;
		const exhausted =
			usage.automaticTurns >= limits.maxAutomaticTurns ||
			(limits.maxTokens !== null && usage.tokens >= limits.maxTokens) ||
			usage.noProgressTurns >= limits.maxNoProgressTurns ||
			(limits.maxWallClockMs !== null && now - this.#state.startedAt >= limits.maxWallClockMs);
		if (!exhausted) return;
		this.#state.phase = "budget_exhausted";
		this.#state.pauseReason =
			"An enabled automatic-turn, token, wall-clock, or no-progress budget was exhausted.";
		this.#state.currentRunAutomatic = false;
		this.#state.currentRunEndObserved = false;
		delete this.#state.continuation;
	}

	#canAccountUsage(): boolean {
		return (
			this.#state.phase === "active" || this.#state.phase === "paused" || this.#state.phase === "cancelling"
		);
	}

	#assertActive(action: string): void {
		if (this.#state.phase !== "active") {
			throw new GoalInvariantError(`Cannot ${action} while goal phase is ${this.#state.phase}.`);
		}
	}

	#fault(reason: string, now: number): void {
		this.#state.phase = "faulted";
		this.#state.faultReason = reason.slice(0, 1_000);
		this.#state.currentRunAutomatic = false;
		this.#state.currentRunEndObserved = false;
		delete this.#state.continuation;
		this.#touch(now);
	}

	#faultAndThrow(message: string, now: number): never {
		this.#fault(message, now);
		throw new GoalInvariantError(message);
	}

	#touch(now: number): void {
		this.#state.updatedAt = now;
		this.#state.revision += 1;
	}

	#assertSnapshot(): void {
		const state = this.#state as unknown;
		if (!isRecord(state) || state.version !== GOAL_STATE_VERSION) {
			throw new GoalInvariantError("Unsupported goal state version.");
		}
		if (!isRecord(state.owner)) throw new GoalInvariantError("Persisted goal owner identity is missing.");
		const owner = state.owner;
		if (
			!validWireValue(owner.goalId) ||
			!validWireValue(owner.sessionId) ||
			!validSessionFile(owner.sessionFile) ||
			!validWireValue(owner.lineageId) ||
			!isSafeCounter(owner.epoch) ||
			owner.epoch < 1
		) {
			throw new GoalInvariantError("Persisted goal owner identity is incomplete.");
		}
		if (!isDigest(state.objectiveDigest))
			throw new GoalInvariantError("Persisted objective digest is invalid.");
		if (typeof state.phase !== "string" || !GOAL_PHASES.has(state.phase as GoalPhase)) {
			throw new GoalInvariantError("Persisted goal phase is invalid.");
		}
		for (const [field, value] of [
			["startedAt", state.startedAt],
			["updatedAt", state.updatedAt],
		] as const) {
			if (!isFiniteTimestamp(value)) throw new GoalInvariantError(`Persisted ${field} is invalid.`);
		}
		if (Number(state.updatedAt) < Number(state.startedAt)) {
			throw new GoalInvariantError("Persisted goal timestamps are out of order.");
		}
		for (const [field, limit] of [
			["pauseReason", 500],
			["faultReason", 1_000],
		] as const) {
			const value = state[field];
			if (value !== undefined && (typeof value !== "string" || value.length > limit)) {
				throw new GoalInvariantError(`Persisted ${field} is invalid.`);
			}
		}
		for (const [field, value] of [
			["revision", state.revision],
			["workGeneration", state.workGeneration],
			["continuationSequence", state.continuationSequence],
			["staleEventCount", state.staleEventCount],
		] as const) {
			if (!isSafeCounter(value)) throw new GoalInvariantError(`Persisted ${field} is invalid.`);
		}
		if (
			typeof state.parentSettled !== "boolean" ||
			typeof state.currentRunAutomatic !== "boolean" ||
			typeof state.currentRunEndObserved !== "boolean" ||
			(state.currentRunEndObserved && state.parentSettled)
		) {
			throw new GoalInvariantError("Persisted parent lifecycle state is invalid.");
		}
		if (!isRecord(state.budgetLimits)) throw new GoalInvariantError("Persisted budget limits are missing.");
		validateBudgetLimits(state.budgetLimits as unknown as BudgetLimits);
		if (!isRecord(state.budgetUsage)) throw new GoalInvariantError("Persisted budget usage is missing.");
		for (const field of ["automaticTurns", "tokens", "noProgressTurns"] as const) {
			if (!isSafeCounter(state.budgetUsage[field])) {
				throw new GoalInvariantError(`Persisted budget usage ${field} is invalid.`);
			}
		}
		if (
			state.budgetUsage.lastProgressSignature !== undefined &&
			typeof state.budgetUsage.lastProgressSignature !== "string"
		) {
			throw new GoalInvariantError("Persisted progress signature is invalid.");
		}
		if (!Array.isArray(state.work) || state.work.length > 10_000) {
			throw new GoalInvariantError("Persisted work ledger is invalid or too large.");
		}
		const identities = new Set<string>();
		for (const rawItem of state.work) {
			if (!isRecord(rawItem)) throw new GoalInvariantError("Persisted work item is invalid.");
			if (
				!validWireValue(rawItem.itemId) ||
				!isSafeCounter(rawItem.attempt) ||
				rawItem.attempt < 1 ||
				rawItem.provider !== "pi-subagents" ||
				typeof rawItem.mode !== "string" ||
				!WORK_MODES.has(rawItem.mode as WorkMode) ||
				typeof rawItem.role !== "string" ||
				!WORK_ROLES.has(rawItem.role as WorkRole) ||
				typeof rawItem.label !== "string" ||
				rawItem.label.length > 200 ||
				typeof rawItem.state !== "string" ||
				(!ACTIVE_WORK_STATES.has(rawItem.state as WorkState) &&
					!TERMINAL_WORK_STATES.has(rawItem.state as WorkState)) ||
				typeof rawItem.outputState !== "string" ||
				!OUTPUT_STATES.has(rawItem.outputState as OutputState) ||
				!isFiniteTimestamp(rawItem.admittedAt) ||
				!isSafeCounter(rawItem.workVersion) ||
				rawItem.workVersion > Number(state.workGeneration)
			) {
				throw new GoalInvariantError("Persisted work item fields are invalid.");
			}
			for (const field of ["outputDigest", "considerationDigest", "resolutionDigest"] as const) {
				const value = rawItem[field];
				if (value !== undefined && !isDigest(value)) {
					throw new GoalInvariantError(`Persisted work item ${field} is invalid.`);
				}
			}
			if (rawItem.ackToken !== undefined && !validWireValue(rawItem.ackToken)) {
				throw new GoalInvariantError("Persisted work item acknowledgement token is invalid.");
			}
			for (const field of ["startedAt", "terminalAt"] as const) {
				const value = rawItem[field];
				if (value !== undefined && !isFiniteTimestamp(value)) {
					throw new GoalInvariantError(`Persisted work item ${field} is invalid.`);
				}
			}
			const admittedAt = Number(rawItem.admittedAt);
			const startedAt = rawItem.startedAt === undefined ? undefined : Number(rawItem.startedAt);
			const terminalAt = rawItem.terminalAt === undefined ? undefined : Number(rawItem.terminalAt);
			if (
				admittedAt < Number(state.startedAt) ||
				admittedAt > Number(state.updatedAt) ||
				(startedAt !== undefined && (startedAt < admittedAt || startedAt > Number(state.updatedAt))) ||
				(terminalAt !== undefined &&
					(terminalAt < (startedAt ?? admittedAt) || terminalAt > Number(state.updatedAt)))
			) {
				throw new GoalInvariantError("Persisted work item timestamps are out of order.");
			}
			const active = ACTIVE_WORK_STATES.has(rawItem.state as WorkState);
			const terminal = TERMINAL_WORK_STATES.has(rawItem.state as WorkState);
			if (
				(active &&
					(rawItem.outputState !== "awaiting" ||
						rawItem.ackToken !== undefined ||
						rawItem.outputDigest !== undefined ||
						rawItem.considerationDigest !== undefined ||
						rawItem.resolutionDigest !== undefined ||
						terminalAt !== undefined)) ||
				(terminal &&
					(rawItem.outputState === "awaiting" ||
						!validWireValue(rawItem.ackToken) ||
						!isDigest(rawItem.outputDigest) ||
						terminalAt === undefined))
			) {
				throw new GoalInvariantError("Persisted work lifecycle evidence is inconsistent.");
			}
			if (
				(rawItem.outputState === "consumed" && !isDigest(rawItem.considerationDigest)) ||
				(rawItem.outputState !== "consumed" && rawItem.considerationDigest !== undefined)
			) {
				throw new GoalInvariantError("Persisted work consumption evidence is inconsistent.");
			}
			const unsuccessful = terminal && rawItem.state !== "succeeded";
			if (
				(rawItem.resolutionDigest !== undefined && (!unsuccessful || rawItem.outputState !== "consumed")) ||
				(rawItem.state === "succeeded" && rawItem.resolutionDigest !== undefined)
			) {
				throw new GoalInvariantError("Persisted work resolution evidence is inconsistent.");
			}
			if (identities.has(rawItem.itemId)) {
				throw new GoalInvariantError(`Duplicate persisted work item ID: ${rawItem.itemId}.`);
			}
			identities.add(rawItem.itemId);
		}
		if (state.continuation !== undefined) this.#assertContinuation(state.continuation);
		else if (this.#state.currentRunAutomatic) {
			throw new GoalInvariantError("Automatic parent run is missing its continuation identity.");
		}
		if (state.review !== undefined) this.#assertReview(state.review);
		const activeItems = this.#state.work.filter((item) => isActiveWorkState(item.state));
		if (this.#state.phase === "cancelled" && activeItems.length > 0) {
			throw new GoalInvariantError("Cancelled goal contains nonterminal work.");
		}
		if (this.#state.phase === "cancelling" && activeItems.length === 0) {
			throw new GoalInvariantError("Cancelling goal has no nonterminal work.");
		}
		if (this.#state.phase === "completed") {
			const incomplete = this.#state.work.some(
				(item) =>
					isActiveWorkState(item.state) ||
					item.outputState !== "consumed" ||
					(item.state !== "succeeded" && !item.resolutionDigest),
			);
			if (incomplete) {
				throw new GoalInvariantError("Completed goal contains incomplete goal-owned work.");
			}
		}
	}

	#assertContinuation(value: unknown): void {
		if (
			!isRecord(value) ||
			!["reserved", "queued", "running"].includes(String(value.status)) ||
			!isRecord(value.ticket)
		) {
			throw new GoalInvariantError("Persisted continuation is invalid.");
		}
		const ticket = value.ticket;
		if (
			ticket.goalId !== this.#state.owner.goalId ||
			ticket.epoch !== this.#state.owner.epoch ||
			!isSafeCounter(ticket.sequence) ||
			ticket.sequence < 1 ||
			ticket.sequence !== this.#state.continuationSequence ||
			!validWireValue(ticket.nonce) ||
			!isSafeCounter(ticket.expectedWorkGeneration) ||
			ticket.expectedWorkGeneration > this.#state.workGeneration ||
			(value.status !== "running" && ticket.expectedWorkGeneration !== this.#state.workGeneration) ||
			!Array.isArray(ticket.outputItemIds) ||
			!ticket.outputItemIds.every(validWireValue) ||
			new Set(ticket.outputItemIds).size !== ticket.outputItemIds.length ||
			(ticket.kind !== "initial" && ticket.kind !== "automatic") ||
			(ticket.kind === "initial" && ticket.outputItemIds.length > 0)
		) {
			throw new GoalInvariantError("Persisted continuation ticket is invalid.");
		}
		for (const itemId of ticket.outputItemIds) {
			const item = this.#state.work.find((candidate) => candidate.itemId === itemId);
			if (!item || !isTerminalWorkState(item.state) || item.outputState === "awaiting") {
				throw new GoalInvariantError("Persisted continuation references unavailable output.");
			}
		}
		if (
			this.#state.phase !== "active" ||
			(value.status === "reserved" && !this.#state.parentSettled) ||
			(value.status !== "reserved" && this.#state.parentSettled) ||
			(value.status !== "running" && this.#state.currentRunAutomatic) ||
			(value.status !== "running" && this.#state.currentRunEndObserved) ||
			(value.status === "running" && this.#state.currentRunAutomatic !== (ticket.kind === "automatic"))
		) {
			throw new GoalInvariantError("Persisted continuation parent lifecycle is inconsistent.");
		}
	}

	#assertReview(value: unknown): void {
		if (!isRecord(value)) throw new GoalInvariantError("Persisted review evidence is invalid.");
		if (
			!validWireValue(value.itemId) ||
			(value.verdict !== "pass" && value.verdict !== "fail") ||
			!isSafeCounter(value.workGeneration) ||
			value.workGeneration !== this.#state.workGeneration ||
			!isDigest(value.findingsDigest)
		) {
			throw new GoalInvariantError("Persisted review evidence fields are invalid.");
		}
		const item = this.#state.work.find((candidate) => candidate.itemId === value.itemId);
		if (item?.role !== "review" || item.state !== "succeeded") {
			throw new GoalInvariantError("Persisted review evidence is not bound to a succeeded review item.");
		}
	}
}
