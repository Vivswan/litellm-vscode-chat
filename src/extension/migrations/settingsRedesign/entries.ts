/**
 * The entry restructure: pre-redesign `servers` entries carried flat
 * credential fields plus per-entry records; the redesigned shape groups them
 * under `auth`, `models`, and `discovery`. Pure functions over the raw
 * setting value - acceptance rules and secret semantics are deliberately
 * duplicated from the old parser here (quarantine), so the live parser can
 * be rewritten for the new shape without touching migration behavior.
 *
 * Secrets never appear: a field whose value lives only in SecretStorage was
 * simply absent from the flat entry and stays absent from the restructured
 * one - the stored value keeps working through its unchanged storage key and
 * the auth form's stored-slot activation rule. The migration reads no
 * secrets, writes no secrets, and synthesizes no placeholder fields.
 */

import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { HEADER_NAME_PATTERN } from "../../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";
import {
	isForceableKey,
	isValidCapabilityField,
	LEGACY_ENTRY_AUTH_FIELD_IDS,
	LEGACY_ENTRY_FIELD_IDS,
	type LegacyEntryAuthFieldId,
} from "./legacyIds";
import type { ScopedMoveTarget } from "./records";
import { transformEntryRecord } from "./records";

/** The old parser's usable-text rule, quarantined: a string with non-blank content, used trimmed. */
function usableString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The entries scoped keys and the global headers value may move into, under
 * the old acceptance rules (usable label and baseUrl, no reserved label,
 * first entry wins a repeated label): only accepted entries ever became
 * groups, so only they ever read a scoped key.
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
		const label = usableString(item.label);
		const baseUrl = usableString(item.baseUrl);
		if (label === undefined || baseUrl === undefined || isUnsafeRecordKey(label) || seen.has(label)) {
			return;
		}
		seen.add(label);
		targets.push({ entryIndex: index, normalizedBaseUrl: normalizeBaseUrl(baseUrl) });
	});
	return targets;
}

/** Safe record assembly: fromEntries defines own properties, so "__proto__" keys stay inert data. */
function fromPairs(pairs: readonly (readonly [string, unknown])[]): Record<string, unknown> {
	return Object.fromEntries(pairs);
}

/** Merge two records key by key, `preferred`'s keys winning. */
function mergePreferring(preferred: Record<string, unknown>, filler: Record<string, unknown>): Record<string, unknown> {
	return fromPairs([...Object.entries(filler), ...Object.entries(preferred)]);
}

export interface EntryRestructureCounts {
	restructuredEntries: number;
	droppedJunkFields: number;
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
		starredKeys: 0,
		movedDeclares: 0,
		strippedInertDeclares: 0,
		droppedAliasKeys: 0,
		rewroteForceDirectives: 0,
	};
}

/**
 * The flat credential fields as the old runtime honored them: usable strings
 * only. A present-but-unusable value (a number, blank text) was invisible to
 * every old reader, so it is consumed and counted instead of carried.
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
		const value = usableString(record[id]);
		if (value === undefined) {
			counts.droppedJunkFields += 1;
		} else {
			fields[id] = value;
		}
	}
	return fields;
}

/**
 * The flat fields' auth object under the settled primacy rule (oauth >
 * apiKey > virtualKey; a form carries strictly-lower-primacy companions):
 * a structurally usable oauth (BOTH tokenUrl and clientId, matching the old
 * runtime's hasOAuth gate) is the form and demotes apiKey and virtualKey to
 * companions; apiKey beside virtualKey is the apiKey form with the
 * virtualKey companion - exactly the header set the old transport sent for
 * each combination. Lone oauth pieces are DROPPED like other never-honored
 * values (counted by the caller): the old runtime ignored a partial oauth
 * entirely, while carrying it forward would make the whole entry
 * misconfigured (structurally incomplete auth is refused, ruling Q2 #3).
 * A SENDABLE virtualKey HEADER without its value keeps riding - the value
 * may rest in SecretStorage, and the parser accepts a header waiting for its
 * secret (ruling Q2 #4). A VALUE without its header, and a header that is
 * not a valid HTTP header name (the old runtime ignored the whole pair;
 * narrowVirtualKey's sendability rule), can never reach the wire - carrying
 * either forward would misconfigure the whole entry, so they drop like the
 * lone oauth pieces (counted; a stored blob under the label survives and a
 * re-added header finds it).
 */
function buildAuth(fields: Partial<Record<LegacyEntryAuthFieldId, string>>): {
	auth: Record<string, unknown> | undefined;
	droppedAuthPieces: number;
} {
	let droppedVirtualKeyValues = 0;
	const virtualKeyPairs: (readonly [string, unknown])[] = [];
	if (fields.virtualKeyHeader !== undefined && HEADER_NAME_PATTERN.test(fields.virtualKeyHeader)) {
		virtualKeyPairs.push(["header", fields.virtualKeyHeader]);
		if (fields.virtualKeyValue !== undefined) {
			virtualKeyPairs.push(["value", fields.virtualKeyValue]);
		}
	} else {
		droppedVirtualKeyValues =
			(fields.virtualKeyHeader !== undefined ? 1 : 0) + (fields.virtualKeyValue !== undefined ? 1 : 0);
	}
	const virtualKey = virtualKeyPairs.length > 0 ? fromPairs(virtualKeyPairs) : undefined;

	const oauthUsable = fields.oauthTokenUrl !== undefined && fields.oauthClientId !== undefined;
	if (oauthUsable) {
		const oauthPairs: (readonly [string, unknown])[] = [
			["tokenUrl", fields.oauthTokenUrl],
			["clientId", fields.oauthClientId],
		];
		if (fields.oauthClientSecret !== undefined) {
			oauthPairs.push(["clientSecret", fields.oauthClientSecret]);
		}
		if (fields.oauthScopes !== undefined) {
			oauthPairs.push(["scopes", fields.oauthScopes]);
		}
		if (fields.apiKey !== undefined) {
			oauthPairs.push(["apiKey", fields.apiKey]);
		}
		if (virtualKey !== undefined) {
			oauthPairs.push(["virtualKey", virtualKey]);
		}
		return { auth: { oauth: fromPairs(oauthPairs) }, droppedAuthPieces: droppedVirtualKeyValues };
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
 * Restructure one raw entry record. Entries without any legacy flat field
 * are already new-world (or minimal) and ride verbatim. A hand-mixed entry
 * carrying both shapes merges with the nested side winning: nested values
 * are the newer intent, and the flat leftovers still drain so the entry
 * stops being detected as legacy.
 */
function restructureEntry(record: Record<string, unknown>, counts: EntryRestructureCounts): Record<string, unknown> {
	if (!LEGACY_ENTRY_FIELD_IDS.some((id) => Object.hasOwn(record, id))) {
		return record;
	}
	counts.restructuredEntries += 1;

	const authFields = collectAuthFields(record, counts);
	const { auth: flatAuth, droppedAuthPieces } = buildAuth(authFields);
	counts.droppedJunkFields += droppedAuthPieces;

	const modelPairs: (readonly [string, unknown])[] = [];
	let declared: readonly string[] = [];
	if (Object.hasOwn(record, "modelParameters")) {
		const transform = transformEntryRecord(record.modelParameters, "parameters");
		counts.starredKeys += transform.starredKeys;
		counts.droppedAliasKeys += transform.droppedAliasKeys;
		counts.rewroteForceDirectives += transform.rewroteForce;
		modelPairs.push(["parameters", transform.value]);
	}
	if (Object.hasOwn(record, "modelCapabilities")) {
		const transform = transformEntryRecord(record.modelCapabilities, "capabilities");
		counts.starredKeys += transform.starredKeys;
		counts.droppedAliasKeys += transform.droppedAliasKeys;
		counts.strippedInertDeclares += transform.strippedInertDeclares;
		counts.movedDeclares += transform.declared.length;
		declared = transform.declared;
		modelPairs.push(["capabilities", transform.value]);
	}
	const flatModels = modelPairs.length > 0 ? fromPairs(modelPairs) : undefined;

	const discoveryPairs: (readonly [string, unknown])[] = [];
	if (Object.hasOwn(record, "expectedFailures")) {
		discoveryPairs.push(["expectedFailures", record.expectedFailures]);
	}
	if (declared.length > 0) {
		discoveryPairs.push(["declared", declared]);
	}
	const flatDiscovery = discoveryPairs.length > 0 ? fromPairs(discoveryPairs) : undefined;

	// `auth` never merges: exactly one form is legal, and mixing a flat
	// credential into an existing auth object would fabricate a second form
	// (or a companion the user never configured). The nested object is the
	// newer intent and wins WHOLESALE; superseded flat pieces drain as junk.
	let mergedAuth: unknown;
	if (record.auth === undefined) {
		mergedAuth = flatAuth;
	} else if (!isRecord(record.auth) && flatAuth !== undefined) {
		// An inert non-record nested value loses to real flat configuration.
		counts.droppedJunkFields += 1;
		mergedAuth = flatAuth;
	} else {
		if (flatAuth !== undefined) {
			counts.droppedJunkFields += 1;
		}
		mergedAuth = record.auth;
	}

	const mergeNested = (
		flat: Record<string, unknown> | undefined,
		existing: unknown
	): Record<string, unknown> | unknown => {
		if (existing === undefined) {
			return flat;
		}
		if (!isRecord(existing)) {
			// An inert non-record nested value loses to real flat configuration
			// and otherwise stays as the user's own text.
			if (flat !== undefined) {
				counts.droppedJunkFields += 1;
				return flat;
			}
			return existing;
		}
		if (flat === undefined) {
			return existing;
		}
		return mergePreferring(existing, flat);
	};

	// `declared` merges additively even when the existing discovery object
	// wins its other keys: a declaration read from `_declare` must not vanish
	// because the entry already had a discovery block.
	const mergedDiscoveryBase = mergeNested(flatDiscovery, record.discovery);
	const mergedDiscovery =
		isRecord(mergedDiscoveryBase) && declared.length > 0
			? withDeclaredIds(mergedDiscoveryBase, declared)
			: mergedDiscoveryBase;

	const nested: Record<string, unknown | undefined> = {
		auth: mergedAuth,
		models: mergeNested(flatModels, record.models),
		discovery: mergedDiscovery,
	};

	const placed = new Set<string>();
	const pairs: (readonly [string, unknown])[] = [];
	for (const [key, value] of Object.entries(record)) {
		if ((LEGACY_ENTRY_FIELD_IDS as readonly string[]).includes(key)) {
			continue;
		}
		if (Object.hasOwn(nested, key)) {
			placed.add(key);
			if (nested[key] !== undefined) {
				pairs.push([key, nested[key]]);
			}
			continue;
		}
		pairs.push([key, value]);
	}
	for (const key of ["auth", "models", "discovery"]) {
		if (!placed.has(key) && nested[key] !== undefined) {
			pairs.push([key, nested[key]]);
		}
	}
	return fromPairs(pairs);
}

/** Merge exact IDs into a discovery object's `declared` list, existing entries first, deduped. */
function withDeclaredIds(discovery: Record<string, unknown>, ids: readonly string[]): Record<string, unknown> {
	const existing = discovery.declared;
	if (existing !== undefined && !Array.isArray(existing)) {
		return discovery;
	}
	const merged = [...(existing ?? [])];
	for (const id of ids) {
		if (!merged.includes(id)) {
			merged.push(id);
		}
	}
	return { ...discovery, declared: merged };
}

/**
 * Restructure every entry of the raw servers value. Non-array values and
 * non-record entries ride verbatim: they were inert and remain the user's
 * text to fix.
 */
export function restructureServers(raw: unknown): { value: unknown; counts: EntryRestructureCounts } {
	const counts = emptyCounts();
	if (!Array.isArray(raw)) {
		return { value: raw, counts };
	}
	const value = raw.map((item: unknown) => (isRecord(item) ? restructureEntry(item, counts) : item));
	return { value, counts };
}

/** Whether one entry's `models.<kind>` slot can take migrated record keys without destroying user data. */
export function entryCanReceiveRecordKeys(entry: unknown, kind: "parameters" | "capabilities"): boolean {
	if (!isRecord(entry)) {
		return false;
	}
	const models = entry.models;
	if (models === undefined) {
		return true;
	}
	if (!isRecord(models)) {
		return false;
	}
	const slot = models[kind];
	return slot === undefined || isRecord(slot);
}

/**
 * The two list-shaped directives a colliding-record merge must reconcile;
 * everything else merges entry-wins. Each carries the eligibility rule its
 * own parser applies when expanding a `true` directive, so the merge cannot
 * mint names the old world never marked (and the diagnostics that would
 * come with them): `_force` refuses provider-owned and underscore keys,
 * `_fallback` accepts only validly-typed capability fields.
 */
const LIST_DIRECTIVES: readonly {
	readonly name: string;
	readonly eligible: (record: Record<string, unknown>, key: string) => boolean;
}[] = [
	{ name: "_force", eligible: (_record, key) => isForceableKey(key) },
	{ name: "_fallback", eligible: (record, key) => isValidCapabilityField(key, record[key]) },
];

const LIST_DIRECTIVE_NAMES: readonly string[] = LIST_DIRECTIVES.map((directive) => directive.name);

/**
 * Merge a moved scoped record into the entry's own record under the SAME
 * key - the one overlap the move can resolve losslessly, because identical
 * keys match identical models and the old runtime merged the entry record
 * over the scoped one field by field: entry fields win, scoped-only fields
 * fill in.
 *
 * The directives are the delicate half, because adding fields to a record
 * changes what its own `_force`/`_fallback` cover. Two rules keep each
 * field at the level it had:
 *  - an entry-side `true` marked the ENTRY's fields only, so it expands to
 *    that literal list before scoped-only fields land (the same
 *    statement-for-fields trade the trio merge makes, and only when fields
 *    really land);
 *  - an entry-side list name that marked nothing (the entry does not set
 *    that field) is dropped when the scoped record supplies the field, so
 *    an inert mark cannot spring to life on a value that was never marked.
 * The scoped side's marks then follow its surviving fields. A scoped name
 * whose field the entry overrode is dropped rather than re-pointed at the
 * entry's value - the one residual of the old "a scoped-forced field beats
 * an unforced entry value" refinement, pinned in the divergence suite.
 * Returns undefined when nothing changes.
 */
function mergeCollidingRecords(
	existing: Record<string, unknown>,
	addition: Record<string, unknown>
): Record<string, unknown> | undefined {
	const newPlain = Object.entries(addition).filter(
		([name]) => !LIST_DIRECTIVE_NAMES.includes(name) && !Object.hasOwn(existing, name)
	);
	const arrivingNames = new Set(newPlain.map(([name]) => name));
	const eligibleNames = (
		record: Record<string, unknown>,
		eligible: (record: Record<string, unknown>, key: string) => boolean
	): string[] => Object.keys(record).filter((name) => !name.startsWith("_") && eligible(record, name));

	const directiveChanges: (readonly [string, unknown])[] = [];
	for (const { name: directive, eligible } of LIST_DIRECTIVES) {
		const existingRaw = Object.hasOwn(existing, directive) ? existing[directive] : undefined;
		const additionRaw = Object.hasOwn(addition, directive) ? addition[directive] : undefined;
		const additionNames =
			additionRaw === true
				? eligibleNames(addition, eligible)
				: Array.isArray(additionRaw)
					? additionRaw.filter((name): name is string => typeof name === "string" && Object.hasOwn(addition, name))
					: [];
		if (existingRaw !== undefined && existingRaw !== false && !Array.isArray(existingRaw)) {
			if (existingRaw === true && arrivingNames.size > 0) {
				// Expand before the arriving fields widen what `true` covers - and
				// the scoped side's marks follow its surviving fields (a scoped
				// fallback/force landed at its own level in the old world; the
				// entry's `true` covered only the entry's own fields).
				const surviving = additionNames.filter((name) => arrivingNames.has(name));
				directiveChanges.push([directive, [...eligibleNames(existing, eligible), ...surviving]]);
				continue;
			}
			// A `true` with nothing arriving (or a junk value) stays as written;
			// junk cannot take additions without overwriting the user's text, so
			// arriving marks are dropped with it (the stays-as-written trade).
			continue;
		}
		// An entry-side name the entry itself does not set marked nothing; keep
		// it only while the merge leaves it inert.
		const base = (Array.isArray(existingRaw) ? existingRaw : []).filter(
			(name) => typeof name !== "string" || !arrivingNames.has(name)
		);
		const surviving = additionNames.filter((name) => !Object.hasOwn(existing, name) && !base.includes(name));
		if (surviving.length > 0 || (Array.isArray(existingRaw) && base.length !== existingRaw.length)) {
			directiveChanges.push([directive, [...base, ...surviving]]);
		}
	}
	if (newPlain.length === 0 && directiveChanges.length === 0) {
		return undefined;
	}
	return fromPairs([...Object.entries(existing), ...newPlain, ...directiveChanges]);
}

/**
 * Add migrated record keys to one entry's `models.<kind>` record. A key the
 * entry does not have is added outright; a colliding key merges through
 * mergeCollidingRecords (entry fields win, scoped-only content fills in), so
 * reruns and user deletions never resurrect or overwrite anything. An
 * entry-side value the old normalization dropped (a non-record) is not
 * user configuration at all - the scoped record was what applied - so the
 * incoming record replaces it.
 */
export function withEntryRecordAdditions(
	entry: Record<string, unknown>,
	kind: "parameters" | "capabilities",
	additions: ReadonlyMap<string, unknown>
): { entry: Record<string, unknown>; added: number } {
	const models = isRecord(entry.models) ? entry.models : {};
	const slot = isRecord(models[kind]) ? (models[kind] as Record<string, unknown>) : {};
	const merged: Record<string, unknown> = Object.fromEntries(Object.entries(slot));
	let added = 0;
	for (const [key, value] of additions) {
		// Addition keys come out of explicitMatcherKey ("*" or "<literal>*"),
		// never a reserved name, so direct assignment is safe here.
		if (!Object.hasOwn(merged, key)) {
			merged[key] = value;
			added += 1;
			continue;
		}
		const existingValue = merged[key];
		if (!isRecord(existingValue)) {
			merged[key] = value;
			added += 1;
			continue;
		}
		if (!isRecord(value)) {
			continue;
		}
		const collided = mergeCollidingRecords(existingValue, value);
		if (collided !== undefined) {
			merged[key] = collided;
			added += 1;
		}
	}
	if (added === 0) {
		return { entry, added: 0 };
	}
	return {
		entry: { ...entry, models: { ...models, [kind]: merged } },
		added,
	};
}

/** Add scoped-key declarations to one entry's `discovery.declared`, deduped; a non-array slot skips. */
export function withEntryDeclares(
	entry: Record<string, unknown>,
	ids: readonly string[]
): { entry: Record<string, unknown>; added: number } {
	const discovery = isRecord(entry.discovery) ? entry.discovery : entry.discovery === undefined ? {} : undefined;
	if (discovery === undefined) {
		return { entry, added: 0 };
	}
	const existing = discovery.declared;
	if (existing !== undefined && !Array.isArray(existing)) {
		return { entry, added: 0 };
	}
	const current: unknown[] = [...(existing ?? [])];
	const missing = ids.filter((id) => !current.includes(id));
	if (missing.length === 0) {
		return { entry, added: 0 };
	}
	return {
		entry: { ...entry, discovery: { ...discovery, declared: [...current, ...missing] } },
		added: missing.length,
	};
}

/** Whether one entry's `headers` slot can take the copied global headers. */
export function entryCanReceiveHeaders(entry: unknown): boolean {
	return isRecord(entry) && (entry.headers === undefined || isRecord(entry.headers));
}

/**
 * Copy global header names into one entry's `headers`; existing entry names
 * win case-insensitively (HTTP header names compare that way, and the
 * entry's value is the newer intent).
 */
export function withEntryHeaders(
	entry: Record<string, unknown>,
	headers: Record<string, unknown>
): { entry: Record<string, unknown>; added: number } {
	const existing = isRecord(entry.headers) ? entry.headers : {};
	const existingNames = new Set(Object.keys(existing).map((name) => name.toLowerCase()));
	const missing = Object.entries(headers).filter(([name]) => !existingNames.has(name.toLowerCase()));
	if (missing.length === 0) {
		return { entry, added: 0 };
	}
	return { entry: { ...entry, headers: fromPairs([...Object.entries(existing), ...missing]) }, added: missing.length };
}
