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

		test("a stale memento read cannot lose an awaited tombstone (#220)", async () => {
			// The nightly monkey fuzzer caught removed groups' models never
			// leaving the host list: globalState handed back a pre-update value
			// after an awaited update (the hazard the sync engine's fingerprint
			// session map documents), so a re-read inside the next add's
			// read-modify-write dropped the earlier tombstone, and the provider's
			// suppression read missed a just-written one. The session journal is
			// applied over every read, so this session's ops always win.
			const { store, storage } = makeStore();
			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			// The storage layer reverts the key to its pre-add value.
			storage.mementoStore.set(REMOVED_GROUP_TOMBSTONES_KEY, []);

			assert.strictEqual(store.isTombstoned("A", "http://host.test"), true, "the session journal serves the read");

			// The next add must build on the session list, not the reverted store:
			// both tombstones survive, and the persisted write carries both.
			await store.addTombstone({ label: "B", baseUrl: "http://host.test" });
			assert.strictEqual(store.isTombstoned("A", "http://host.test"), true, "A survives B's read-modify-write");
			assert.strictEqual(store.isTombstoned("B", "http://host.test"), true);
			assert.deepStrictEqual(storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY), [
				{ label: "A", baseUrl: "http://host.test" },
				{ label: "B", baseUrl: "http://host.test" },
			]);
		});

		test("a stale store cannot resurrect a cleared tombstone (a re-declared group never stays suppressed)", async () => {
			const { store, storage } = makeStore();
			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			assert.strictEqual(await store.removeTombstone({ label: "A", baseUrl: "http://host.test" }), true);

			// The storage layer reverts to the version that still holds A; the
			// session journal must keep the group unsuppressed anyway.
			storage.mementoStore.set(REMOVED_GROUP_TOMBSTONES_KEY, [{ label: "A", baseUrl: "http://host.test" }]);
			assert.strictEqual(store.isTombstoned("A", "http://host.test"), false);
		});

		test("another window's tombstone rides through this window's mutations", async () => {
			// globalState is shared across windows: the journal shadows only this
			// session's own ops, so a record another window persisted must both
			// answer reads here and survive this window's next full-list write.
			const { store, storage } = makeStore();
			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			storage.mementoStore.set(REMOVED_GROUP_TOMBSTONES_KEY, [
				{ label: "A", baseUrl: "http://host.test" },
				{ label: "W", baseUrl: "http://host.test" },
			]);

			assert.strictEqual(store.isTombstoned("W", "http://host.test"), true, "fresh reads see the other window");
			await store.addTombstone({ label: "B", baseUrl: "http://host.test" });
			assert.deepStrictEqual(storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY), [
				{ label: "A", baseUrl: "http://host.test" },
				{ label: "W", baseUrl: "http://host.test" },
				{ label: "B", baseUrl: "http://host.test" },
			]);
		});

		test("a rejected persist still hides the group this session and self-heals on the next write", async () => {
			const { store, storage, changes } = makeStore();
			const persistErrors: unknown[] = [];
			store.onPersistError = (error) => persistErrors.push(error);
			const update = storage.memento.update.bind(storage.memento);
			let failNext = true;
			(storage.memento as { update: (key: string, value: unknown) => Thenable<void> }).update = (key, value) => {
				if (failNext) {
					failNext = false;
					return Promise.reject(new Error("storage write failed"));
				}
				return update(key, value);
			};

			// Persistence is best-effort: the journal hides the group, the
			// provider is notified, and the failure is reported instead of thrown
			// (a thrown persist would make callers report the opposite of the
			// effective state).
			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			assert.strictEqual(store.isTombstoned("A", "http://host.test"), true, "the journal hides the group anyway");
			assert.strictEqual(changes.length, 1, "the provider is notified despite the failed persist");
			assert.strictEqual(persistErrors.length, 1, "the failure is reported, not thrown");

			await store.addTombstone({ label: "B", baseUrl: "http://host.test" });
			assert.deepStrictEqual(
				storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY),
				[
					{ label: "A", baseUrl: "http://host.test" },
					{ label: "B", baseUrl: "http://host.test" },
				],
				"the next write persists the journaled view, healing the store"
			);
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
