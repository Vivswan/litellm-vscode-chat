/**
 * The one write turn for the extension's settings. Every writer runs inside it, so no write interleaves with another
 * writer's read-then-write block: a dashboard scalar write cannot land between an import's same-turn check and its
 * writes, and no servers array is derived from a read another writer invalidated. The servers token is minted only
 * inside a turn, so a store's servers write accepts nothing a turn did not derive.
 *
 *   SettingsAccess keyed writers     -> one write per turn
 *   dashboard intents, the dev seed  -> writeServersSettingFrom: an array derived from the fresh read
 *   the URL-spelling migration       -> replaceServersSetting: a value planned over an earlier read, refused once moved
 *   settings import and its undo     -> SettingsAccess.writeTurn: a plan judged against a same-turn read, then writes
 */

import { isDeepStrictEqual } from "node:util";
import { Mutex } from "async-mutex";

const MINT = Symbol("mint");

class ServersSettingWrite {
	readonly #value: unknown;
	constructor(value: unknown, key: symbol) {
		if (key !== MINT) {
			throw new TypeError("ServersSettingWrite is minted inside settingsWriteTurn.ts's write turn only");
		}
		this.#value = value;
	}
	static valueOf(write: ServersSettingWrite): unknown {
		return write.#value;
	}
}
Object.freeze(ServersSettingWrite);

export type { ServersSettingWrite };

/** The value behind a token; a TypeError for an object the turn never minted, whatever its shape. */
export function settingValueOf(write: ServersSettingWrite): unknown {
	return ServersSettingWrite.valueOf(write);
}

/** Where a writer's servers setting lives: SettingsAccess, IntentEnvironment, and DevSeedEnv are stores. */
export interface ServersSettingStore {
	/** The value a write would replace. */
	readServersSetting(): unknown;
	/** Write the value a turn minted; no other value is writable. */
	writeServersSetting(write: ServersSettingWrite): Promise<void>;
}

/** What a turn hands its body. */
export interface SettingsWriteTurn {
	/** The token for a servers value this turn derived. */
	servers(value: unknown): ServersSettingWrite;
}

/**
 * The servers-setting array as a mutable copy, entries preserved verbatim: junk siblings (non-objects, entries without
 * labels) must survive a rewrite untouched so a save never deletes what the user typed by hand. Non-arrays read as
 * empty so a save can still land.
 */
export function rawServerEntries(raw: unknown): unknown[] {
	return Array.isArray(raw) ? [...raw] : [];
}

const settingsWriteMutex = new Mutex();

/** `run` holds the turn until its promise settles; nothing in this process writes a setting meanwhile. */
export function inSettingsWriteTurn<T>(run: (turn: SettingsWriteTurn) => Promise<T>): Promise<T> {
	return settingsWriteMutex.runExclusive(() => run({ servers: (value) => new ServersSettingWrite(value, MINT) }));
}

export function writeServersSettingFrom(
	store: ServersSettingStore,
	next: (fresh: readonly unknown[]) => readonly unknown[] | undefined
): Promise<boolean> {
	return inSettingsWriteTurn(async (turn) => {
		const entries = next(rawServerEntries(store.readServersSetting()));
		if (entries === undefined) {
			return false;
		}
		await store.writeServersSetting(turn.servers(entries));
		return true;
	});
}

/**
 * Writes a value planned over an earlier read only while the setting still reads deep-equal to `plannedOver`; false
 * once it moved, since the decisions made over it no longer hold. An undefined `value` removes the user-scope value.
 */
export function replaceServersSetting(
	store: ServersSettingStore,
	plannedOver: unknown,
	value: unknown
): Promise<boolean> {
	return inSettingsWriteTurn(async (turn) => {
		if (!isDeepStrictEqual(store.readServersSetting(), plannedOver)) {
			return false;
		}
		await store.writeServersSetting(turn.servers(value));
		return true;
	});
}
