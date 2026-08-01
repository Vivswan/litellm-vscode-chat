import * as assert from "node:assert";
import { GroupRemovalStore } from "../../../extension/servers/groupRemovals";
import { ORPHANED_GROUP_PROVENANCE_KEY, REMOVED_GROUP_TOMBSTONES_KEY } from "../../../shared/config/storageKeys";
import { makeExtensionStorage } from "../../testUtils";

function makeStore(initial: Record<string, unknown> = {}) {
	const storage = makeExtensionStorage(initial);
	const store = new GroupRemovalStore(storage.memento);
	const changes: number[] = [];
	store.onDidChange = () => changes.push(changes.length + 1);
	return { store, storage, changes };
}

suite("extension/servers/groupRemovals", () => {
	suite("tombstones", () => {
		test("add, match, and explicit removal round-trip; base URLs compare normalized", async () => {
			const { store, changes } = makeStore();
			assert.deepStrictEqual(store.tombstones(), []);

			await store.addTombstone({ label: "Prod", baseUrl: "http://prod.test/" });
			assert.deepStrictEqual(store.tombstones(), [{ label: "Prod", baseUrl: "http://prod.test" }]);
			assert.strictEqual(store.isTombstoned("Prod", "http://prod.test"), true);
			assert.strictEqual(store.isTombstoned("Prod", "http://prod.test///"), true, "trailing slashes are identity-free");
			assert.strictEqual(store.isTombstoned("Prod", "http://other.test"), false, "the URL is half the identity");
			assert.strictEqual(store.isTombstoned("Staging", "http://prod.test"), false, "the label is the other half");
			assert.strictEqual(changes.length, 1, "the add fires one change");

			assert.strictEqual(await store.removeTombstone({ label: "Prod", baseUrl: "http://prod.test" }), true);
			assert.deepStrictEqual(store.tombstones(), []);
			assert.strictEqual(changes.length, 2, "the unhide fires one change");

			assert.strictEqual(
				await store.removeTombstone({ label: "Prod", baseUrl: "http://prod.test" }),
				false,
				"removing a missing tombstone reports false"
			);
			assert.strictEqual(changes.length, 2, "a no-op removal fires no change");
		});

		test("adding an existing identity is a no-op and fires no change", async () => {
			const { store, changes } = makeStore();
			await store.addTombstone({ label: "Prod", baseUrl: "http://prod.test" });
			await store.addTombstone({ label: "Prod", baseUrl: "http://prod.test/" });

			assert.strictEqual(store.tombstones().length, 1);
			assert.strictEqual(changes.length, 1);
		});

		test("clearTombstonesFor removes exactly the identities a declared entry matches", async () => {
			const { store, changes } = makeStore();
			await store.addTombstone({ label: "Prod", baseUrl: "http://prod.test" });
			await store.addTombstone({ label: "Staging", baseUrl: "http://staging.test" });

			const cleared = await store.clearTombstonesFor([
				{ label: "Prod", baseUrl: "http://prod.test/" },
				{ label: "Unrelated", baseUrl: "http://elsewhere.test" },
			]);

			assert.strictEqual(cleared, true);
			assert.deepStrictEqual(store.tombstones(), [{ label: "Staging", baseUrl: "http://staging.test" }]);
			assert.strictEqual(changes.length, 3);

			assert.strictEqual(
				await store.clearTombstonesFor([{ label: "Prod", baseUrl: "http://prod.test" }]),
				false,
				"nothing left to clear reports false"
			);
			assert.strictEqual(changes.length, 3, "a no-op clear fires no change");
		});

		test("corrupt stored values are validated at the read boundary", () => {
			const { store } = makeStore({
				[REMOVED_GROUP_TOMBSTONES_KEY]: [
					{ label: "Prod", baseUrl: "http://prod.test" },
					{ label: 42, baseUrl: "http://bad.test" },
					"junk",
					{ label: "NoUrl" },
				],
			});
			assert.deepStrictEqual(store.tombstones(), [{ label: "Prod", baseUrl: "http://prod.test" }]);

			const { store: notAList } = makeStore({ [REMOVED_GROUP_TOMBSTONES_KEY]: "junk" });
			assert.deepStrictEqual(notAList.tombstones(), []);
		});
	});

	suite("provenance", () => {
		test("records one origin per identity, newest wins, and looks it up by normalized identity", async () => {
			const { store, changes } = makeStore();
			await store.recordOrigin({
				label: "Prod",
				baseUrl: "http://prod.test/",
				origin: { kind: "removed-entry-leftover", removedLabel: "Prod" },
			});
			assert.deepStrictEqual(store.originFor("Prod", "http://prod.test"), {
				kind: "removed-entry-leftover",
				removedLabel: "Prod",
			});
			assert.strictEqual(store.originFor("Prod", "http://other.test"), undefined);

			await store.recordOrigin({
				label: "Prod",
				baseUrl: "http://prod.test",
				origin: { kind: "rename-leftover", oldLabel: "Prod", newLabel: "Production" },
			});
			assert.deepStrictEqual(store.originFor("Prod", "http://prod.test"), {
				kind: "rename-leftover",
				oldLabel: "Prod",
				newLabel: "Production",
			});
			assert.strictEqual(store.provenance().length, 1, "one record per identity");
			assert.strictEqual(changes.length, 0, "provenance writes fire no tombstone change");
		});

		test("corrupt provenance records are dropped at the read boundary", () => {
			const { store } = makeStore({
				[ORPHANED_GROUP_PROVENANCE_KEY]: [
					{ label: "A", baseUrl: "http://a.test", origin: { kind: "removed-entry-leftover", removedLabel: "A" } },
					{ label: "B", baseUrl: "http://b.test", origin: { kind: "unknown-kind" } },
					{ label: "C", baseUrl: "http://c.test" },
					{ label: "D", baseUrl: "http://d.test", origin: { kind: "rename-leftover", oldLabel: "D" } },
				],
			});
			assert.deepStrictEqual(store.provenance(), [
				{ label: "A", baseUrl: "http://a.test", origin: { kind: "removed-entry-leftover", removedLabel: "A" } },
			]);
		});
	});
});
