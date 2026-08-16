import * as assert from "node:assert";
import { GroupRemovalStore } from "../../../extension/servers/groupRemovals";
import { ORPHANED_GROUP_PROVENANCE_KEY, REMOVED_GROUP_TOMBSTONES_KEY } from "../../../shared/config/storageKeys";
import { expectDefined } from "../../pureHelpers";
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

			const { store: junkRecords } = makeStore({ [REMOVED_GROUP_TOMBSTONES_KEY]: { version: 3, records: "junk" } });
			assert.deepStrictEqual(junkRecords.tombstones(), []);
		});

		test("a pre-versioning bare-array blob is readable and upgraded on write", async () => {
			const { store, storage } = makeStore({
				[REMOVED_GROUP_TOMBSTONES_KEY]: [{ label: "Old", baseUrl: "http://old.test" }],
			});
			assert.strictEqual(store.isTombstoned("Old", "http://old.test"), true);

			await store.addTombstone({ label: "New", baseUrl: "http://new.test" });
			assert.deepStrictEqual(storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY), {
				version: "1",
				records: [
					{ label: "Old", baseUrl: "http://old.test" },
					{ label: "New", baseUrl: "http://new.test" },
				],
			});
		});

		test("a broken persisted version re-enters versioning at 0 instead of freezing adoption", async () => {
			// Versions are decimal strings compared as BigInt; junk of any shape re-enters
			// at 0 with the records kept, so no hand-edited value can park the protocol.
			for (const broken of [Number.POSITIVE_INFINITY, Number.NaN, 1e20, -1, 1.5, "junk", "-1", "1.5", ""]) {
				const { store, storage } = makeStore({
					[REMOVED_GROUP_TOMBSTONES_KEY]: { version: broken, records: [{ label: "A", baseUrl: "http://host.test" }] },
				});
				assert.strictEqual(store.isTombstoned("A", "http://host.test"), true, `records survive version ${broken}`);

				await store.addTombstone({ label: "B", baseUrl: "http://host.test" });
				assert.deepStrictEqual(
					storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY),
					{
						version: "1",
						records: [
							{ label: "A", baseUrl: "http://host.test" },
							{ label: "B", baseUrl: "http://host.test" },
						],
					},
					`version ${broken} re-enters at 0`
				);
			}
		});

		test("a stale memento read cannot lose an awaited tombstone (#220)", async () => {
			// globalState can hand back a pre-update value after an awaited update, which
			// would drop an earlier tombstone in the next add's read-modify-write. A
			// reverted snapshot carries an older-or-equal version, so the in-memory list
			// keeps serving reads and the next write rebuilds the store from it.
			const { store, storage } = makeStore();
			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			// The storage layer reverts the key to its pre-add value.
			storage.mementoStore.set(REMOVED_GROUP_TOMBSTONES_KEY, []);

			assert.strictEqual(store.isTombstoned("A", "http://host.test"), true, "the stale snapshot is ignored");

			// The next add must build on the in-memory list, not the reverted
			// store: both tombstones survive, and the persisted write carries both.
			await store.addTombstone({ label: "B", baseUrl: "http://host.test" });
			assert.strictEqual(store.isTombstoned("A", "http://host.test"), true, "A survives B's read-modify-write");
			assert.strictEqual(store.isTombstoned("B", "http://host.test"), true);
			assert.deepStrictEqual(storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY), {
				version: "2",
				records: [
					{ label: "A", baseUrl: "http://host.test" },
					{ label: "B", baseUrl: "http://host.test" },
				],
			});
		});

		test("a stale store cannot resurrect a cleared tombstone (a re-declared group never stays suppressed)", async () => {
			const { store, storage } = makeStore();
			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			assert.strictEqual(await store.removeTombstone({ label: "A", baseUrl: "http://host.test" }), true);

			// The storage layer reverts to the version that still holds A; the
			// older snapshot must not win over the in-memory list.
			storage.mementoStore.set(REMOVED_GROUP_TOMBSTONES_KEY, {
				version: 1,
				records: [{ label: "A", baseUrl: "http://host.test" }],
			});
			assert.strictEqual(store.isTombstoned("A", "http://host.test"), false);
		});

		test("another window's tombstone rides through this window's mutations", async () => {
			// globalState is shared across windows: another window syncs before it mutates,
			// so its write is strictly newer and is adopted here on the next read.
			const { store, storage } = makeStore();
			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			storage.mementoStore.set(REMOVED_GROUP_TOMBSTONES_KEY, {
				version: 2,
				records: [
					{ label: "A", baseUrl: "http://host.test" },
					{ label: "W", baseUrl: "http://host.test" },
				],
			});

			assert.strictEqual(store.isTombstoned("W", "http://host.test"), true, "fresh reads see the other window");
			await store.addTombstone({ label: "B", baseUrl: "http://host.test" });
			assert.deepStrictEqual(storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY), {
				version: "3",
				records: [
					{ label: "A", baseUrl: "http://host.test" },
					{ label: "W", baseUrl: "http://host.test" },
					{ label: "B", baseUrl: "http://host.test" },
				],
			});
		});

		test("another window's store-level unhide is adopted, never re-clobbered", async () => {
			// The version tells a genuine foreign clear apart from the reverted store read
			// of #220: another window's Unhide is strictly newer and wins, while a revert
			// is older-or-equal and loses.
			const { store, storage } = makeStore();
			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			// Another window adopted version 1, unhid A, and persisted version 2.
			storage.mementoStore.set(REMOVED_GROUP_TOMBSTONES_KEY, { version: 2, records: [] });

			assert.strictEqual(store.isTombstoned("A", "http://host.test"), false, "the foreign unhide is honored here");
			await store.addTombstone({ label: "B", baseUrl: "http://host.test" });
			assert.deepStrictEqual(
				storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY),
				{ version: "3", records: [{ label: "B", baseUrl: "http://host.test" }] },
				"A stays cleared through this window's next write"
			);
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

			// Persistence is best-effort: the in-memory list hides the group and the
			// failure is reported instead of thrown, since a thrown persist would make
			// callers report the opposite of the effective state.
			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			assert.strictEqual(store.isTombstoned("A", "http://host.test"), true, "the in-memory list hides the group");
			assert.strictEqual(changes.length, 1, "the provider is notified despite the failed persist");
			assert.strictEqual(persistErrors.length, 1, "the failure is reported, not thrown");

			await store.addTombstone({ label: "B", baseUrl: "http://host.test" });
			assert.deepStrictEqual(
				storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY),
				{
					version: "1",
					records: [
						{ label: "A", baseUrl: "http://host.test" },
						{ label: "B", baseUrl: "http://host.test" },
					],
				},
				"the next write persists the whole in-memory view, healing the store"
			);
		});

		test("a foreign snapshot cannot drop records a failed persist left unwritten", async () => {
			// After a rejected write memory is ahead of storage, so adoption is suspended:
			// a strictly newer foreign blob must not silently drop the unpersisted
			// tombstone. The healing write versions above the skipped snapshot.
			const { store, storage } = makeStore();
			store.onPersistError = () => {};
			const update = storage.memento.update.bind(storage.memento);
			let failNext = true;
			(storage.memento as { update: (key: string, value: unknown) => Thenable<void> }).update = (key, value) => {
				if (failNext) {
					failNext = false;
					return Promise.reject(new Error("storage write failed"));
				}
				return update(key, value);
			};

			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			storage.mementoStore.set(REMOVED_GROUP_TOMBSTONES_KEY, { version: 5, records: [] });

			assert.strictEqual(store.isTombstoned("A", "http://host.test"), true, "A survives while unpersisted");
			await store.addTombstone({ label: "B", baseUrl: "http://host.test" });
			assert.deepStrictEqual(storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY), {
				version: "6",
				records: [
					{ label: "A", baseUrl: "http://host.test" },
					{ label: "B", baseUrl: "http://host.test" },
				],
			});
		});

		test("onDidChange listeners observe the mutated state, and the persist settles after", async () => {
			// The activation wiring re-resolves models synchronously from the change
			// event, so the in-memory list must already answer with the mutation.
			const storage = makeExtensionStorage({});
			const store = new GroupRemovalStore(storage.memento);
			const seen: boolean[] = [];
			store.onDidChange = () => seen.push(store.isTombstoned("A", "http://host.test"));

			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			await store.removeTombstone({ label: "A", baseUrl: "http://host.test" });

			assert.deepStrictEqual(seen, [true, false], "each listener call sees the state its mutation produced");
		});

		test("the callback slots are set-once: a second assignment throws and the first listener stays attached", async () => {
			const { store, changes } = makeStore();
			assert.throws(() => {
				store.onDidChange = () => {};
			}, /already assigned/);
			store.onPersistError = () => {};
			assert.throws(() => {
				store.onPersistError = () => {};
			}, /already assigned/);

			await store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			assert.strictEqual(changes.length, 1, "the original listener survives the rejected assignment");
		});

		test("serialized writes: a covered failure leaves no false dirty state, an uncovered one suspends adoption", async () => {
			// Writes run serialized, each persisting the records as of when it runs. The
			// stalled first write lands AFTER both adds, so it persists A and B together
			// and the second write's failure is covered: adoption must NOT suspend.
			const { store, storage } = makeStore();
			store.onPersistError = () => {};
			const update = storage.memento.update.bind(storage.memento);
			let firstGate: (() => void) | undefined;
			let call = 0;
			(storage.memento as { update: (key: string, value: unknown) => Thenable<void> }).update = (key, value) => {
				call += 1;
				if (call === 1) {
					// The first write stalls until released.
					return new Promise((resolve) => {
						firstGate = () => resolve(update(key, value));
					});
				}
				if (call === 2) {
					return Promise.reject(new Error("storage write failed"));
				}
				return update(key, value);
			};

			const first = store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			const second = store.addTombstone({ label: "B", baseUrl: "http://host.test" });
			// The queued first write reaches the stalled update on a microtask.
			await new Promise((resolve) => setTimeout(resolve, 0));
			expectDefined(firstGate)();
			await Promise.all([first, second]);

			assert.deepStrictEqual(
				storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY),
				{
					version: "1",
					records: [
						{ label: "A", baseUrl: "http://host.test" },
						{ label: "B", baseUrl: "http://host.test" },
					],
				},
				"the first write persisted both adds"
			);

			// Everything committed is in storage, so a foreign clear is adopted.
			storage.mementoStore.set(REMOVED_GROUP_TOMBSTONES_KEY, { version: 9, records: [] });
			assert.strictEqual(store.isTombstoned("B", "http://host.test"), false, "the foreign clear is honored");
		});

		test("an earlier success cannot mark a later, uncovered failure as persisted", async () => {
			// The mirror case: the first write is in flight holding only A when B is
			// committed, so its success covers A alone and B stays unwritten.
			const { store, storage } = makeStore();
			store.onPersistError = () => {};
			const update = storage.memento.update.bind(storage.memento);
			let firstGate: (() => void) | undefined;
			let call = 0;
			(storage.memento as { update: (key: string, value: unknown) => Thenable<void> }).update = (key, value) => {
				call += 1;
				if (call === 1) {
					return new Promise((resolve) => {
						firstGate = () => resolve(update(key, value));
					});
				}
				if (call === 2) {
					return Promise.reject(new Error("storage write failed"));
				}
				return update(key, value);
			};

			const first = store.addTombstone({ label: "A", baseUrl: "http://host.test" });
			// Let the first write start (and stall) before B is committed.
			await new Promise((resolve) => setTimeout(resolve, 0));
			const second = store.addTombstone({ label: "B", baseUrl: "http://host.test" });
			expectDefined(firstGate)();
			await Promise.all([first, second]);

			// B never reached storage, so a newer foreign snapshot must be skipped.
			storage.mementoStore.set(REMOVED_GROUP_TOMBSTONES_KEY, { version: 9, records: [] });
			assert.strictEqual(store.isTombstoned("B", "http://host.test"), true, "B survives its failed write");
		});

		test("the version keeps advancing past every numeric boundary (BigInt, no overflow)", async () => {
			// Number.MAX_SAFE_INTEGER and a 64-digit string are both boundaries a numeric
			// or length-capped scheme would freeze at; here each successor is exact,
			// strictly newer, and round-trips through a fresh store.
			for (const start of [BigInt(Number.MAX_SAFE_INTEGER), BigInt("9".repeat(64))]) {
				const { store, storage } = makeStore({
					[REMOVED_GROUP_TOMBSTONES_KEY]: {
						version: start.toString(),
						records: [{ label: "A", baseUrl: "http://host.test" }],
					},
				});

				await store.addTombstone({ label: "B", baseUrl: "http://host.test" });
				assert.deepStrictEqual(
					storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY),
					{
						version: (start + 1n).toString(),
						records: [
							{ label: "A", baseUrl: "http://host.test" },
							{ label: "B", baseUrl: "http://host.test" },
						],
					},
					`the successor of ${start} is exact and strictly newer`
				);
				// The written string version round-trips: a fresh store adopts it and counts on.
				const { store: reread, storage: rereadStorage } = makeStore(Object.fromEntries(storage.mementoStore.entries()));
				await reread.addTombstone({ label: "C", baseUrl: "http://host.test" });
				const blob = rereadStorage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY) as { version: string };
				assert.strictEqual(blob.version, (start + 2n).toString());
				assert.strictEqual(reread.isTombstoned("B", "http://host.test"), true, "the fresh store adopted the records");
			}
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
