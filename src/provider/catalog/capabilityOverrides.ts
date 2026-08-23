/**
 * The attach-side application of modelCapabilities: registration and the
 * discovery cache stay config-free, and these functions decorate the models a
 * refresh actually serves. Both rebuild dependent artifacts coherently from
 * the effective fields (token limits, capability flags, the reasoning control)
 * instead of hand-patching, and both are idempotent: the resolver reads the
 * untouched serverDeclared baseline riding each model, never previously
 * patched values.
 */

import type {
	CapabilityCatalogLookup,
	CapabilityDiagnostic,
	CapabilityLevel,
	EffectiveCapabilities,
	EffectiveCapabilityFields,
	ModelCapabilitiesRecord,
} from "../../shared/config/capabilityResolution";
import { CAPABILITY_FIELDS, CAPABILITY_LEVEL_ORDER, capabilityField } from "../../shared/config/capabilityResolution";
import type { ModelResolutionTable } from "../../shared/config/resolutionTable";
import { getCurrencySymbol } from "../../shared/config/settings";
import type { ServerConfig } from "../../shared/servers";
import type { PreAttachModelInfo } from "./groupModels";
import type { PerTokenCosts } from "./modelCatalog";
import { buildExposedModelId } from "./modelCatalog";
import { effectiveReasoningLevels, reasoningEffortPickerValues, reasoningEffortSchema } from "./modelConfiguration";
import type { ModelPricing } from "./registration";
import { COMMON_MODEL_FIELDS, pricingFromCosts, serverDisplayContext } from "./registration";

/** The configuration one serve pass resolves against; the provider assembles it from its injected seams. */
export interface CapabilityOverrideOptions {
	/** The modelCapabilities setting as normalizeModelCapabilities returns it. */
	readonly globalCapabilities: ModelCapabilitiesRecord;
	/** The matched declared entry's own capability records, when the served server has one. */
	readonly entryCapabilities?: ModelCapabilitiesRecord | undefined;
	/**
	 * The matched declared entry's discovery.declared model IDs: exact IDs to
	 * register when discovery does not list them, inert when it does.
	 */
	readonly entryDeclaredModels?: readonly string[] | undefined;
	readonly catalog: CapabilityCatalogLookup;
	/** The provider-shared flat resolution table; every resolve here goes through it. */
	readonly resolution: ModelResolutionTable;
	/** Classification-only logging (record keys and field names are user configuration, never response text). */
	readonly log: (message: string, data?: unknown) => void;
	/**
	 * The advisory sink for informational notes (output channel only, never the
	 * issue-report buffer). Applying an open field as-is is a feature and
	 * recurs on every serve pass, so it must not consume the issue reporter's
	 * small ring-buffer budget; real record problems go through `log`.
	 */
	readonly logAdvisory: (message: string, data?: unknown) => void;
}

/**
 * Whether a field resolved at this level means user configuration or the
 * catalog decided it, so the entry must rebuild instead of taking the
 * identity fast path. Total over CapabilityLevel on purpose: a level added
 * to the walk fails compilation here instead of silently skipping rebuilds.
 */
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

/** The 8 cost fields under their wire names, exhaustive over PerTokenCosts by the satisfies check. */
const COST_CAPABILITY_FIELDS = Object.keys({
	input_cost_per_token: true,
	output_cost_per_token: true,
	cache_read_input_token_cost: true,
	cache_creation_input_token_cost: true,
	long_context_input_cost_per_token: true,
	long_context_output_cost_per_token: true,
	long_context_cache_read_input_token_cost: true,
	long_context_cache_creation_input_token_cost: true,
} satisfies Record<keyof PerTokenCosts, true>) as readonly (keyof PerTokenCosts)[];

/**
 * Every capability field whose effective value feeds a registered artifact:
 * the typed core, the 8 cost fields, supports_prompt_caching,
 * supported_openai_params, and reasoning_effort_levels. The rebuild reads
 * exactly these, so only they leave the identity fast path: an extras-only
 * configuration leaves registered models alone.
 */
const REGISTRATION_CONSUMED_FIELDS: readonly string[] = [
	...Object.keys(CAPABILITY_FIELDS),
	...COST_CAPABILITY_FIELDS,
	"supports_prompt_caching",
	"supported_openai_params",
	"reasoning_effort_levels",
];

/**
 * Rebuild the picker's pricing block from the effective cost fields, through
 * the SAME converter registration used, so a rebuild over untouched server
 * costs re-derives byte-identical pricing - which is what lets
 * advertisesEffective compare exactly and keeps rebuilds idempotent. A raw
 * zero pair here is user-written on at least one side (the server's 0/0
 * no-pricing stamp died at discovery ingest and never enters the walk), and
 * pricingFromCosts prices it as genuinely free on purpose.
 */
export function pricingFieldsFromEffective(fields: EffectiveCapabilityFields, currencySymbol: string): ModelPricing {
	const costs: { -readonly [K in keyof PerTokenCosts]?: number } = {};
	for (const name of COST_CAPABILITY_FIELDS) {
		const value = capabilityField(fields, name)?.value;
		if (typeof value === "number") {
			costs[name] = value;
		}
	}
	return pricingFromCosts(costs, currencySymbol);
}

/** Walk order as ranks for reasoningGate's which-field-wins comparison, derived from the walk's own order declaration. */
const LEVEL_RANK: Readonly<Record<CapabilityLevel, number>> = Object.fromEntries(
	CAPABILITY_LEVEL_ORDER.map((level, rank) => [level, rank])
) as Record<CapabilityLevel, number>;

/**
 * Whether a model gets the reasoning-effort control, from the effective
 * fields. Two fields carry a signal - the supports_reasoning flag and
 * reasoning_effort's membership in supported_openai_params - and the one that
 * resolved at the higher-precedence level decides; a tie goes to the flag, so
 * a user's explicit supports_reasoning beats their own params list in one
 * record. The flag's floor level counts as no-signal, not a demotion: it is
 * the walk's backstop `false`, so a user-set params list at any level outranks
 * it. A winning params list WITHOUT reasoning_effort demotes, which is how a
 * user turns the control off.
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

/** The effective prompt-caching answer: the resolved flag, or false when no level carries one. */
function promptCachingFrom(fields: EffectiveCapabilityFields): boolean {
	return capabilityField(fields, "supports_prompt_caching")?.value === true;
}

/**
 * Whether the entry's stored reasoning control matches the walk: no schema
 * exactly when the gate is off, and a schema whose enum is the one the
 * effective level list produces when it is on. The enum comparison goes
 * through the same builder the schema uses, so a levels change can never
 * freeze a stale menu behind the fast path.
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
 * One log line per distinct record diagnostic per pass, so a record shared by
 * many models logs once; keys and field names are user configuration, never
 * response-derived text (values never log). An unrecognized key is
 * informational - the open vocabulary applies it as-is - while every other
 * kind names a real problem the resolution ignored.
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
				// The advisory sink keeps the recurring open-field note out of the
				// issue reporter's ring-buffer budget; problems keep the budget.
				if (diagnostic.kind === "unrecognized-key") {
					opts.logAdvisory("Applying an unrecognized capability field as-is", diagnostic);
				} else {
					opts.log("Ignoring a modelCapabilities record problem", diagnostic);
				}
			}
		}
	};
}

/** Every pricing field a rebuild strips before re-deriving, exhaustive over ModelPricing by the satisfies check. */
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

/** Strip every ModelPricing key; the rebuild re-derives them from the effective fields. */
function withoutPricing<T extends ModelPricing>(info: T): Omit<T, keyof ModelPricing> {
	const rest: Record<string, unknown> = { ...info };
	for (const key of MODEL_PRICING_KEYS) {
		delete rest[key];
	}
	return rest as unknown as Omit<T, keyof ModelPricing>;
}

/** Whether the entry's stored pricing block equals the rebuilt one, key by key (absent compares equal to undefined). */
function advertisesPricing(info: ModelPricing, expected: ModelPricing): boolean {
	return MODEL_PRICING_KEYS.every((key) => info[key] === expected[key]);
}

/**
 * Whether the entry already advertises exactly the resolver's effective
 * fields. The fast path must verify this rather than assume it: the status
 * window's stale-served copies were rebuilt under an EARLIER configuration,
 * so after an override is removed mid-outage the stored values still carry the
 * old override - identity would freeze it in place, and the verified rebuild
 * heals it instead. A field missed here would either rebuild forever or freeze
 * a stale value, so every rebuilt artifact has its clause.
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

/**
 * Apply the capability overrides to one refresh's registered models. Models
 * nothing matches are returned by object identity (and an untouched pass
 * returns the input array itself), so the common no-configuration case costs
 * no copies. A matched model is rebuilt coherently from the effective fields:
 * token limits, the toolCalling/imageInput capabilities, the audio and
 * prompt-caching gates, the reasoning configurationSchema, the pricing block,
 * and the outputLimitSource provenance ("user" for any override level).
 * Pricing is never catalog-sourced: every price a served model carries is
 * re-derived here from the effective cost fields, so nothing but the server's
 * report and the user's records can put a number on a model.
 */
export function applyCapabilityOverrides(
	infos: readonly PreAttachModelInfo[],
	server: ServerConfig,
	opts: CapabilityOverrideOptions
): readonly PreAttachModelInfo[] {
	let changed = false;
	const logDiagnostics = diagnosticLogger(opts);
	// Read once per pass: every rebuilt pricing label carries the same symbol,
	// and a symbol change since registration fails advertisesPricing's exact
	// compare, so the verified fast path itself heals stale labels here.
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
		// The rebuild reads the registration-consumed fields only, so only they
		// gate the fast path.
		const needsRebuild = REGISTRATION_CONSUMED_FIELDS.some((name) => {
			const field = capabilityField(fields, name);
			return field !== undefined && LEVEL_TRIGGERS_REBUILD[field.level];
		});
		if (!needsRebuild && effective.directive === undefined && advertisesEffective(info, effective, currencySymbol)) {
			return info;
		}
		changed = true;
		// The schema is removed on demotion by destructuring it away, then
		// rebuilt from the effective level list only when the gate holds - a
		// fresh build every rebuild, because the menu's contents are effective
		// fields too. The pricing block is stripped the same way and re-derived
		// from the effective cost fields, so untouched server costs come back
		// byte-identical and a price the walk no longer justifies never survives
		// a rebuild.
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
 * Build the declared models the current configuration creates on one server.
 * A declared ID that discovery listed is inert - judged against the DISCOVERED
 * raw-ID set, not the registered one, because registration may emit only
 * synthetic variants (`foo:cheapest`) for a discovered `foo`. A declared ID
 * whose exposed form collides with an ID registration is about to emit is
 * suppressed with a logged warning: never two models with one exposed ID.
 * Declared models are always rebuilt from the configuration at hand and never
 * persisted, so removing a declared ID takes effect on the next serve even
 * mid-outage.
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
	// Exact IDs, inert when discovered, config-rebuilt every serve; a
	// duplicated ID synthesizes once.
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
		// Field problems in a declared model's records usually have no discovered
		// model to surface through, so this resolve is their one log seam.
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
			// The same effective-field reads as applyCapabilityOverrides, over the
			// declared baseline (no server level at all): a user cost record prices
			// a declared model, and the caching and reasoning gates apply alike.
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
