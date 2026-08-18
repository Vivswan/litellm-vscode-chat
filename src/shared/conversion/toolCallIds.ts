import * as vscode from "vscode";

export function isToolResultPart(value: unknown): value is vscode.LanguageModelToolResultPart {
	return value instanceof vscode.LanguageModelToolResultPart;
}

/**
 * The one answer to "what id pairs an assistant tool call with its tool
 * result". Policy, decided once for validation and conversion alike: a pair
 * whose intent is recoverable is minted a deterministic, pair-stable id (an
 * empty callId is a real backend artifact, and rejecting it would strand the
 * whole conversation), while shapes with no recoverable pairing - a result
 * answering no live call, a call id reused while still awaiting its result,
 * a call no result ever answers - are reported for validation to reject.
 * Conversion consumes only the id assignments, so it stays total.
 */
export interface ToolCallPairing {
	/** Wire id for every tool-call and tool-result part, keyed by wireIdKey. */
	readonly wireIds: ReadonlyMap<string, string>;
	/** Tool calls no tool result answers, ordered by each id's first appearance. */
	readonly unpairedCallIds: readonly string[];
	/** Tool results answering no call still awaiting one at their position. */
	readonly strayResultIds: readonly string[];
	/** Ids that recur on a call while an earlier call with the same id is still awaiting its result. */
	readonly duplicateLiveCallIds: readonly string[];
}

export function wireIdKey(messageIndex: number, partIndex: number): string {
	return `${messageIndex}:${partIndex}`;
}

/**
 * Pair tool calls with tool results across the whole message list, in part
 * order and role-agnostic - conversion ships these parts wherever they sit,
 * so pairing must see exactly what the wire will carry. An id may be reused
 * once its earlier call is answered (some backends mint the same id every
 * turn); an empty-id result pairs FIFO with the oldest still-open empty-id
 * call, both halves receiving the same minted id.
 */
export function pairToolCallIds(messages: readonly vscode.LanguageModelChatRequestMessage[]): ToolCallPairing {
	const rawIds = new Set<string>();
	for (const message of messages) {
		for (const part of message.content ?? []) {
			if ((part instanceof vscode.LanguageModelToolCallPart || isToolResultPart(part)) && part.callId) {
				rawIds.add(part.callId);
			}
		}
	}
	let mintCounter = 0;
	const mint = (): string => {
		let candidate = `call_synth_${mintCounter++}`;
		while (rawIds.has(candidate)) {
			candidate = `call_synth_${mintCounter++}`;
		}
		return candidate;
	};

	const wireIds = new Map<string, string>();
	const strayResultIds: string[] = [];
	const duplicateLiveCallIds: string[] = [];
	/** Calls awaiting a result: wire id -> open count, insertion-ordered for the unpaired report. */
	const pending = new Map<string, number>();
	/** Minted ids of still-open empty-id calls, oldest first. */
	const pendingMinted: string[] = [];

	messages.forEach((message, messageIndex) => {
		(message.content ?? []).forEach((part, partIndex) => {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				let id: string;
				if (part.callId) {
					id = part.callId;
					if ((pending.get(id) ?? 0) > 0) {
						duplicateLiveCallIds.push(id);
					}
				} else {
					id = mint();
					pendingMinted.push(id);
				}
				pending.set(id, (pending.get(id) ?? 0) + 1);
				wireIds.set(wireIdKey(messageIndex, partIndex), id);
			} else if (isToolResultPart(part)) {
				let id: string;
				if (part.callId) {
					id = part.callId;
					const open = pending.get(id) ?? 0;
					if (open > 0) {
						pending.set(id, open - 1);
					} else {
						strayResultIds.push(id);
					}
				} else {
					const paired = pendingMinted.shift();
					if (paired === undefined) {
						id = mint();
						strayResultIds.push(id);
					} else {
						id = paired;
						pending.set(id, (pending.get(id) ?? 0) - 1);
					}
				}
				wireIds.set(wireIdKey(messageIndex, partIndex), id);
			}
		});
	});

	const unpairedCallIds: string[] = [];
	for (const [id, open] of pending) {
		for (let i = 0; i < open; i++) {
			unpairedCallIds.push(id);
		}
	}
	return { wireIds, unpairedCallIds, strayResultIds, duplicateLiveCallIds };
}
