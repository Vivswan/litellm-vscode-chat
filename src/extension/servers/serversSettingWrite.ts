/**
 * The one write turn for the servers setting. Every writer derives what it writes from a read made in the same tick,
 * inside one serialized turn, so two writers cannot interleave with one landing an entry the other's precomputed
 * array then drops. The token is minted only inside a turn, so a store's write accepts nothing else.
 *
 *   dashboard intents, the dev seed  -> writeServersSettingFrom: an array derived from the fresh read
 *   settings import and its undo     -> replaceServersSetting: a value planned over an earlier read, refused once moved
 */

import { isDeepStrictEqual } from "node:util";

const MINT = Symbol("mint");

class ServersSettingWrite {
	readonly #value: unknown;
	constructor(value: unknown, key: symbol) {
		if (key !== MINT) {
			throw new TypeError("ServersSettingWrite is minted inside serversSettingWrite.ts's write turn only");
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

/**
 * The servers-setting array as a mutable copy, entries preserved verbatim: junk siblings (non-objects, entries without
 * labels) must survive a rewrite untouched so a save never deletes what the user typed by hand. Non-arrays read as
 * empty so a save can still land.
 */
export function rawServerEntries(raw: unknown): unknown[] {
	return Array.isArray(raw) ? [...raw] : [];
}

let serversWriteTurn: Promise<unknown> = Promise.resolve();

/** `next` runs in the same tick as the read; a promise continuation between the two would be a yield point. */
function withServersSettingWrite(
	store: ServersSettingStore,
	next: (current: unknown) => ServersSettingWrite | undefined
): Promise<boolean> {
	const run = async (): Promise<boolean> => {
		const write = next(store.readServersSetting());
		if (write === undefined) {
			return false;
		}
		await store.writeServersSetting(write);
		return true;
	};
	const turn = serversWriteTurn.then(run, run);
	serversWriteTurn = turn.catch(() => undefined);
	return turn;
}

export function writeServersSettingFrom(
	store: ServersSettingStore,
	next: (fresh: readonly unknown[]) => readonly unknown[] | undefined
): Promise<boolean> {
	return withServersSettingWrite(store, (current) => {
		const entries = next(rawServerEntries(current));
		return entries === undefined ? undefined : new ServersSettingWrite(entries, MINT);
	});
}

/**
 * Writes a value planned over an earlier read (an import's merge, an undo's restore) only while the setting still reads
 * deep-equal to `plannedOver`; false once it moved, since the decisions made over it no longer hold. An undefined
 * `value` removes the user-scope value (an undo restoring a recorded absence).
 */
export function replaceServersSetting(
	store: ServersSettingStore,
	plannedOver: unknown,
	value: unknown
): Promise<boolean> {
	return withServersSettingWrite(store, (current) =>
		isDeepStrictEqual(current, plannedOver) ? new ServersSettingWrite(value, MINT) : undefined
	);
}
