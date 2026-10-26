import type * as vscode from "vscode";

export type SseFrame = { kind: "data"; payload: string } | { kind: "done" };

/** The frame a raw SSE line carries, or undefined for a line that is not a data line. */
function frameOf(rawLine: string): SseFrame | undefined {
	//   SSE over CRLF frames every line with a trailing \r -> stripping keeps "data: [DONE]\r\n" recognized
	//                                                        instead of logged as malformed
	const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
	if (!line.startsWith("data: ")) {
		return undefined;
	}
	const data = line.slice(6);
	return data === "[DONE]" ? { kind: "done" } : { kind: "data", payload: data };
}

/**
 * Framing only: what a payload means (JSON parsing, the malformed-line log-and-skip leniency, the in-band error-frame
 * rule) is the processor loop's decision.
 */
export async function* sseFrames(
	responseBody: ReadableStream<Uint8Array>,
	token: vscode.CancellationToken
): AsyncGenerator<SseFrame, void, undefined> {
	const reader = responseBody.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (!token.isCancellationRequested) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const rawLine of lines) {
				const frame = frameOf(rawLine);
				if (frame !== undefined) {
					yield frame;
				}
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// The stream may already be errored (e.g. aborted fetch); the lock is moot then.
		}
	}
}
