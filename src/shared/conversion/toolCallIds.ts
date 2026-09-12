import * as vscode from "vscode";

export function isToolResultPart(value: unknown): value is vscode.LanguageModelToolResultPart {
	return value instanceof vscode.LanguageModelToolResultPart;
}

/**
 * The one answer to which id pairs a tool call with its result, decided once for validation and conversion alike.
 * An empty callId is a real backend artifact, and rejecting it would strand the whole conversation, so it is minted instead.
 *
 *   empty-id call and its result                             -> the same deterministic, pair-stable minted id on both halves
 *   stray result, live id reuse, or a call no result answers -> reported for validation to reject
 */
export interface ToolCallPairing {
	/** Wire id for every tool-call and tool-result part, keyed by wireIdKey. */
	readonly wireIds: ReadonlyMap<string, string>;
	/** Tool calls no tool result answers, ordered by each id's first appearance. */
	readonly unpairedCallIds: readonly string[];
	/** Tool results answering no call still awaiting one at their position. */
	readonly strayResultIds: readonly string[];
	/** Ids reused while still live, by a later call or by two calls of one message. */
	readonly duplicateLiveCallIds: readonly string[];
}

export function wireIdKey(messageIndex: number, partIndex: number): string {
	return `${messageIndex}:${partIndex}`;
}

/**
 * Pairing is role-agnostic and in part order because conversion ships these parts wherever they sit.
 *
 *   an id reused after its earlier call was answered -> allowed; some backends mint the same id every turn
 *   an id shared by two calls of one message         -> duplicate; they ship in one tool_calls array, live even with a result part between
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
		/** Wire ids of this message's calls so far; a repeat shares its tool_calls array. */
		const messageCallIds = new Set<string>();
		(message.content ?? []).forEach((part, partIndex) => {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				let id: string;
				if (part.callId) {
					id = part.callId;
					if ((pending.get(id) ?? 0) > 0 || messageCallIds.has(id)) {
						duplicateLiveCallIds.push(id);
					}
					messageCallIds.add(id);
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
