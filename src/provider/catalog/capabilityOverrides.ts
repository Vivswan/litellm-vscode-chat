/**
 * The attach-side application of modelCapabilities: registration and the discovery cache stay config-free, and these
 * functions decorate the models a refresh actually serves. Both rebuild dependent artifacts coherently from the
 * effective fields (token limits, capability flags, the reasoning control) instead of hand-patching, and both are
 * idempotent: the resolver reads the untouched serverDeclared baseline riding each model, never previously patched
 * values.
 */

import type {
	CapabilityCatalogLookup,
	CapabilityDiagnostic,
	CapabilityLevel,
	EffectiveCapabilities,
	EffectiveCapabilityFields,
	ModelCapabilitiesRecord,
} from "../../shared/config/capabilityResolution";
import {
	CAPABILITY_FIELDS,
	CAPABILITY_LEVEL_ORDER,
	capabilityField,
	consumedFieldsOfKind,
} from "../../shared/config/capabilityResolution";
import type { ModelResolutionTable } from "../../shared/config/resolutionTable";
import { getCurrencySymbol } from "../../shared/config/settings";
import type { ServerConfig } from "../../shared/servers";
import type { PreAttachModelInfo } from "./groupModels";
import { buildExposedModelId } from "./modelCatalog";
import { effectiveReasoningLevels, reasoningEffortPickerValues, reasoningEffortSchema } from "./modelConfiguration";
import type { ModelPricing } from "./registration";
import { COMMON_MODEL_FIELDS, pricingFromCosts, serverDisplayContext } from "./registration";
import type { DeclaredPerTokenCosts } from "./schemas";

export interface CapabilityOverrideOptions {
	/** The modelCapabilities setting as normalizeModelCapabilities returns it. */
	readonly globalCapabilities: ModelCapabilitiesRecord;
	/** The matched declared entry's own capability records, when the served server has one. */
	readonly entryCapabilities?: ModelCapabilitiesRecord | undefined;
	/**
	 * The matched declared entry's discovery.declared model IDs: exact IDs to register when discovery does not list
	 * them, inert when it does.
	 */
	readonly entryDeclaredModels?: readonly string[] | undefined;
	readonly catalog: CapabilityCatalogLookup;
	/** The provider-shared flat resolution table; every resolve here goes through it. */
	readonly resolution: ModelResolutionTable;
	/** Classification-only logging (record keys and field names are user configuration, never response text). */
	readonly log: (message: string, data?: unknown) => void;
	/**
	 * The advisory sink for informational notes (output channel only, never the issue-report buffer). Applying an open
	 * field as-is is a feature and recurs on every serve pass, so it must not consume the issue reporter's small
	 * ring-buffer budget; real record problems go through `log`.
	 */
	readonly logAdvisory: (message: string, data?: unknown) => void;
}

const LEVEL_TRIGGERS_REBUILD: Readonly<Record<CapabilityLevel, boolean>> = {
	entry: true,
	global: true,
	directive: true,
	server: false,
	"entry-fallback": true,
	"global-fallback": true,
	catalog: true,
	derived: false,
	floor: false,
};

const COST_FIELDS = consumedFieldsOfKind("cost");

const REGISTRATION_CONSUMED_FIELDS: readonly string[] = [
	...Object.keys(CAPABILITY_FIELDS),
	...COST_FIELDS,
	"supports_prompt_caching",
	"supported_openai_params",
	"reasoning_effort_levels",
];

/**
 * Rebuild the picker's pricing block from the effective cost fields, through the SAME converter registration used. A
 * raw zero pair here is user-written on at least one side (the server's 0/0 no-pricing stamp died at discovery ingest
 * and never enters the walk), and pricingFromCosts prices it as genuinely free on purpose.
 */
export function pricingFieldsFromEffective(fields: EffectiveCapabilityFields, currencySymbol: string): ModelPricing {
	const costs: DeclaredPerTokenCosts = {};
	for (const name of COST_FIELDS) {
		const value = capabilityField(fields, name)?.value;
		if (typeof value === "number") {
			costs[name] = value;
		}
	}
	return pricingFromCosts(costs, currencySymbol);
}

const LEVEL_RANK: Readonly<Record<CapabilityLevel, number>> = Object.fromEntries(
	CAPABILITY_LEVEL_ORDER.map((level, rank) => [level, rank])
) as Record<CapabilityLevel, number>;

/**
 * A winning params list WITHOUT reasoning_effort demotes, which is how a user turns the control off.
 * The flag's floor level is the walk's backstop `false`, not an explicit demotion, so it counts as no signal.
 */
export function reasoningGate(fields: EffectiveCapabilityFields): boolean {
	const flag = fields.supports_reasoning;
	const params = capabilityField(fields, "supported_openai_params");
	if (params === undefined) {
		return flag.value;
	}
	const paramsListReasoning = Array.isArray(params.value) && params.value.includes("reasoning_effort");
	if (flag.level === "floor") {
		return paramsListReasoning;
	}
	return LEVEL_RANK[flag.level] <= LEVEL_RANK[params.level] ? flag.value : paramsListReasoning;
}

function promptCachingFrom(fields: EffectiveCapabilityFields): boolean {
	return capabilityField(fields, "supports_prompt_caching")?.value === true;
}

/**
 * The enum comparison goes through the same builder the schema uses, so a levels change can never freeze a stale menu
 * behind the fast path.
 */
function advertisesReasoningMenu(
	schema: PreAttachModelInfo["configurationSchema"],
	fields: EffectiveCapabilityFields
): boolean {
	if (!reasoningGate(fields)) {
		return schema === undefined;
	}
	const advertised: unknown = schema?.properties?.reasoningEffort?.enum;
	const expected = reasoningEffortPickerValues(effectiveReasoningLevels(fields));
	return (
		Array.isArray(advertised) &&
		advertised.length === expected.length &&
		expected.every((value, index) => advertised[index] === value)
	);
}

/**
 * One log line per distinct record diagnostic per pass, so a record shared by many models logs once; keys and field
 * names are user configuration, never response-derived text (values never log). An unrecognized key is informational -
 * the open vocabulary applies it as-is - while every other kind names a real problem the resolution ignored.
 */
function diagnosticLogger(
	opts: Pick<CapabilityOverrideOptions, "log" | "logAdvisory">
): (diagnostics: readonly CapabilityDiagnostic[]) => void {
	const seen = new Set<string>();
	return (diagnostics) => {
		for (const diagnostic of diagnostics) {
			const key = JSON.stringify([diagnostic.kind, diagnostic.layer, diagnostic.recordKey, diagnostic.key]);
			if (!seen.has(key)) {
				seen.add(key);
				if (diagnostic.kind === "unrecognized-key") {
					opts.logAdvisory("Applying an unrecognized capability field as-is", diagnostic);
				} else {
					opts.log("Ignoring a modelCapabilities record problem", diagnostic);
				}
			}
		}
	};
}

const MODEL_PRICING_KEYS = Object.keys({
	inputCost: true,
	outputCost: true,
	cacheCost: true,
	cacheWriteCost: true,
	longContextInputCost: true,
	longContextOutputCost: true,
	longContextCacheCost: true,
	longContextCacheWriteCost: true,
	priceCategory: true,
	pricing: true,
} satisfies Record<keyof ModelPricing, true>) as readonly (keyof ModelPricing)[];

function withoutPricing<T extends ModelPricing>(info: T): Omit<T, keyof ModelPricing> {
	const rest: Record<string, unknown> = { ...info };
	for (const key of MODEL_PRICING_KEYS) {
		delete rest[key];
	}
	return rest as unknown as Omit<T, keyof ModelPricing>;
}

function advertisesPricing(info: ModelPricing, expected: ModelPricing): boolean {
	return MODEL_PRICING_KEYS.every((key) => info[key] === expected[key]);
}

/**
 * The fast path must verify this rather than assume it: the status window's stale-served copies were rebuilt under an
 * EARLIER configuration, so after an override is removed mid-outage the stored values still carry the old override -
 * identity would freeze it in place, and the verified rebuild heals it instead. A field missed here would either
 * rebuild forever or freeze a stale value, so every rebuilt artifact has its clause.
 */
function advertisesEffective(
	info: PreAttachModelInfo,
	effective: EffectiveCapabilities,
	currencySymbol: string
): boolean {
	const fields = effective.fields;
	return (
		info.maxInputTokens === fields.max_input_tokens.value &&
		info.maxOutputTokens === fields.max_output_tokens.value &&
		Boolean(info.capabilities?.toolCalling) === fields.supports_function_calling.value &&
		Boolean(info.capabilities?.imageInput) === fields.supports_vision.value &&
		(info.litellm.supportsAudioInput === true) === fields.supports_audio_input.value &&
		info.litellm.supportsPromptCaching === promptCachingFrom(fields) &&
		info.litellm.outputLimitSource === effective.outputLimitSource &&
		advertisesReasoningMenu(info.configurationSchema, fields) &&
		advertisesPricing(info, pricingFieldsFromEffective(fields, currencySymbol))
	);
}

/** Pricing is re-derived from the effective cost fields, which the walk never fills from the catalog. */
export function applyCapabilityOverrides(
	infos: readonly PreAttachModelInfo[],
	server: ServerConfig,
	opts: CapabilityOverrideOptions
): readonly PreAttachModelInfo[] {
	let changed = false;
	const logDiagnostics = diagnosticLogger(opts);
	// Read once per pass: every rebuilt pricing label carries the same symbol, and a symbol change since registration
	// fails advertisesPricing's exact compare, so the verified fast path itself heals stale labels here.
	const currencySymbol = getCurrencySymbol();
	const out = infos.map((info) => {
		const rawModelId = info.litellm.rawModelId;
		const effective = opts.resolution.resolveCapabilities(server.id, rawModelId, {
			globalCapabilities: opts.globalCapabilities,
			entryCapabilities: opts.entryCapabilities,
			catalog: opts.catalog,
			serverDeclared: info.litellm.serverDeclared,
		});
		logDiagnostics(effective.diagnostics);
		const fields = effective.fields;
		const needsRebuild = REGISTRATION_CONSUMED_FIELDS.some((name) => {
			const field = capabilityField(fields, name);
			return field !== undefined && LEVEL_TRIGGERS_REBUILD[field.level];
		});
		if (!needsRebuild && effective.directive === undefined && advertisesEffective(info, effective, currencySymbol)) {
			return info;
		}
		changed = true;
		// The schema is removed on demotion by destructuring it away, then rebuilt from the effective level list only
		// when the gate holds - a fresh build every rebuild, because the menu's contents are effective fields too. The
		// pricing block is stripped the same way and re-derived from the effective cost fields.
		//   a price the walk no longer justifies -> never survives a rebuild
		const { configurationSchema: _replaced, ...rest } = info;
		const base = withoutPricing(rest);
		return {
			...base,
			maxInputTokens: fields.max_input_tokens.value,
			maxOutputTokens: fields.max_output_tokens.value,
			capabilities: {
				...info.capabilities,
				toolCalling: fields.supports_function_calling.value,
				imageInput: fields.supports_vision.value,
			},
			...pricingFieldsFromEffective(fields, currencySymbol),
			...(reasoningGate(fields)
				? { configurationSchema: reasoningEffortSchema(effectiveReasoningLevels(fields)) }
				: {}),
			litellm: {
				...info.litellm,
				supportsPromptCaching: promptCachingFrom(fields),
				outputLimitSource: effective.outputLimitSource,
				supportsAudioInput: fields.supports_audio_input.value,
			},
		} satisfies PreAttachModelInfo;
	});
	return changed ? out : infos;
}

/**
 * Declared models are rebuilt every serve and never persisted, so removing a declared ID takes effect on
 * the next serve, even mid-outage. Inertness is judged against the DISCOVERED raw IDs, not the registered
 * ones, since registration.ts may emit only synthetic variants (`foo:cheapest`) of a discovered `foo`.
 */
export function synthesizeDeclaredModels(
	discoveredRawIds: ReadonlySet<string>,
	reservedExposedIds: ReadonlySet<string>,
	server: ServerConfig,
	serverCount: number,
	opts: CapabilityOverrideOptions
): readonly PreAttachModelInfo[] {
	const logDiagnostics = diagnosticLogger(opts);
	// Same one-read-per-pass rule as applyCapabilityOverrides.
	const currencySymbol = getCurrencySymbol();
	const specs = [...new Set(opts.entryDeclaredModels ?? [])].map((rawId) => ({ rawId, layer: "entry" as const }));
	const display = serverDisplayContext(server, serverCount);
	const infos: PreAttachModelInfo[] = [];
	for (const spec of specs) {
		if (discoveredRawIds.has(spec.rawId)) {
			continue;
		}
		const exposedId = buildExposedModelId(spec.rawId, server.id, serverCount);
		if (reservedExposedIds.has(exposedId)) {
			opts.log("Suppressing a declared model: the declared ID collides with a registered model ID", {
				modelId: spec.rawId,
				layer: spec.layer,
			});
			continue;
		}
		const effective = opts.resolution.resolveCapabilities(server.id, spec.rawId, {
			globalCapabilities: opts.globalCapabilities,
			entryCapabilities: opts.entryCapabilities,
			catalog: opts.catalog,
			serverDeclared: { kind: "declared" },
		});
		// Field problems in a declared model's records usually have no discovered model to surface through, so this
		// resolve is their one log seam.
		logDiagnostics(effective.diagnostics);
		const fields = effective.fields;
		infos.push({
			...COMMON_MODEL_FIELDS,
			detail: display.detail,
			id: exposedId,
			name: `${display.namePrefix}${spec.rawId}`,
			tooltip: display.tooltip,
			family: "litellm",
			maxInputTokens: fields.max_input_tokens.value,
			maxOutputTokens: fields.max_output_tokens.value,
			capabilities: {
				toolCalling: fields.supports_function_calling.value,
				imageInput: fields.supports_vision.value,
			},
			// The same effective-field reads as applyCapabilityOverrides, over the declared baseline (no server level
			// at all): a user cost record prices a declared model, and the caching and reasoning gates apply alike.
			...pricingFieldsFromEffective(fields, currencySymbol),
			...(reasoningGate(fields)
				? { configurationSchema: reasoningEffortSchema(effectiveReasoningLevels(fields)) }
				: {}),
			litellm: {
				rawModelId: spec.rawId,
				supportsPromptCaching: promptCachingFrom(fields),
				outputLimitSource: effective.outputLimitSource,
				supportsAudioInput: fields.supports_audio_input.value,
				declared: true,
				serverDeclared: { kind: "declared" },
			},
		} satisfies PreAttachModelInfo);
	}
	return infos;
}
