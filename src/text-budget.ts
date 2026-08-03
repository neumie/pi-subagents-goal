import { GOAL_LIMITS } from "./limits.ts";

export const MAX_MODEL_TEXT_BYTES = GOAL_LIMITS.maxModelPayloadBytes;

export function utf8ByteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
		throw new RangeError("maxBytes must be a non-negative integer.");
	if (utf8ByteLength(value) <= maxBytes) return { text: value, truncated: false };
	let used = 0;
	let text = "";
	for (const codePoint of value) {
		const bytes = utf8ByteLength(codePoint);
		if (used + bytes > maxBytes) break;
		text += codePoint;
		used += bytes;
	}
	return { text, truncated: true };
}

export function equalPreviewByteLimit(input: {
	maxBytes?: number;
	fixedText: string;
	itemCount: number;
	perTruncatedItemMarker: string;
}): number {
	if (!Number.isSafeInteger(input.itemCount) || input.itemCount < 1) {
		throw new RangeError("itemCount must be an integer >= 1.");
	}
	const maxBytes = input.maxBytes ?? MAX_MODEL_TEXT_BYTES;
	const fixedBytes = utf8ByteLength(input.fixedText);
	const reservedMarkerBytes = utf8ByteLength(input.perTruncatedItemMarker) * input.itemCount;
	return Math.max(0, Math.floor((maxBytes - fixedBytes - reservedMarkerBytes) / input.itemCount));
}
