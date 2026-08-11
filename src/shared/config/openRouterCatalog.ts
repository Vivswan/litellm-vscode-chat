/**
 * The OpenRouter capability catalog: the mapping from OpenRouter's /models
 * payload to the core capability vocabulary, the slimming that produces the
 * packaged dist/openrouter-models.json artifact, and the lookup the resolver
 * consumes (capabilityResolution's CapabilityCatalogLookup). The catalog maps
 * capabilities only - context_length, max_output_tokens, supports_vision,
 * supports_function_calling, supports_reasoning, plus id and name for the
 * directive picker; pricing deliberately never rides the catalog: LiteLLM's
 * /model/info is the only pricing source. Pure (no vscode, no zod, no Node)
 * and lenient by contract: the catalog is best-effort backfill data, so every
 * parser here degrades malformed input to absence instead of throwing - a
 * broken snapshot yields an empty catalog, never a broken activation. That
 * leniency also covers legacy artifacts: slim files cached or packaged while
 * slimming still kept OpenRouter's pricing block, parse unchanged (the mapping
 * ignores unmapped keys), and re-slimming them sheds the pricing keys.
 * Consumed by the runtime store (src/extension/openRouterCatalog.ts)
 * and the build-time fetch script (scripts/dev/fetch-openrouter-catalog.ts);
 * never imported anywhere reachable from src/webview/.
 */

import { isRecord } from "../util/json";
import { normalizePositiveNumber } from "../util/numbers";
import type { CapabilityCatalogLookup, CapabilityFieldValues, CatalogLookupResult } from "./capabilityResolution";

/** The unauthenticated endpoint both the fetch script and the runtime refresh read. */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/**
 * The smallest model count a live payload may carry before the fetch script
 * calls it schema drift (the catalog has held well over 300 models for
 * years). The packaged-file-list CI check asserts the same floor on the
 * shipped artifact with jq; keep the two numbers in sync.
 */
export const CATALOG_MODEL_COUNT_FLOOR = 200;

/** One catalog entry after mapping: the capability fields its OpenRouter record declares. */
export interface CatalogModel {
	readonly id: string;
	readonly name?: string | undefined;
	readonly fields: Readonly<Partial<CapabilityFieldValues>>;
}

/** A parsed catalog snapshot; ids are unique (the first occurrence of a duplicate wins). */
export interface OpenRouterCatalogSnapshot {
	readonly models: readonly CatalogModel[];
}

export const EMPTY_CATALOG_SNAPSHOT: OpenRouterCatalogSnapshot = { models: [] };

/**
 * One slimmed OpenRouter entry, in the wire shape: exactly the fields the
 * mapping consumes plus id and name, so raw payloads and slimmed artifacts
 * parse through the same code path.
 */
export interface SlimOpenRouterModel {
	readonly id: string;
	readonly name?: string;
	readonly context_length?: number;
	readonly architecture?: { readonly input_modalities: readonly string[] };
	readonly top_provider?: { readonly max_completion_tokens: number };
	readonly supported_parameters?: readonly string[];
}

/** The slimmed artifact file shape, mirroring the endpoint's `{ data: [...] }` envelope. */
export interface SlimCatalogFile {
	readonly data: readonly SlimOpenRouterModel[];
}

/** The input_modalities tokens the mapping reads; slimming drops the rest. */
const MAPPED_INPUT_MODALITIES = ["image"] as const;

/** The supported_parameters tokens the mapping reads; slimming drops the rest. */
const MAPPED_SUPPORTED_PARAMETERS = ["tools", "reasoning"] as const;

/** The entry array of a payload: the endpoint's `{ data: [...] }` envelope or a bare array. */
function entriesOf(payload: unknown): readonly unknown[] {
	if (Array.isArray(payload)) {
		return payload;
	}
	if (isRecord(payload) && Array.isArray(payload.data)) {
		return payload.data;
	}
	return [];
}

function nonBlankString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** String tokens of a value that should be an array; undefined when it is not one. */
function stringTokens(value: unknown): readonly string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/**
 * Map one OpenRouter entry to the capability vocabulary:
 * context_length -> context_length, top_provider.max_completion_tokens ->
 * max_output_tokens, architecture.input_modalities containing "image" ->
 * supports_vision, supported_parameters containing "tools"/"reasoning" ->
 * supports_function_calling/supports_reasoning. A present modality or
 * parameter list is authoritative both ways
 * (its booleans are set true or false); an absent or malformed one leaves the
 * fields unset so lower precedence levels keep them. Entries without a
 * usable id map to undefined; nothing here throws.
 */
export function mapOpenRouterEntry(entry: unknown): CatalogModel | undefined {
	if (!isRecord(entry)) {
		return undefined;
	}
	const id = nonBlankString(entry.id);
	if (id === undefined) {
		return undefined;
	}

	const numbers: { context_length?: number; max_output_tokens?: number } = {};
	const contextLength = normalizePositiveNumber(entry.context_length);
	if (contextLength !== undefined) {
		numbers.context_length = contextLength;
	}
	const maxOutputTokens = isRecord(entry.top_provider)
		? normalizePositiveNumber(entry.top_provider.max_completion_tokens)
		: undefined;
	if (maxOutputTokens !== undefined) {
		numbers.max_output_tokens = maxOutputTokens;
	}

	const booleans: {
		supports_vision?: boolean;
		supports_function_calling?: boolean;
		supports_reasoning?: boolean;
	} = {};
	const modalities = isRecord(entry.architecture) ? stringTokens(entry.architecture.input_modalities) : undefined;
	if (modalities !== undefined) {
		booleans.supports_vision = modalities.includes("image");
	}
	const parameters = stringTokens(entry.supported_parameters);
	if (parameters !== undefined) {
		booleans.supports_function_calling = parameters.includes("tools");
		booleans.supports_reasoning = parameters.includes("reasoning");
	}

	const name = nonBlankString(entry.name);
	return {
		id,
		...(name !== undefined ? { name } : {}),
		fields: { ...numbers, ...booleans },
	};
}

/**
 * Parse a whole catalog payload - the live endpoint's, the slimmed artifact's,
 * or garbage - into a snapshot. Unusable entries are dropped, duplicate ids
 * keep their first occurrence, and any non-catalog value yields the empty
 * snapshot. Never throws.
 */
export function parseCatalogSnapshot(payload: unknown): OpenRouterCatalogSnapshot {
	const models: CatalogModel[] = [];
	const seen = new Set<string>();
	for (const entry of entriesOf(payload)) {
		const model = mapOpenRouterEntry(entry);
		if (model !== undefined && !seen.has(model.id)) {
			seen.add(model.id);
			models.push(model);
		}
	}
	return { models };
}

/**
 * Slim one entry to the wire subset the mapping consumes, normalizing as it
 * goes (numbers parsed, token lists reduced to the mapped tokens in a fixed
 * order) so the artifact is deterministic and mapping-equivalent to its
 * source: parsing the slimmed entry yields exactly what parsing the raw
 * entry did. Unmapped source keys - OpenRouter's pricing block among them -
 * never survive slimming.
 */
function slimEntry(entry: unknown): SlimOpenRouterModel | undefined {
	const model = mapOpenRouterEntry(entry);
	if (model === undefined || !isRecord(entry)) {
		return undefined;
	}
	const { fields } = model;
	const modalities = isRecord(entry.architecture) ? stringTokens(entry.architecture.input_modalities) : undefined;
	const parameters = stringTokens(entry.supported_parameters);
	return {
		id: model.id,
		...(model.name !== undefined ? { name: model.name } : {}),
		...(fields.context_length !== undefined ? { context_length: fields.context_length } : {}),
		...(modalities !== undefined
			? { architecture: { input_modalities: MAPPED_INPUT_MODALITIES.filter((token) => modalities.includes(token)) } }
			: {}),
		...(fields.max_output_tokens !== undefined
			? { top_provider: { max_completion_tokens: fields.max_output_tokens } }
			: {}),
		...(parameters !== undefined
			? { supported_parameters: MAPPED_SUPPORTED_PARAMETERS.filter((token) => parameters.includes(token)) }
			: {}),
	};
}

/**
 * Slim a whole payload into the artifact shape: only mapped fields plus id
 * and name survive, duplicate ids keep their first occurrence, and entries
 * sort by id - so the artifact is byte-deterministic for a given payload and
 * diffs cleanly between fetches. Idempotent: slimming a slimmed file changes
 * nothing. Never throws.
 */
export function slimCatalogPayload(payload: unknown): SlimCatalogFile {
	const slimmed = new Map<string, SlimOpenRouterModel>();
	for (const entry of entriesOf(payload)) {
		const slim = slimEntry(entry);
		if (slim !== undefined && !slimmed.has(slim.id)) {
			slimmed.set(slim.id, slim);
		}
	}
	const data = [...slimmed.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { data };
}

function foundResult(model: CatalogModel): CatalogLookupResult {
	return {
		kind: "found",
		id: model.id,
		fields: model.fields,
	};
}

const NOT_FOUND: CatalogLookupResult = { kind: "not-found" };
const AMBIGUOUS: CatalogLookupResult = { kind: "ambiguous" };

/**
 * Build the resolver's catalog view over a snapshot. byExactId answers
 * `_openrouter_model` directives and always serves the snapshot. byRawModelId
 * is the implicit low-precedence lookup by a model's own raw ID: an exact
 * catalog-ID match wins; otherwise the post-"vendor/" suffix must match
 * exactly one catalog entry - two or more answer ambiguous (the walk skips
 * the level rather than guessing a vendor). With implicitLookup false (the
 * opt-out setting), byRawModelId answers not-found while byExactId keeps
 * serving: explicit directives are user intent and involve no network, so the
 * opt-out never breaks them.
 */
export function createCatalogLookup(
	snapshot: OpenRouterCatalogSnapshot,
	options: { readonly implicitLookup: boolean }
): CapabilityCatalogLookup {
	const byId = new Map<string, CatalogModel>();
	const bySuffix = new Map<string, CatalogModel[]>();
	for (const model of snapshot.models) {
		if (byId.has(model.id)) {
			continue;
		}
		byId.set(model.id, model);
		const slash = model.id.indexOf("/");
		const suffix = slash > 0 ? model.id.slice(slash + 1) : undefined;
		if (suffix !== undefined && suffix !== "") {
			const matches = bySuffix.get(suffix);
			if (matches === undefined) {
				bySuffix.set(suffix, [model]);
			} else {
				matches.push(model);
			}
		}
	}

	return {
		byExactId: (id) => {
			const model = byId.get(id);
			return model !== undefined ? foundResult(model) : NOT_FOUND;
		},
		byRawModelId: (rawId) => {
			if (!options.implicitLookup) {
				return NOT_FOUND;
			}
			const exact = byId.get(rawId);
			if (exact !== undefined) {
				return foundResult(exact);
			}
			const matches = bySuffix.get(rawId);
			if (matches === undefined) {
				return NOT_FOUND;
			}
			const [sole] = matches;
			return matches.length === 1 && sole !== undefined ? foundResult(sole) : AMBIGUOUS;
		},
	};
}

/**
 * Case-insensitive substring search over the snapshot's IDs and names, for
 * the dashboard's catalog picker. Returns matches in the snapshot's own
 * (id-sorted) order; the caller bounds the result count. A blank query
 * matches nothing rather than everything - the picker only opens on input.
 */
export function searchCatalogModels(
	snapshot: OpenRouterCatalogSnapshot,
	query: string
): readonly { readonly id: string; readonly name: string }[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) {
		return [];
	}
	return snapshot.models
		.filter((model) => model.id.toLowerCase().includes(needle) || (model.name ?? "").toLowerCase().includes(needle))
		.map((model) => ({ id: model.id, name: model.name ?? model.id }));
}
