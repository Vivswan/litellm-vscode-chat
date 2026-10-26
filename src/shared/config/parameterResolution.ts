/**
 * The single owner of the models.parameters resolution.
 * Pure, so the request path and the dashboard's effective-values inspector run the one implementation; the equivalence
 * property suite pins that against buildRequestBody.
 *
 *   Runtime options and the picker configuration -> override later, on the request path only - except for `_force`d
 *                                                   fields, which beat both (forced entry over forced global, key by
 *                                                   key)
 */

import type { ModelRecordMap } from "./modelMatcher";
import type {
	ParsedRecord,
	RecordChainResolution,
	RecordDiagnostic,
	RecordLayer,
	ResolvedChainField,
} from "./recordResolution";
import {
	canonicalFieldKey,
	FIM_TEMPLATE_DIRECTIVE,
	FORCE_DIRECTIVE,
	isFimTemplateValue,
	lintRecordMap,
	parseMarkingDirective,
	parseSharedDirectives,
	resolveRecordChain,
	wrongTypeDirectives,
} from "./recordResolution";

export type { ModelRecordMap } from "./modelMatcher";

/** The fallback max_tokens cap when nothing sets one and the output limit is a guess (guessedMaxTokensDefault). */
export const DEFAULT_MAX_TOKENS_CAP = 4096;

export type ModelParametersRecord = ModelRecordMap;

/** Extension-owned: skipped on every pass-through source and shown as not-sent; max_tokens feeds resolveMaxTokens. */
const PROVIDER_OWNED_KEYS: ReadonlySet<string> = new Set([
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
 * Underscore-prefixed keys are internal on every source (VS Code injects them into modelOptions; extension directives
 * live there in user configuration); provider-owned keys cannot be overridden.
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
 * Everything settable is forceable: of the provider-owned keys only max_tokens is settable, so it alone escapes the
 * refusal. The record editors' force checkboxes consult it too, so the editor and the wire cannot disagree about
 * forceability.
 */
export function isForceableParameter(key: string): boolean {
	return key === "max_tokens" || parameterSkipReason(key) === undefined;
}

const WRONG_TYPE_DIRECTIVES = wrongTypeDirectives("parameters");

export type ParameterConfigLayer = RecordLayer;

export interface ParameterDiagnostic extends RecordDiagnostic {
	readonly layer: ParameterConfigLayer;
}

/**
 * `fimTemplateDeclared` marks that the record SPELLED the directive at all, valid or not: an invalid spelling must
 * suppress a broader layer's template (falling back to the native prompt+suffix body, as documented) rather than
 * silently reaching past to it.
 */
export interface ParsedParameterRecord extends ParsedRecord {
	readonly fimTemplate?: string | undefined;
	readonly fimTemplateDeclared?: true;
}

/**
 * The vocabulary stays open, so every non-underscore key passes through; unknown underscore keys are silently ignored
 * for forward compatibility.
 */
export function parseParameterRecord(record: Readonly<Record<string, unknown>>): ParsedParameterRecord {
	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		// Underscore keys are directives or reserved, never fields - which also keeps a hostile own "__proto__" key
		// (JSON.parse can produce one) out of every merge below.
		if (!key.startsWith("_")) {
			fields[canonicalFieldKey("parameters", key)] = value;
		}
	}

	const force = parseMarkingDirective(record, FORCE_DIRECTIVE, fields, {
		allows: isForceableParameter,
		refusalKind: "unforceable-key",
	});
	const diagnostics: Omit<RecordDiagnostic, "recordKey">[] = [...force.diagnostics];

	let fimTemplate: string | undefined;
	let fimTemplateDeclared = false;
	if (Object.hasOwn(record, FIM_TEMPLATE_DIRECTIVE)) {
		fimTemplateDeclared = true;
		const value = record[FIM_TEMPLATE_DIRECTIVE];
		if (isFimTemplateValue(value)) {
			fimTemplate = value;
		} else {
			diagnostics.push({ kind: "invalid-directive", key: FIM_TEMPLATE_DIRECTIVE });
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
		forced: force.marked,
		fallback: new Set(),
		inheritFrom: shared.inheritFrom,
		...(fimTemplate === undefined ? {} : { fimTemplate }),
		...(fimTemplateDeclared ? { fimTemplateDeclared: true as const } : {}),
		diagnostics,
	};
}

export function resolveParameterLayer(rawModelId: string, records: ModelRecordMap): RecordChainResolution {
	return resolveRecordChain(rawModelId, records, parseParameterRecord);
}

export function lintParameterRecords(records: ModelRecordMap): readonly RecordDiagnostic[] {
	return lintRecordMap(records, parseParameterRecord);
}

/**
 * An entry-layer ref always names the declared entry that owns the record (stamped by the projection), so a consumer
 * can never pair an entry value with the wrong label.
 */
export type ParameterSourceRef =
	| { readonly layer: "global"; readonly key: string }
	| { readonly layer: "entry"; readonly key: string; readonly entryLabel: string };

/** A lower-precedence layer's value for a key some higher layer won. */
export type ShadowedParameterValue = ParameterSourceRef & { readonly value: unknown };

/** Where a value came from; `key` is the record whose literal field carries it (the place to edit it). */
interface ResolvedSourceRef {
	readonly layer: ParameterConfigLayer;
	readonly key: string;
}

/**
 * A merged key's attribution. `inheritedBy` is present exactly when the winning layer's record did not write the field
 * itself: it inherited it from source.key, and this names that winning record (never equal to source.key by
 * construction). `forced` is present exactly when the value's source record `_force`-marks this key.
 */
interface ResolvedParameterSource {
	readonly source: ResolvedSourceRef;
	readonly inheritedBy?: string;
	readonly shadowed: readonly (ResolvedSourceRef & { readonly value: unknown })[];
	readonly forced?: true;
}

export interface ResolveModelParametersInput {
	/** The model's own raw ID, matched against the record keys. */
	readonly rawModelId: string;

	/** The models.parameters setting as the request path reads it (normalizeModelParameters output). */
	readonly globalParameters: ModelParametersRecord;

	/** The declared server entry's own record, when the request routes through one. */
	readonly entryParameters?: ModelParametersRecord | undefined;
}

/**
 * The resolved parameters of one model.
 *
 * `params` is each layer's resolved chain view merged entry over global key by key, then the forced winners on top (a
 * globally forced key beats an unforced entry value); underscore keys never appear.
 *
 * `forcedParams` is always a subset of `params` (same values); buildRequestBody re-applies them ABOVE runtime options
 * and the picker configuration.
 *
 * `fimTemplate` is the winning `_fim_template`, entry layer over global: a directive belongs to a layer's WINNING
 * record only, never inherited (the capability side's `_openrouter_model` rule). It is the ONE parameters-record value
 * the /completions path reads; the chat path ignores it. The parse captures only usable templates, so it is valid by
 * construction.
 */
export interface ResolvedModelParameters {
	/** The effective configured merge. */
	readonly params: Record<string, unknown>;

	/** The forced values, entry over global key by key. */
	readonly forcedParams: Readonly<Record<string, unknown>>;

	/** Attribution per merged key; every own key of `params` has an entry. */
	readonly sources: ReadonlyMap<string, ResolvedParameterSource>;

	/** The winning `_fim_template`, when a winning record spelled a usable one. */
	readonly fimTemplate?: string | undefined;

	/** Matcher, directive, and `_force` problems in the matching records, attributed to their layer. */
	readonly diagnostics: readonly ParameterDiagnostic[];
}

function layerAttribution(
	layer: ParameterConfigLayer,
	resolution: RecordChainResolution,
	name: string
): { source: ResolvedSourceRef; inheritedBy?: string } {
	const field = resolution.fields.get(name);
	const sourceKey = field?.sourceKey ?? resolution.winnerKey ?? "";

	return {
		source: { layer, key: sourceKey },
		...(field !== undefined && resolution.winnerKey !== undefined && field.sourceKey !== resolution.winnerKey
			? { inheritedBy: resolution.winnerKey }
			: {}),
	};
}

function forcedMark(field: ResolvedChainField): { forced: true } | Record<string, never> {
	return field.forced ? { forced: true } : {};
}

/**
 * Each layer's resolved chain view merged entry over global key by key, with every merged key's attribution. A key
 * only the global layer forces keeps the global attribution: its forced value beats the unforced entry value on the
 * wire.
 */
function mergeParameterLayers(
	global: RecordChainResolution,
	entry: RecordChainResolution
): { params: Record<string, unknown>; sources: Map<string, ResolvedParameterSource> } {
	const params: Record<string, unknown> = {};
	const sources = new Map<string, ResolvedParameterSource>();

	for (const [name, field] of global.fields) {
		params[name] = field.value;
		sources.set(name, { ...layerAttribution("global", global, name), shadowed: [], ...forcedMark(field) });
	}

	for (const [name, field] of entry.fields) {
		const globalField = global.fields.get(name);
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
			...layerAttribution("entry", entry, name),
			shadowed:
				globalField === undefined ? [] : [{ layer: "global", key: globalField.sourceKey, value: globalField.value }],
			...forcedMark(field),
		});
	}

	return { params, sources };
}

/** The forced values, entry over global key by key; never underscore keys, which parseParameterRecord bars. */
function forcedParamsOf(global: RecordChainResolution, entry: RecordChainResolution): Record<string, unknown> {
	const forced: Record<string, unknown> = {};
	for (const [name, field] of global.fields) {
		if (field.forced) {
			forced[name] = field.value;
		}
	}

	for (const [name, field] of entry.fields) {
		if (field.forced) {
			forced[name] = field.value;
		}
	}

	return forced;
}

export function resolveModelParameters(input: ResolveModelParametersInput): ResolvedModelParameters {
	const { rawModelId, globalParameters, entryParameters } = input;
	const global = resolveParameterLayer(rawModelId, globalParameters);
	const entry = resolveParameterLayer(rawModelId, entryParameters ?? {});

	const { params, sources } = mergeParameterLayers(global, entry);
	const forcedParams = forcedParamsOf(global, entry);
	for (const [key, value] of Object.entries(forcedParams)) {
		params[key] = value;
	}

	const diagnostics: ParameterDiagnostic[] = [
		...entry.diagnostics.map((d) => ({ ...d, layer: "entry" as const })),
		...global.diagnostics.map((d) => ({ ...d, layer: "global" as const })),
	];

	const entryWinner = entry.winner as ParsedParameterRecord | undefined;
	const globalWinner = global.winner as ParsedParameterRecord | undefined;
	// An entry winner that SPELLED the directive owns the outcome outright: a valid template applies, an invalid one
	// suppresses the global layer's (the documented invalid-means-native rule).
	const fimTemplate = entryWinner?.fimTemplateDeclared === true ? entryWinner.fimTemplate : globalWinner?.fimTemplate;

	return {
		params,
		forcedParams,
		sources,
		...(fimTemplate === undefined ? {} : { fimTemplate }),
		diagnostics,
	};
}

export type MaxTokensSource = "forced" | "runtime" | "configured" | "limit" | "capped";

/** A model's output limits; `defaultMaxTokens` is LiteLLMModelMetadataBase.defaultMaxTokens (groupModels.ts). */
export interface OutputLimits {
	readonly maxOutputTokens: number;
	readonly defaultMaxTokens: number;
}

export interface ResolveMaxTokensInput extends OutputLimits {
	/** The merged forced parameters' max_tokens, untyped: only a number counts. Beats even runtime options. */
	readonly forcedMaxTokens?: unknown;

	/** options.modelOptions?.max_tokens, untyped: only a number counts. */
	readonly runtimeMaxTokens: unknown;

	/** The merged configured parameters' max_tokens, untyped: only a number counts. */
	readonly configuredMaxTokens: unknown;
}

/**
 * The one home of the max_tokens fallback chain. The fallback is the decided default as-is; the two source names only
 * tell the inspector whether that default is the advertised limit itself or the cap under a guessed one.
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
	return {
		value: input.defaultMaxTokens,
		source: input.defaultMaxTokens < input.maxOutputTokens ? "capped" : "limit",
	};
}

/**
 * One row of the parameter inspector.
 *
 * `sent` says whether the request body carries the key; a false row carries its `skipReason`.
 *
 * `inheritedBy` is present when the winning record inherited the value from source.key, and names that winning record.
 *
 * `forced` is present exactly when `_force` marks the key, whose value then beats runtime options and the picker.
 */
export interface EffectiveParameterRow {
	readonly name: string;
	readonly value: unknown;
	readonly sent: boolean;
	readonly skipReason?: ParameterSkipReason | undefined;
	readonly source: ParameterSourceRef;
	readonly inheritedBy?: string | undefined;
	readonly shadowed: readonly ShadowedParameterValue[];
	readonly forced?: true;
}

/**
 * The inspector's max_tokens derivation. Runtime options are unknowable ahead of a request, so no "runtime" here.
 * `configuredSource` is the layer that set the value, present exactly when source is "configured" or "forced".
 */
export interface ProjectedMaxTokens {
	readonly value: number;
	readonly source: Exclude<MaxTokensSource, "runtime">;
	readonly configuredSource?: ParameterSourceRef | undefined;
}

/**
 * What the inspector's projection reads; `entry` is the declared entry's record together with its label, since
 * entry-layer refs carry the label and the two travel as one.
 */
export interface EffectiveParametersInput extends OutputLimits {
	readonly rawModelId: string;
	readonly globalParameters: ModelParametersRecord;
	readonly entry?: { readonly label: string; readonly parameters: ModelParametersRecord } | undefined;
}

/** The inspector's view; `rows` are the configured parameters matching the model, sent and not-sent alike, by name. */
export interface EffectiveParametersProjection {
	readonly rows: readonly EffectiveParameterRow[];
	readonly maxTokens: ProjectedMaxTokens;
	readonly diagnostics: readonly ParameterDiagnostic[];
}

/**
 * The NAIVE side of the seed-pinned equivalence property (src/test/shared/config/parameterResolution.property.test.ts),
 * not dead code.
 */
export function projectEffectiveParameters(input: EffectiveParametersInput): EffectiveParametersProjection {
	return projectResolvedParameters(
		resolveModelParameters({
			rawModelId: input.rawModelId,
			globalParameters: input.globalParameters,
			entryParameters: input.entry?.parameters,
		}),
		{
			maxOutputTokens: input.maxOutputTokens,
			defaultMaxTokens: input.defaultMaxTokens,
		},
		input.entry?.label
	);
}

/**
 * The projection over an already-resolved merge: what the params inspector renders when the resolution comes from the
 * shared flat table (the SAME cache requests read).
 *
 * `entryLabel` must be present whenever the resolution used entry parameters; it is stamped onto every entry-layer ref.
 *   projectEffectiveParameters delegates here -> the two paths cannot diverge
 */
export function projectResolvedParameters(
	resolved: ResolvedModelParameters,
	limits: OutputLimits,
	entryLabel?: string
): EffectiveParametersProjection {
	const sourceRef = (ref: ResolvedSourceRef): ParameterSourceRef => {
		if (ref.layer === "global") {
			return { layer: "global", key: ref.key };
		}
		if (entryLabel === undefined) {
			// Unreachable through the sanctioned callers: entry parameters and their entry's label travel together
			// (EntryParametersResolution).
			throw new Error("entry-layer parameter resolved without an entry label");
		}
		return { layer: "entry", key: ref.key, entryLabel };
	};
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
			...(skipReason === undefined ? {} : { skipReason }),
			source: sourceRef(attribution.source),
			...(attribution.inheritedBy === undefined ? {} : { inheritedBy: attribution.inheritedBy }),
			shadowed: attribution.shadowed.map((shadow) => ({ ...sourceRef(shadow), value: shadow.value })),
			...(attribution.forced === true ? { forced: true } : {}),
		});
	}
	rows.sort((a, b) => a.name.localeCompare(b.name));

	const resolvedMax = resolveMaxTokens({
		forcedMaxTokens: resolved.forcedParams.max_tokens,
		runtimeMaxTokens: undefined,
		configuredMaxTokens,
		...limits,
	});
	const configuredSource = maxTokensConfigured ? resolved.sources.get("max_tokens")?.source : undefined;
	const maxTokens: ProjectedMaxTokens = {
		value: resolvedMax.value,
		// resolveMaxTokens never answers "runtime" for an undefined runtime option.
		source: resolvedMax.source as Exclude<MaxTokensSource, "runtime">,
		...(configuredSource === undefined ? {} : { configuredSource: sourceRef(configuredSource) }),
	};

	return { rows, maxTokens, diagnostics: resolved.diagnostics };
}
