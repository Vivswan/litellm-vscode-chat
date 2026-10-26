/**
 * Pure functions over the raw setting value - acceptance rules and secret semantics are deliberately duplicated from
 * the old parser here (quarantine), so the live parser can be rewritten for the new shape without touching migration
 * behavior. The live record parsers are the one import: a migrated record is theirs to read, so what their `true`
 * directive covers is theirs to say.
 *
 * Secrets never appear: a field whose value lives only in SecretStorage was absent from the flat entry and stays
 * absent from the restructured one - the stored value keeps working through its unchanged storage key.
 *
 * Records are assembled with Object.fromEntries throughout: it defines own properties, so a user's "__proto__" key
 * stays inert data instead of becoming a prototype.
 */

import { parseCapabilityRecord } from "../../../shared/config/capabilityResolution";
import { parseParameterRecord } from "../../../shared/config/parameterResolution";
import { canonicalFieldKey } from "../../../shared/config/recordResolution";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { HEADER_NAME_PATTERN, headerNameKey, usableHttpText } from "../../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";
import { LEGACY_ENTRY_AUTH_FIELD_IDS, LEGACY_ENTRY_FIELD_IDS, type LegacyEntryAuthFieldId } from "./legacyIds";
import type { EntryRecordTransform, RecordKind, ScopedMoveTarget } from "./records";
import { transformEntryRecord } from "./records";

/**
 * The entries scoped keys and the global headers value may move into, under the old acceptance rules (usable label and
 * baseUrl, no reserved label, first entry wins a repeated label): only accepted entries ever became groups, so only
 * they ever read a scoped key.
 */
export function scopedMoveTargets(rawServers: unknown): ScopedMoveTarget[] {
	if (!Array.isArray(rawServers)) {
		return [];
	}
	const targets: ScopedMoveTarget[] = [];
	const seen = new Set<string>();
	rawServers.forEach((item: unknown, index) => {
		if (!isRecord(item)) {
			return;
		}
		const label = usableHttpText(item.label);
		const baseUrl = usableHttpText(item.baseUrl);
		if (label === undefined || baseUrl === undefined || isUnsafeRecordKey(label) || seen.has(label)) {
			return;
		}
		seen.add(label);
		targets.push({ entryIndex: index, normalizedBaseUrl: normalizeBaseUrl(baseUrl) });
	});
	return targets;
}

/**
 * One rule for every landing an entry takes (flat fields, scoped keys, declares, the global headers): a slot takes a
 * value only while the records on its path and its leaf are absent or of the mergeable shape. A hand-written value of
 * any other shape is the user's text; the source stays in place and is counted instead of overwriting it.
 */
export interface EntrySlot {
	readonly path: readonly string[];
	readonly leaf: "record" | "list";
}

export const ENTRY_SLOTS = {
	auth: { path: ["auth"], leaf: "record" },
	headers: { path: ["headers"], leaf: "record" },
	parameters: { path: ["models", "parameters"], leaf: "record" },
	capabilities: { path: ["models", "capabilities"], leaf: "record" },
	declared: { path: ["discovery", "declared"], leaf: "list" },
	expectedFailures: { path: ["discovery", "expectedFailures"], leaf: "list" },
} as const satisfies Readonly<Record<string, EntrySlot>>;

export function entrySlotAccepts(entry: unknown, slot: EntrySlot): boolean {
	let holder: unknown = entry;
	for (const key of slot.path.slice(0, -1)) {
		if (!isRecord(holder)) {
			return false;
		}
		holder = holder[key];
		if (holder === undefined) {
			return true;
		}
	}
	if (!isRecord(holder)) {
		return false;
	}
	const leaf = holder[slot.path[slot.path.length - 1] as string];
	return leaf === undefined || (slot.leaf === "record" ? isRecord(leaf) : Array.isArray(leaf));
}

export interface EntryRestructureCounts {
	restructuredEntries: number;
	droppedJunkFields: number;
	blockedFields: number;
	starredKeys: number;
	movedDeclares: number;
	strippedInertDeclares: number;
	droppedAliasKeys: number;
	rewroteForceDirectives: number;
}

function emptyCounts(): EntryRestructureCounts {
	return {
		restructuredEntries: 0,
		droppedJunkFields: 0,
		blockedFields: 0,
		starredKeys: 0,
		movedDeclares: 0,
		strippedInertDeclares: 0,
		droppedAliasKeys: 0,
		rewroteForceDirectives: 0,
	};
}

/**
 * A present-but-unusable value (a number, blank text) was invisible to every old reader, so it is consumed and counted
 * instead of carried. A credential position reads by the one credential trim rule (HTTP whitespace), so a Latin-1 byte
 * at the edge of a key migrates as the key's own; the settings import reuses this restructuring.
 */
function collectAuthFields(
	record: Record<string, unknown>,
	counts: EntryRestructureCounts
): Partial<Record<LegacyEntryAuthFieldId, string>> {
	const fields: Partial<Record<LegacyEntryAuthFieldId, string>> = {};
	for (const id of LEGACY_ENTRY_AUTH_FIELD_IDS) {
		if (!Object.hasOwn(record, id)) {
			continue;
		}
		const value = usableHttpText(record[id]);
		if (value === undefined) {
			counts.droppedJunkFields += 1;
		} else {
			fields[id] = value;
		}
	}
	return fields;
}

/**
 * The virtual-key half of the restructured auth: the header with its value when present, or nothing with the pieces
 * counted as dropped when the header is missing or illegal (the value then never reached the wire).
 */
function virtualKeyAuth(fields: Partial<Record<LegacyEntryAuthFieldId, string>>): {
	virtualKey: Record<string, unknown> | undefined;
	dropped: number;
} {
	if (fields.virtualKeyHeader === undefined || !HEADER_NAME_PATTERN.test(fields.virtualKeyHeader)) {
		const dropped = (fields.virtualKeyHeader === undefined ? 0 : 1) + (fields.virtualKeyValue === undefined ? 0 : 1);
		return { virtualKey: undefined, dropped };
	}
	const pairs: (readonly [string, unknown])[] = [["header", fields.virtualKeyHeader]];
	if (fields.virtualKeyValue !== undefined) {
		pairs.push(["value", fields.virtualKeyValue]);
	}
	return { virtualKey: Object.fromEntries(pairs), dropped: 0 };
}

/** The oauth object with its companions: client secret and scopes when present, then the api key and virtual key. */
function oauthAuth(
	fields: Partial<Record<LegacyEntryAuthFieldId, string>>,
	virtualKey: Record<string, unknown> | undefined
): Record<string, unknown> {
	const pairs: (readonly [string, unknown])[] = [
		["tokenUrl", fields.oauthTokenUrl],
		["clientId", fields.oauthClientId],
	];
	if (fields.oauthClientSecret !== undefined) {
		pairs.push(["clientSecret", fields.oauthClientSecret]);
	}
	if (fields.oauthScopes !== undefined) {
		pairs.push(["scopes", fields.oauthScopes]);
	}
	if (fields.apiKey !== undefined) {
		pairs.push(["apiKey", fields.apiKey]);
	}
	if (virtualKey !== undefined) {
		pairs.push(["virtualKey", virtualKey]);
	}
	return Object.fromEntries(pairs);
}

/**
 * Primacy is oauth > apiKey > virtualKey with lower forms riding as companions, because that is exactly the
 * header set the old transport sent for each combination. Drops mirror what the old runtime never honored, so
 * nothing carried forward can turn a working entry into a misconfigured one.
 *
 *   tokenUrl or clientId alone                        -> dropped: the old hasOAuth gate ignored a partial oauth
 *   virtualKey header without its value               -> kept: the value may rest in SecretStorage
 *   value without a header, or an illegal header name -> dropped: it never reached the wire, and the stored blob waits
 *                                                        for a re-added header
 */
function buildAuth(fields: Partial<Record<LegacyEntryAuthFieldId, string>>): {
	auth: Record<string, unknown> | undefined;
	droppedAuthPieces: number;
} {
	const { virtualKey, dropped: droppedVirtualKeyValues } = virtualKeyAuth(fields);

	if (fields.oauthTokenUrl !== undefined && fields.oauthClientId !== undefined) {
		return { auth: { oauth: oauthAuth(fields, virtualKey) }, droppedAuthPieces: droppedVirtualKeyValues };
	}

	const droppedAuthPieces =
		droppedVirtualKeyValues +
		(["oauthTokenUrl", "oauthClientId", "oauthClientSecret", "oauthScopes"] as const).filter(
			(id) => fields[id] !== undefined
		).length;
	if (fields.apiKey !== undefined && virtualKey !== undefined) {
		return { auth: { apiKey: fields.apiKey, virtualKey }, droppedAuthPieces };
	}
	if (fields.apiKey !== undefined) {
		return { auth: { apiKey: fields.apiKey }, droppedAuthPieces };
	}
	if (virtualKey !== undefined) {
		return { auth: { virtualKey }, droppedAuthPieces };
	}
	return { auth: undefined, droppedAuthPieces };
}

/**
 * A hand-mixed entry carrying both shapes keeps the nested side: nested values are the newer intent, so an existing
 * auth form or record key wins and the flat leftovers drain. A flat field whose slot is blocked stays in place, which
 * keeps the entry old-world, so every activation retries it until the user repairs the slot.
 */
function restructureEntry(record: Record<string, unknown>, counts: EntryRestructureCounts): Record<string, unknown> {
	if (!LEGACY_ENTRY_FIELD_IDS.some((id) => Object.hasOwn(record, id))) {
		return record;
	}
	let entry = record;
	const consumed = new Set<string>();
	const land = (ids: readonly string[], slots: readonly EntrySlot[], landing: () => void): void => {
		const present = ids.filter((id) => Object.hasOwn(record, id));
		if (present.length === 0) {
			return;
		}
		if (!slots.every((slot) => entrySlotAccepts(entry, slot))) {
			counts.blockedFields += present.length;
			return;
		}
		landing();
		for (const id of present) {
			consumed.add(id);
		}
	};
	const landRecord = (kind: RecordKind, transform: EntryRecordTransform): void => {
		counts.starredKeys += transform.starredKeys;
		counts.droppedAliasKeys += transform.droppedAliasKeys;
		if (isRecord(transform.value)) {
			entry = withEntryRecordAdditions(entry, kind, new Map(Object.entries(transform.value)));
			return;
		}
		// A non-record rides verbatim into an empty slot (inert under both worlds); an existing record drains it.
		const models = isRecord(entry.models) ? entry.models : {};
		if (models[kind] === undefined) {
			entry = { ...entry, models: { ...models, [kind]: transform.value } };
		} else {
			counts.droppedJunkFields += 1;
		}
	};

	land(LEGACY_ENTRY_AUTH_FIELD_IDS, [ENTRY_SLOTS.auth], () => {
		const { auth, droppedAuthPieces } = buildAuth(collectAuthFields(record, counts));
		counts.droppedJunkFields += droppedAuthPieces;
		if (auth === undefined) {
			return;
		}
		// Exactly one auth form is legal, so a flat credential never merges into an existing auth object.
		if (entry.auth === undefined) {
			entry = { ...entry, auth };
		} else {
			counts.droppedJunkFields += 1;
		}
	});
	land(["modelParameters"], [ENTRY_SLOTS.parameters], () => {
		const transform = transformEntryRecord(record.modelParameters, "parameters");
		counts.rewroteForceDirectives += transform.rewroteForce;
		landRecord("parameters", transform);
	});
	if (Object.hasOwn(record, "modelCapabilities")) {
		const transform = transformEntryRecord(record.modelCapabilities, "capabilities");
		const declares = transform.declared.length > 0;
		land(
			["modelCapabilities"],
			declares ? [ENTRY_SLOTS.capabilities, ENTRY_SLOTS.declared] : [ENTRY_SLOTS.capabilities],
			() => {
				counts.strippedInertDeclares += transform.strippedInertDeclares;
				counts.movedDeclares += transform.declared.length;
				landRecord("capabilities", transform);
				if (declares) {
					entry = withEntryDeclares(entry, transform.declared);
				}
			}
		);
	}
	land(["expectedFailures"], [ENTRY_SLOTS.expectedFailures], () => {
		const discovery = isRecord(entry.discovery) ? entry.discovery : {};
		if (!Object.hasOwn(discovery, "expectedFailures")) {
			entry = { ...entry, discovery: { ...discovery, expectedFailures: record.expectedFailures } };
		}
	});

	if (consumed.size === 0) {
		return record;
	}
	counts.restructuredEntries += 1;
	return Object.fromEntries(Object.entries(entry).filter(([key]) => !consumed.has(key)));
}

/** Non-array values and non-record entries ride verbatim: they were inert and remain the user's text to fix. */
export function restructureServers(raw: unknown): { value: unknown; counts: EntryRestructureCounts } {
	const counts = emptyCounts();
	if (!Array.isArray(raw)) {
		return { value: raw, counts };
	}
	const value = raw.map((item: unknown) => (isRecord(item) ? restructureEntry(item, counts) : item));
	return { value, counts };
}

export function canonicalFieldNames(kind: RecordKind, keys: readonly unknown[]): Set<string> {
	return new Set(
		keys.filter((key): key is string => typeof key === "string").map((key) => canonicalFieldKey(kind, key))
	);
}

/**
 * The record's own key for a directive, so a rewrite lands on the user's spelling instead of beside it; the parser
 * keeps the last spelling, so does this. Absent, the directive's name.
 */
export function directiveKey(kind: RecordKind, record: Record<string, unknown>, directive: string): string {
	const spellings = Object.keys(record).filter((key) => canonicalFieldKey(kind, key) === directive);
	return spellings.length > 0 ? (spellings[spellings.length - 1] as string) : directive;
}

/** The record's own keys a `_fallback: true` marks, as the live parser reads it, under the record's own spelling. */
export function fallbackMarksUnderTrue(record: Record<string, unknown>): string[] {
	const marked = parseCapabilityRecord(record).fallback;
	return Object.keys(record).filter((key) => marked.has(canonicalFieldKey("capabilities", key)));
}

/** Old forceability is settled upstream: records.ts rewrites a migrated `_force` before any merge. */
const LIST_DIRECTIVES: readonly {
	readonly name: string;
	readonly marksUnderTrue: (record: Record<string, unknown>) => string[];
}[] = [
	{ name: "_force", marksUnderTrue: (record) => [...parseParameterRecord(record).forced] },
	{ name: "_fallback", marksUnderTrue: fallbackMarksUnderTrue },
];

/** The list-directive keys, read off LIST_DIRECTIVES so the two tables cannot drift apart. */
const LIST_DIRECTIVE_NAMES: readonly string[] = LIST_DIRECTIVES.map((directive) => directive.name);

type ListDirective = (typeof LIST_DIRECTIVES)[number];

/** The two records of one same-key collision and the canonical names the addition brings in. */
interface CollisionContext {
	readonly kind: RecordKind;
	readonly existing: Record<string, unknown>;
	readonly addition: Record<string, unknown>;
	readonly arrivingNames: ReadonlySet<string>;
}

/**
 * The field names the addition's list directive marks: everything the parser marks under a `true`, the addition's
 * non-directive keys the list names otherwise, and none without a list.
 */
function additionMarks(context: CollisionContext, additionRaw: unknown, directive: ListDirective): string[] {
	const { kind, addition } = context;
	if (additionRaw === true) {
		return directive.marksUnderTrue(addition);
	}
	if (!Array.isArray(additionRaw)) {
		return [];
	}
	const listed = canonicalFieldNames(kind, additionRaw);
	return Object.keys(addition).filter((key) => {
		const canonical = canonicalFieldKey(kind, key);
		return !canonical.startsWith("_") && listed.has(canonical);
	});
}

/** The existing record's list directive after the merge, keyed as written, or undefined when it stays as it is. */
function mergedDirective(context: CollisionContext, directive: ListDirective): readonly [string, unknown] | undefined {
	const { kind, existing, addition, arrivingNames } = context;
	const canonical = (key: string): string => canonicalFieldKey(kind, key);
	const existingKey = directiveKey(kind, existing, directive.name);
	const existingRaw = Object.hasOwn(existing, existingKey) ? existing[existingKey] : undefined;
	const additionKey = directiveKey(kind, addition, directive.name);
	const additionRaw = Object.hasOwn(addition, additionKey) ? addition[additionKey] : undefined;
	const surviving = additionMarks(context, additionRaw, directive).filter((name) => arrivingNames.has(canonical(name)));
	if (existingRaw !== undefined && existingRaw !== false && !Array.isArray(existingRaw)) {
		if (existingRaw === true && arrivingNames.size > 0) {
			// Expand before the arriving fields widen what `true` covers; the scoped side's marks follow its surviving
			// fields.
			return [existingKey, [...directive.marksUnderTrue(existing), ...surviving]];
		}
		// A `true` with nothing arriving (or a junk value) stays as written; junk cannot take additions without
		// overwriting the user's text, so arriving marks are dropped with it.
		return undefined;
	}
	// An entry-side name the entry itself does not set marked nothing; keep it only while the merge leaves it inert.
	const base = (Array.isArray(existingRaw) ? existingRaw : []).filter(
		(name) => typeof name !== "string" || !arrivingNames.has(canonical(name))
	);
	if (surviving.length > 0 || (Array.isArray(existingRaw) && base.length !== existingRaw.length)) {
		return [existingKey, [...base, ...surviving]];
	}
	return undefined;
}

/**
 * A same-key collision merges field by field, fields identified by their canonical name, with the entry winning whole
 * (its spelling included), as the old runtime merged entry over scoped; the one accepted loss is a scoped mark on a
 * field the entry overrode, which drops rather than re-pointing at the entry's value. Adding fields changes what a
 * record's own `_force`/`_fallback` cover, so every mark keeps the coverage it had.
 *
 *   entry-side `true`                          -> expands to what the parser marks under it before scoped fields land
 *   entry-side name that marked nothing        -> dropped once the scoped record supplies the field
 *   scoped name whose field the entry overrode -> dropped, never re-pointed at the entry's value
 */
function mergeCollidingRecords(
	existing: Record<string, unknown>,
	addition: Record<string, unknown>,
	kind: RecordKind
): Record<string, unknown> | undefined {
	const canonical = (key: string): string => canonicalFieldKey(kind, key);
	const existingNames = canonicalFieldNames(kind, Object.keys(existing));
	const newPlain = Object.entries(addition).filter(
		([name]) => !LIST_DIRECTIVE_NAMES.includes(canonical(name)) && !existingNames.has(canonical(name))
	);
	const arrivingNames = canonicalFieldNames(
		kind,
		newPlain.map(([name]) => name)
	);

	const context: CollisionContext = { kind, existing, addition, arrivingNames };
	const directiveChanges: (readonly [string, unknown])[] = [];
	for (const directive of LIST_DIRECTIVES) {
		const change = mergedDirective(context, directive);
		if (change !== undefined) {
			directiveChanges.push(change);
		}
	}
	if (newPlain.length === 0 && directiveChanges.length === 0) {
		return undefined;
	}
	return Object.fromEntries([...Object.entries(existing), ...newPlain, ...directiveChanges]);
}

/**
 * Callers gate with entrySlotAccepts first, so `models` and the slot are absent or records here. An entry-side value
 * the old normalization dropped (a non-record) was never configuration, so the incoming record replaces it.
 */
export function withEntryRecordAdditions(
	entry: Record<string, unknown>,
	kind: RecordKind,
	additions: ReadonlyMap<string, unknown>
): Record<string, unknown> {
	const models = isRecord(entry.models) ? entry.models : {};
	const slot = models[kind];
	const merged = new Map(isRecord(slot) ? Object.entries(slot) : []);
	let added = 0;
	for (const [key, value] of additions) {
		const existingValue = merged.get(key);
		if (!merged.has(key) || !isRecord(existingValue)) {
			merged.set(key, value);
			added += 1;
			continue;
		}
		if (!isRecord(value)) {
			continue;
		}
		const collided = mergeCollidingRecords(existingValue, value, kind);
		if (collided !== undefined) {
			merged.set(key, collided);
			added += 1;
		}
	}
	if (added === 0) {
		return entry;
	}
	return { ...entry, models: { ...models, [kind]: Object.fromEntries(merged) } };
}

/** Callers gate with entrySlotAccepts first, so `discovery` and `declared` are absent or of the mergeable shape here. */
export function withEntryDeclares(entry: Record<string, unknown>, ids: readonly string[]): Record<string, unknown> {
	const discovery = isRecord(entry.discovery) ? entry.discovery : {};
	const current: unknown[] = Array.isArray(discovery.declared) ? discovery.declared : [];
	const declared = [...current];
	for (const id of ids) {
		if (!declared.includes(id)) {
			declared.push(id);
		}
	}
	if (declared.length === current.length) {
		return entry;
	}
	return { ...entry, discovery: { ...discovery, declared } };
}

/** Copy global header names into one entry's `headers`; existing entry names win (keyed by headerNameKey). */
export function withEntryHeaders(
	entry: Record<string, unknown>,
	headers: Record<string, unknown>
): Record<string, unknown> {
	const existing = isRecord(entry.headers) ? entry.headers : {};
	const existingNames = new Set(Object.keys(existing).map(headerNameKey));
	const missing = Object.entries(headers).filter(([name]) => !existingNames.has(headerNameKey(name)));
	if (missing.length === 0) {
		return entry;
	}
	return { ...entry, headers: Object.fromEntries([...Object.entries(existing), ...missing]) };
}
