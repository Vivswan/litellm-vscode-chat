/**
 * Shared fixtures for the streaming suites: a counting tool-call ID source, a part
 * collector, the visible-text and event-sequence views of a response, and the
 * SSE stream plus replay loop that drive chunks through the real transport.
 */
import * as vscode from "vscode";
import type { StreamProcessor } from "../../../provider/transport/streaming";

/** A standalone tool-call ID source with an observable count, mirroring the ChatClient's. */
export function idSource(): { next(): number; readonly count: number } {
	let count = 0;
	return {
		next: () => ++count,
		get count() {
			return count;
		},
	};
}

export function collector(): {
	parts: vscode.LanguageModelResponsePart[];
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
} {
	const parts: vscode.LanguageModelResponsePart[] = [];
	return { parts, progress: { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) } };
}

export function toolCallsOf(parts: vscode.LanguageModelResponsePart[]): vscode.LanguageModelToolCallPart[] {
	return parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart[];
}

export function visibleTextOf(parts: vscode.LanguageModelResponsePart[]): string {
	return parts
		.filter((p) => p instanceof vscode.LanguageModelTextPart)
		.map((p) => (p as vscode.LanguageModelTextPart).value)
		.join("");
}

/** Normalized event sequence: adjacent text parts merge, tool calls keep order. */
export function eventSequenceOf(parts: vscode.LanguageModelResponsePart[]): string[] {
	const events: string[] = [];
	for (const part of parts) {
		if (part instanceof vscode.LanguageModelTextPart) {
			const last = events[events.length - 1];
			if (last?.startsWith("text:")) {
				events[events.length - 1] = last + part.value;
			} else {
				events.push(`text:${part.value}`);
			}
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			events.push(`tool:${part.name}`);
		}
	}
	return events;
}

export function sseStream(chunks: string[], onEnd?: () => void): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(encoder.encode(chunks[i++]));
			} else {
				onEnd?.();
				controller.close();
			}
		},
	});
}

/**
 * Drive chunk objects through the real transport loop, appending [DONE]. The
 * end-of-stream trailers emit only on the loop's final run, so tests asserting
 * on them must go through here rather than calling processDelta.
 */
export async function playChunks(
	stream: StreamProcessor,
	chunks: unknown[],
	progress: vscode.Progress<vscode.LanguageModelResponsePart>
): Promise<void> {
	const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n`);
	lines.push("data: [DONE]\n");
	await stream.processStreamingResponse(sseStream(lines), progress, new vscode.CancellationTokenSource().token);
}
