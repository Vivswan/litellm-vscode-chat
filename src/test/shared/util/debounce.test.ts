import * as assert from "node:assert";
import { debounced } from "../../../shared/util/debounce";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

suite("shared/util/debounce", () => {
	test("a burst of schedules runs the action once, after the delay", async () => {
		let runs = 0;
		const action = debounced(() => {
			runs += 1;
		}, 20);
		action.schedule();
		action.schedule();
		action.schedule();
		assert.strictEqual(runs, 0, "trailing edge: nothing runs during the burst");
		await wait(60);
		assert.strictEqual(runs, 1);
	});

	test("each schedule restarts the delay", async () => {
		let runs = 0;
		const action = debounced(() => {
			runs += 1;
		}, 40);
		action.schedule();
		await wait(20);
		action.schedule();
		await wait(25);
		assert.strictEqual(runs, 0, "the second schedule pushed the deadline past this point");
		await wait(40);
		assert.strictEqual(runs, 1);
	});

	test("a schedule after a run starts a fresh cycle", async () => {
		let runs = 0;
		const action = debounced(() => {
			runs += 1;
		}, 10);
		action.schedule();
		await wait(40);
		action.schedule();
		await wait(40);
		assert.strictEqual(runs, 2);
	});

	test("dispose cancels the pending run", async () => {
		let runs = 0;
		const action = debounced(() => {
			runs += 1;
		}, 10);
		action.schedule();
		action.dispose();
		await wait(40);
		assert.strictEqual(runs, 0, "a disposed action must never fire (extensions dispose on deactivate)");
	});

	test("dispose without a pending run is a no-op, and the action stays usable", async () => {
		let runs = 0;
		const action = debounced(() => {
			runs += 1;
		}, 10);
		action.dispose();
		action.schedule();
		await wait(40);
		assert.strictEqual(runs, 1);
	});
});
