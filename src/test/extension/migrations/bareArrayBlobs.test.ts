import * as assert from "node:assert";
import { bareArrayWrappingMemento } from "../../../extension/migrations/bareArrayBlobs";
import { GroupRemovalStore } from "../../../extension/servers/groupRemovals";
import { ORPHANED_GROUP_PROVENANCE_KEY, REMOVED_GROUP_TOMBSTONES_KEY } from "../../../shared/config/storageKeys";
import { makeExtensionStorage } from "../../testUtils";

suite("extension/migrations/bareArrayBlobs", () => {
	test("the view hands each region's bare array back in its versioned shape, losslessly", () => {
		const tombstone = { label: "Hidden", baseUrl: "http://hidden.test" };
		const provenance = {
			label: "Left",
			baseUrl: "http://left.test",
			origin: { kind: "removed-entry-leftover", removedLabel: "Left" },
		};
		// Corrupt members ride the wrap untouched: losslessness is the contract
		// here, and the readers' own sanitization keeps judging them.
		const storage = makeExtensionStorage({
			[REMOVED_GROUP_TOMBSTONES_KEY]: [tombstone, 42],
			[ORPHANED_GROUP_PROVENANCE_KEY]: [provenance],
		});
		const view = bareArrayWrappingMemento(storage.memento);

		assert.deepStrictEqual(view.get(REMOVED_GROUP_TOMBSTONES_KEY), { version: "0", records: [tombstone, 42] });
		assert.deepStrictEqual(view.get(ORPHANED_GROUP_PROVENANCE_KEY), { version: "0", records: [provenance] });
		// The view never writes on its own (see the module doc for why): the
		// stored blobs stay bare until a genuine persist promotes them.
		assert.ok(Array.isArray(storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY)));

		// The store constructed over the view (the activation wiring) adopts the
		// records like any versioned snapshot.
		const removals = new GroupRemovalStore(view);
		assert.strictEqual(removals.isTombstoned("Hidden", "http://hidden.test"), true);
		assert.strictEqual(removals.provenance().length, 1);
	});

	test("the first genuine persist promotes the format durably above the bare array", async () => {
		// Adoption is strictly-newer only, so the view wraps at the protocol's
		// floor (version 0) and the store's first persist writes version 1 - a
		// versioned superset that outranks the bare blob for every later reader.
		const storage = makeExtensionStorage({
			[REMOVED_GROUP_TOMBSTONES_KEY]: [{ label: "Old", baseUrl: "http://old.test" }],
		});
		const removals = new GroupRemovalStore(bareArrayWrappingMemento(storage.memento));

		await removals.addTombstone({ label: "New", baseUrl: "http://new.test" });

		assert.deepStrictEqual(storage.mementoStore.get(REMOVED_GROUP_TOMBSTONES_KEY), {
			version: "1",
			records: [
				{ label: "Old", baseUrl: "http://old.test" },
				{ label: "New", baseUrl: "http://new.test" },
			],
		});
	});

	test("versioned blobs and unrelated keys pass through untouched, by identity", () => {
		const versioned = { version: "4", records: [{ label: "L", baseUrl: "http://x.test" }] };
		const storage = makeExtensionStorage({
			[REMOVED_GROUP_TOMBSTONES_KEY]: versioned,
			"litellm.someOtherKey": ["a", "bare", "array"],
		});
		const view = bareArrayWrappingMemento(storage.memento);

		assert.strictEqual(
			view.get(REMOVED_GROUP_TOMBSTONES_KEY),
			versioned,
			"a versioned blob is handed back by identity"
		);
		assert.deepStrictEqual(view.get("litellm.someOtherKey"), ["a", "bare", "array"], "only the two regions wrap");
	});
});
