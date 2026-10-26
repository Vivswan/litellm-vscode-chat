import * as vscode from "vscode";

export function isToolResultPart(value: unknown): value is vscode.LanguageModelToolResultPart {
	return value instanceof vscode.LanguageModelToolResultPart;
}

/**
 * The one answer to which id pairs a tool call with its result, decided once for validation and conversion alike. An
 * empty callId is a real backend artifact, and rejecting it would strand the whole conversation, so it is minted
 * instead.
 *
 *   empty-id call and its result                             -> the same deterministic, pair-stable minted id on both
 *                                                               halves
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

/** Every non-empty call id the history carries, so a minted id can never collide with one. */
function rawCallIds(messages: readonly vscode.LanguageModelChatRequestMessage[]): Set<string> {
	const rawIds = new Set<string>();
	for (const message of messages) {
		for (const part of message.content ?? []) {
			if ((part instanceof vscode.LanguageModelToolCallPart || isToolResultPart(part)) && part.callId) {
				rawIds.add(part.callId);
			}
		}
	}

	return rawIds;
}

/**
 * The calls of one pairing walk still awaiting a result (wire id to open count, insertion-ordered for the unpaired
 * report), the minted ids among them in order so an empty-id result takes the oldest, and the strays and live repeats
 * the walk found.
 */
class OpenCallLedger {
	readonly strayResultIds: string[] = [];

	readonly duplicateLiveCallIds: string[] = [];

	private readonly rawIds: ReadonlySet<string>;

	private readonly pending = new Map<string, number>();

	private readonly pendingMinted: string[] = [];

	private mintCounter = 0;

	constructor(rawIds: ReadonlySet<string>) {
		this.rawIds = rawIds;
	}

	private mint(): string {
		let candidate = `call_synth_${this.mintCounter++}`;
		while (this.rawIds.has(candidate)) {
			candidate = `call_synth_${this.mintCounter++}`;
		}

		return candidate;
	}

	/** The wire id of a call: its own when it has one (a repeat of a live id is recorded), a minted one otherwise. */
	openCall(callId: string, messageCallIds: Set<string>): string {
		let id: string;
		if (callId) {
			id = callId;
			if ((this.pending.get(id) ?? 0) > 0 || messageCallIds.has(id)) {
				this.duplicateLiveCallIds.push(id);
			}
			messageCallIds.add(id);
		} else {
			id = this.mint();
			this.pendingMinted.push(id);
		}

		this.pending.set(id, (this.pending.get(id) ?? 0) + 1);

		return id;
	}

	/** A result's wire id: its own when it has one (strays recorded), else the oldest minted call's, else minted. */
	closeCall(callId: string): string {
		if (callId) {
			const open = this.pending.get(callId) ?? 0;
			if (open > 0) {
				this.pending.set(callId, open - 1);
			} else {
				this.strayResultIds.push(callId);
			}
			return callId;
		}

		const paired = this.pendingMinted.shift();
		if (paired === undefined) {
			const id = this.mint();
			this.strayResultIds.push(id);
			return id;
		}

		this.pending.set(paired, (this.pending.get(paired) ?? 0) - 1);

		return paired;
	}

	/** Every call still open, one entry per open count, in first-appearance order. */
	unpairedCallIds(): string[] {
		const unpaired: string[] = [];
		for (const [id, open] of this.pending) {
			for (let i = 0; i < open; i++) {
				unpaired.push(id);
			}
		}

		return unpaired;
	}
}

/**
 * Pairing is role-agnostic and in part order because conversion ships these parts wherever they sit.
 *
 *   an id reused after its earlier call was answered -> allowed; some backends mint the same id every turn
 *   an id shared by two calls of one message         -> duplicate; they ship in one tool_calls array, live even with a
 *                                                       result part between
 */
export function pairToolCallIds(messages: readonly vscode.LanguageModelChatRequestMessage[]): ToolCallPairing {
	const ledger = new OpenCallLedger(rawCallIds(messages));
	const wireIds = new Map<string, string>();
	messages.forEach((message, messageIndex) => {
		/** Wire ids of this message's calls so far; a repeat shares its tool_calls array. */
		const messageCallIds = new Set<string>();
		(message.content ?? []).forEach((part, partIndex) => {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				wireIds.set(wireIdKey(messageIndex, partIndex), ledger.openCall(part.callId, messageCallIds));
			} else if (isToolResultPart(part)) {
				wireIds.set(wireIdKey(messageIndex, partIndex), ledger.closeCall(part.callId));
			}
		});
	});

	return {
		wireIds,
		unpairedCallIds: ledger.unpairedCallIds(),
		strayResultIds: ledger.strayResultIds,
		duplicateLiveCallIds: ledger.duplicateLiveCallIds,
	};
}
