/**
 * A small bounded LRU for inline completion results, consulted before any
 * request so a backspace-and-retype never pays a second round trip. Pure and
 * clock-free: recency is the map's insertion order, refreshed on every hit,
 * which is monotonic by construction - no timers, no Date.now.
 */

export interface CompletionCacheKey {
	/** The configured entry label the request routes through. */
	readonly server: string;
	/** The raw model ID on that server. */
	readonly model: string;
	/** The budget-truncated prefix tail the request would send. */
	readonly prefix: string;
	/** The budget-truncated suffix head the request would send. */
	readonly suffix: string;
}

export const DEFAULT_COMPLETION_CACHE_CAPACITY = 64;

/** JSON-encoded so no field content can collide across field boundaries. */
function encode(key: CompletionCacheKey): string {
	return JSON.stringify([key.server, key.model, key.prefix, key.suffix]);
}

/**
 * Completion texts keyed by (model, prefix tail, suffix head). Empty strings
 * are cached like any other result: "the model had nothing to add here" is
 * an answer worth not re-requesting.
 */
export class CompletionCache {
	private readonly entries = new Map<string, string>();
	private readonly capacity: number;

	constructor(capacity: number = DEFAULT_COMPLETION_CACHE_CAPACITY) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new Error(`Completion cache capacity must be a positive integer, got ${capacity}`);
		}
		this.capacity = capacity;
	}

	/** The cached completion for this context, refreshing its recency; undefined is a miss. */
	get(key: CompletionCacheKey): string | undefined {
		const encoded = encode(key);
		const value = this.entries.get(encoded);
		if (value === undefined) {
			return undefined;
		}
		this.entries.delete(encoded);
		this.entries.set(encoded, value);
		return value;
	}

	/** Store one completion, evicting the least recently used entry beyond capacity. */
	set(key: CompletionCacheKey, completion: string): void {
		const encoded = encode(key);
		this.entries.delete(encoded);
		this.entries.set(encoded, completion);
		if (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) {
				this.entries.delete(oldest);
			}
		}
	}

	/** Drop everything; the wiring calls this on model or configuration changes. */
	invalidate(): void {
		this.entries.clear();
	}

	/** Current entry count, for tests and diagnostics. */
	get size(): number {
		return this.entries.size;
	}
}
