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

function isTextPart(part: unknown): part is TextPart {
	return !!part && typeof part === "object" && "value" in part && typeof (part as TextPart).value === "string";
}

function isToolCallPart(part: unknown): part is ToolCallPart {
	return !!part && typeof part === "object" && "name" in part && "input" in part;
}

function isDataPart(part: unknown): part is DataPart {
	return !!part && typeof part === "object" && "mimeType" in part && "data" in part;
}

export function countMessageTokens(content: ReadonlyArray<unknown>): number {
	let total = 0;
	for (const part of content) {
		if (isTextPart(part)) {
			total += countTextTokens(part.value);
		} else if (isToolCallPart(part)) {
			total += countTextTokens(part.name + JSON.stringify(part.input ?? {}));
		} else if (isDataPart(part)) {
			const mime = part.mimeType.toLowerCase();
			if (mime.startsWith("image/")) {
				total += 765;
			} else if (mime === "application/pdf") {
				total += 500;
			} else if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) {
				const decoded = part.data instanceof Uint8Array ? new TextDecoder().decode(part.data) : String(part.data);
				total += countTextTokens(decoded);
			}
		}
	}
	return total;
}
