/**
 * Record-key rewrites for the redesign: pre-redesign record keys were
 * implicit prefixes (optionally server-URL scoped in the global records);
 * the new grammar is explicit matchers with no server scoping. The transforms
 * here are pure and shared by the global-record and entry-record paths.
 */

import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";
import { DECLARE_DIRECTIVE } from "./legacyIds";

/**
 * Old prefix key -> explicit matcher. The old catch-all aliases ("" and the
 * bare "*") collapse to "*"; every other key gains a trailing glob, so it
 * keeps matching exactly the IDs the old prefix rule matched. A key that
 * already contains "*" comes out with a non-trailing star - an invalid
 * matcher, diagnosed and ignored - which is behavior-preserving too: no real
 * model ID contains "*", so the old literal prefix never matched either.
 */
function explicitMatcherKey(prefix: string): string {
	return prefix === "" || prefix === "*" ? "*" : `${prefix}*`;
}

/**
 * Old base URLs always contain "://" while model IDs never do - the same
 * disambiguation rule the removed scoped-key matching used, so the migration
 * classifies exactly the keys the old readers classified.
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
	readonly value: unknown;
	/** True when the record carried a legal `_declare: true` (moved when the key can name an ID). */
	readonly declared: boolean;
	/** True when a `_declare` key was removed without producing a declaration. */
	readonly strippedInert: boolean;
}

/**
 * Remove the retired `_declare` directive from one capability record value.
 * Only a literal `true` on a declarable key ever declared; every other
 * carrier (false, junk values, catch-all or unscoped keys) was inert or
 * diagnosed, so stripping it is behavior-preserving either way.
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
 * Assemble transformed keys into a record, resolving the one possible
 * collision: "" and "*" both map to "*", and the old prefix matching broke
 * that tie toward "*", so the "*" source's value wins and the "" source is
 * dropped (counted). Object.fromEntries defines own properties, so a
 * pathological "__proto__*" key stays inert data.
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
	readonly value: unknown;
	/** Exact IDs whose record carried an honored `_declare: true`. */
	readonly declared: readonly string[];
	readonly starredKeys: number;
	readonly droppedAliasKeys: number;
	readonly strippedInertDeclares: number;
}

/**
 * Transform one per-entry record (no scoping existed there): every key
 * becomes an explicit matcher, and capability records shed their `_declare`
 * directives into the returned `declared` list. A non-record value rides
 * verbatim - it was inert under the old readers and stays inert under the
 * new ones, and the user's text survives.
 */
export function transformEntryRecord(raw: unknown, kind: RecordKind): EntryRecordTransform {
	if (!isRecord(raw)) {
		return { value: raw, declared: [], starredKeys: 0, droppedAliasKeys: 0, strippedInertDeclares: 0 };
	}
	const declared: string[] = [];
	let starredKeys = 0;
	let strippedInertDeclares = 0;
	const transformed: TransformedKey[] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (isUnsafeRecordKey(key)) {
			// The old normalization dropped reserved keys wholesale (inert), so
			// starring one would ACTIVATE it; verbatim it stays dropped-inert
			// under the new normalization too, and the user's text survives.
			transformed.push({ sourceKey: key, newKey: key, value });
			continue;
		}
		let carried = value;
		if (kind === "capabilities") {
			const strip = stripDeclare(value, isDeclarableKey(key));
			carried = strip.value;
			if (strip.declared) {
				declared.push(key);
			}
			if (strip.strippedInert) {
				strippedInertDeclares += 1;
			}
		}
		const newKey = explicitMatcherKey(key);
		if (newKey !== key) {
			starredKeys += 1;
		}
		transformed.push({ sourceKey: key, newKey, value: carried });
	}
	const { record, dropped } = assembleRecord(transformed);
	return { value: record, declared, starredKeys, droppedAliasKeys: dropped, strippedInertDeclares };
}

/** One declared entry a scoped key can move into: its raw-array index and its normalized base URL. */
export interface ScopedMoveTarget {
	readonly entryIndex: number;
	readonly normalizedBaseUrl: string;
}

export interface GlobalRecordTransform {
	readonly value: unknown;
	/** Per entry index: transformed remainder key -> record value (first source key wins). */
	readonly entryAdditions: ReadonlyMap<number, ReadonlyMap<string, unknown>>;
	/** Per entry index: exact IDs its scoped keys declared. */
	readonly entryDeclares: ReadonlyMap<number, readonly string[]>;
	readonly starredKeys: number;
	readonly droppedAliasKeys: number;
	readonly movedScopedKeys: number;
	readonly inertScopedKeys: number;
	readonly strippedInertDeclares: number;
}

/**
 * Transform one global record. Unscoped keys become explicit matchers in
 * place; a URL-scoped key ("<baseUrl>/<model prefix>") moves into EVERY
 * declared entry whose normalized base URL prefixes it, because under the
 * old runtime every server at that URL read the key - each entry receives
 * the key's post-scope remainder as an explicit matcher. A scoped key no
 * declared entry matches is left VERBATIM: it matches no real model ID under
 * the new grammar (IDs never contain "://"), so it is inert exactly like the
 * old readers treated another server's keys, and collectLegacyHints reports
 * it to the dashboard. Global `_declare` directives declared only through a
 * scoped key's exact remainder; unscoped ones were diagnosed and inert, so
 * both strip - the scoped ones into the owning entries' declared lists.
 */
export function transformGlobalRecord(
	raw: unknown,
	kind: RecordKind,
	targets: readonly ScopedMoveTarget[]
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
		};
	}
	const entryAdditions = new Map<number, Map<string, unknown>>();
	const entryDeclares = new Map<number, string[]>();
	let starredKeys = 0;
	let movedScopedKeys = 0;
	let inertScopedKeys = 0;
	let strippedInertDeclares = 0;
	const kept: TransformedKey[] = [];

	for (const [key, value] of Object.entries(raw)) {
		if (isUrlScopedKey(key)) {
			// A bare "<baseUrl>" key without a remainder separator never
			// scoped-matched anything under the old rules; only "<baseUrl>/..."
			// keys are movable readings.
			const movable = targets.filter((target) => key.startsWith(`${target.normalizedBaseUrl}/`));
			if (movable.length === 0) {
				inertScopedKeys += 1;
				kept.push({ sourceKey: key, newKey: key, value });
				continue;
			}
			movedScopedKeys += 1;
			// Declare bookkeeping is per KEY: the directive moved if any target
			// declared it, and counts as inert at most once otherwise.
			let keyDeclared = false;
			let keyStrippedInert = false;
			for (const target of movable) {
				const remainder = key.slice(target.normalizedBaseUrl.length + 1);
				let carried = value;
				if (kind === "capabilities") {
					const strip = stripDeclare(value, isDeclarableKey(remainder));
					carried = strip.value;
					if (strip.declared) {
						keyDeclared = true;
						const list = entryDeclares.get(target.entryIndex) ?? [];
						list.push(remainder);
						entryDeclares.set(target.entryIndex, list);
					} else if (strip.strippedInert) {
						keyStrippedInert = true;
					}
				}
				const additions = entryAdditions.get(target.entryIndex) ?? new Map<string, unknown>();
				const newKey = explicitMatcherKey(remainder);
				// The one intra-entry collision mirrors assembleRecord: the "*"
				// remainder beat "" under the old per-scope tie rule.
				if (!additions.has(newKey) || remainder === "*") {
					additions.set(newKey, carried);
				}
				entryAdditions.set(target.entryIndex, additions);
			}
			if (keyStrippedInert && !keyDeclared) {
				strippedInertDeclares += 1;
			}
			continue;
		}
		if (isUnsafeRecordKey(key)) {
			// Same rule as the entry transform: reserved keys were dropped-inert
			// and stay verbatim so they cannot become active matchers.
			kept.push({ sourceKey: key, newKey: key, value });
			continue;
		}
		let carried = value;
		if (kind === "capabilities") {
			// Unscoped `_declare` was the unscoped-declare diagnostic: never a
			// declaration, so it strips without one.
			const strip = stripDeclare(value, false);
			carried = strip.value;
			if (strip.strippedInert) {
				strippedInertDeclares += 1;
			}
		}
		const newKey = explicitMatcherKey(key);
		if (newKey !== key) {
			starredKeys += 1;
		}
		kept.push({ sourceKey: key, newKey, value: carried });
	}

	const { record, dropped } = assembleRecord(kept);
	return {
		value: record,
		entryAdditions,
		entryDeclares,
		starredKeys,
		droppedAliasKeys: dropped,
		movedScopedKeys,
		inertScopedKeys,
		strippedInertDeclares,
	};
}
