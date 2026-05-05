export function countTextTokens(text: string): number {
	if (!text) {
		return 0;
	}
	const charEstimate = text.length / 3.5;
	const words = text.split(/\s+/).filter(Boolean);
	const wordEstimate = words.length * 1.3;
	return Math.ceil(Math.max(charEstimate, wordEstimate));
}

interface TextPart {
	value: string;
}
interface ToolCallPart {
	name: string;
	input: unknown;
}
interface DataPart {
	mimeType: string;
	data: Uint8Array | string;
}
interface ToolResultPart {
	callId: string;
	content?: ReadonlyArray<unknown>;
}

function isTextPart(part: unknown): part is TextPart {
	return !!part && typeof part === "object" && "value" in part && typeof (part as TextPart).value === "string";
}

function isToolCallPart(part: unknown): part is ToolCallPart {
	return !!part && typeof part === "object" && "name" in part && "input" in part;
}

function isDataPart(part: unknown): part is DataPart {
	return !!part && typeof part === "object" && "mimeType" in part && "data" in part;
}

function isToolResultPart(part: unknown): part is ToolResultPart {
	return !!part && typeof part === "object" && "callId" in part && "content" in part;
}

function isPromptTsxPart(part: unknown): boolean {
	if (!part || typeof part !== "object") {
		return false;
	}
	const ctorName = (Object.getPrototypeOf(part as object) as { constructor?: { name?: string } } | undefined)
		?.constructor?.name;
	return ctorName === "LanguageModelPromptTsxPart";
}

function extractPromptTsxText(part: unknown): string {
	const obj = part as Record<string, unknown>;
	if (typeof obj.value === "string") {
		return obj.value;
	}
	if (obj.value !== undefined && obj.value !== null) {
		try {
			return JSON.stringify(obj.value);
		} catch {
			return "";
		}
	}
	return "";
}

export const IMAGE_TOKEN_ESTIMATE = 765;
export const PDF_TOKEN_ESTIMATE = 500;

export function countDataPartTokens(mime: string, data: Uint8Array | string): number {
	const lower = mime.toLowerCase();
	if (lower.startsWith("image/")) {
		return IMAGE_TOKEN_ESTIMATE;
	}
	if (lower === "application/pdf") {
		return PDF_TOKEN_ESTIMATE;
	}
	if (lower.startsWith("text/") || lower === "application/json" || lower.endsWith("+json")) {
		const decoded = data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data);
		return countTextTokens(decoded);
	}
	return 0;
}

export function countMessageTokens(content: ReadonlyArray<unknown>): number {
	let total = 0;
	for (const part of content) {
		if (isTextPart(part)) {
			total += countTextTokens(part.value);
		} else if (isToolCallPart(part)) {
			total += countTextTokens(part.name + JSON.stringify(part.input ?? {}));
		} else if (isDataPart(part)) {
			total += countDataPartTokens(part.mimeType, part.data);
		} else if (isToolResultPart(part)) {
			for (const sub of part.content ?? []) {
				if (isTextPart(sub)) {
					total += countTextTokens(sub.value);
				} else if (isDataPart(sub)) {
					total += countDataPartTokens(sub.mimeType, sub.data);
				}
			}
		} else if (isPromptTsxPart(part)) {
			total += countTextTokens(extractPromptTsxText(part));
		}
	}
	return total;
}
