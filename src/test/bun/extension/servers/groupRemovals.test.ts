/**
 * The tombstone index is a second structure over the region's record list. What would drift silently: an adoption of
 * another window's blob (no commit here) leaving the index on the old records, and a lookup growing a storage read per
 * record. The scan's comparison count is not observable here and is not what this pins.
 */

import { expect, test } from "bun:test";
import type { GroupKey, RemovalMemento, TombstoneIdentity } from "../../../../extension/servers/groupRemovals";
import { GroupRemovalStore } from "../../../../extension/servers/groupRemovals";
import { REMOVED_GROUP_TOMBSTONES_KEY } from "../../../../shared/config/storageKeys";

function countingMemento(initial: Record<string, unknown>): {
	memento: RemovalMemento;
	store: Map<string, unknown>;
	reads: () => number;
} {
	const store = new Map<string, unknown>(Object.entries(initial));
	let reads = 0;
	return {
		store,
		reads: () => reads,
		memento: {
			get: (key) => {
				reads += 1;
				return store.get(key);
			},
			update: async (key, value) => {
				store.set(key, value);
			},
		},
	};
}

const stamped = (label: string, baseUrl: string): GroupKey => ({
	groupId: `group:${label}`,
	label: "h.test",
	entryLabel: label,
	baseUrl,
});

const unstamped = (groupId: string, label: string, baseUrl: string): GroupKey => ({
	groupId,
	label,
	entryLabel: undefined,
	baseUrl,
});

test("a lookup costs one storage read however many tombstones stand, and its answer follows commits, a foreign adoption, and a removal", async () => {
	const legacyStatusRecord = { label: "Legacy", baseUrl: "http://legacy.test" };
	const { memento, store, reads } = countingMemento({
		[REMOVED_GROUP_TOMBSTONES_KEY]: { version: "1", records: [legacyStatusRecord] },
	});
	const removals = new GroupRemovalStore(memento, { confirmDurable: async () => "durable" });
	const added: TombstoneIdentity[] = [];
	for (let i = 0; i < 150; i += 1) {
		added.push({ by: "entry", label: `E${i}`, baseUrl: `http://e${i}.test/` });
		added.push({ by: "group", groupId: `client:${i}`, label: "g.test", baseUrl: `http://g${i}.test` });
	}
	for (const identity of added) {
		await removals.addTombstone(identity);
	}
	expect(removals.tombstones().length).toBe(301);

	const lookups: [GroupKey, boolean][] = [
		[stamped("E7", "HTTP://E7.test"), true],
		[stamped("E7", "http://other.test"), false],
		[unstamped("client:9", "g.test", "http://g9.test"), true],
		[unstamped("client:none", "g.test", "http://g9.test"), false],
		[unstamped("client:none", "Legacy", "http://legacy.test/"), true],
		[unstamped("client:none", "Legacy", "http://elsewhere.test"), false],
	];
	const before = reads();
	for (const [group, hidden] of lookups) {
		expect(removals.isTombstoned(group)).toBe(hidden);
	}
	expect(removals.hasTombstone("E7", "http://e7.test")).toBe(true);
	expect(removals.hasTombstone("g.test", "http://g9.test")).toBe(true);
	expect(removals.hasTombstone("Legacy", "http://legacy.test")).toBe(true);
	expect(removals.hasTombstone("E7", "http://other.test")).toBe(false);
	expect(reads() - before).toBe(lookups.length + 4);

	// Another window wrote a strictly newer blob: the next read adopts it without any commit here.
	store.set(REMOVED_GROUP_TOMBSTONES_KEY, {
		version: "9000",
		records: [{ by: "entry", label: "Foreign", baseUrl: "http://foreign.test" }],
	});
	expect(removals.isTombstoned(stamped("Foreign", "http://foreign.test"))).toBe(true);
	expect(removals.isTombstoned(stamped("E7", "http://e7.test"))).toBe(false);
	expect(removals.isTombstoned(unstamped("client:9", "g.test", "http://g9.test"))).toBe(false);

	expect(await removals.removeTombstone({ label: "Foreign", baseUrl: "http://foreign.test/" })).toBe(true);
	expect(removals.isTombstoned(stamped("Foreign", "http://foreign.test"))).toBe(false);
	expect(removals.hasTombstone("Foreign", "http://foreign.test")).toBe(false);
});
