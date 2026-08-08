/**
 * The migration fuzzer's behavior-equivalence oracle: two pluggable resolve
 * functions that reduce "what does this configuration mean for (server,
 * model)" to one comparable view.
 *
 * - resolveOldWorld runs THIS BRANCH's live resolvers (the pre-redesign
 *   prefix/scoped semantics) over an old-world snapshot.
 * - resolveNewWorldReference is a test-local interpreter of the redesigned
 *   grammar (tracker semantics) over a MIGRATED snapshot, restricted to the
 *   sublanguage the migration can output: exact keys, trailing globs, "*",
 *   `_force`/`_fallback`, and the trio's `_inheritable` "*" record. No
 *   regex, no `_inherit_from` - the migration never emits them.
 *
 * INTEGRATION PLUG (post R1+R2 merge): swap resolveNewWorldReference's body
 * for R1's real resolver (same NewWorldResolve signature - build R1's input
 * from the migrated snapshot and project its flat table down to
 * EffectiveView). The old side's imports break when R1 rewrites
 * parameterResolution/capabilityResolution; at that point freeze the old
 * behavior by pinning this file's old-side imports to copies, or retire the
 * old side and keep reference-vs-R1.
 *
 * Scope notes (documented divergences the property skips or ignores):
 * - The old "scoped global record replaces the unscoped record WHOLE" rule
 *   cannot survive the move to entry level (entry merges field by field);
 *   samples where the old resolver reports `replacedUnscoped` are skipped.
 * - descopingDiverges skips the two remaining descoping corners: a scoped
 *   winner alongside an unscoped match, and a scoped winner competing with
 *   an entry winner under a DIFFERENT key. Same-KEY collisions (which the
 *   migration merges field by field) and uncontested scoped moves stay in
 *   the property. Both skipped corners are pinned by dedicated tests in the
 *   property file's divergence suite.
 * - The trio's walk-level equivalence (fallback fill below the server
 *   report) needs the full capability walk and lands with R1's resolver;
 *   the shipped property compares the resolver level (overrides, fallbacks,
 *   declared IDs), and a placement property pins the trio merge directly.
 * - Old configs carrying `_inheritable`/`_inherit_from` as then-inert
 *   underscore keys would ACTIVATE under the new grammar; the migration
 *   rides them verbatim by design (generators never emit them), so a corpus
 *   entry with one would report a false migration failure here.
 */

import {
	CAPABILITY_FIELDS,
	EMPTY_CATALOG_LOOKUP,
	extractDeclaredModels,
	resolveCapabilityOverrides,
} from "../../../shared/config/capabilityResolution";
import {
	findLongestPrefixEntry,
	findScopedMatch,
	parameterSkipReason,
	resolveModelParameters,
} from "../../../shared/config/parameterResolution";
import { normalizeModelCapabilities, normalizeModelParameters } from "../../../shared/config/settings";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";

export interface OracleServer {
	readonly label: string;
	readonly baseUrl: string;
}

/**
 * Apply a plan to a snapshot the way the applier applies it to user
 * settings: value writes set the Global layer, undefined deletes it; other
 * layers are untouched (the plan never names them). Shared by the unit
 * suite's rerun assertions and the property suite's idempotence invariant.
 */
export function applyPlanToSnapshot(
	snapshot: Readonly<
		Record<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }>
	>,
	writes: readonly { readonly section: string; readonly value: unknown }[]
): Record<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }> {
	const sections: Record<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }> =
		Object.fromEntries(Object.entries(snapshot).map(([id, layers]) => [id, { ...layers }]));
	for (const write of writes) {
		const layers = { ...(sections[write.section] ?? {}) };
		if (write.value === undefined) {
			delete layers.globalValue;
		} else {
			layers.globalValue = write.value;
		}
		if (Object.keys(layers).length === 0) {
			delete sections[write.section];
		} else {
			sections[write.section] = layers;
		}
	}
	return sections;
}

/** One comparable meaning of a configuration for (server, model). */
export interface EffectiveView {
	/** The effective configured request parameters (forced winners applied). */
	readonly parameters: Record<string, unknown>;
	/** The forced subset, entry over global. */
	readonly forced: Record<string, unknown>;
	/** Capability override values, entry over global, field by field. */
	readonly capabilityOverrides: Record<string, unknown>;
	/** Effective below-server fallback values, entry over global. */
	readonly capabilityFallbacks: Record<string, unknown>;
	/** The exact model IDs declared for this server, sorted. */
	readonly declared: readonly string[];
}

type Snapshot = Readonly<Record<string, { readonly globalValue?: unknown }>>;

export type OldWorldResolve = (
	snapshot: Snapshot,
	server: OracleServer,
	modelId: string
) => EffectiveView & { skipEquivalence: boolean };

export type NewWorldResolve = (snapshot: Snapshot, server: OracleServer, modelId: string) => EffectiveView;

/** The old parser's entry acceptance, replicated for both worlds (label+URL identity, first label wins). */
function acceptedEntryRecord(rawServers: unknown, server: OracleServer): Record<string, unknown> | undefined {
	if (!Array.isArray(rawServers)) {
		return undefined;
	}
	const seen = new Set<string>();
	for (const item of rawServers) {
		if (!isRecord(item)) {
			continue;
		}
		const label = typeof item.label === "string" ? item.label.trim() : "";
		const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl.trim() : "";
		if (label === "" || baseUrl === "" || isUnsafeRecordKey(label) || seen.has(label)) {
			continue;
		}
		seen.add(label);
		if (label === server.label && normalizeBaseUrl(baseUrl) === normalizeBaseUrl(server.baseUrl)) {
			return item;
		}
	}
	return undefined;
}

/** Every server identity the old acceptance rules admit from a raw servers value. */
export function acceptedServers(rawServers: unknown): OracleServer[] {
	if (!Array.isArray(rawServers)) {
		return [];
	}
	const servers: OracleServer[] = [];
	const seen = new Set<string>();
	for (const item of rawServers) {
		if (!isRecord(item)) {
			continue;
		}
		const label = typeof item.label === "string" ? item.label.trim() : "";
		const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl.trim() : "";
		if (label === "" || baseUrl === "" || isUnsafeRecordKey(label) || seen.has(label)) {
			continue;
		}
		seen.add(label);
		servers.push({ label, baseUrl });
	}
	return servers;
}

/**
 * Whether the descoping of one record diverges for this model. A scoped
 * match always won the old global layer outright, and after the move it
 * lives at the ENTRY level instead, so:
 *  - a scoped winner alongside an unscoped match diverges (the unscoped
 *    record was replaced WHOLE, and now merges below the entry level);
 *  - a scoped winner alongside an entry winner under a DIFFERENT key
 *    diverges (two levels merged field by field, one level now resolves
 *    most-specific-wholesale).
 * A scoped winner whose key matches the entry winner's is exactly the
 * same-key collision withEntryRecordAdditions merges field by field, and a
 * scoped winner with no competition simply moves - both stay in the
 * equivalence property.
 */
function descopingDiverges(
	global: Record<string, Record<string, unknown>>,
	entryRecord: Record<string, Record<string, unknown>> | undefined,
	scope: string,
	modelId: string
): boolean {
	const scopedWinner = findScopedMatch(modelId, [scope], global);
	if (scopedWinner === undefined) {
		return false;
	}
	const unscopedOnly = Object.fromEntries(Object.entries(global).filter(([key]) => !key.includes("://")));
	if (findLongestPrefixEntry(modelId, unscopedOnly) !== undefined) {
		return true;
	}
	const entryWinner = findLongestPrefixEntry(modelId, entryRecord ?? {});
	if (entryWinner === undefined) {
		return false;
	}
	const remainder = scopedWinner.key.slice(scope.length + 1);
	return explicitMatcherKey(remainder) !== explicitMatcherKey(entryWinner.key);
}

/** The migration's key rewrite, replicated so the comparison uses post-migration key identity. */
function explicitMatcherKey(prefix: string): string {
	return prefix === "" || prefix === "*" ? "*" : `${prefix}*`;
}

export const resolveOldWorld: OldWorldResolve = (snapshot, server, modelId) => {
	const scopes = [normalizeBaseUrl(server.baseUrl)];
	const entry = acceptedEntryRecord(snapshot.servers?.globalValue, server);
	const globalParameters = normalizeModelParameters(snapshot.modelParameters?.globalValue);
	const entryParameters = entry !== undefined ? normalizeModelParameters(entry.modelParameters) : undefined;
	const params = resolveModelParameters({
		rawModelId: modelId,
		globalParameters,
		serverScopes: scopes,
		...(entryParameters !== undefined && Object.keys(entryParameters).length > 0 ? { entryParameters } : {}),
	});

	const globalCapabilities = normalizeModelCapabilities(snapshot.modelCapabilities?.globalValue);
	const entryCapabilities = entry !== undefined ? normalizeModelCapabilities(entry.modelCapabilities) : undefined;
	const capsInput = {
		rawModelId: modelId,
		globalCapabilities,
		serverScopes: scopes,
		...(entryCapabilities !== undefined && Object.keys(entryCapabilities).length > 0 ? { entryCapabilities } : {}),
		catalog: EMPTY_CATALOG_LOOKUP,
	};
	const caps = resolveCapabilityOverrides(capsInput);
	const declared = extractDeclaredModels({
		globalCapabilities,
		serverScopes: scopes,
		...(capsInput.entryCapabilities !== undefined ? { entryCapabilities: capsInput.entryCapabilities } : {}),
	});

	const capabilityOverrides: Record<string, unknown> = {};
	const capabilityFallbacks: Record<string, unknown> = {};
	for (const field of Object.keys(CAPABILITY_FIELDS) as (keyof typeof CAPABILITY_FIELDS)[]) {
		const override = caps.fields[field];
		if (override !== undefined) {
			capabilityOverrides[field] = override.value;
		}
		const candidates = caps.fallbackFields[field];
		if (candidates !== undefined && candidates.length > 0) {
			capabilityFallbacks[field] = candidates[0]?.value;
		}
	}

	const scope = scopes[0] as string;
	return {
		parameters: { ...params.params },
		forced: { ...params.forcedParams },
		capabilityOverrides,
		capabilityFallbacks,
		declared: [...new Set(declared.models.map((model) => model.rawId))].sort(),
		skipEquivalence:
			params.replacedUnscoped !== undefined ||
			caps.replacedUnscoped !== undefined ||
			descopingDiverges(globalParameters, entryParameters, scope, modelId) ||
			descopingDiverges(globalCapabilities, entryCapabilities, scope, modelId),
	};
};

// --- The new-grammar reference interpreter -------------------------------

interface MatchedRecord {
	readonly key: string;
	readonly record: Record<string, unknown>;
}

/**
 * The redesigned matcher grammar restricted to the migration's output: "*"
 * is the catch-all, a trailing "*" is a glob over its literal prefix (a
 * literal containing another "*" is an invalid matcher and ignored, ruling
 * O1), anything else matches exactly. Specificity: exact > glob with the
 * longer literal > "*".
 */
function mostSpecificMatch(record: Record<string, unknown>, modelId: string): MatchedRecord | undefined {
	let exact: MatchedRecord | undefined;
	let glob: (MatchedRecord & { literal: string }) | undefined;
	let catchAll: MatchedRecord | undefined;
	for (const [key, value] of Object.entries(record)) {
		if (!isRecord(value)) {
			continue;
		}
		if (key === "*") {
			catchAll = { key, record: value };
			continue;
		}
		if (key.endsWith("*")) {
			const literal = key.slice(0, -1);
			if (literal.includes("*")) {
				continue;
			}
			if (modelId.startsWith(literal) && (glob === undefined || literal.length > glob.literal.length)) {
				glob = { key, record: value, literal };
			}
			continue;
		}
		if (key.includes("*")) {
			continue;
		}
		if (key === modelId) {
			exact = { key, record: value };
		}
	}
	return exact ?? glob ?? catchAll;
}

/** The names a `true | [fields]` directive marks among a record's own non-directive fields. */
function markedFields(record: Record<string, unknown>, directive: string, eligible: readonly string[]): Set<string> {
	const raw = record[directive];
	if (raw === true) {
		return new Set(eligible);
	}
	if (Array.isArray(raw)) {
		return new Set(raw.filter((name): name is string => typeof name === "string" && eligible.includes(name)));
	}
	return new Set();
}

/** One level's resolved capability chain: override and fallback values with the "*" record's inheritable flow. */
function capabilityChain(
	record: Record<string, unknown> | undefined,
	modelId: string
): { overrides: Record<string, unknown>; fallbacks: Record<string, unknown> } {
	const overrides: Record<string, unknown> = {};
	const fallbacks: Record<string, unknown> = {};
	if (record === undefined) {
		return { overrides, fallbacks };
	}
	const winner = mostSpecificMatch(record, modelId);
	if (winner === undefined) {
		return { overrides, fallbacks };
	}
	// Value typing mirrors parseCapabilityRecord: number fields take positive
	// integers, boolean fields booleans, anything else stays unset (so a
	// lower level's valid value can win) - and only validly-set fields are
	// eligible for `_fallback` marking.
	const isValidField = (source: Record<string, unknown>, name: string): boolean => {
		const type = CAPABILITY_FIELDS[name as keyof typeof CAPABILITY_FIELDS];
		const value = source[name];
		if (type === "number") {
			return typeof value === "number" && Number.isInteger(value) && value > 0;
		}
		return type === "boolean" && typeof value === "boolean";
	};
	const fieldNames = (source: Record<string, unknown>): string[] =>
		Object.keys(source).filter((key) => Object.hasOwn(CAPABILITY_FIELDS, key) && isValidField(source, key));
	const place = (source: Record<string, unknown>, field: string): void => {
		const fallbackSet = markedFields(source, "_fallback", fieldNames(source));
		if (fallbackSet.has(field)) {
			fallbacks[field] = source[field];
		} else {
			overrides[field] = source[field];
		}
	};
	for (const field of fieldNames(winner.record)) {
		place(winner.record, field);
	}
	// Pass-through inheritance from an inheritable "*" record: fields flow to
	// a more specific winner that does not set them, keeping their source's
	// fallback marking. The migration emits `_inheritable` only there.
	const broad = winner.key !== "*" && isRecord(record["*"]) ? (record["*"] as Record<string, unknown>) : undefined;
	if (broad !== undefined) {
		const inheritable = markedFields(broad, "_inheritable", fieldNames(broad));
		for (const field of fieldNames(broad)) {
			if (!inheritable.has(field) || Object.hasOwn(winner.record, field)) {
				continue;
			}
			place(broad, field);
		}
	}
	return { overrides, fallbacks };
}

/** One level's resolved parameter chain: pass-through fields plus the `_force` winners. */
function parameterChain(
	record: Record<string, unknown> | undefined,
	modelId: string
): { fields: Record<string, unknown>; forced: Record<string, unknown> } {
	const fields: Record<string, unknown> = {};
	const forced: Record<string, unknown> = {};
	if (record === undefined) {
		return { fields, forced };
	}
	const winner = mostSpecificMatch(record, modelId);
	if (winner === undefined) {
		return { fields, forced };
	}
	for (const [key, value] of Object.entries(winner.record)) {
		if (key !== "_force") {
			Object.defineProperty(fields, key, { value, enumerable: true, writable: true, configurable: true });
		}
	}
	const eligible = Object.keys(fields).filter((key) => parameterSkipReason(key) === undefined);
	for (const name of markedFields(winner.record, "_force", eligible)) {
		forced[name] = fields[name];
	}
	return { fields, forced };
}

function newWorldRecord(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const cleaned = Object.fromEntries(Object.entries(value).filter(([key]) => !isUnsafeRecordKey(key)));
	return cleaned;
}

export const resolveNewWorldReference: NewWorldResolve = (snapshot, server, modelId) => {
	const entry = acceptedEntryRecord(snapshot.servers?.globalValue, server);
	const entryModels = entry !== undefined && isRecord(entry.models) ? entry.models : undefined;

	const globalParams = parameterChain(newWorldRecord(snapshot["models.parameters"]?.globalValue), modelId);
	const entryParams = parameterChain(newWorldRecord(entryModels?.parameters), modelId);
	const forced = { ...globalParams.forced, ...entryParams.forced };
	const parameters = { ...globalParams.fields, ...entryParams.fields, ...forced };

	const globalCaps = capabilityChain(newWorldRecord(snapshot["models.capabilities"]?.globalValue), modelId);
	const entryCaps = capabilityChain(newWorldRecord(entryModels?.capabilities), modelId);
	const capabilityOverrides = { ...globalCaps.overrides, ...entryCaps.overrides };
	const capabilityFallbacks = { ...globalCaps.fallbacks, ...entryCaps.fallbacks };

	const discovery = entry !== undefined && isRecord(entry.discovery) ? entry.discovery : undefined;
	const declared = Array.isArray(discovery?.declared)
		? [...new Set(discovery.declared.filter((id): id is string => typeof id === "string"))].sort()
		: [];

	return { parameters, forced, capabilityOverrides, capabilityFallbacks, declared };
};
