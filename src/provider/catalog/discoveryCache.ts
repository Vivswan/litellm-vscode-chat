/**
 *   Freshness is decided at read time -> a lowered TTL takes effect immediately
 *   failed loads                      -> are never stored
 */
export class DiscoveryCache<T> {
	private readonly entries = new Map<string, { value: T; storedAt: number }>();
	/**
	 * `superseded` is set by clear(): the load still resolves for its callers but never stores, so an explicit "sync
	 * now" is not answered with pre-sync data for the rest of the TTL.
	 */
	private readonly inFlight = new Map<string, { promise: Promise<T>; load: { superseded: boolean } }>();

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

	fetch(key: string, loader: () => Promise<T>): Promise<T> {
		const pending = this.inFlight.get(key);
		if (pending !== undefined) {
			return pending.promise;
		}
		const load = { superseded: false };
		const promise = (async () => {
			const value = await loader();
			if (!load.superseded) {
				this.entries.set(key, { value, storedAt: this.now() });
			}
			return value;
		})();
		this.inFlight.set(key, { promise, load });
		// A clear() may have detached this load with a fresh one already in flight under the key; an unconditional
		// delete would orphan its coalescing.
		const cleanup = () => {
			if (this.inFlight.get(key)?.load === load) {
				this.inFlight.delete(key);
			}
		};
		void promise.then(cleanup, cleanup);
		return promise;
	}

	/**
	 * Drop every stored result AND detach in-flight loads: explicit refreshes must start a real round trip, never join
	 * a load that began before the clear. Detached loads still resolve for their original callers.
	 */
	clear(): void {
		this.entries.clear();
		for (const pending of this.inFlight.values()) {
			pending.load.superseded = true;
		}
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
