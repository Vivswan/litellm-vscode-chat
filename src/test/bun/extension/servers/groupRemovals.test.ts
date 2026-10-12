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
	writes: () => number;
} {
	const store = new Map<string, unknown>(Object.entries(initial));
	let reads = 0;
	let writes = 0;
	return {
		store,
		reads: () => reads,
		writes: () => writes,
		memento: {
			get: (key) => {
				reads += 1;
				return store.get(key);
			},
			update: async (key, value) => {
				writes += 1;
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

test("a batch of tombstones is one mutation: one change event, one persist, and per-identity answers as addTombstone gives them", async () => {
	// Every change event is a host re-resolve of every group, so a reconcile recording two or three identities per
	// removed entry must not fire per identity. Under a session-only salt the group-keyed records stay in memory.
	const { memento, store, writes } = countingMemento({});
	const removals = new GroupRemovalStore(memento, { confirmDurable: async () => "session-only" });
	let changes = 0;
	removals.onDidChange = () => {
		changes += 1;
	};
	const entry: TombstoneIdentity = { by: "entry", label: "A", baseUrl: "http://a.test/" };
	const again: TombstoneIdentity = { by: "entry", label: "A", baseUrl: "http://a.test" };
	const first: TombstoneIdentity = { by: "group", groupId: "client:1", label: "A", baseUrl: "http://a.test" };
	const second: TombstoneIdentity = { by: "group", groupId: "client:2", label: "A", baseUrl: "http://a.test" };

	const recorded = await removals.addTombstones([entry, first, again, second]);
	expect(recorded).toEqual([
		{ identity: entry, persistence: "durable", added: true },
		{ identity: first, persistence: "session-only", added: true },
		{ identity: again, persistence: "durable", added: false },
		{ identity: second, persistence: "session-only", added: true },
	]);
	expect(recorded.map((record) => record.identity)).toEqual([entry, first, again, second]);
	expect(changes).toBe(1);
	expect(writes()).toBe(1);
	expect(removals.tombstones()).toEqual([
		{ by: "entry", label: "A", baseUrl: "http://a.test" },
		{ by: "group", groupId: "client:1", label: "A", baseUrl: "http://a.test" },
		{ by: "group", groupId: "client:2", label: "A", baseUrl: "http://a.test" },
	]);
	expect(store.get(REMOVED_GROUP_TOMBSTONES_KEY)).toEqual({
		version: "1",
		records: [{ by: "entry", label: "A", baseUrl: "http://a.test" }],
	});
	expect(removals.isTombstoned(unstamped("client:2", "a.test", "http://a.test"))).toBe(true);

	// Nothing new: no event, and the durable record's re-persist heals an earlier failed write.
	expect(await removals.addTombstones([entry, second])).toEqual([
		{ identity: entry, persistence: "durable", added: false },
		{ identity: second, persistence: "session-only", added: false },
	]);
	expect(changes).toBe(1);
	expect(writes()).toBe(2);
});
