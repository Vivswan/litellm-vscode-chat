/**
 *   Freshness is decided at read time -> a lowered TTL takes effect immediately
 *   failed loads                      -> are never stored
 */
export class DiscoveryCache<T> {
	private readonly entries = new Map<string, { value: T; storedAt: number }>();
	// storeAllowed: a load that started before an invalidate() of its key must not store its result, or an explicit
	// "sync now" is answered with pre-sync data for the rest of the TTL.
	private readonly inFlight = new Map<string, { promise: Promise<T>; guard: { storeAllowed: boolean } }>();

	/** The only clock seam; tests inject a fake. */
	constructor(private readonly now: () => number = () => Date.now()) {}

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

	/** Callers that just invalidated the key still join a live load; only clear() detaches in-flight loads. */
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
		// A clear() may have detached this load with a fresh one already in flight under the key; an unconditional
		// delete would orphan its coalescing.
		const cleanup = () => {
			if (this.inFlight.get(key)?.guard === guard) {
				this.inFlight.delete(key);
			}
		};
		void promise.then(cleanup, cleanup);
		return promise;
	}

	/** An in-flight load still resolves for its callers but is not stored. */
	invalidate(key: string): void {
		this.entries.delete(key);
		const pending = this.inFlight.get(key);
		if (pending !== undefined) {
			pending.guard.storeAllowed = false;
		}
	}

	/**
	 * Drop every stored result AND detach in-flight loads: explicit refreshes must start a real round trip, never join
	 * a load that began before the clear, which the store guard alone would not prevent. Detached loads still resolve
	 * for their original callers.
	 */
	clear(): void {
		this.entries.clear();
		this.inFlight.clear();
	}

	/** In-flight loads are untouched. */
	prune(keep: Iterable<string>): void {
		const keepSet = new Set(keep);
		for (const key of this.entries.keys()) {
			if (!keepSet.has(key)) {
				this.entries.delete(key);
			}
		}
	}
}
