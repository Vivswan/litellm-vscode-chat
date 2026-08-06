/**
 * The single owner of modelParameters prefix resolution, the precedence
 * merge, and the max_tokens fallback branch. Pure (no vscode, no DOM) on
 * purpose: the request path (provider/transport) builds requests from these
 * functions, and the dashboard's effective-values inspector renders its
 * projection through the protocol module's re-exports - one implementation,
 * so the inspector cannot drift from what a request actually carries. The
 * equivalence property suite pins that claim against buildRequestBody.
 *
 * Scoping semantics worth stating once: a scoped global match REPLACES the
 * whole unscoped global record (it does not merge with it), and the entry
 * record then merges over the global winner key by key. Runtime options and
 * the picker configuration override later, on the request path only.
 */

/**
 * Cap on the fallback max_tokens when neither runtime options nor configured
 * model parameters set one and the model's output limit is a defaults-derived
 * guess rather than server-declared.
 */
export const DEFAULT_MAX_TOKENS_CAP = 4096;

/** A modelParameters record: model-ID prefix (optionally base-URL scoped) to request parameters. */
export type ModelParametersRecord = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * The catch-all prefix key: a bare "*" matches every model ID at specificity
 * zero, exactly like the empty string (the friendlier spelling of the same
 * thing). Both settings and both scoping forms share the alias through
 * prefixSpecificity below.
 */
export const CATCH_ALL_PREFIX = "*";

/**
 * How many characters `prefix` pins down of `id`, or undefined when it does
 * not match. The bare catch-all is an alias of "" (specificity 0, matches
 * everything) - as a consequence, "*" never literal-matches a hypothetical ID
 * that starts with an asterisk (no real model IDs do); longer keys like "*x"
 * stay literal prefixes.
 */
function prefixSpecificity(id: string, prefix: string): number | undefined {
	if (prefix === CATCH_ALL_PREFIX) {
		return 0;
	}
	return id === prefix || id.startsWith(prefix) ? prefix.length : undefined;
}

/**
 * The most specific key matching `id`, with its value; undefined when none
 * does. The only possible specificity tie is "" against "*" (any other two
 * keys of equal specificity that both prefix `id` are the same key), and "*"
 * wins it deterministically.
 */
export function findLongestPrefixEntry<T>(
	id: string,
	entries: Record<string, T>
): { key: string; value: T } | undefined {
	let best: { key: string; specificity: number; value: T } | undefined;
	for (const [key, value] of Object.entries(entries)) {
		const specificity = prefixSpecificity(id, key);
		if (specificity === undefined) {
			continue;
		}
		if (!best || specificity > best.specificity || (specificity === best.specificity && key === CATCH_ALL_PREFIX)) {
			best = { key, specificity, value };
		}
	}
	return best === undefined ? undefined : { key: best.key, value: best.value };
}

export function findLongestPrefixMatch<T>(id: string, entries: Record<string, T>): T | undefined {
	return findLongestPrefixEntry(id, entries)?.value;
}

/**
 * The most specific scoped entry across all scopes. Specificity is the length
 * of the model prefix after the scope, not of the whole key; "<scope>/*" is
 * the scoped catch-all (specificity 0, same as "<scope>/"). Scoped keys must
 * contain the full "<scope>/" prefix. Ties on model prefix length resolve to
 * the earlier scope in `scopes`, then to configuration object order - except
 * that within one scope "*" beats "" (the one tie two distinct keys can
 * produce). The winning key rides along so attribution can name it.
 */
export function findScopedMatch<T>(
	rawId: string,
	scopes: readonly string[],
	entries: Record<string, T>
): { key: string; specificity: number; value: T } | undefined {
	let best: { key: string; specificity: number; value: T; scope: string; modelPrefix: string } | undefined;
	for (const scope of scopes) {
		const scopePrefix = `${scope}/`;
		for (const [key, value] of Object.entries(entries)) {
			if (!key.startsWith(scopePrefix)) {
				continue;
			}
			const modelPrefix = key.slice(scopePrefix.length);
			const specificity = prefixSpecificity(rawId, modelPrefix);
			if (specificity === undefined) {
				continue;
			}
			const beatsTie =
				best !== undefined &&
				specificity === best.specificity &&
				best.scope === scope &&
				modelPrefix === CATCH_ALL_PREFIX &&
				best.modelPrefix === "";
			if (!best || specificity > best.specificity || beatsTie) {
				best = { key, specificity, value, scope, modelPrefix };
			}
		}
	}
	return best === undefined ? undefined : { key: best.key, specificity: best.specificity, value: best.value };
}

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
 * Code injects them into modelOptions; retired extension metadata may linger
 * in user configuration); provider-owned keys cannot be overridden.
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

/** Which configuration layer set a value, and under which record key. */
export interface ParameterSourceRef {
	/** "entry" is the declared server entry's own record; "global" the modelParameters setting. */
	readonly layer: "entry" | "global";
	/** The winning record key in that layer; scoped global keys keep their base-URL prefix. */
	readonly key: string;
}

/** A lower-precedence layer's value for a key some higher layer won. */
export interface ShadowedParameterValue extends ParameterSourceRef {
	readonly value: unknown;
}

/** One merged parameter with its attribution. */
interface ResolvedParameterSource {
	readonly source: ParameterSourceRef;
	/** Lower-precedence layers that also set this key; present only when one really did. */
	readonly shadowed: readonly ShadowedParameterValue[];
}

export interface ResolveModelParametersInput {
	readonly rawModelId: string;
	/** The modelParameters setting as the request path reads it (normalizeModelParameters output). */
	readonly globalParameters: ModelParametersRecord;
	/** Scopes for scoped-key matching: the server's normalized base URL. */
	readonly serverScopes: readonly string[];
	/** The declared server entry's own record, when the request routes through one. */
	readonly entryParameters?: ModelParametersRecord | undefined;
}

export interface ResolvedModelParameters {
	/** The merged record exactly as the request path forwards it into buildRequestBody. */
	readonly params: Record<string, unknown>;
	/** Attribution per merged key; every own key of `params` has an entry. */
	readonly sources: ReadonlyMap<string, ResolvedParameterSource>;
	/**
	 * The unscoped global record a scoped match replaced WHOLE, when one did.
	 * Replacement is record-level, not key-level, so the inspector must show
	 * this entire record as shadowed - not just the keys the winner also sets.
	 */
	readonly replacedUnscoped?: { readonly key: string; readonly record: Readonly<Record<string, unknown>> } | undefined;
}

/**
 * Resolve the configured modelParameters for one model, with attribution.
 * The merge itself is the request path's contract verbatim: any scoped global
 * match replaces the whole unscoped record (scoped ?? longest-unscoped), then
 * the entry record's longest-prefix match overrides the global winner key by
 * key. getModelParameters delegates here, so `params` IS what requests carry.
 */
export function resolveModelParameters(input: ResolveModelParametersInput): ResolvedModelParameters {
	const { rawModelId, globalParameters, serverScopes, entryParameters } = input;
	const scoped = findScopedMatch(rawModelId, serverScopes, globalParameters);
	const unscoped = findLongestPrefixEntry(rawModelId, globalParameters);
	// Mirrors the original `scoped?.value ?? findLongestPrefixMatch(...)`:
	// only a scoped match with a real value replaces the unscoped record.
	const globalWinner = scoped?.value !== undefined ? { key: scoped.key, value: scoped.value } : unscoped;
	const entry = findLongestPrefixEntry(rawModelId, entryParameters ?? {});

	const params: Record<string, unknown> = { ...globalWinner?.value, ...entry?.value };
	const sources = new Map<string, ResolvedParameterSource>();
	if (globalWinner !== undefined) {
		for (const key of Object.keys(globalWinner.value)) {
			sources.set(key, { source: { layer: "global", key: globalWinner.key }, shadowed: [] });
		}
	}
	if (entry !== undefined) {
		for (const key of Object.keys(entry.value)) {
			const global = globalWinner !== undefined && Object.hasOwn(globalWinner.value, key) ? globalWinner : undefined;
			sources.set(key, {
				source: { layer: "entry", key: entry.key },
				shadowed: global !== undefined ? [{ layer: "global", key: global.key, value: global.value[key] }] : [],
			});
		}
	}

	const replacedUnscoped =
		scoped?.value !== undefined && unscoped !== undefined ? { key: unscoped.key, record: unscoped.value } : undefined;
	return { params, sources, ...(replacedUnscoped !== undefined ? { replacedUnscoped } : {}) };
}

export type MaxTokensSource = "runtime" | "configured" | "declared" | "capped-default";

export interface ResolveMaxTokensInput {
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
 * The one home of the max_tokens fallback chain: runtime option, configured
 * parameter, the server-declared limit as-is, else min(cap, model max output)
 * because a defaults-derived guess must not escape the cap. chatClient.send
 * consumes the value; the inspector consumes value and source.
 */
export function resolveMaxTokens(input: ResolveMaxTokensInput): { value: number; source: MaxTokensSource } {
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
	readonly shadowed: readonly ShadowedParameterValue[];
}

/** The inspector's max_tokens derivation. Runtime options are unknowable ahead of a request, so no "runtime" here. */
export interface ProjectedMaxTokens {
	readonly value: number;
	readonly source: Exclude<MaxTokensSource, "runtime">;
	/** Which layer set the configured value; present exactly when source is "configured". */
	readonly configuredSource?: ParameterSourceRef | undefined;
}

export interface EffectiveParametersInput {
	readonly rawModelId: string;
	readonly globalParameters: ModelParametersRecord;
	readonly serverScopes: readonly string[];
	readonly entryParameters?: ModelParametersRecord | undefined;
	readonly maxOutputTokens: number;
	readonly outputLimitDeclared: boolean;
}

export interface EffectiveParametersProjection {
	/** Configured parameters matching the model, sent and not-sent alike, sorted by name. */
	readonly rows: readonly EffectiveParameterRow[];
	readonly maxTokens: ProjectedMaxTokens;
	/** See ResolvedModelParameters.replacedUnscoped. */
	readonly replacedUnscoped?: { readonly key: string; readonly record: Readonly<Record<string, unknown>> } | undefined;
}

/**
 * The inspector's view of one model's request, computed from the same
 * resolution the request path runs. A numeric configured max_tokens never
 * appears as a row: it becomes the request's max_tokens value, which the
 * derivation reports with its attribution. A non-numeric one stays a row,
 * not sent, because buildRequestBody drops the provider-owned key and
 * resolveMaxTokens ignores non-numbers. The equivalence property pins: every
 * row marked sent appears in buildRequestBody's output with the same value,
 * every non-provider-owned body key appears here as sent, and the projected
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
		// The one key body assignment could not create as an own property is
		// "__proto__" (the Object.prototype accessor would swallow it), and the
		// underscore rule already classifies it as not sent - buildRequestBody
		// skips it for the same reason, so the wire truth and the reason agree.
		const skipReason = parameterSkipReason(name);
		rows.push({
			name,
			value,
			sent: skipReason === undefined,
			...(skipReason !== undefined ? { skipReason } : {}),
			source: attribution.source,
			shadowed: attribution.shadowed,
		});
	}
	rows.sort((a, b) => a.name.localeCompare(b.name));

	const resolvedMax = resolveMaxTokens({
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

	return {
		rows,
		maxTokens,
		...(resolved.replacedUnscoped !== undefined ? { replacedUnscoped: resolved.replacedUnscoped } : {}),
	};
}
