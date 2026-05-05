export function countTextTokens(text: string): number {
	if (!text) return 0;
	const charEstimate = text.length / 3.5;
	const words = text.split(/\s+/).filter(Boolean);
	const wordEstimate = words.length * 1.3;
	return Math.ceil(Math.max(charEstimate, wordEstimate));
}

export function countMessageTokens(content: ReadonlyArray<unknown>): number {
	let total = 0;
	for (const part of content) {
		if (part && typeof part === "object" && "value" in part && typeof (part as any).value === "string") {
			total += countTextTokens((part as any).value);
		} else if (part && typeof part === "object" && "name" in part && "input" in part) {
			total += countTextTokens((part as any).name + JSON.stringify((part as any).input ?? {}));
		} else if (part && typeof part === "object" && "mimeType" in part && "data" in part) {
			const mime = ((part as any).mimeType as string).toLowerCase();
			if (mime.startsWith("image/")) {
				total += 765;
			} else if (mime === "application/pdf") {
				total += 500;
			} else if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) {
				total += countTextTokens(String((part as any).data));
			}
		}
	}
	return total;
}
