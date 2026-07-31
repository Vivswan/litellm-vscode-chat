/**
 * Single-flight + TTL cache for per-group model discovery. The host
 * re-resolves provider groups in bursts (several calls for one group within a
 * second), so concurrent loads for one key share a single network call and
 * completed results are served from memory until they age out.
 *
 * Keys are group client IDs (see groupModels.ts), which fingerprint the base
 * URL and credentials: rotating a group's key mints a new cache key, so a
 * result fetched with old credentials is never served for new ones. prune()
 * drops the entries such a rotation leaves behind.
 *
 * Freshness is decided at read time: fetch() stores a successful result, and
 * lookup() applies the caller's TTL against the stored timestamp. Lowering
 * the TTL setting therefore takes effect immediately, and a TTL of 0 disables
 * serving from the store without disabling the request coalescing. Failed
 * loads are never stored, so the next call reaches the network again.
 */
export class DiscoveryCache<T> {
	private readonly entries = new Map<string, { value: T; storedAt: number }>();
	private readonly inFlight = new Map<string, Promise<T>>();
	// Advanced by clear() and invalidate(): a load that started before the drop
	// must not store its result afterwards, or an explicit "sync now" could be
	// silently answered with pre-sync data for the rest of the TTL. Global
	// rather than per-key: the collateral (an unrelated concurrent load skips
	// its store and the next read refetches) is safe and rare.
	private epoch = 0;

	/** `now` is the only clock seam; tests inject a fake. The default reads Date.now at call time. */
	constructor(private readonly now: () => number = () => Date.now()) {}

	/** The stored value for `key` when it is younger than `ttlMs`; undefined otherwise. Expired entries are dropped. */
	lookup(key: string, ttlMs: number): T | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) {
			return undefined;
		}
		if (this.now() - entry.storedAt >= ttlMs) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	/**
	 * Load `key`, sharing one in-flight `load` among concurrent callers; a
	 * rejection propagates to every caller of the shared load. A load already
	 * in flight is joined even by callers that just invalidated the key: it is
	 * a live network call, not a stale stored result.
	 */
	fetch(key: string, load: () => Promise<T>): Promise<T> {
		const pending = this.inFlight.get(key);
		if (pending !== undefined) {
			return pending;
		}
		const startEpoch = this.epoch;
		const loading = (async () => {
			try {
				const value = await load();
				if (this.epoch === startEpoch) {
					this.entries.set(key, { value, storedAt: this.now() });
				}
				return value;
			} finally {
				this.inFlight.delete(key);
			}
		})();
		this.inFlight.set(key, loading);
		return loading;
	}

	/** Drop the stored result for `key`. An in-flight load still resolves for its callers but is not stored. */
	invalidate(key: string): void {
		this.entries.delete(key);
		this.epoch += 1;
	}

	/** Drop every stored result. In-flight loads still resolve for their callers but are not stored. */
	clear(): void {
		this.entries.clear();
		this.epoch += 1;
	}

	/**
	 * Drop every stored result whose key is not in `keep`, mirroring the
	 * provider's client pruning: entries for removed or re-keyed groups embed
	 * the old plaintext credentials in their model objects and must not
	 * outlive the group. In-flight loads are untouched (their callers are, by
	 * definition, still interested).
	 */
	prune(keep: Iterable<string>): void {
		const keepSet = new Set(keep);
		for (const key of this.entries.keys()) {
			if (!keepSet.has(key)) {
				this.entries.delete(key);
			}
		}
	}
}
