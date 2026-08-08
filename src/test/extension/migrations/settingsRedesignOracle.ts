/**
 * The migration fuzzer's behavior-equivalence oracle: two pluggable resolve
 * functions that reduce "what does this configuration mean for (server,
 * model)" to one comparable view.
 *
 * - resolveOldWorld runs the FROZEN pre-redesign resolvers (pinned as
 *   test-local copies in oldWorldResolvers.ts - the live resolvers were
 *   rewritten for the redesign) over an old-world snapshot.
 * - resolveNewWorld runs the LIVE redesigned resolvers
 *   (shared/config/parameterResolution + capabilityResolution, the same
 *   matcher/inheritance engine requests and registration use) over a
 *   MIGRATED snapshot.
 *
 * Both sides resolve the entry by the same acceptance rule (label + base URL
 * identity, first label wins), so the property isolates RESOLVER equivalence;
 * the entry-parser-vs-migration seam has its own coverage in the serverSync
 * suites. The walk-level values (the full capability walk, trio included)
 * compare under a fixed set of server baselines, values only - provenance is
 * allowed to differ where the redesign upgrades a migrated default to
 * user-set (the documented clamp-lifting change).
 *
 * Scope notes (documented divergences the property skips, each pinned by a
 * dedicated test in the property file's divergence suite):
 * - The old "scoped global record replaces the unscoped record WHOLE" rule
 *   cannot survive the move to entry level (entry merges field by field).
 *   Skipped only when the replacement actually mattered: the replaced
 *   unscoped record carried a field the scoped winner does not set, or any
 *   forced/fallback mark (the narrowed form of the old replacedUnscoped
 *   skip).
 * - A scoped winner competing with an entry record under a DIFFERENT key:
 *   two levels merged field by field, one level now resolves
 *   most-specific-wholesale. Skipped only when the losing record carries any
 *   field or mark of its own.
 * - The old default* trio applied to EVERY model, below records but above
 *   the floor (and defaultMaxInputTokens even above the server report),
 *   while the migrated "*" fill participates in the matcher chain like any
 *   record: a matching record that sets the same field can win it, drain the
 *   fill at merge time, or block its flow to a more specific winner. The
 *   walk comparison skips conservatively whenever a configured trio field is
 *   also set by a matching unscoped global record; the corners are pinned in
 *   the divergence suite.
 * - A star-bearing old key migrates to an escaped anchored-prefix regex
 *   (lossless match set), but the regex TIER ranks below globs, so ordering
 *   against another matching key can differ from the old longest-prefix rule
 *   (the ruling's accepted caveat). Skipped whenever a star-bearing key
 *   matches beside any other matching key in the same record.
 * - Old configs carrying `_inheritable`/`_inherit_from` as then-inert
 *   underscore keys would ACTIVATE under the new grammar; the migration
 *   rides them verbatim by design (generators never emit them), so a corpus
 *   entry with one would report a false migration failure here.
 */

import {
	CAPABILITY_FIELDS,
	EMPTY_CATALOG_LOOKUP,
	resolveCapabilityOverrides,
	resolveModelCapabilities,
	type ServerDeclaredCapabilities,
} from "../../../shared/config/capabilityResolution";
import { resolveModelParameters } from "../../../shared/config/parameterResolution";
import { normalizeModelCapabilities, normalizeModelParameters } from "../../../shared/config/settings";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";
import { normalizePositiveNumber } from "../../../shared/util/numbers";
import {
	extractOldDeclaredModels,
	findLongestPrefixEntry,
	findScopedMatch,
	type OldCapabilityTokenDefaults,
	parseOldCapabilityRecord,
	parseOldParameterRecord,
	resolveOldCapabilityOverrides,
	resolveOldModelCapabilities,
	resolveOldModelParameters,
} from "./oldWorldResolvers";

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

/**
 * The fixed server baselines walk-level values compare under: a declared
 * model (no server side), a discovered model reporting nothing, and a
 * discovered model with typical token values.
 */
export const WALK_BASELINES: readonly ServerDeclaredCapabilities[] = [
	{ kind: "declared" },
	{ kind: "discovered", values: {}, outputDeclared: false },
	{
		kind: "discovered",
		values: { context_length: 100000, max_output_tokens: 8000, max_input_tokens: 90000, supports_vision: true },
		outputDeclared: true,
	},
];

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
	/** Full-walk effective values (trio included) per WALK_BASELINES entry; values only, never provenance. */
	readonly walks: readonly Record<string, number | boolean>[];
}

type Snapshot = Readonly<Record<string, { readonly globalValue?: unknown }>>;

export type OldWorldResolve = (
	snapshot: Snapshot,
	server: OracleServer,
	modelId: string
) => EffectiveView & {
	/** Skip every comparison: the descoping corners change resolver-level outcomes (and therefore walks too). */
	skipEquivalence: boolean;
	/** Skip only the walk-level comparison: the trio-fill flow corners live below the resolver views. */
	skipWalks: boolean;
};

export type NewWorldResolve = (snapshot: Snapshot, server: OracleServer, modelId: string) => EffectiveView;

/** The entry acceptance both worlds share (label+URL identity, first label wins). */
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

/** The migration's key rewrite, replicated so the comparison uses post-migration key identity. */
function explicitMatcherKey(prefix: string): string {
	if (prefix === "" || prefix === "*") {
		return "*";
	}
	if (prefix.includes("*")) {
		return `/${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*/`;
	}
	return `${prefix}*`;
}

/** The record's own contribution, judged by the record type's parse: field keys plus its mark set. */
function recordContribution(
	record: Readonly<Record<string, unknown>>,
	type: "params" | "caps"
): { fieldKeys: ReadonlySet<string>; markedFields: ReadonlySet<string>; marked: boolean } {
	if (type === "params") {
		const parsed = parseOldParameterRecord(record);
		return {
			fieldKeys: new Set(Object.keys(parsed.fields)),
			markedFields: new Set(parsed.forced),
			marked: parsed.forced.size > 0,
		};
	}
	const parsed = parseOldCapabilityRecord(record, { allowDeclare: true });
	return {
		fieldKeys: new Set(Object.keys(parsed.fields)),
		markedFields: new Set(parsed.fallback),
		marked: parsed.fallback.length > 0,
	};
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	return [...a].some((member) => b.has(member));
}

/**
 * Whether the descoping of one record diverges for this model - narrowed to
 * the cases where the moved record's new position actually changes the
 * outcome (see the header's scope notes):
 *  - a scoped winner alongside an unscoped match diverges only when the
 *    replaced unscoped record contributed something the scoped winner does
 *    not carry (a field key of its own, or any mark);
 *  - a scoped winner beside an entry winner under a DIFFERENT key diverges
 *    only when the record that loses the new most-specific-wholesale rule
 *    carried any contribution of its own.
 */
function descopingDiverges(
	global: Record<string, Record<string, unknown>>,
	entryRecord: Record<string, Record<string, unknown>> | undefined,
	scope: string,
	modelId: string,
	type: "params" | "caps"
): boolean {
	const scopedWinner = findScopedMatch(modelId, [scope], global);
	if (scopedWinner === undefined) {
		return false;
	}
	const scopedContribution = recordContribution(scopedWinner.value, type);
	const unscopedOnly = Object.fromEntries(Object.entries(global).filter(([key]) => !key.includes("://")));
	const unscopedWinner = findLongestPrefixEntry(modelId, unscopedOnly);
	if (unscopedWinner !== undefined) {
		const replaced = recordContribution(unscopedWinner.value, type);
		if (
			replaced.marked ||
			[...replaced.fieldKeys].some((key) => !scopedContribution.fieldKeys.has(key)) ||
			// A scoped MARK on a field the replaced record also set diverges: the
			// old replacement erased the unscoped value entirely, while the new
			// per-field merge lets it surface at the level the mark vacated.
			intersects(scopedContribution.markedFields, replaced.fieldKeys)
		) {
			return true;
		}
	}
	const entryWinner = findLongestPrefixEntry(modelId, entryRecord ?? {});
	if (entryWinner === undefined) {
		return false;
	}
	const remainder = scopedWinner.key.slice(scope.length + 1);
	if (explicitMatcherKey(remainder) === explicitMatcherKey(entryWinner.key)) {
		// Same post-migration key: the migration merges the two field by field
		// with the entry winning - exactly the old entry-over-scoped merge for
		// UNMARKED fields. A mark crossing the boundary diverges: a scoped mark
		// on a field the entry sets is dropped rather than re-pointed (the
		// divergence pin's _force case), and an entry mark on a field the
		// scoped record used to win as an override changes its level (the
		// scoped value dies with the merge).
		const entryContribution = recordContribution(entryWinner.value, type);
		return (
			intersects(scopedContribution.markedFields, entryContribution.fieldKeys) ||
			intersects(entryContribution.markedFields, scopedContribution.fieldKeys)
		);
	}
	// Post-migration both live in the entry level and the more specific key
	// wins wholesale (a longer glob literal; an exact key beats any glob).
	// The old world merged entry over scoped key by key, so divergence needs
	// the losing record to have contributed something.
	const remainderKey = explicitMatcherKey(remainder);
	const entryKey = explicitMatcherKey(entryWinner.key);
	// exact > glob (literal length) > regex (star-bearing old keys) > "*".
	const specificity = (key: string): number =>
		key === "*"
			? -1
			: key.startsWith("/") && key.endsWith("/")
				? 0
				: key.endsWith("*")
					? key.length - 1
					: key.length + 1e6;
	const entryWins = specificity(entryKey) >= specificity(remainderKey);
	const loser = entryWins ? scopedWinner.value : entryWinner.value;
	const loserContribution = recordContribution(loser, type);
	// In the old world the entry always won key by key; a losing scoped record
	// still contributed its non-overlapping keys, and a losing entry record
	// contributed everything it had. A winner MARK on a field the loser also
	// set diverges too: old-world levels merged per field (a fallback-demoted
	// entry field still let the scoped override win the override slot), while
	// the new wholesale winner erases the loser's level entirely.
	if (entryWins) {
		const winner = recordContribution(entryWinner.value, type);
		return (
			loserContribution.marked ||
			[...loserContribution.fieldKeys].some((key) => !winner.fieldKeys.has(key)) ||
			intersects(winner.markedFields, loserContribution.fieldKeys)
		);
	}
	return loserContribution.marked || loserContribution.fieldKeys.size > 0;
}

/**
 * The star-ordering caveat (see the header): the effective old-matching keys
 * of one record map for this model and scope - unscoped keys matching the
 * ID, plus this scope's remainders - diverge in ORDER when a star-bearing
 * key matches beside any other matching key (the regex tier ranks below
 * globs while old longest-prefix ranked by literal length alone).
 */
function starOrderingDiverges(
	record: Record<string, Record<string, unknown>>,
	scope: string,
	modelId: string
): boolean {
	const oldPrefixMatches = (prefix: string): boolean =>
		prefix === "*" || prefix === "" || modelId === prefix || modelId.startsWith(prefix);
	const effectiveKeys: string[] = [];
	for (const key of Object.keys(record)) {
		if (key.includes("://")) {
			if (key.startsWith(`${scope}/`) && oldPrefixMatches(key.slice(scope.length + 1))) {
				effectiveKeys.push(key.slice(scope.length + 1));
			}
			continue;
		}
		if (oldPrefixMatches(key)) {
			effectiveKeys.push(key);
		}
	}
	return effectiveKeys.length > 1 && effectiveKeys.some((key) => key !== "*" && key.includes("*"));
}

/** The old default* trio exactly as the walk consumed it (explicitly-configured positives only). */
function oldTokenDefaults(snapshot: Snapshot): OldCapabilityTokenDefaults {
	const explicit = (id: string): { value: number; explicitlyConfigured: boolean } => {
		const configured = normalizePositiveNumber(snapshot[id]?.globalValue);
		return configured !== undefined
			? { value: configured, explicitlyConfigured: true }
			: { value: 0, explicitlyConfigured: false };
	};
	return {
		contextLength: explicit("defaultContextLength"),
		maxOutputTokens: explicit("defaultMaxOutputTokens"),
		maxInputTokens: normalizePositiveNumber(snapshot.defaultMaxInputTokens?.globalValue),
	};
}

export const resolveOldWorld: OldWorldResolve = (snapshot, server, modelId) => {
	const scopes = [normalizeBaseUrl(server.baseUrl)];
	const entry = acceptedEntryRecord(snapshot.servers?.globalValue, server);
	const globalParameters = normalizeModelParameters(snapshot.modelParameters?.globalValue);
	const entryParameters = entry !== undefined ? normalizeModelParameters(entry.modelParameters) : undefined;
	const hasEntryParameters = entryParameters !== undefined && Object.keys(entryParameters).length > 0;
	const params = resolveOldModelParameters({
		rawModelId: modelId,
		globalParameters,
		serverScopes: scopes,
		...(hasEntryParameters ? { entryParameters } : {}),
	});

	const globalCapabilities = normalizeModelCapabilities(snapshot.modelCapabilities?.globalValue);
	const entryCapabilities = entry !== undefined ? normalizeModelCapabilities(entry.modelCapabilities) : undefined;
	const hasEntryCapabilities = entryCapabilities !== undefined && Object.keys(entryCapabilities).length > 0;
	const capsInput = {
		rawModelId: modelId,
		globalCapabilities,
		serverScopes: scopes,
		...(hasEntryCapabilities ? { entryCapabilities } : {}),
	};
	const caps = resolveOldCapabilityOverrides(capsInput);
	const declared = extractOldDeclaredModels(capsInput);

	const tokenDefaults = oldTokenDefaults(snapshot);
	const walks = WALK_BASELINES.map((serverDeclared) => ({
		...resolveOldModelCapabilities({ ...capsInput, serverDeclared, tokenDefaults }),
	}));

	// The trio-fill flow corners (see the header): the OLD trio applied to
	// every model regardless of other records, while the migrated "*" fill
	// participates in the matcher chain - a matching record that sets the
	// same field either wins it in both worlds (no divergence) or blocks the
	// fill's flow / drains it at merge time (divergence: the old trio still
	// applied underneath, max_input's above-server quirk included). Skips the
	// WALK comparison only (the trio lived below the resolver views, so the
	// resolver-level comparison stays live), conservatively whenever a
	// configured trio field is also set by any matching unscoped global
	// record; the drained, blocked, and quirk corners are each pinned in the
	// property file's divergence suite.
	const configuredTrioFields = [
		...(tokenDefaults.contextLength.explicitlyConfigured ? (["context_length"] as const) : []),
		...(tokenDefaults.maxOutputTokens.explicitlyConfigured ? (["max_output_tokens"] as const) : []),
		...(tokenDefaults.maxInputTokens !== undefined ? (["max_input_tokens"] as const) : []),
	];
	const oldPrefixMatches = (key: string): boolean => key === "*" || modelId === key || modelId.startsWith(key);
	const trioFlowDiverges =
		configuredTrioFields.length > 0 &&
		Object.entries(globalCapabilities).some(
			([key, record]) =>
				!key.includes("://") &&
				oldPrefixMatches(key) &&
				configuredTrioFields.some((field) =>
					Object.hasOwn(parseOldCapabilityRecord(record, { allowDeclare: true }).fields, field)
				)
		);

	const capabilityOverrides: Record<string, unknown> = {};
	const capabilityFallbacks: Record<string, unknown> = {};
	for (const field of Object.keys(CAPABILITY_FIELDS)) {
		const override = caps.overrides[field as keyof typeof caps.overrides];
		if (override !== undefined) {
			capabilityOverrides[field] = override;
		}
		const fallback = caps.fallbacks[field as keyof typeof caps.fallbacks];
		if (fallback !== undefined) {
			capabilityFallbacks[field] = fallback;
		}
	}

	const scope = scopes[0] as string;
	const skipEquivalence =
		descopingDiverges(globalParameters, hasEntryParameters ? entryParameters : undefined, scope, modelId, "params") ||
		descopingDiverges(
			globalCapabilities,
			hasEntryCapabilities ? entryCapabilities : undefined,
			scope,
			modelId,
			"caps"
		) ||
		starOrderingDiverges(globalParameters, scope, modelId) ||
		starOrderingDiverges(globalCapabilities, scope, modelId) ||
		(hasEntryParameters && starOrderingDiverges(entryParameters, scope, modelId)) ||
		(hasEntryCapabilities && starOrderingDiverges(entryCapabilities, scope, modelId));
	return {
		parameters: { ...params.params },
		forced: { ...params.forcedParams },
		capabilityOverrides,
		capabilityFallbacks,
		declared: [...new Set(declared)].sort(),
		walks,
		skipEquivalence,
		skipWalks: skipEquivalence || trioFlowDiverges,
	};
};

// --- The redesigned world, resolved by the LIVE resolvers -----------------

function newWorldRecord(value: unknown): Record<string, Record<string, unknown>> {
	return normalizeModelParameters(value);
}

export const resolveNewWorldReference: NewWorldResolve = (snapshot, server, modelId) => {
	const entry = acceptedEntryRecord(snapshot.servers?.globalValue, server);
	const entryModels = entry !== undefined && isRecord(entry.models) ? entry.models : undefined;

	const globalParameters = newWorldRecord(snapshot["models.parameters"]?.globalValue);
	const entryParameters = entryModels !== undefined ? newWorldRecord(entryModels.parameters) : undefined;
	const hasEntryParameters = entryParameters !== undefined && Object.keys(entryParameters).length > 0;
	const params = resolveModelParameters({
		rawModelId: modelId,
		globalParameters,
		...(hasEntryParameters ? { entryParameters } : {}),
	});

	const globalCapabilities = normalizeModelCapabilities(snapshot["models.capabilities"]?.globalValue);
	const entryCapabilities =
		entryModels !== undefined ? normalizeModelCapabilities(entryModels.capabilities) : undefined;
	const hasEntryCapabilities = entryCapabilities !== undefined && Object.keys(entryCapabilities).length > 0;
	const capsInput = {
		rawModelId: modelId,
		globalCapabilities,
		...(hasEntryCapabilities ? { entryCapabilities } : {}),
		catalog: EMPTY_CATALOG_LOOKUP,
	};
	const caps = resolveCapabilityOverrides(capsInput);

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

	const walks = WALK_BASELINES.map((serverDeclared) => {
		const effective = resolveModelCapabilities({ ...capsInput, serverDeclared });
		return Object.fromEntries(
			Object.keys(CAPABILITY_FIELDS).map((field) => [
				field,
				effective.fields[field as keyof typeof CAPABILITY_FIELDS].value,
			])
		);
	});

	const discovery = entry !== undefined && isRecord(entry.discovery) ? entry.discovery : undefined;
	const declared = Array.isArray(discovery?.declared)
		? [
				...new Set(
					discovery.declared
						.map((id) => (typeof id === "string" ? id.trim() : undefined))
						.filter((id): id is string => id !== undefined && id !== "")
				),
			].sort()
		: [];

	return {
		parameters: { ...params.params },
		forced: { ...params.forcedParams },
		capabilityOverrides,
		capabilityFallbacks,
		declared,
		walks,
	};
};
