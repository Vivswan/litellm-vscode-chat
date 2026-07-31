import type * as vscode from "vscode";

/** One framed SSE event: a data payload still in wire form, or the [DONE] sentinel. */
export type SseFrame = { kind: "data"; payload: string } | { kind: "done" };

/**
 * Frame a raw SSE response body into data payloads: TextDecoder buffering
 * across chunk boundaries, CRLF stripping, the "data: " prefix, and [DONE]
 * recognition. Framing only - what a payload means (JSON parsing, the
 * malformed-line log-and-skip leniency, the in-band error-frame rule) is the
 * processor loop's decision, so payloads are yielded as raw strings. Reading
 * stops at the first check after cancellation is requested; the reader's lock
 * is released however the generator exits.
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
				// SSE over CRLF frames every line with a trailing \r; JSON payloads
				// never end in a raw \r (it is escaped), so stripping it is safe and
				// keeps "data: [DONE]\r\n" recognized instead of logged as malformed.
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
				if (!line.startsWith("data: ")) {
					continue;
				}
				const data = line.slice(6);
				yield data === "[DONE]" ? { kind: "done" } : { kind: "data", payload: data };
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
