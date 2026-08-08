/**
 * The single owner of the models.parameters resolution: the matcher-and-
 * inheritance walk (via recordResolution.ts), the entry-over-global merge,
 * the `_force` directive, and the max_tokens fallback branch. Pure (no
 * vscode, no DOM) on purpose: the request path (provider/transport) builds
 * requests from these functions, and the dashboard's effective-values
 * inspector renders its projection through the protocol module's re-exports
 * - one implementation, so the inspector cannot drift from what a request
 * actually carries. The equivalence property suite pins that claim against
 * buildRequestBody.
 *
 * Precedence: the entry record's resolution beats the global setting's field
 * by field (each level resolves its own matching chain first). Runtime
 * options and the picker configuration override later, on the request path
 * only - except for `_force`d fields, which beat both (forced entry over
 * forced global, key by key).
 */

import type { ModelRecordMap } from "./modelMatcher";
import type { ParsedRecord, RecordChainResolution, RecordDiagnostic, RecordLayer } from "./recordResolution";
import { parseSharedDirectives, resolveRecordChain } from "./recordResolution";

// The record grammar is shared machinery; the parameters-side consumers
// import it through this module (the capability side re-exports its own).
export type { ModelRecordMap } from "./modelMatcher";

/**
 * Cap on the fallback max_tokens when neither runtime options nor configured
 * model parameters set one and the model's output limit is a defaults-derived
 * guess rather than server-declared.
 */
export const DEFAULT_MAX_TOKENS_CAP = 4096;

/** A models.parameters record map: matcher key to request parameters. */
export type ModelParametersRecord = ModelRecordMap;

/**
 * The request fields the extension owns. Configuration and runtime options
 * can never set them: buildRequestBody skips these keys on every pass-through
 * source, and the inspector renders them as not-sent for the same reason.
 * max_tokens belongs here too - it is provider-owned on the wire - but its
 * VALUE is special-cased: a numeric configured max_tokens feeds
 * resolveMaxTokens instead of passing through.
 */
export const PROVIDER_OWNED_KEYS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"stream",
	"stream_options",
	"max_tokens",
	"tools",
	"tool_choice",
]);

export type ParameterSkipReason = "underscore" | "provider-owned";

/**
 * Why buildRequestBody would drop a configured key, or undefined when the key
 * passes through. Underscore-prefixed keys are internal on every source (VS
 * Code injects them into modelOptions; extension directives live there in
 * user configuration); provider-owned keys cannot be overridden.
 */
export function parameterSkipReason(key: string): ParameterSkipReason | undefined {
	if (key.startsWith("_")) {
		return "underscore";
	}
	if (PROVIDER_OWNED_KEYS.has(key)) {
		return "provider-owned";
	}
	return undefined;
}

/**
 * Marks all (`true`) or the listed parameter fields of its record as FORCED:
 * forced fields beat runtime modelOptions and the picker configuration on the
 * wire. Provider-owned and underscore keys are unforceable (diagnosed and
 * skipped) - with one exception: max_tokens is provider-owned on the wire but
 * user-settable by design (it feeds resolveMaxTokens), so it is forceable
 * like any set parameter, and a forced value tops the max_tokens chain.
 */
export const FORCE_DIRECTIVE = "_force";

/**
 * Whether `_force` may mark this key. Everything settable is forceable: of
 * the provider-owned keys only max_tokens is settable (its value feeds the
 * derivation instead of passing through), so it alone escapes the refusal.
 */
function forceable(key: string): boolean {
	return key === "max_tokens" || parameterSkipReason(key) === undefined;
}

/** Capability-record directives, known here only to diagnose them as the wrong record type. */
const WRONG_TYPE_DIRECTIVES = ["_fallback", "_openrouter_model"] as const;

/** "entry" is the declared server entry's own record; "global" the models.parameters setting. */
export type ParameterConfigLayer = RecordLayer;

/** A record problem attributed to its configuration layer; see RecordDiagnostic for kinds and keys. */
export interface ParameterDiagnostic extends RecordDiagnostic {
	readonly layer: ParameterConfigLayer;
}

/**
 * Parse one parameters record into the engine's terms: every non-underscore
 * key is a pass-through field (the vocabulary stays open), `_force` marks
 * forced fields (refusing provider-owned and underscore names, and names the
 * record does not set), and the shared `_inheritable`/`_inherit_from`
 * directives parse in recordResolution. Capability directives are diagnosed
 * as the wrong record type; truly unknown underscore keys stay silently
 * ignored for forward compatibility.
 */
function parseParameterRecord(record: Readonly<Record<string, unknown>>): ParsedRecord {
	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		// Underscore keys are directives or reserved, never fields - which also
		// keeps a hostile own "__proto__" key (JSON.parse can produce one) out
		// of every merge below.
		if (!key.startsWith("_")) {
			fields[key] = value;
		}
	}

	const diagnostics: Omit<RecordDiagnostic, "recordKey">[] = [];
	const forced = new Set<string>();
	if (Object.hasOwn(record, FORCE_DIRECTIVE)) {
		const directive = record[FORCE_DIRECTIVE];
		if (directive === true) {
			for (const key of Object.keys(fields)) {
				if (forceable(key)) {
					forced.add(key);
				}
			}
		} else if (Array.isArray(directive)) {
			for (const name of directive) {
				if (typeof name !== "string") {
					diagnostics.push({ kind: "invalid-directive", key: FORCE_DIRECTIVE });
				} else if (!forceable(name)) {
					diagnostics.push({ kind: "unforceable-key", key: name });
				} else if (!Object.hasOwn(fields, name)) {
					diagnostics.push({ kind: "invalid-directive", key: FORCE_DIRECTIVE });
				} else {
					forced.add(name);
				}
			}
		} else if (directive !== false) {
			diagnostics.push({ kind: "invalid-directive", key: FORCE_DIRECTIVE });
		}
	}

	for (const directive of WRONG_TYPE_DIRECTIVES) {
		if (Object.hasOwn(record, directive)) {
			diagnostics.push({ kind: "wrong-record-type", key: directive });
		}
	}

	const shared = parseSharedDirectives(record, fields);
	diagnostics.push(...shared.diagnostics);

	return {
		fields,
		inheritable: shared.inheritable,
		forced,
		fallback: new Set(),
		inheritFrom: shared.inheritFrom,
		diagnostics,
	};
}

/** Resolve one layer's record map for a model through the shared chain walk. */
export function resolveParameterLayer(rawModelId: string, records: ModelRecordMap): RecordChainResolution {
	return resolveRecordChain(rawModelId, records, parseParameterRecord);
}

/** Which configuration layer set a value, and under which record key. */
export interface ParameterSourceRef {
	readonly layer: ParameterConfigLayer;
	/** The record key whose literal field carries the value (the place to edit it). */
	readonly key: string;
}

/** A lower-precedence layer's value for a key some higher layer won. */
export interface ShadowedParameterValue extends ParameterSourceRef {
	readonly value: unknown;
}

/** One merged parameter with its attribution. */
interface ResolvedParameterSource {
	readonly source: ParameterSourceRef;
	/**
	 * Present exactly when the winning layer's record did not write the field
	 * itself: the value was inherited, and this names the record it came from
	 * (always equal to source.key - presence is the signal).
	 */
	readonly inheritedFrom?: string;
	/** Lower-precedence layers that also set this key; present only when one really did. */
	readonly shadowed: readonly ShadowedParameterValue[];
	/** Present exactly when the value's source record `_force`-marks this key. */
	readonly forced?: true;
}

export interface ResolveModelParametersInput {
	readonly rawModelId: string;
	/** The models.parameters setting as the request path reads it (normalizeModelParameters output). */
	readonly globalParameters: ModelParametersRecord;
	/** The declared server entry's own record, when the request routes through one. */
	readonly entryParameters?: ModelParametersRecord | undefined;
}

export interface ResolvedModelParameters {
	/**
	 * The effective configured merge: each layer's resolved chain view, entry
	 * over global key by key, then the forced winners on top (a globally
	 * forced key beats an unforced entry value). Underscore keys never appear:
	 * directives are instructions and unknown ones are reserved, so only
	 * wire-shaped fields survive the parse.
	 */
	readonly params: Record<string, unknown>;
	/**
	 * The forced values, entry over global key by key; always a subset of
	 * `params` (same values). buildRequestBody re-applies them ABOVE runtime
	 * options and the picker configuration.
	 */
	readonly forcedParams: Readonly<Record<string, unknown>>;
	/** Attribution per merged key; every own key of `params` has an entry. */
	readonly sources: ReadonlyMap<string, ResolvedParameterSource>;
	/** Matcher, directive, and `_force` problems in the matching records, attributed to their layer. */
	readonly diagnostics: readonly ParameterDiagnostic[];
}

/**
 * Resolve the configured models.parameters for one model, with attribution.
 * Each layer resolves its own matching chain (specificity plus inheritance;
 * see recordResolution.ts), the entry result overrides the global result key
 * by key, and forced fields win above both: a key the global chain FORCES
 * outranks an unforced entry value, and a forced entry value outranks
 * everything. getModelParameters and the resolution table delegate here, so
 * `params` plus `forcedParams` IS what requests carry.
 */
export function resolveModelParameters(input: ResolveModelParametersInput): ResolvedModelParameters {
	const { rawModelId, globalParameters, entryParameters } = input;
	const global = resolveParameterLayer(rawModelId, globalParameters);
	const entry = resolveParameterLayer(rawModelId, entryParameters ?? {});

	const params: Record<string, unknown> = {};
	const forcedParams: Record<string, unknown> = {};
	const sources = new Map<string, ResolvedParameterSource>();

	const attribution = (
		layer: ParameterConfigLayer,
		resolution: RecordChainResolution,
		name: string
	): { source: ParameterSourceRef; inheritedFrom?: string } => {
		const field = resolution.fields.get(name);
		const sourceKey = field?.sourceKey ?? resolution.winnerKey ?? "";
		return {
			source: { layer, key: sourceKey },
			...(field !== undefined && resolution.winnerKey !== undefined && field.sourceKey !== resolution.winnerKey
				? { inheritedFrom: field.sourceKey }
				: {}),
		};
	};

	for (const [name, field] of global.fields) {
		params[name] = field.value;
		sources.set(name, {
			...attribution("global", global, name),
			shadowed: [],
			...(field.forced ? { forced: true as const } : {}),
		});
	}

	for (const [name, field] of entry.fields) {
		const globalField = global.fields.get(name);
		// A key only the global layer forces keeps the global attribution: its
		// forced value beats the unforced entry value on the wire.
		if (globalField?.forced && !field.forced) {
			const existing = sources.get(name);
			if (existing !== undefined) {
				sources.set(name, {
					...existing,
					shadowed: [{ layer: "entry", key: field.sourceKey, value: field.value }],
				});
			}
			continue;
		}
		params[name] = field.value;
		sources.set(name, {
			...attribution("entry", entry, name),
			shadowed:
				globalField !== undefined ? [{ layer: "global", key: globalField.sourceKey, value: globalField.value }] : [],
			...(field.forced ? { forced: true as const } : {}),
		});
	}

	// Forced fields can never be underscore keys - parseParameterRecord bars
	// them on the `true` path and the list path alike.
	for (const [name, field] of global.fields) {
		if (field.forced) {
			forcedParams[name] = field.value;
		}
	}
	for (const [name, field] of entry.fields) {
		if (field.forced) {
			forcedParams[name] = field.value;
		}
	}
	for (const [key, value] of Object.entries(forcedParams)) {
		params[key] = value;
	}

	const diagnostics: ParameterDiagnostic[] = [
		...entry.diagnostics.map((d) => ({ ...d, layer: "entry" as const })),
		...global.diagnostics.map((d) => ({ ...d, layer: "global" as const })),
	];

	return { params, forcedParams, sources, diagnostics };
}

export type MaxTokensSource = "forced" | "runtime" | "configured" | "declared" | "capped-default";

export interface ResolveMaxTokensInput {
	/** The merged forced parameters' max_tokens, untyped: only a number counts. Beats even runtime options. */
	readonly forcedMaxTokens?: unknown;
	/** options.modelOptions?.max_tokens, untyped: only a number counts. */
	readonly runtimeMaxTokens: unknown;
	/** The merged configured parameters' max_tokens, untyped: only a number counts. */
	readonly configuredMaxTokens: unknown;
	/** The model's advertised max output tokens. */
	readonly maxOutputTokens: number;
	/** True when the server declared the output limit ("provider" provenance); only then is it sent uncapped. */
	readonly outputLimitDeclared: boolean;
}

/**
 * The one home of the max_tokens fallback chain: forced configured value
 * (max_tokens is the one provider-owned key `_force` may mark, because it is
 * user-settable by design), runtime option, configured parameter, the
 * server-declared limit as-is, else min(cap, model max output) because a
 * defaults-derived guess must not escape the cap. chatClient.send consumes
 * the value; the inspector consumes value and source.
 */
export function resolveMaxTokens(input: ResolveMaxTokensInput): { value: number; source: MaxTokensSource } {
	if (typeof input.forcedMaxTokens === "number") {
		return { value: input.forcedMaxTokens, source: "forced" };
	}
	if (typeof input.runtimeMaxTokens === "number") {
		return { value: input.runtimeMaxTokens, source: "runtime" };
	}
	if (typeof input.configuredMaxTokens === "number") {
		return { value: input.configuredMaxTokens, source: "configured" };
	}
	if (input.outputLimitDeclared) {
		return { value: input.maxOutputTokens, source: "declared" };
	}
	return { value: Math.min(DEFAULT_MAX_TOKENS_CAP, input.maxOutputTokens), source: "capped-default" };
}

/** One row of the effective-values inspector. */
export interface EffectiveParameterRow {
	readonly name: string;
	readonly value: unknown;
	/** Whether the request body carries this key; false rows carry their reason. */
	readonly sent: boolean;
	readonly skipReason?: ParameterSkipReason | undefined;
	readonly source: ParameterSourceRef;
	/** Present when the winning record inherited the value; names the source record (== source.key). */
	readonly inheritedFrom?: string | undefined;
	readonly shadowed: readonly ShadowedParameterValue[];
	/** Present exactly when `_force` marks this key: the value beats runtime options and the picker. */
	readonly forced?: true;
}

/** The inspector's max_tokens derivation. Runtime options are unknowable ahead of a request, so no "runtime" here. */
export interface ProjectedMaxTokens {
	readonly value: number;
	readonly source: Exclude<MaxTokensSource, "runtime">;
	/** Which layer set the value; present exactly when source is "configured" or "forced". */
	readonly configuredSource?: ParameterSourceRef | undefined;
}

export interface EffectiveParametersInput {
	readonly rawModelId: string;
	readonly globalParameters: ModelParametersRecord;
	readonly entryParameters?: ModelParametersRecord | undefined;
	readonly maxOutputTokens: number;
	readonly outputLimitDeclared: boolean;
}

export interface EffectiveParametersProjection {
	/** Configured parameters matching the model, sent and not-sent alike, sorted by name. */
	readonly rows: readonly EffectiveParameterRow[];
	readonly maxTokens: ProjectedMaxTokens;
	/** See ResolvedModelParameters.diagnostics. */
	readonly diagnostics: readonly ParameterDiagnostic[];
}

/**
 * The inspector's view of one model's request, computed from the same
 * resolution the request path runs. A numeric configured max_tokens never
 * appears as a row: it becomes the request's max_tokens value, which the
 * derivation reports with its attribution. A non-numeric one stays a row,
 * not sent, because buildRequestBody drops the provider-owned key and
 * resolveMaxTokens ignores non-numbers. The equivalence property pins: every
 * row marked sent appears in buildRequestBody's output with the same value
 * (forced rows even against runtime options and the picker), every
 * non-provider-owned body key appears here as sent, and the projected
 * max_tokens equals the body's.
 */
export function projectEffectiveParameters(input: EffectiveParametersInput): EffectiveParametersProjection {
	const resolved = resolveModelParameters(input);
	const configuredMaxTokens = resolved.params.max_tokens;
	const maxTokensConfigured = typeof configuredMaxTokens === "number";

	const rows: EffectiveParameterRow[] = [];
	for (const [name, value] of Object.entries(resolved.params)) {
		if (name === "max_tokens" && maxTokensConfigured) {
			continue;
		}
		const attribution = resolved.sources.get(name);
		if (attribution === undefined) {
			continue; // Unreachable: resolveModelParameters attributes every merged key.
		}
		const skipReason = parameterSkipReason(name);
		rows.push({
			name,
			value,
			sent: skipReason === undefined,
			...(skipReason !== undefined ? { skipReason } : {}),
			source: attribution.source,
			...(attribution.inheritedFrom !== undefined ? { inheritedFrom: attribution.inheritedFrom } : {}),
			shadowed: attribution.shadowed,
			...(attribution.forced === true ? { forced: true } : {}),
		});
	}
	rows.sort((a, b) => a.name.localeCompare(b.name));

	const resolvedMax = resolveMaxTokens({
		forcedMaxTokens: resolved.forcedParams.max_tokens,
		runtimeMaxTokens: undefined,
		configuredMaxTokens,
		maxOutputTokens: input.maxOutputTokens,
		outputLimitDeclared: input.outputLimitDeclared,
	});
	const configuredSource = maxTokensConfigured ? resolved.sources.get("max_tokens")?.source : undefined;
	const maxTokens: ProjectedMaxTokens = {
		value: resolvedMax.value,
		// resolveMaxTokens never answers "runtime" for an undefined runtime option.
		source: resolvedMax.source as Exclude<MaxTokensSource, "runtime">,
		...(configuredSource !== undefined ? { configuredSource } : {}),
	};

	return { rows, maxTokens, diagnostics: resolved.diagnostics };
}
