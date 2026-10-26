/**
 * Record-key rewrites for the redesign: pre-redesign record keys were implicit prefixes (optionally server-URL scoped
 * in the global records); the new grammar is explicit matchers with no server scoping. The transforms here are pure
 * and shared by the global-record and entry-record paths.
 */

import { trimHttpWhitespace } from "../../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";
import { DECLARE_DIRECTIVE, isForceableKey } from "./legacyIds";

/**
 * Each form matches exactly the IDs the old literal prefix matched, so a prefix containing "*" (beyond the bare
 * "*" alias) becomes an escaped anchored regex; both obvious spellings would break or widen it.
 *
 *   append a star -> a second star, which parseMatcherKey rejects as misplaced
 *   ride verbatim -> glob or regex semantics over a different match set, or a misplaced-star rejection
 *
 * The regex form ranks below globs, so overlapping keys can order differently than under the old longest-prefix rule;
 * accepted.
 */
function explicitMatcherKey(prefix: string): string {
	if (prefix === "" || prefix === "*") {
		return "*";
	}
	if (prefix.includes("*")) {
		return `/${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*/`;
	}
	return `${prefix}*`;
}

/**
 * The migration freezes OLD forceability, where max_tokens was provider-owned and unforceable, while the new grammar
 * deliberately allows forcing it. A migrated record whose `_force` would newly cover max_tokens is minimally
 * rewritten - `true` expands to the old-forceable literal list only when the record sets max_tokens, and an explicit
 * list drops the max_tokens name the old parser diagnosed and ignored.
 */
function normalizeMigratedForce(value: unknown): { value: unknown; rewrote: boolean } {
	if (!isRecord(value) || !Object.hasOwn(value, "_force")) {
		return { value, rewrote: false };
	}
	const directive = value._force;
	if (directive === true) {
		if (!Object.hasOwn(value, "max_tokens")) {
			return { value, rewrote: false };
		}
		const list = Object.keys(value).filter((key) => key !== "_force" && isForceableKey(key));
		return { value: { ...value, _force: list }, rewrote: true };
	}
	if (Array.isArray(directive) && directive.some((name) => name === "max_tokens")) {
		return { value: { ...value, _force: directive.filter((name) => name !== "max_tokens") }, rewrote: true };
	}
	return { value, rewrote: false };
}

/**
 *   the same disambiguation rule the removed scoped-key matching used -> the migration classifies exactly the keys
 *       the old readers classified
 */
export function isUrlScopedKey(key: string): boolean {
	return key.includes("://");
}

/** A record key whose exact literal a `_declare` directive could name: anything but the catch-all aliases. */
function isDeclarableKey(key: string): boolean {
	return key !== "" && key !== "*";
}

export type RecordKind = "parameters" | "capabilities";

interface DeclareStripResult {
	/** The record without its `_declare` key, or the input untouched when it carried none. */
	readonly value: unknown;

	/** True when the record carried a legal `_declare: true` (moved when the key can name an ID). */
	readonly declared: boolean;

	/** True when a `_declare` key was removed without producing a declaration. */
	readonly strippedInert: boolean;
}

/**
 * Only a literal `true` on a declarable key ever declared; every other carrier (false, junk values, catch-all or
 * unscoped keys) was inert or diagnosed, so stripping it is behavior-preserving either way.
 */
function stripDeclare(value: unknown, declarable: boolean): DeclareStripResult {
	if (!isRecord(value) || !Object.hasOwn(value, DECLARE_DIRECTIVE)) {
		return { value, declared: false, strippedInert: false };
	}
	const declared = value[DECLARE_DIRECTIVE] === true && declarable;
	const stripped = Object.fromEntries(Object.entries(value).filter(([key]) => key !== DECLARE_DIRECTIVE));
	return { value: stripped, declared, strippedInert: !declared };
}

/** One transformed record key, before the catch-all collision is resolved. */
interface TransformedKey {
	readonly sourceKey: string;
	readonly newKey: string;
	readonly value: unknown;
}

/**
 * Assemble transformed keys into a record, resolving the one possible collision: "" and "*" both map to "*", and the
 * old prefix matching broke that tie toward "*", so the "*" source's value wins and the "" source is dropped.
 * Object.fromEntries defines own properties, so a pathological "__proto__*" key stays inert data.
 */
function assembleRecord(transformed: readonly TransformedKey[]): { record: Record<string, unknown>; dropped: number } {
	let dropped = 0;
	const winners = new Map<string, TransformedKey>();
	for (const entry of transformed) {
		const existing = winners.get(entry.newKey);
		if (existing === undefined) {
			winners.set(entry.newKey, entry);
			continue;
		}
		dropped += 1;
		if (entry.sourceKey === "*") {
			winners.set(entry.newKey, entry);
		}
	}
	return {
		record: Object.fromEntries([...winners.values()].map((entry) => [entry.newKey, entry.value])),
		dropped,
	};
}

export interface EntryRecordTransform {
	/** The transformed record, or the raw value verbatim when it was not a record. */
	readonly value: unknown;

	/** Exact IDs whose record carried an honored `_declare: true`. */
	readonly declared: readonly string[];

	/** Counts the keys rewritten to the explicit matcher spelling (explicitMatcherKey). */
	readonly starredKeys: number;

	/** Counts the keys dropped because "" and "*" both map to "*" and the "*" source wins (assembleRecord). */
	readonly droppedAliasKeys: number;

	/** Counts the `_declare` keys removed without producing a declaration. */
	readonly strippedInertDeclares: number;

	/** Counts the records whose migrated `_force` was rewritten to its old forceable coverage. */
	readonly rewroteForce: number;
}

/** One record value as the migration carries it, with what the carry did to it. */
interface CarriedValue {
	readonly value: unknown;
	readonly declared: boolean;
	readonly strippedInert: boolean;
	readonly rewroteForce: boolean;
}

/**
 * Carries one record value: a capabilities record has its `_declare` stripped (declaring when the key can name an ID),
 * a parameters record has its migrated `_force` normalized to the names it really forced.
 */
function carryValue(value: unknown, kind: RecordKind, declarable: boolean): CarriedValue {
	if (kind === "capabilities") {
		const strip = stripDeclare(value, declarable);
		return { value: strip.value, declared: strip.declared, strippedInert: strip.strippedInert, rewroteForce: false };
	}
	const normalized = normalizeMigratedForce(value);
	return { value: normalized.value, declared: false, strippedInert: false, rewroteForce: normalized.rewrote };
}

/**
 * A non-record value rides verbatim - it was inert under the old readers and stays inert under the new ones.
 */
export function transformEntryRecord(raw: unknown, kind: RecordKind): EntryRecordTransform {
	if (!isRecord(raw)) {
		return { value: raw, declared: [], starredKeys: 0, droppedAliasKeys: 0, strippedInertDeclares: 0, rewroteForce: 0 };
	}
	const declared: string[] = [];
	let starredKeys = 0;
	let strippedInertDeclares = 0;
	let rewroteForce = 0;
	const transformed: TransformedKey[] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (isUnsafeRecordKey(key)) {
			// The old normalization dropped reserved keys wholesale (inert), so starring one would ACTIVATE it;
			// verbatim it stays dropped-inert under the new normalization too.
			transformed.push({ sourceKey: key, newKey: key, value });
			continue;
		}
		const carried = carryValue(value, kind, isDeclarableKey(key));
		if (carried.declared) {
			// The parser trims declared IDs, so the move writes the trimmed form.
			declared.push(trimHttpWhitespace(key));
		}
		if (carried.strippedInert) {
			strippedInertDeclares += 1;
		}
		if (carried.rewroteForce) {
			rewroteForce += 1;
		}
		const newKey = explicitMatcherKey(key);
		if (newKey !== key) {
			starredKeys += 1;
		}
		transformed.push({ sourceKey: key, newKey, value: carried.value });
	}
	const { record, dropped } = assembleRecord(transformed);
	return { value: record, declared, starredKeys, droppedAliasKeys: dropped, strippedInertDeclares, rewroteForce };
}

/** One declared entry a scoped key can move into: its raw-array index and its normalized base URL. */
export interface ScopedMoveTarget {
	readonly entryIndex: number;
	readonly normalizedBaseUrl: string;
}

/**
 * A target with the state of the two slots a scoped key can land in (entries.ts, entrySlotAccepts). A key moves only
 * when every target at its URL can take it, so one blocked entry keeps the key in place for all of them.
 */
export interface ScopedMoveTargetState extends ScopedMoveTarget {
	readonly acceptsRecords: boolean;
	readonly acceptsDeclares: boolean;
}

export interface GlobalRecordTransform {
	/** The global record with its moved scoped keys removed, or the raw value verbatim when it was not a record. */
	readonly value: unknown;

	/** Per entry index: the moved scoped keys' values under their new keys, the entry record's additions. */
	readonly entryAdditions: ReadonlyMap<number, ReadonlyMap<string, unknown>>;

	/** Per entry index: exact IDs its scoped keys declared. */
	readonly entryDeclares: ReadonlyMap<number, readonly string[]>;

	/** Counts the keys rewritten to the explicit matcher spelling (explicitMatcherKey). */
	readonly starredKeys: number;

	/** Counts the keys dropped in the "" versus "*" collision (assembleRecord). */
	readonly droppedAliasKeys: number;

	/** Counts the URL-scoped keys that moved into every declared entry at their URL. */
	readonly movedScopedKeys: number;

	/** Counts the URL-scoped keys kept verbatim: no entry at their URL, or one that cannot take them. */
	readonly inertScopedKeys: number;

	/** Counts the `_declare` keys removed without producing a declaration, once per key. */
	readonly strippedInertDeclares: number;

	/** Counts the records whose migrated `_force` was rewritten to its old forceable coverage. */
	readonly rewroteForce: number;
}

/**
 * One place a URL-scoped key lands: the entry at its URL, the key's remainder past the URL, the value stripped for
 * it.
 */
interface ScopedLanding {
	readonly target: ScopedMoveTargetState;
	readonly remainder: string;
	readonly strip: DeclareStripResult;
}

/**
 * The mutable state of one global-record transform: the moved keys per entry, the kept keys, and the running
 * counts.
 */
interface GlobalMoveState {
	readonly entryAdditions: Map<number, Map<string, unknown>>;
	readonly entryDeclares: Map<number, string[]>;
	readonly kept: TransformedKey[];
	starredKeys: number;
	movedScopedKeys: number;
	inertScopedKeys: number;
	strippedInertDeclares: number;
	rewroteForce: number;
}

/**
 * The entries a URL-scoped key lands in. A bare "<baseUrl>" key without a remainder separator never scoped-matched
 * anything under the old rules; only "<baseUrl>/..." keys are movable readings.
 */
function scopedLandings(
	key: string,
	value: unknown,
	kind: RecordKind,
	targets: readonly ScopedMoveTargetState[]
): ScopedLanding[] {
	return targets.flatMap((target) => {
		if (!key.startsWith(`${target.normalizedBaseUrl}/`)) {
			return [];
		}
		const remainder = key.slice(target.normalizedBaseUrl.length + 1);
		const strip: DeclareStripResult =
			kind === "capabilities"
				? stripDeclare(value, isDeclarableKey(remainder))
				: { value, declared: false, strippedInert: false };
		return [{ target, remainder, strip }];
	});
}

/**
 * Lands one key in one target: a declaration joins the entry's declared list, a parameters value has its `_force`
 * normalized, and the value lands under its explicit matcher key. The one intra-entry collision mirrors assembleRecord:
 * the "*" remainder beat "" under the old per-scope tie rule.
 */
function landInTarget(state: GlobalMoveState, kind: RecordKind, { target, remainder, strip }: ScopedLanding): void {
	if (strip.declared) {
		const list = state.entryDeclares.get(target.entryIndex) ?? [];
		// The parser trims declared IDs, so the move writes the trimmed form.
		list.push(trimHttpWhitespace(remainder));
		state.entryDeclares.set(target.entryIndex, list);
	}
	let carried = strip.value;
	if (kind === "parameters") {
		const normalized = normalizeMigratedForce(carried);
		carried = normalized.value;
		if (normalized.rewrote) {
			state.rewroteForce += 1;
		}
	}
	const additions = state.entryAdditions.get(target.entryIndex) ?? new Map<string, unknown>();
	const newKey = explicitMatcherKey(remainder);
	if (!additions.has(newKey) || remainder === "*") {
		additions.set(newKey, carried);
	}
	state.entryAdditions.set(target.entryIndex, additions);
}

/**
 * Lands one movable key in every target. Declare bookkeeping is per KEY: the directive moved if any target declared
 * it, and counts as inert at most once otherwise.
 */
function landScopedKey(state: GlobalMoveState, kind: RecordKind, landings: readonly ScopedLanding[]): void {
	let keyDeclared = false;
	let keyStrippedInert = false;
	for (const landing of landings) {
		landInTarget(state, kind, landing);
		keyDeclared ||= landing.strip.declared;
		keyStrippedInert ||= !landing.strip.declared && landing.strip.strippedInert;
	}
	if (keyStrippedInert && !keyDeclared) {
		state.strippedInertDeclares += 1;
	}
}

/**
 * Moves one URL-scoped key into every declared entry at its URL, or keeps it verbatim when no entry is there or one
 * cannot take it. Under the old runtime every entry at the URL read the key, so a partial move would silently drop
 * one entry's reading.
 */
function moveScopedKey(
	state: GlobalMoveState,
	kind: RecordKind,
	targets: readonly ScopedMoveTargetState[],
	key: string,
	value: unknown
): void {
	const landings = scopedLandings(key, value, kind, targets);
	const blocked = landings.some(
		({ target, strip }) => !target.acceptsRecords || (strip.declared && !target.acceptsDeclares)
	);
	if (landings.length === 0 || blocked) {
		state.inertScopedKeys += 1;
		state.kept.push({ sourceKey: key, newKey: key, value });
		return;
	}
	state.movedScopedKeys += 1;
	landScopedKey(state, kind, landings);
}

/**
 * Carries one unscoped key like the entry transform does, except that an unscoped `_declare` was the unscoped-declare
 * diagnostic: never a declaration, so it strips without one.
 */
function carryUnscopedKey(state: GlobalMoveState, kind: RecordKind, key: string, value: unknown): void {
	const carried = carryValue(value, kind, false);
	if (carried.strippedInert) {
		state.strippedInertDeclares += 1;
	}
	if (carried.rewroteForce) {
		state.rewroteForce += 1;
	}
	const newKey = explicitMatcherKey(key);
	if (newKey !== key) {
		state.starredKeys += 1;
	}
	state.kept.push({ sourceKey: key, newKey, value: carried.value });
}

/**
 *   Under the old runtime every server at a URL -> read its scoped keys
 *
 *   scoped key no declared entry matches -> kept verbatim
 *                                        -> collectLegacyHints reports it
 *   scoped key an entry at its URL cannot take -> kept verbatim the same way
 *   unscoped `_declare`                  -> stripped; the old parser diagnosed it as inert
 *   scoped `_declare`                    -> stripped into the owning entries' declared lists; it declared only the
 *                                           key's exact remainder
 */
export function transformGlobalRecord(
	raw: unknown,
	kind: RecordKind,
	targets: readonly ScopedMoveTargetState[]
): GlobalRecordTransform {
	if (!isRecord(raw)) {
		return {
			value: raw,
			entryAdditions: new Map(),
			entryDeclares: new Map(),
			starredKeys: 0,
			droppedAliasKeys: 0,
			movedScopedKeys: 0,
			inertScopedKeys: 0,
			strippedInertDeclares: 0,
			rewroteForce: 0,
		};
	}
	const state: GlobalMoveState = {
		entryAdditions: new Map(),
		entryDeclares: new Map(),
		kept: [],
		starredKeys: 0,
		movedScopedKeys: 0,
		inertScopedKeys: 0,
		strippedInertDeclares: 0,
		rewroteForce: 0,
	};

	for (const [key, value] of Object.entries(raw)) {
		if (isUrlScopedKey(key)) {
			moveScopedKey(state, kind, targets, key, value);
			continue;
		}
		if (isUnsafeRecordKey(key)) {
			// Same rule as the entry transform: reserved keys were dropped-inert and stay verbatim so they cannot
			// become active matchers.
			state.kept.push({ sourceKey: key, newKey: key, value });
			continue;
		}
		carryUnscopedKey(state, kind, key, value);
	}

	const { record, dropped } = assembleRecord(state.kept);
	return {
		value: record,
		entryAdditions: state.entryAdditions,
		entryDeclares: state.entryDeclares,
		starredKeys: state.starredKeys,
		droppedAliasKeys: dropped,
		movedScopedKeys: state.movedScopedKeys,
		inertScopedKeys: state.inertScopedKeys,
		strippedInertDeclares: state.strippedInertDeclares,
		rewroteForce: state.rewroteForce,
	};
}
