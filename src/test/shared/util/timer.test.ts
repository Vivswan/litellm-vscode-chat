import * as assert from "node:assert";
import type { Timer } from "../../../shared/util/timer";
import { PendingCall, REAL_TIMER, SYSTEM_CLOCK, sleepUnlessAborted } from "../../../shared/util/timer";

/** A recording timer: nothing fires until the test fires it. */
class FakeTimer implements Timer {
	readonly scheduled: { callback: () => void; ms: number; cancelled: boolean }[] = [];

	set(callback: () => void, ms: number): () => void {
		const entry = { callback, ms, cancelled: false };
		this.scheduled.push(entry);
		return () => {
			entry.cancelled = true;
		};
	}

	pending(): { callback: () => void; ms: number; cancelled: boolean }[] {
		return this.scheduled.filter((entry) => !entry.cancelled);
	}
}

suite("shared/util/timer", () => {
	test("arm schedules once and reports pending until fired", () => {
		const timer = new FakeTimer();
		const call = new PendingCall(timer);
		let fired = 0;

		assert.strictEqual(call.pending, false);
		call.arm(() => {
			fired += 1;
		}, 1000);
		assert.strictEqual(call.pending, true);
		assert.strictEqual(timer.pending().length, 1);
		assert.strictEqual(timer.pending()[0]?.ms, 1000);

		timer.pending()[0]?.callback();
		assert.strictEqual(fired, 1);
		assert.strictEqual(call.pending, false, "firing clears the pending flag");
	});

	test("re-arming replaces the pending call instead of stacking a second one", () => {
		const timer = new FakeTimer();
		const call = new PendingCall(timer);
		let first = 0;
		let second = 0;

		call.arm(() => {
			first += 1;
		}, 1000);
		call.arm(() => {
			second += 1;
		}, 2000);

		assert.strictEqual(timer.pending().length, 1, "the first call was cancelled");
		assert.strictEqual(timer.pending()[0]?.ms, 2000);
		timer.pending()[0]?.callback();
		assert.strictEqual(first, 0);
		assert.strictEqual(second, 1);
	});

	test("cancel drops the pending call and clears the flag; cancelling idle is a no-op", () => {
		const timer = new FakeTimer();
		const call = new PendingCall(timer);
		let fired = 0;

		call.cancel();
		call.arm(() => {
			fired += 1;
		}, 500);
		call.cancel();

		assert.strictEqual(call.pending, false);
		assert.deepStrictEqual(timer.pending(), []);
		assert.strictEqual(fired, 0);
	});

	test("the pending flag clears before the callback runs, so a callback may re-arm", () => {
		const timer = new FakeTimer();
		const call = new PendingCall(timer);
		let rearmed = false;

		call.arm(() => {
			assert.strictEqual(call.pending, false, "the fired call no longer counts as pending");
			call.arm(() => {
				rearmed = true;
			}, 100);
		}, 100);

		timer.pending()[0]?.callback();
		assert.strictEqual(call.pending, true, "the callback's re-arm sticks");
		assert.strictEqual(rearmed, false);
	});

	test("a timer that fires synchronously inside set() does not strand a stale pending flag", () => {
		const synchronous: Timer = {
			set: (callback) => {
				callback();
				return () => {};
			},
		};
		const call = new PendingCall(synchronous);
		let fired = 0;

		call.arm(() => {
			fired += 1;
		}, 0);

		assert.strictEqual(fired, 1);
		assert.strictEqual(call.pending, false, "the already-fired call must not read as pending");
	});

	test("REAL_TIMER fires after the delay and its cancel closure prevents the call", async () => {
		let fired = 0;
		REAL_TIMER.set(() => {
			fired += 1;
		}, 5);
		const cancel = REAL_TIMER.set(() => {
			fired += 100;
		}, 5);
		cancel();
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.strictEqual(fired, 1);
	});

	test("SYSTEM_CLOCK tracks Date.now", () => {
		const before = Date.now();
		const reading = SYSTEM_CLOCK.now();
		const after = Date.now();
		assert.ok(reading >= before && reading <= after);
	});

	test("sleepUnlessAborted resolves early when the signal aborts, and immediately when already aborted", async () => {
		const controller = new AbortController();
		const slept = sleepUnlessAborted(60_000, controller.signal);
		controller.abort();
		await slept;

		const aborted = new AbortController();
		aborted.abort();
		await sleepUnlessAborted(60_000, aborted.signal);
	});

	test("sleepUnlessAborted resolves after the delay without an abort", async () => {
		const controller = new AbortController();
		const start = Date.now();
		await sleepUnlessAborted(10, controller.signal);
		assert.ok(Date.now() - start >= 5, "the sleep waited for its delay");
	});
});
