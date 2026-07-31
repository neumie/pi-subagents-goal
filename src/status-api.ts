import {
	isActiveWorkState,
	isTerminalWorkState,
	type BudgetLimits,
	type GoalPhase,
	type GoalSnapshot,
	type OutputState,
	type WorkRole,
	type WorkState,
} from "./state.ts";

export const GOAL_STATUS_PROTOCOL_VERSION = 1 as const;
export const GOAL_STATUS_REQUEST_EVENT = "@neumie/pi-subagents-goal:v1:status-request";
export const GOAL_STATUS_EVENT = "@neumie/pi-subagents-goal:v1:status";

export interface GoalStatusRequest {
	version: typeof GOAL_STATUS_PROTOCOL_VERSION;
	sessionId: string;
}

export interface GoalStatusWorkItem {
	label: string;
	role: WorkRole;
	state: WorkState;
	outputState: OutputState;
}

export interface GoalStatusWorkSummary {
	total: number;
	active: number;
	terminal: number;
	unread: number;
	unsuccessful: number;
	items: GoalStatusWorkItem[];
	itemsOmitted: number;
}

export interface GoalStatusBudget {
	limits: BudgetLimits;
	usage: {
		automaticTurns: number;
		tokens: number;
		noProgressTurns: number;
	};
}

export interface GoalStatus {
	epoch: number;
	phase: GoalPhase;
	live: boolean;
	objective: string;
	startedAt: number;
	updatedAt: number;
	work: GoalStatusWorkSummary;
	budget: GoalStatusBudget;
	continuation?: "reserved" | "queued" | "running";
	review: "none" | "pass" | "fail";
	reason?: string;
}

export interface GoalStatusEnvelope {
	version: typeof GOAL_STATUS_PROTOCOL_VERSION;
	providerId: string;
	sequence: number;
	sessionId: string;
	goal: GoalStatus | null;
	providerError?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function isGoalStatusRequest(value: unknown): value is GoalStatusRequest {
	try {
		const request = record(value);
		return (
			request?.version === GOAL_STATUS_PROTOCOL_VERSION &&
			typeof request.sessionId === "string" &&
			request.sessionId.length > 0 &&
			request.sessionId.length <= 1_024
		);
	} catch {
		return false;
	}
}

const MAX_STATUS_ITEMS = 128;

function publicReason(snapshot: GoalSnapshot): string | undefined {
	if (snapshot.phase === "faulted") return "Goal coordination faulted.";
	return snapshot.pauseReason;
}

export function createGoalStatusEnvelope(input: {
	providerId: string;
	sequence: number;
	sessionId: string;
	objective?: string;
	snapshot?: GoalSnapshot;
	providerError?: string;
}): GoalStatusEnvelope {
	const { snapshot } = input;
	let goal: GoalStatus | null = null;
	if (snapshot && input.objective !== undefined) {
		const visibleItems = snapshot.work.slice(-MAX_STATUS_ITEMS);
		const reason = publicReason(snapshot);
		goal = {
			epoch: snapshot.owner.epoch,
			phase: snapshot.phase,
			live: snapshot.phase !== "completed" && snapshot.phase !== "cancelled",
			objective: input.objective,
			startedAt: snapshot.startedAt,
			updatedAt: snapshot.updatedAt,
			work: {
				total: snapshot.work.length,
				active: snapshot.work.filter((item) => isActiveWorkState(item.state)).length,
				terminal: snapshot.work.filter((item) => isTerminalWorkState(item.state)).length,
				unread: snapshot.work.filter(
					(item) => isTerminalWorkState(item.state) && item.outputState !== "consumed",
				).length,
				unsuccessful: snapshot.work.filter(
					(item) => isTerminalWorkState(item.state) && item.state !== "succeeded",
				).length,
				items: visibleItems.map((item) => ({
					label: item.label,
					role: item.role,
					state: item.state,
					outputState: item.outputState,
				})),
				itemsOmitted: snapshot.work.length - visibleItems.length,
			},
			budget: {
				limits: structuredClone(snapshot.budgetLimits),
				usage: {
					automaticTurns: snapshot.budgetUsage.automaticTurns,
					tokens: snapshot.budgetUsage.tokens,
					noProgressTurns: snapshot.budgetUsage.noProgressTurns,
				},
			},
			...(snapshot.continuation ? { continuation: snapshot.continuation.status } : {}),
			review: snapshot.review?.verdict ?? "none",
			...(reason !== undefined ? { reason } : {}),
		};
	}

	return {
		version: GOAL_STATUS_PROTOCOL_VERSION,
		providerId: input.providerId,
		sequence: input.sequence,
		sessionId: input.sessionId,
		goal,
		...(input.providerError ? { providerError: input.providerError.slice(0, 1_000) } : {}),
	};
}
