/**
 * The attach-side application of modelCapabilities: registration and the
 * discovery cache stay config-free, and these functions decorate the models a
 * refresh actually serves - applyCapabilityOverrides patches discovered
 * entries through the shared resolveModelCapabilities walk (the same one the
 * dashboard's inspector renders, so the two cannot drift), and
 * synthesizeDeclaredModels builds the entry-declared models discovery did not
 * list. Both rebuild dependent artifacts coherently from the effective fields
 * (token limits, capability flags, the reasoning control, pricing) instead of
 * hand-patching, and both are idempotent: the resolver reads the untouched
 * serverDeclared baseline riding each model, never previously patched values.
 */

import type {
	CapabilityCatalogLookup,
	CapabilityDiagnostic,
	CapabilityLevel,
	CatalogPricing,
	EffectiveCapabilities,
	ModelCapabilitiesRecord,
} from "../../shared/config/capabilityResolution";
import type { ModelResolutionTable } from "../../shared/config/resolutionTable";
import type { ServerConfig } from "../../shared/servers";
import type { PreAttachModelInfo } from "./groupModels";
import type { ModelRoute } from "./modelCatalog";
import { buildExposedModelId, rawModelIdFromExposed } from "./modelCatalog";
import { REASONING_EFFORT_SCHEMA } from "./modelConfiguration";
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
}

/**
 * Whether a field resolved at this level means user configuration or the
 * catalog decided it, so the entry must rebuild instead of taking the
 * identity fast path. Total over CapabilityLevel on purpose: a level added
 * to the walk fails compilation here instead of silently skipping rebuilds
 * (the shipped fast-path staleness when the fallback levels arrived).
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

/**
 * One warning per distinct record problem per pass, so a record shared by
 * many models logs once; keys and field names are user configuration, never
 * response-derived text.
 */
function diagnosticLogger(
	log: CapabilityOverrideOptions["log"]
): (diagnostics: readonly CapabilityDiagnostic[]) => void {
	const seen = new Set<string>();
	return (diagnostics) => {
		for (const diagnostic of diagnostics) {
			const key = JSON.stringify([diagnostic.kind, diagnostic.layer, diagnostic.recordKey, diagnostic.key]);
			if (!seen.has(key)) {
				seen.add(key);
				log("Ignoring a modelCapabilities record problem", diagnostic);
			}
		}
	};
}

/**
 * Whether the registered entry carries SERVER-reported pricing, which catalog
 * pricing never displaces. Pricing a previous pass applied from the catalog
 * (the litellm.catalogPricing marker) does not count: stale-served window
 * copies re-decorate through here, and treating their catalog price as the
 * server's would latch a removed or re-pointed directive's price in place.
 */
function hasServerPricing(info: PreAttachModelInfo): boolean {
	return (
		info.litellm.catalogPricing !== true &&
		(info.inputCost !== undefined ||
			info.outputCost !== undefined ||
			info.cacheCost !== undefined ||
			info.cacheWriteCost !== undefined)
	);
}

/** Every pricing field a rebuild strips before re-deriving catalog pricing (server pricing is never stripped). */
function withoutPricing<T extends ModelPricing>(info: T): Omit<T, keyof ModelPricing> {
	const {
		inputCost: _inputCost,
		outputCost: _outputCost,
		cacheCost: _cacheCost,
		cacheWriteCost: _cacheWriteCost,
		longContextInputCost: _longContextInputCost,
		longContextOutputCost: _longContextOutputCost,
		longContextCacheCost: _longContextCacheCost,
		longContextCacheWriteCost: _longContextCacheWriteCost,
		priceCategory: _priceCategory,
		pricing: _pricing,
		...rest
	} = info;
	return rest;
}

/**
 * The catalog pricing a model without server pricing may carry, under the
 * settled precedence: an applied `_openrouter_model` directive's pricing
 * first, the implicit exact/suffix match's second. Converted through
 * registration's per-million rules, so a catalog price renders exactly like a
 * server price would.
 */
function catalogPricingFields(
	effective: EffectiveCapabilities,
	catalog: CapabilityCatalogLookup,
	rawModelId: string
): ModelPricing | undefined {
	const directivePricing = effective.directive?.kind === "applied" ? effective.directive.pricing : undefined;
	const pricing: CatalogPricing | undefined =
		directivePricing ??
		(() => {
			const implicit = catalog.byRawModelId(rawModelId);
			return implicit.kind === "found" ? implicit.pricing : undefined;
		})();
	if (pricing === undefined) {
		return undefined;
	}
	const fields = pricingFromCosts(pricing);
	return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * Whether the entry already advertises exactly the resolver's effective
 * fields. The fast path must verify this rather than assume it: the status
 * window's stale-served copies were rebuilt under an EARLIER configuration,
 * so after an override is removed mid-outage nothing matches anymore, yet the
 * stored values still carry the old override - identity would freeze it in
 * place, and the verified rebuild heals it instead.
 */
function advertisesEffective(info: PreAttachModelInfo, effective: EffectiveCapabilities): boolean {
	const fields = effective.fields;
	return (
		info.maxInputTokens === fields.max_input_tokens.value &&
		info.maxOutputTokens === fields.max_output_tokens.value &&
		Boolean(info.capabilities?.toolCalling) === fields.supports_function_calling.value &&
		Boolean(info.capabilities?.imageInput) === fields.supports_vision.value &&
		(info.litellm.supportsAudioInput === true) === fields.supports_audio_input.value &&
		info.litellm.outputLimitSource === effective.outputLimitSource &&
		(info.configurationSchema !== undefined) === fields.supports_reasoning.value
	);
}

/**
 * Apply the capability overrides to one refresh's registered models. Models
 * nothing matches are returned by object identity (and an untouched pass
 * returns the input array itself), so the common no-configuration case costs
 * no copies. A matched model is rebuilt coherently from the effective fields:
 * token limits, the toolCalling/imageInput capabilities, the audio gate, the
 * reasoning configurationSchema (added on promotion, removed on demotion),
 * the outputLimitSource provenance ("user" for any override level), and the
 * pricing precedence server > directive > implicit catalog match.
 */
export function applyCapabilityOverrides(
	infos: readonly PreAttachModelInfo[],
	server: ServerConfig,
	opts: CapabilityOverrideOptions
): readonly PreAttachModelInfo[] {
	let changed = false;
	const logDiagnostics = diagnosticLogger(opts.log);
	const out = infos.map((info) => {
		const rawModelId = rawModelIdFromExposed(info.id, server.id);
		const effective = opts.resolution.resolveCapabilities(server.id, rawModelId, {
			globalCapabilities: opts.globalCapabilities,
			entryCapabilities: opts.entryCapabilities,
			catalog: opts.catalog,
			serverDeclared: info.litellm.serverDeclared,
		});
		logDiagnostics(effective.diagnostics);
		const fields = effective.fields;
		const needsRebuild = Object.values(fields).some((field) => LEVEL_TRIGGERS_REBUILD[field.level]);
		const pricingPatch = hasServerPricing(info) ? undefined : catalogPricingFields(effective, opts.catalog, rawModelId);
		if (
			!needsRebuild &&
			effective.directive === undefined &&
			pricingPatch === undefined &&
			info.litellm.catalogPricing !== true &&
			advertisesEffective(info, effective)
		) {
			// Nothing matched and the entry already says what the walk resolves
			// (see advertisesEffective for why that is verified, not assumed). A
			// catalog-priced copy never takes it: its price must re-derive so a
			// removed directive's price does not survive by identity.
			return info;
		}
		changed = true;
		// The schema is removed on demotion by destructuring it away, then
		// re-added only when the effective flag holds; an entry that already
		// carried it keeps the same object. Catalog-applied pricing is stripped
		// and re-derived the same way; server pricing rides `rest` untouched.
		const { configurationSchema, ...rest } = info;
		const base = info.litellm.catalogPricing === true ? withoutPricing(rest) : rest;
		const { catalogPricing: _catalogPricing, ...litellmBase } = info.litellm;
		return {
			...base,
			maxInputTokens: fields.max_input_tokens.value,
			maxOutputTokens: fields.max_output_tokens.value,
			capabilities: {
				...info.capabilities,
				toolCalling: fields.supports_function_calling.value,
				imageInput: fields.supports_vision.value,
			},
			...(fields.supports_reasoning.value
				? { configurationSchema: configurationSchema ?? REASONING_EFFORT_SCHEMA }
				: {}),
			...(pricingPatch ?? {}),
			litellm: {
				...litellmBase,
				outputLimitSource: effective.outputLimitSource,
				supportsAudioInput: fields.supports_audio_input.value,
				...(pricingPatch !== undefined ? { catalogPricing: true } : {}),
			},
		} satisfies PreAttachModelInfo;
	});
	return changed ? out : infos;
}

export interface DeclaredModelSynthesis {
	readonly infos: readonly PreAttachModelInfo[];
	/** Registry-path routes for the declared entries; the provider merges them additively into its route map. */
	readonly routes: ReadonlyMap<string, ModelRoute>;
}

/**
 * Build the declared models the current configuration creates on one server:
 * the matched entry's discovery.declared list. A declared ID that discovery
 * listed is inert - judged against the DISCOVERED raw-ID set, not the
 * registered one, because registration may emit only synthetic variants
 * (`foo:cheapest`) for a discovered `foo`. A declared ID whose exposed form
 * collides with an ID registration is about to emit (a synthetic aggregate,
 * a per-provider variant) is suppressed with a logged warning: never two
 * models with one exposed ID. Declared models are always rebuilt from the
 * configuration at hand and never persisted, so removing a declared ID takes
 * effect on the next serve even mid-outage.
 */
export function synthesizeDeclaredModels(
	discoveredRawIds: ReadonlySet<string>,
	reservedExposedIds: ReadonlySet<string>,
	server: ServerConfig,
	serverCount: number,
	opts: CapabilityOverrideOptions
): DeclaredModelSynthesis {
	const logDiagnostics = diagnosticLogger(opts.log);
	// Exact IDs, inert when discovered, config-rebuilt every serve; a
	// duplicated ID synthesizes once.
	const specs = [...new Set(opts.entryDeclaredModels ?? [])].map((rawId) => ({ rawId, layer: "entry" as const }));
	const display = serverDisplayContext(server, serverCount);
	const infos: PreAttachModelInfo[] = [];
	const routes = new Map<string, ModelRoute>();
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
		// No server side exists, so catalog pricing (directive first, implicit
		// second) is the only candidate.
		const pricing = catalogPricingFields(effective, opts.catalog, spec.rawId);
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
			...(fields.supports_reasoning.value ? { configurationSchema: REASONING_EFFORT_SCHEMA } : {}),
			...(pricing ?? {}),
			litellm: {
				supportsPromptCaching: false,
				outputLimitSource: effective.outputLimitSource,
				supportsAudioInput: fields.supports_audio_input.value,
				declared: true,
				serverDeclared: { kind: "declared" },
				...(pricing !== undefined ? { catalogPricing: true } : {}),
			},
		} satisfies PreAttachModelInfo);
		routes.set(exposedId, { serverId: server.id, rawModelId: spec.rawId, serverLabel: server.label });
	}
	return { infos, routes };
}
