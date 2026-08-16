/**
 * Single-flight + TTL cache for per-group model discovery: concurrent loads
 * for one key share a single network call.
 *
 * Keys are group client IDs fingerprinting base URL and credentials, so a
 * result fetched with old credentials is never served for new ones. Freshness
 * is decided at read time - a lowered TTL takes effect immediately, and a TTL
 * of 0 disables serving from the store without disabling coalescing - and
 * failed loads are never stored.
 */
export class DiscoveryCache<T> {
	private readonly entries = new Map<string, { value: T; storedAt: number }>();
	// storeAllowed: a load that started before an invalidate() of its key must
	// not store its result, or an explicit "sync now" is answered with pre-sync
	// data for the rest of the TTL.
	private readonly inFlight = new Map<string, { promise: Promise<T>; guard: { storeAllowed: boolean } }>();

	/** The only clock seam; tests inject a fake. */
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
	 * rejection propagates to all of them. Callers that just invalidated the key
	 * still join a live load; only clear() detaches in-flight loads.
	 */
	fetch(key: string, load: () => Promise<T>): Promise<T> {
		const pending = this.inFlight.get(key);
		if (pending !== undefined) {
			return pending.promise;
		}
		const guard = { storeAllowed: true };
		const promise = (async () => {
			const value = await load();
			// Identity covers clear() (which detaches by emptying the map);
			// storeAllowed covers invalidate() of this key.
			if (this.inFlight.get(key)?.guard === guard && guard.storeAllowed) {
				this.entries.set(key, { value, storedAt: this.now() });
			}
			return value;
		})();
		this.inFlight.set(key, { promise, guard });
		// A clear() may have detached this load with a fresh one already in flight
		// under the key; an unconditional delete would orphan its coalescing.
		const cleanup = () => {
			if (this.inFlight.get(key)?.guard === guard) {
				this.inFlight.delete(key);
			}
		};
		void promise.then(cleanup, cleanup);
		return promise;
	}

	/** Drop the stored result for `key`. An in-flight load still resolves for its callers but is not stored. */
	invalidate(key: string): void {
		this.entries.delete(key);
		const pending = this.inFlight.get(key);
		if (pending !== undefined) {
			pending.guard.storeAllowed = false;
		}
	}

	/**
	 * Drop ONLY the stored result for `key`, leaving in-flight loads storable:
	 * for callers correcting a COMPLETED load whose result was stale
	 * configuration, so concurrent correctors converge on one stored fresh
	 * result instead of suppressing each other's.
	 */
	dropStored(key: string): void {
		this.entries.delete(key);
	}

	/**
	 * Drop every stored result AND detach in-flight loads: explicit refreshes
	 * must start a real round trip, never join a load that began before the
	 * clear, which the store guard alone would not prevent. Detached loads
	 * still resolve for their original callers.
	 */
	clear(): void {
		this.entries.clear();
		this.inFlight.clear();
	}

	/**
	 * Drop every stored result whose key is not in `keep`: entries for removed
	 * or re-keyed groups embed the old plaintext credentials in their model
	 * objects and must not outlive the group. In-flight loads are untouched.
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
