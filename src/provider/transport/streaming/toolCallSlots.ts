import type { StreamedToolCall, ToolCallBuffer } from "../wire";

/** A wire index (a numeric string is the same index), or the server's call id for a delta that carries no index. */
export type ToolCallSlot = number | string;

function normalizeToolCallIndex(index: number | string): number {
	if (typeof index === "number") {
		return index;
	}
	if (index.trim() !== "") {
		const parsed = Number(index);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return 0;
}

/**
 * The per-request tool_calls buffers, keyed so parallel calls stay apart whichever identity the server sends.
 *
 *   index present    -> that index, the OpenAI contract
 *   no index, an id  -> the id: without indexes, distinct ids are all that tells parallel calls apart
 *   neither          -> the call in flight: the last id-keyed delta accepted, else slot 0
 *
 * Keying every index-less delta to slot 0 made parallel calls share one buffer: the first emitted and retired the
 * slot, and the rest were skipped as late deltas of a finished call. Only an accepted id-keyed delta becomes the call
 * in flight: a trailing frame for a call that already emitted is refused, and must not redirect the bare
 * continuations of the call still streaming.
 */
export class ToolCallSlots {
	private readonly buffers = new Map<ToolCallSlot, ToolCallBuffer>();

	private readonly retired = new Set<ToolCallSlot>();

	private openIdSlot: string | undefined;

	/** Folds the delta into its slot and returns the slot, or undefined once that slot's call has left the stream. */
	accept(tc: StreamedToolCall): ToolCallSlot | undefined {
		const slot = this.slotOf(tc);
		if (this.retired.has(slot)) {
			return undefined;
		}
		if (typeof slot === "string") {
			this.openIdSlot = slot;
		}
		const buf = this.buffers.get(slot) ?? { args: "" };
		if (tc.id) {
			buf.id = tc.id;
		}
		if (tc.function?.name) {
			buf.name = tc.function.name;
		}
		if (typeof tc.function?.arguments === "string") {
			buf.args += tc.function.arguments;
		}
		this.buffers.set(slot, buf);
		return slot;
	}

	private slotOf(tc: StreamedToolCall): ToolCallSlot {
		if (tc.index !== undefined) {
			return normalizeToolCallIndex(tc.index);
		}
		return tc.id || (this.openIdSlot ?? 0);
	}

	get(slot: ToolCallSlot): ToolCallBuffer | undefined {
		return this.buffers.get(slot);
	}

	/** The slot's call emitted or was suppressed as a duplicate: a later delta for it is refused. */
	retire(slot: ToolCallSlot): void {
		this.buffers.delete(slot);
		this.retired.add(slot);
	}

	/** Live, so a retire during an end-of-stream walk takes effect in the walk. */
	entries(): IterableIterator<[ToolCallSlot, ToolCallBuffer]> {
		return this.buffers.entries();
	}
}
