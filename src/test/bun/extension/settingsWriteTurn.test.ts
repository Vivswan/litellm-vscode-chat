/**
 * The servers-setting write turn: the one value the derive door cannot express (an undo's recorded absence), which the
 * replace door writes as a removal instead of skipping, and the ordering a second writer's derivation observes.
 */

import { expect, test } from "bun:test";
import type { ServersSettingStore } from "../../../extension/settingsWriteTurn";
import { replaceServersSetting, settingValueOf, writeServersSettingFrom } from "../../../extension/settingsWriteTurn";

function memoryStore(initial: unknown): { store: ServersSettingStore; writes: unknown[] } {
	const writes: unknown[] = [];
	let value = initial;
	return {
		writes,
		store: {
			readServersSetting: () => value,
			writeServersSetting: async (write) => {
				value = settingValueOf(write);
				writes.push(value);
			},
		},
	};
}

test("a replacement planned over an earlier read lands only while the setting still reads the same, a recorded absence included", async () => {
	const planned = [{ label: "a", baseUrl: "http://a.test" }];
	const moved = memoryStore([...planned, { label: "b", baseUrl: "http://b.test" }]);
	expect(await replaceServersSetting(moved.store, planned, [])).toBe(false);
	expect(moved.writes).toEqual([]);

	// Equal by value, not identity: the host hands a fresh object on every read.
	const same = memoryStore([{ label: "a", baseUrl: "http://a.test" }]);
	expect(await replaceServersSetting(same.store, planned, undefined)).toBe(true);
	expect(same.writes).toEqual([undefined]);
});

test("a second writer's derivation runs after the first's write landed and sees it", async () => {
	const { store, writes } = memoryStore([]);
	let releaseFirst: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const slow: ServersSettingStore = {
		...store,
		writeServersSetting: async (write) => {
			await held;
			await store.writeServersSetting(write);
		},
	};
	const first = writeServersSettingFrom(slow, (fresh) => [...fresh, "first"]);
	const second = writeServersSettingFrom(store, (fresh) => [...fresh, "second"]);
	releaseFirst();
	await Promise.all([first, second]);
	expect(writes).toEqual([["first"], ["first", "second"]]);
});
