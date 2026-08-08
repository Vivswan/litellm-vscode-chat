/**
 * The FROZEN pre-redesign resolvers, pinned as test-local copies for the
 * migration fuzzer's old-world side (settingsRedesignOracle.ts). The live
 * resolvers were rewritten for the matcher/inheritance redesign, so the old
 * prefix/scoped semantics survive only here - verbatim from the pre-redesign
 * shared/config sources, trimmed to what the oracle projects (values, forced
 * marks, fallback marks, declared IDs, the replaced-unscoped flag, and the
 * full walk for the token trio). Legacy semantics are quarantined in this
 * migrations test directory on purpose; nothing outside the oracle may
 * import it.
 */

import type { ServerDeclaredCapabilities } from "../../../shared/config/capabilityResolution";

// The pre-redesign vocabulary and policy constants, frozen LOCALLY: importing
// the live ones would let a future vocabulary or forceability change silently
// mutate this oracle's old-world behavior.
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

/** How many characters `prefix` pins down of `id`, or undefined when it does not match. */
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

/** The most specific scoped entry across all scopes; see the pre-redesign findScopedMatch for the tie rules. */
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
	/** Every key of the record except the directive; the open pass-through vocabulary stays open. */
	readonly fields: Record<string, unknown>;
	/** The field names the record's `_force` directive marks; always own keys of `fields`. */
	readonly forced: ReadonlySet<string>;
}

/** The pre-redesign parameter-record parse, minus diagnostics (the oracle projects values only). */
export function parseOldParameterRecord(record: Readonly<Record<string, unknown>>): OldParsedParameterRecord {
	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key !== FORCE_DIRECTIVE) {
			Object.defineProperty(fields, key, { value, enumerable: true, writable: true, configurable: true });
		}
	}
	const forced = new Set<string>();
	if (Object.hasOwn(record, FORCE_DIRECTIVE)) {
		const directive = record[FORCE_DIRECTIVE];
		if (directive === true) {
			for (const key of Object.keys(fields)) {
				if (parameterSkipReason(key) === undefined) {
					forced.add(key);
				}
			}
		} else if (Array.isArray(directive)) {
			for (const name of directive) {
				if (typeof name === "string" && parameterSkipReason(name) === undefined && Object.hasOwn(fields, name)) {
					forced.add(name);
				}
			}
		}
	}
	return { fields, forced };
}

export interface OldResolvedModelParameters {
	readonly params: Record<string, unknown>;
	readonly forcedParams: Readonly<Record<string, unknown>>;
	/** Present when a scoped global match replaced the unscoped record WHOLE. */
	readonly replacedUnscoped?: { readonly key: string; readonly record: Readonly<Record<string, unknown>> } | undefined;
}

/**
 * The pre-redesign parameter merge verbatim: any scoped global match replaces
 * the whole unscoped record (scoped ?? longest-unscoped), the entry record's
 * longest-prefix match overrides key by key, and forced fields win on top
 * (forced entry over forced global; a globally forced key beats an unforced
 * entry value).
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
	const globalWinner = scoped?.value !== undefined ? { key: scoped.key, value: scoped.value } : unscoped;
	const entry = findLongestPrefixEntry(rawModelId, entryParameters ?? {});

	const parsedGlobal = globalWinner !== undefined ? parseOldParameterRecord(globalWinner.value) : undefined;
	const parsedEntry = entry !== undefined ? parseOldParameterRecord(entry.value) : undefined;

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
	return { params, forcedParams, ...(replacedUnscoped !== undefined ? { replacedUnscoped } : {}) };
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
	/** The field names `_fallback` marks; always keys of `fields`. */
	readonly fallback: readonly CapabilityFieldName[];
}

/** The pre-redesign capability-record parse, minus diagnostics and `_openrouter_model` (the oracle runs catalog-free). */
export function parseOldCapabilityRecord(
	record: Readonly<Record<string, unknown>>,
	options: { readonly allowDeclare: boolean }
): OldParsedCapabilityRecord {
	const fields: Partial<Record<CapabilityFieldName, number | boolean>> = {};
	let isDeclared = false;
	for (const [key, value] of Object.entries(record)) {
		if (key === DECLARE_DIRECTIVE) {
			if (typeof value === "boolean" && (options.allowDeclare || !value)) {
				isDeclared = value;
			}
			continue;
		}
		if (key === OPENROUTER_MODEL_DIRECTIVE || key.startsWith("_") || !isCapabilityFieldName(key)) {
			continue;
		}
		if (CAPABILITY_FIELDS[key] === "number") {
			if (typeof value === "number" && Number.isInteger(value) && value > 0) {
				fields[key] = value;
			}
		} else if (typeof value === "boolean") {
			fields[key] = value;
		}
	}
	const fallback: CapabilityFieldName[] = [];
	if (Object.hasOwn(record, FALLBACK_DIRECTIVE)) {
		const directive = record[FALLBACK_DIRECTIVE];
		if (directive === true) {
			fallback.push(...(Object.keys(fields) as CapabilityFieldName[]));
		} else if (Array.isArray(directive)) {
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
		}
	}
	return { fields: fields as Readonly<Partial<CapabilityFieldValues>>, declare: isDeclared, fallback };
}

function isUrlScopedKey(key: string): boolean {
	return key.includes("://");
}

/** The exact model ID a scoped key may declare: its longest remainder under the matching scopes. */
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

/** The pre-redesign `_declare` extraction: exact entry keys plus scoped global remainders, entry-over-global dedupe. */
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
	/** Per field, the winning override value (entry over global, fallback-demoted fields excluded). */
	readonly overrides: Partial<Record<CapabilityFieldName, number | boolean>>;
	/** Per field, the highest fallback candidate's value (entry-fallback over global-fallback). */
	readonly fallbacks: Partial<Record<CapabilityFieldName, number | boolean>>;
	/** Present when a scoped global match replaced the unscoped record WHOLE. */
	readonly replacedUnscoped?: { readonly key: string; readonly record: Readonly<Record<string, unknown>> } | undefined;
}

/**
 * The pre-redesign capability override/fallback resolution at value level:
 * the scoped-replaces-unscoped global merge, the entry-over-global field
 * chain, and the `_declare`+`_fallback` ban (a record whose declaration
 * creates the resolved model keeps its fields as overrides).
 */
export function resolveOldCapabilityOverrides(input: {
	readonly rawModelId: string;
	readonly globalCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly serverScopes: readonly string[];
	readonly entryCapabilities?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
}): OldResolvedCapabilityOverrides {
	const { rawModelId, globalCapabilities, serverScopes, entryCapabilities } = input;
	const scoped = findScopedMatch(rawModelId, serverScopes, globalCapabilities);
	const unscoped = findLongestPrefixEntry(rawModelId, globalCapabilities);
	const globalWinner = scoped?.value !== undefined ? { key: scoped.key, value: scoped.value } : unscoped;
	const entryWinner = findLongestPrefixEntry(rawModelId, entryCapabilities ?? {});

	const parsedGlobal =
		globalWinner !== undefined ? parseOldCapabilityRecord(globalWinner.value, { allowDeclare: true }) : undefined;
	const parsedEntry =
		entryWinner !== undefined ? parseOldCapabilityRecord(entryWinner.value, { allowDeclare: true }) : undefined;

	const entryBanned =
		parsedEntry?.declare === true &&
		parsedEntry.fallback.length > 0 &&
		entryWinner !== undefined &&
		entryWinner.key !== "" &&
		entryWinner.key !== CATCH_ALL_PREFIX &&
		entryWinner.key === rawModelId;
	const globalBanned =
		parsedGlobal?.declare === true &&
		parsedGlobal.fallback.length > 0 &&
		globalWinner !== undefined &&
		scopedDeclarableId(globalWinner.key, serverScopes) === rawModelId;
	const entryFallback: readonly CapabilityFieldName[] = entryBanned ? [] : (parsedEntry?.fallback ?? []);
	const globalFallback: readonly CapabilityFieldName[] = globalBanned ? [] : (parsedGlobal?.fallback ?? []);

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

	const replacedUnscoped =
		scoped?.value !== undefined && unscoped !== undefined ? { key: unscoped.key, record: unscoped.value } : undefined;
	return { overrides, fallbacks, ...(replacedUnscoped !== undefined ? { replacedUnscoped } : {}) };
}

/** One deprecated default* token setting: its effective value and whether the user really set it. */
export interface OldCapabilityTokenDefaults {
	readonly contextLength: { readonly value: number; readonly explicitlyConfigured: boolean };
	readonly maxOutputTokens: { readonly value: number; readonly explicitlyConfigured: boolean };
	readonly maxInputTokens: number | undefined;
}

/** The effective capability values the pre-redesign full walk resolves (values only, catalog-free). */
export type OldEffectiveCapabilityValues = { readonly [K in CapabilityFieldName]: number | boolean };

/**
 * The pre-redesign full capability walk at value level, catalog-free: entry >
 * global > server > fallbacks > explicitly-configured default* setting >
 * floor, with defaultMaxInputTokens keeping its quirk of beating even the
 * server-declared max input, and max_input_tokens deriving
 * max(1, context - output) as its backstop.
 */
export function resolveOldModelCapabilities(input: {
	readonly rawModelId: string;
	readonly globalCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly serverScopes: readonly string[];
	readonly entryCapabilities?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
	readonly serverDeclared: ServerDeclaredCapabilities;
	readonly tokenDefaults?: OldCapabilityTokenDefaults | undefined;
}): OldEffectiveCapabilityValues {
	const { overrides, fallbacks } = resolveOldCapabilityOverrides(input);
	const serverValues: Readonly<Partial<CapabilityFieldValues>> =
		input.serverDeclared.kind === "discovered" ? input.serverDeclared.values : {};
	const defaults = input.tokenDefaults;

	const resolveNumber = (
		name: "context_length" | "max_output_tokens",
		explicitDefault: { readonly value: number; readonly explicitlyConfigured: boolean } | undefined
	): number => {
		const candidates: (number | boolean | undefined)[] = [
			overrides[name],
			serverValues[name],
			fallbacks[name],
			explicitDefault?.explicitlyConfigured ? explicitDefault.value : undefined,
		];
		const winner = candidates.find((value) => value !== undefined);
		return typeof winner === "number" ? winner : CAPABILITY_FLOOR[name];
	};
	const contextLength = resolveNumber("context_length", defaults?.contextLength);
	const maxOutputTokens = resolveNumber("max_output_tokens", defaults?.maxOutputTokens);
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
		context_length: contextLength,
		max_input_tokens: maxInputTokens,
		max_output_tokens: maxOutputTokens,
		supports_function_calling: booleanField("supports_function_calling"),
		supports_vision: booleanField("supports_vision"),
		supports_reasoning: booleanField("supports_reasoning"),
		supports_audio_input: booleanField("supports_audio_input"),
	};
}
