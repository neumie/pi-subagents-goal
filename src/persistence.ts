import { GoalInvariantError, GoalMachine, sha256, type GoalSnapshot } from "./state.ts";

export const GOAL_STATE_ENTRY = "pi-subagents-goal/state-v1";
export const GOAL_OBJECTIVE_MESSAGE = "pi-subagents-goal/objective-v1";
export const GOAL_CONTINUATION_MESSAGE = "pi-subagents-goal/continuation-v1";
export const GOAL_TOOL_DETAILS_VERSION = 2 as const;

export interface SessionIdentity {
	sessionId: string;
	sessionFile: string | null;
}

export interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
	content?: unknown;
	details?: unknown;
	message?: unknown;
}

export type GoalLoadResult =
	| { kind: "none" }
	| { kind: "loaded"; snapshot: GoalSnapshot; objective: string }
	| { kind: "foreign"; snapshot: GoalSnapshot; reason: string }
	| { kind: "invalid"; reason: string };

interface CustomMessageLike {
	customType: string;
	content: unknown;
	details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textContent(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const text = value
		.flatMap((block) =>
			isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
		)
		.join("\n");
	return text || undefined;
}

function customMessage(entry: SessionEntryLike): CustomMessageLike | undefined {
	if (entry.type === "custom_message" && typeof entry.customType === "string") {
		return {
			customType: entry.customType,
			content: entry.content,
			...(entry.details !== undefined ? { details: entry.details } : {}),
		};
	}
	if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
	const message = entry.message;
	if (message.role !== "custom" || typeof message.customType !== "string") return undefined;
	return {
		customType: message.customType,
		content: message.content,
		...(message.details !== undefined ? { details: message.details } : {}),
	};
}

function parseSnapshot(value: unknown): GoalSnapshot {
	try {
		return new GoalMachine(value as GoalSnapshot).snapshot;
	} catch (error) {
		if (error instanceof GoalInvariantError) throw error;
		throw new GoalInvariantError(
			`Could not decode persisted goal state: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function objectiveForGoal(
	entries: readonly SessionEntryLike[],
	goalId: string,
	objectiveDigest: string,
): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const message = customMessage(entries[index] ?? {});
		if (!message || message.customType !== GOAL_OBJECTIVE_MESSAGE || !isRecord(message.details)) continue;
		if (message.details.goalId !== goalId || message.details.objectiveDigest !== objectiveDigest) continue;
		const objective = textContent(message.content);
		if (objective && sha256(objective) === objectiveDigest) return objective;
	}
	return undefined;
}

export function loadGoalFromBranch(
	entries: readonly SessionEntryLike[],
	currentSession: SessionIdentity,
): GoalLoadResult {
	let latest: unknown;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY) latest = entry.data;
	}
	if (latest === undefined) return { kind: "none" };
	let snapshot: GoalSnapshot;
	try {
		snapshot = parseSnapshot(latest);
	} catch (error) {
		return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
	}
	if (
		snapshot.owner.sessionId !== currentSession.sessionId ||
		snapshot.owner.sessionFile !== currentSession.sessionFile
	) {
		return {
			kind: "foreign",
			snapshot,
			reason: "Persisted goal metadata belongs to a different Pi session or fork.",
		};
	}
	const objective = objectiveForGoal(entries, snapshot.owner.goalId, snapshot.objectiveDigest);
	if (!objective)
		return { kind: "invalid", reason: "The goal objective message is missing or failed its digest check." };
	return { kind: "loaded", snapshot, objective };
}

export function persistenceSnapshot(snapshot: GoalSnapshot): GoalSnapshot {
	const copy = new GoalMachine(snapshot).snapshot;
	for (const item of copy.work) {
		if (item.outputDigest && !/^[a-f0-9]{64}$/u.test(item.outputDigest)) {
			throw new GoalInvariantError(`Work output digest is invalid for ${item.itemId}.`);
		}
	}
	return copy;
}

export function objectiveMessage(objective: string, snapshot: GoalSnapshot) {
	if (sha256(objective) !== snapshot.objectiveDigest) {
		throw new GoalInvariantError("Goal objective does not match its persisted digest.");
	}
	return {
		customType: GOAL_OBJECTIVE_MESSAGE,
		content: objective,
		display: true,
		details: {
			version: GOAL_TOOL_DETAILS_VERSION,
			goalId: snapshot.owner.goalId,
			epoch: snapshot.owner.epoch,
			lineageId: snapshot.owner.lineageId,
			objectiveDigest: snapshot.objectiveDigest,
		},
	};
}
