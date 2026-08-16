/** The two routes a tool call arrives on: structured tool_calls deltas, or inline text the parser recovers. */
export type ToolCallChannel = "delta" | "inline";

/**
 * The per-request dedup ledger for tool calls that can surface twice: as a
 * structured delta and inline in the text, or replayed inline by a model that
 * re-sends its own output.
 *
 * Cross-channel dedup is count-based: a call arriving on one channel consumes
 * one pending count from the other and is suppressed; with none pending it
 * emits and increments its own. N delta plus M inline occurrences of one
 * name:args key therefore emit max(N, M), so identical parallel calls on one
 * channel all survive while cross-channel duplicates collapse in either
 * arrival order.
 */
export class ToolCallLedger {
	/** Inline calls already decided (emitted or deduped) while provisional, so their completion is not re-emitted. */
	private readonly _handledTextCallSeqs = new Set<number>();
	/** name:index pairs from inline headers, deduping re-sent inline calls that carry an explicit index. */
	private readonly _inlineEmittedIndexIds = new Set<string>();
	/** name:args keys of emitted inline calls, deduping re-sent inline calls without an explicit index. */
	private readonly _inlineEmittedContentKeys = new Set<string>();
	/** Per-channel counts of emitted name:args keys; see the max(N, M) rule on the class. */
	private readonly _deltaEmittedCounts = new Map<string, number>();
	private readonly _inlineEmittedCounts = new Map<string, number>();

	/** Whether this inline parser seq was already decided (emitted or deduped). */
	alreadyHandled(seq: number): boolean {
		return this._handledTextCallSeqs.has(seq);
	}

	markHandled(seq: number): void {
		this._handledTextCallSeqs.add(seq);
	}

	/** Whether this inline call is a replay: by name:index when the header carried an index, by name:args otherwise. */
	inlineAlreadyEmitted(name: string, index: number | undefined, contentKey: string): boolean {
		if (typeof index === "number") {
			return this._inlineEmittedIndexIds.has(`${name}:${index}`);
		}
		return this._inlineEmittedContentKeys.has(contentKey);
	}

	recordInlineEmission(name: string, index: number | undefined, contentKey: string): void {
		if (typeof index === "number") {
			this._inlineEmittedIndexIds.add(`${name}:${index}`);
		}
		this._inlineEmittedContentKeys.add(contentKey);
	}

	/**
	 * Whether this arrival is the other channel's duplicate. Consuming: a true
	 * result spends one pending count, so the caller must suppress the call it
	 * asked about.
	 */
	shouldSuppress(channel: ToolCallChannel, key: string): boolean {
		const otherCounts = channel === "inline" ? this._deltaEmittedCounts : this._inlineEmittedCounts;
		const pending = otherCounts.get(key) ?? 0;
		if (pending === 0) {
			return false;
		}
		if (pending === 1) {
			otherCounts.delete(key);
		} else {
			otherCounts.set(key, pending - 1);
		}
		return true;
	}

	/** Count an emission on its own channel, arming suppression of the same key arriving on the other one. */
	recordEmission(channel: ToolCallChannel, key: string): void {
		const ownCounts = channel === "inline" ? this._inlineEmittedCounts : this._deltaEmittedCounts;
		ownCounts.set(key, (ownCounts.get(key) ?? 0) + 1);
	}
}
