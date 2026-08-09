/**
 * The shared one-shot timing seams every scheduler in the codebase injects:
 * the OpenRouter catalog store's weekly refresh, the usage poller's cadence,
 * the usage status bar's stale edge, and the notifier's grace deferral all
 * test against fake time through these instead of hand-rolling identical
 * Timer/Clock types and setTimeout wrappers.
 */

/** One-shot timer effects, injectable so cadences are testable without real time. */
export interface Timer {
	/** Schedule `callback` after `ms`; the returned closure cancels the pending call. */
	set(callback: () => void, ms: number): () => void;
}

/** The production timer: plain setTimeout/clearTimeout. */
export const REAL_TIMER: Timer = {
	set: (callback, ms) => {
		const handle = setTimeout(callback, ms);
		return () => clearTimeout(handle);
	},
};

export interface Clock {
	now(): number;
}

/** The production clock. */
export const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

/**
 * One re-armable pending call on a Timer: arming replaces any pending call,
 * firing clears the pending flag before the callback runs, and the holder
 * can ask whether one is pending. This is the `cancelScheduled` closure
 * bookkeeping the schedulers used to hand-roll - kept deliberately free of
 * enabled/disposed policy, which stays with each owner.
 */
export class PendingCall {
	private cancelPending: (() => void) | undefined;

	constructor(private readonly timer: Timer) {}

	get pending(): boolean {
		return this.cancelPending !== undefined;
	}

	/** Schedule `callback` after `ms`, replacing any pending call. */
	arm(callback: () => void, ms: number): void {
		this.cancel();
		// A Timer may fire synchronously inside set() (fake timers in tests);
		// the fired flag keeps the spent cancel closure from being written back
		// over whatever the callback armed.
		let fired = false;
		const cancel = this.timer.set(() => {
			fired = true;
			this.cancelPending = undefined;
			callback();
		}, ms);
		if (!fired) {
			this.cancelPending = cancel;
		}
	}

	cancel(): void {
		this.cancelPending?.();
		this.cancelPending = undefined;
	}
}

/** Resolves after `ms` or as soon as the signal aborts, whichever comes first. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
