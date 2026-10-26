/**
 * The FROZEN pre-redesign resolvers, pinned as test-local copies for the migration fuzzer's old-world side
 * (settingsRedesignOracle.ts): the live resolvers were rewritten for the matcher/inheritance redesign, so the old
 * prefix/scoped semantics survive only here, trimmed to what the oracle projects.
 */

import type { ServerDeclaredCapabilities } from "../../../shared/config/capabilityResolution";

// Frozen locally: importing the live vocabulary would let a later change mutate this oracle's old-world behavior.
const CAPABILITY_FIELDS = {
	context_length: "number",
	max_input_tokens: "number",
	max_output_tokens: "number",
	supports_function_calling: "boolean",
	supports_vision: "boolean",
	supports_reasoning: "boolean",
	supports_audio_input: "boolean",
} as const;

type CapabilityFieldName = keyof typeof CAPABILITY_FIELDS;

type CapabilityFieldValues = { readonly [K in CapabilityFieldName]: number | boolean };

/** The pre-redesign floor the walk ends at; max_input_tokens has none and derives from context minus output. */
const CAPABILITY_FLOOR = {
	context_length: 128000,
	max_output_tokens: 16000,
	supports_function_calling: true,
	supports_vision: false,
	supports_reasoning: false,
	supports_audio_input: false,
} as const;

/** The pre-redesign skip rule: max_tokens was provider-owned and therefore UNFORCEABLE in the old grammar. */
const OLD_PROVIDER_OWNED_KEYS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"stream",
	"stream_options",
	"max_tokens",
	"tools",
	"tool_choice",
]);

function parameterSkipReason(key: string): "underscore" | "provider-owned" | undefined {
	if (key.startsWith("_")) {
		return "underscore";
	}
	if (OLD_PROVIDER_OWNED_KEYS.has(key)) {
		return "provider-owned";
	}
	return undefined;
}

const CATCH_ALL_PREFIX = "*";

function prefixSpecificity(id: string, prefix: string): number | undefined {
	if (prefix === CATCH_ALL_PREFIX) {
		return 0;
	}
	return id === prefix || id.startsWith(prefix) ? prefix.length : undefined;
}

/** The most specific key matching `id`, with its value; "*" wins its one possible tie against "". */
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

const FORCE_DIRECTIVE = "_force";

export interface OldParsedParameterRecord {
	readonly fields: Record<string, unknown>;
	readonly forced: ReadonlySet<string>;
}

/**
 * The parameter keys an old `_force` directive marks: every unskipped field for `true`, the named present fields for a
 * list.
 */
function oldForcedKeys(directive: unknown, fields: Readonly<Record<string, unknown>>): Set<string> {
	const forced = new Set<string>();
	if (directive === true) {
		for (const key of Object.keys(fields)) {
			if (parameterSkipReason(key) === undefined) {
				forced.add(key);
			}
		}
		return forced;
	}

	if (!Array.isArray(directive)) {
		return forced;
	}

	for (const name of directive) {
		if (typeof name === "string" && parameterSkipReason(name) === undefined && Object.hasOwn(fields, name)) {
			forced.add(name);
		}
	}
	return forced;
}

/** The pre-redesign parameter-record parse, minus diagnostics (the oracle projects values only). */
export function parseOldParameterRecord(record: Readonly<Record<string, unknown>>): OldParsedParameterRecord {
	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key !== FORCE_DIRECTIVE) {
			Object.defineProperty(fields, key, { value, enumerable: true, writable: true, configurable: true });
		}
	}
	const directive = Object.hasOwn(record, FORCE_DIRECTIVE) ? record[FORCE_DIRECTIVE] : undefined;
	return { fields, forced: oldForcedKeys(directive, fields) };
}

export interface OldResolvedModelParameters {
	readonly params: Record<string, unknown>;
	readonly forcedParams: Readonly<Record<string, unknown>>;
	readonly replacedUnscoped?: { readonly key: string; readonly record: Readonly<Record<string, unknown>> } | undefined;
}

/**
 * The pre-redesign parameter merge verbatim: any scoped global match replaces the whole unscoped record (scoped ??
 * longest-unscoped), the entry record's longest-prefix match overrides key by key, and forced fields win on top (forced
 * entry over forced global; a globally forced key beats an unforced entry value).
 */
export function resolveOldModelParameters(input: {
	readonly rawModelId: string;
	readonly globalParameters: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly serverScopes: readonly string[];
	readonly entryParameters?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
}): OldResolvedModelParameters {
	const { rawModelId, globalParameters, serverScopes, entryParameters } = input;
	const scoped = findScopedMatch(rawModelId, serverScopes, globalParameters);
	const unscoped = findLongestPrefixEntry(rawModelId, globalParameters);
	const globalWinner = scoped?.value === undefined ? unscoped : { key: scoped.key, value: scoped.value };
	const entry = findLongestPrefixEntry(rawModelId, entryParameters ?? {});

	const parsedGlobal = globalWinner === undefined ? undefined : parseOldParameterRecord(globalWinner.value);
	const parsedEntry = entry === undefined ? undefined : parseOldParameterRecord(entry.value);

	const params: Record<string, unknown> = { ...parsedGlobal?.fields, ...parsedEntry?.fields };
	const forcedParams: Record<string, unknown> = {};
	if (parsedGlobal !== undefined) {
		for (const key of parsedGlobal.forced) {
			forcedParams[key] = parsedGlobal.fields[key];
		}
	}
	if (parsedEntry !== undefined) {
		for (const key of parsedEntry.forced) {
			forcedParams[key] = parsedEntry.fields[key];
		}
	}
	for (const [key, value] of Object.entries(forcedParams)) {
		params[key] = value;
	}

	const replacedUnscoped =
		scoped?.value !== undefined && unscoped !== undefined ? { key: unscoped.key, record: unscoped.value } : undefined;
	return { params, forcedParams, ...(replacedUnscoped === undefined ? {} : { replacedUnscoped }) };
}

const DECLARE_DIRECTIVE = "_declare";
const OPENROUTER_MODEL_DIRECTIVE = "_openrouter_model";
const FALLBACK_DIRECTIVE = "_fallback";

function isCapabilityFieldName(key: string): key is CapabilityFieldName {
	return Object.hasOwn(CAPABILITY_FIELDS, key);
}

export interface OldParsedCapabilityRecord {
	readonly fields: Readonly<Partial<CapabilityFieldValues>>;
	readonly declare: boolean;
	readonly fallback: readonly CapabilityFieldName[];
}

/** The value a capability field keeps in the old parse: a positive integer for a number field, a boolean for a flag. */
function oldCapabilityValue(name: CapabilityFieldName, value: unknown): number | boolean | undefined {
	if (CAPABILITY_FIELDS[name] === "number") {
		return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
	}

	return typeof value === "boolean" ? value : undefined;
}

/** The record's capability fields by the old vocabulary, directives and unknown keys skipped. */
function oldCapabilityFields(
	record: Readonly<Record<string, unknown>>
): Partial<Record<CapabilityFieldName, number | boolean>> {
	const fields: Partial<Record<CapabilityFieldName, number | boolean>> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === OPENROUTER_MODEL_DIRECTIVE || key.startsWith("_") || !isCapabilityFieldName(key)) {
			continue;
		}
		const kept = oldCapabilityValue(key, value);
		if (kept !== undefined) {
			fields[key] = kept;
		}
	}
	return fields;
}

/** Whether an old `_declare: true` counts: read once among the record's own entries, where the key may declare. */
function oldDeclareFlag(record: Readonly<Record<string, unknown>>, allowDeclare: boolean): boolean {
	for (const [key, value] of Object.entries(record)) {
		if (key === DECLARE_DIRECTIVE) {
			return value === true && allowDeclare;
		}
	}
	return false;
}

/** The parsed fields an old `_fallback` demotes: all of them for `true`, the named present ones for a list. */
function oldFallbackNames(
	directive: unknown,
	fields: Readonly<Partial<Record<CapabilityFieldName, number | boolean>>>
): CapabilityFieldName[] {
	if (directive === true) {
		return Object.keys(fields) as CapabilityFieldName[];
	}

	if (!Array.isArray(directive)) {
		return [];
	}

	const fallback: CapabilityFieldName[] = [];
	for (const name of directive) {
		if (
			typeof name === "string" &&
			isCapabilityFieldName(name) &&
			Object.hasOwn(fields, name) &&
			!fallback.includes(name)
		) {
			fallback.push(name);
		}
	}
	return fallback;
}

/**
 * The pre-redesign capability-record parse, minus diagnostics and `_openrouter_model` (the oracle runs catalog-free).
 */
export function parseOldCapabilityRecord(
	record: Readonly<Record<string, unknown>>,
	options: { readonly allowDeclare: boolean }
): OldParsedCapabilityRecord {
	const fields = oldCapabilityFields(record);
	const fallbackDirective = Object.hasOwn(record, FALLBACK_DIRECTIVE) ? record[FALLBACK_DIRECTIVE] : undefined;
	return {
		fields: fields as Readonly<Partial<CapabilityFieldValues>>,
		declare: oldDeclareFlag(record, options.allowDeclare),
		fallback: oldFallbackNames(fallbackDirective, fields),
	};
}

function isUrlScopedKey(key: string): boolean {
	return key.includes("://");
}

function scopedDeclarableId(key: string, scopes: readonly string[]): string | undefined {
	let remainder: string | undefined;
	for (const scope of scopes) {
		if (key.startsWith(`${scope}/`)) {
			const candidate = key.slice(scope.length + 1);
			if (remainder === undefined || candidate.length > remainder.length) {
				remainder = candidate;
			}
		}
	}
	return remainder === "" || remainder === CATCH_ALL_PREFIX ? undefined : remainder;
}

export function extractOldDeclaredModels(input: {
	readonly globalCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly serverScopes: readonly string[];
	readonly entryCapabilities?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
}): readonly string[] {
	const declared = new Set<string>();
	const scan = (declarableId: string | undefined, record: Readonly<Record<string, unknown>>): void => {
		const parsed = parseOldCapabilityRecord(record, { allowDeclare: declarableId !== undefined });
		if (parsed.declare && declarableId !== undefined) {
			declared.add(declarableId);
		}
	};
	for (const [key, record] of Object.entries(input.entryCapabilities ?? {})) {
		scan(key !== "" && key !== CATCH_ALL_PREFIX ? key : undefined, record);
	}
	for (const [key, record] of Object.entries(input.globalCapabilities)) {
		if (input.serverScopes.some((scope) => key.startsWith(`${scope}/`))) {
			scan(scopedDeclarableId(key, input.serverScopes), record);
		} else if (!isUrlScopedKey(key)) {
			scan(undefined, record);
		}
	}
	return [...declared];
}

export interface OldResolvedCapabilityOverrides {
	readonly overrides: Partial<Record<CapabilityFieldName, number | boolean>>;
	readonly fallbacks: Partial<Record<CapabilityFieldName, number | boolean>>;
	readonly replacedUnscoped?: { readonly key: string; readonly record: Readonly<Record<string, unknown>> } | undefined;
}

/**
 * Whether the retired `_declare`+`_fallback` ban applies to a winning record: it declares a model, demotes fields, and
 * the id it declares is the resolved model itself.
 */
function oldBanApplies(
	parsed: OldParsedCapabilityRecord | undefined,
	declaredId: string | undefined,
	rawModelId: string,
	lifted: boolean | undefined
): boolean {
	return lifted !== true && parsed?.declare === true && parsed.fallback.length > 0 && declaredId === rawModelId;
}

/** The id an entry-level key declares: the key itself, unless it is the empty or catch-all key. */
function entryDeclarableId(key: string | undefined): string | undefined {
	return key === undefined || key === "" || key === CATCH_ALL_PREFIX ? undefined : key;
}

/**
 * The entry-over-global field chain: each field's override from the first unfallen level, its fallback from the first
 * demoted one.
 */
function oldCapabilityLevels(
	parsedEntry: OldParsedCapabilityRecord | undefined,
	parsedGlobal: OldParsedCapabilityRecord | undefined,
	entryFallback: readonly CapabilityFieldName[],
	globalFallback: readonly CapabilityFieldName[]
): Pick<OldResolvedCapabilityOverrides, "overrides" | "fallbacks"> {
	const overrides: Partial<Record<CapabilityFieldName, number | boolean>> = {};
	const fallbacks: Partial<Record<CapabilityFieldName, number | boolean>> = {};
	for (const name of Object.keys(CAPABILITY_FIELDS) as CapabilityFieldName[]) {
		const entryValue = parsedEntry?.fields[name];
		const globalValue = parsedGlobal?.fields[name];
		if (entryValue !== undefined && !entryFallback.includes(name)) {
			overrides[name] = entryValue;
		} else if (globalValue !== undefined && !globalFallback.includes(name)) {
			overrides[name] = globalValue;
		}
		if (entryValue !== undefined && entryFallback.includes(name)) {
			fallbacks[name] = entryValue;
		} else if (globalValue !== undefined && globalFallback.includes(name)) {
			fallbacks[name] = globalValue;
		}
	}
	return { overrides, fallbacks };
}

/**
 * The pre-redesign capability override/fallback resolution at value level: the scoped-replaces-unscoped global merge,
 * the entry-over-global field chain, and the `_declare`+`_fallback` ban (a record whose declaration creates the
 * resolved model keeps its fields as overrides). `liftDeclareFallbackBan` disables the ban, which the redesign RETIRES;
 * the oracle compares against these ban-free semantics and pins the ban itself as a documented divergence.
 */
export function resolveOldCapabilityOverrides(input: {
	readonly rawModelId: string;
	readonly globalCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly serverScopes: readonly string[];
	readonly entryCapabilities?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
	readonly liftDeclareFallbackBan?: boolean | undefined;
}): OldResolvedCapabilityOverrides {
	const { rawModelId, globalCapabilities, serverScopes, entryCapabilities } = input;
	const scoped = findScopedMatch(rawModelId, serverScopes, globalCapabilities);
	const unscoped = findLongestPrefixEntry(rawModelId, globalCapabilities);
	const globalWinner = scoped?.value === undefined ? unscoped : { key: scoped.key, value: scoped.value };
	const entryWinner = findLongestPrefixEntry(rawModelId, entryCapabilities ?? {});

	const parsedGlobal =
		globalWinner === undefined ? undefined : parseOldCapabilityRecord(globalWinner.value, { allowDeclare: true });
	const parsedEntry =
		entryWinner === undefined ? undefined : parseOldCapabilityRecord(entryWinner.value, { allowDeclare: true });

	const lifted = input.liftDeclareFallbackBan;
	const entryBanned = oldBanApplies(parsedEntry, entryDeclarableId(entryWinner?.key), rawModelId, lifted);
	const globalDeclaredId = globalWinner === undefined ? undefined : scopedDeclarableId(globalWinner.key, serverScopes);
	const globalBanned = oldBanApplies(parsedGlobal, globalDeclaredId, rawModelId, lifted);
	const entryFallback: readonly CapabilityFieldName[] = entryBanned ? [] : (parsedEntry?.fallback ?? []);
	const globalFallback: readonly CapabilityFieldName[] = globalBanned ? [] : (parsedGlobal?.fallback ?? []);

	const replacedUnscoped =
		scoped?.value !== undefined && unscoped !== undefined ? { key: unscoped.key, record: unscoped.value } : undefined;
	return {
		...oldCapabilityLevels(parsedEntry, parsedGlobal, entryFallback, globalFallback),
		...(replacedUnscoped === undefined ? {} : { replacedUnscoped }),
	};
}

export interface OldCapabilityTokenDefaults {
	readonly contextLength: { readonly value: number; readonly explicitlyConfigured: boolean };
	readonly maxOutputTokens: { readonly value: number; readonly explicitlyConfigured: boolean };
	readonly maxInputTokens: number | undefined;
}

type OldEffectiveCapabilityValues = { readonly [K in CapabilityFieldName]: number | boolean };

/**
 * One pre-redesign capability walk. outputLimitSource follows the old USER_SET_LEVELS:
 *   override, fallback                                             -> "user" (uncapped on the wire)
 *   server, when the baseline's request default is the limit itself -> "provider"
 *   default setting, floor                                          -> "defaults" (min(4096, limit))
 */
export interface OldWalkResult {
	/** The effective value of every old capability field after the walk. */
	readonly fields: OldEffectiveCapabilityValues;

	/** Which level set the output limit; the mapping is in this record's doc comment. */
	readonly outputLimitSource: "user" | "provider" | "defaults";
}

type OldNumberLevel = "override" | "server" | "fallback" | "default-setting" | "floor";

/**
 * Which level set the output limit under the old USER_SET_LEVELS: override and fallback are "user", the server level is
 * "provider" only when the baseline's request default is the limit itself, and every other level is "defaults".
 */
function oldOutputLimitSource(
	level: OldNumberLevel,
	serverDeclared: ServerDeclaredCapabilities,
	maxOutputTokens: number
): OldWalkResult["outputLimitSource"] {
	if (level === "override" || level === "fallback") {
		return "user";
	}
	if (
		level === "server" &&
		serverDeclared.kind === "discovered" &&
		serverDeclared.defaultMaxTokens === maxOutputTokens
	) {
		return "provider";
	}
	return "defaults";
}

/**
 * The pre-redesign full capability walk at value level, catalog-free: entry > global > server > fallbacks >
 * explicitly-configured default* setting > floor, with defaultMaxInputTokens keeping its quirk of beating even the
 * server-declared max input, and max_input_tokens deriving max(1, context - output) as its backstop.
 */
export function resolveOldModelCapabilities(input: {
	readonly rawModelId: string;
	readonly globalCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly serverScopes: readonly string[];
	readonly entryCapabilities?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
	readonly serverDeclared: ServerDeclaredCapabilities;
	readonly tokenDefaults?: OldCapabilityTokenDefaults | undefined;
	readonly liftDeclareFallbackBan?: boolean | undefined;
}): OldWalkResult {
	const { overrides, fallbacks } = resolveOldCapabilityOverrides(input);
	const serverValues: Readonly<Partial<CapabilityFieldValues>> =
		input.serverDeclared.kind === "discovered" ? input.serverDeclared.values : {};
	const defaults = input.tokenDefaults;

	const resolveNumber = (
		name: "context_length" | "max_output_tokens",
		explicitDefault: { readonly value: number; readonly explicitlyConfigured: boolean } | undefined
	): { value: number; level: OldNumberLevel } => {
		const candidates: { level: OldNumberLevel; value: number | boolean | undefined }[] = [
			{ level: "override", value: overrides[name] },
			{ level: "server", value: serverValues[name] },
			{ level: "fallback", value: fallbacks[name] },
			{ level: "default-setting", value: explicitDefault?.explicitlyConfigured ? explicitDefault.value : undefined },
		];
		const winner = candidates.find((candidate) => candidate.value !== undefined);
		return typeof winner?.value === "number"
			? { value: winner.value, level: winner.level }
			: { value: CAPABILITY_FLOOR[name], level: "floor" };
	};
	const contextLength = resolveNumber("context_length", defaults?.contextLength).value;
	const maxOutput = resolveNumber("max_output_tokens", defaults?.maxOutputTokens);
	const maxOutputTokens = maxOutput.value;
	const outputLimitSource = oldOutputLimitSource(maxOutput.level, input.serverDeclared, maxOutputTokens);
	const maxInputCandidates: (number | boolean | undefined)[] = [
		overrides.max_input_tokens,
		defaults?.maxInputTokens,
		serverValues.max_input_tokens,
		fallbacks.max_input_tokens,
	];
	const maxInputWinner = maxInputCandidates.find((value) => value !== undefined);
	const maxInputTokens =
		typeof maxInputWinner === "number" ? maxInputWinner : Math.max(1, contextLength - maxOutputTokens);

	const booleanField = (
		name: "supports_function_calling" | "supports_vision" | "supports_reasoning" | "supports_audio_input"
	): boolean => {
		const candidates: (number | boolean | undefined)[] = [overrides[name], serverValues[name], fallbacks[name]];
		const winner = candidates.find((value) => value !== undefined);
		return typeof winner === "boolean" ? winner : CAPABILITY_FLOOR[name];
	};

	return {
		fields: {
			context_length: contextLength,
			max_input_tokens: maxInputTokens,
			max_output_tokens: maxOutputTokens,
			supports_function_calling: booleanField("supports_function_calling"),
			supports_vision: booleanField("supports_vision"),
			supports_reasoning: booleanField("supports_reasoning"),
			supports_audio_input: booleanField("supports_audio_input"),
		},
		outputLimitSource,
	};
}
