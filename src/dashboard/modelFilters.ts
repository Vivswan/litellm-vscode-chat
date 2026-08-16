/**
 * The models list's filters. Pure (no vscode, no React) so the semantics pin
 * in the bun tree, and shared by the row renderers and the pills so the two
 * cannot disagree. Composition: dimensions compose AND, the pills of one
 * dimension compose OR - except capabilities, where each pill is its own
 * dimension ("tools" and "vision" together mean a model that has both).
 */
import * as l10n from "@vscode/l10n";
import type { DashboardModel } from "./viewModels";

/**
 * Every capability with its answer, paired with the wire key that names it,
 * in the fixed order the row's detail prints them; the single source the
 * capability pills derive from. The row at rest prints only the true ones:
 * a strikethrough means SUPERSEDED everywhere in this dashboard (the
 * inspector's resolution chain, accessibility-pinned), so absence carries
 * "cannot" on the row and the detail answers explicitly.
 */
export const CAPABILITY_FLAGS = [
	// A key of its own, apart from the max-tools count suffix "tools": a chip
	// label may translate differently from a suffix after a number.
	[
		"supports_function_calling",
		"toolCalling",
		() => l10n.t({ message: "tools", comment: ["Capability chip: the model supports tool calling."] }),
	],
	["supports_vision", "imageInput", () => l10n.t("vision")],
	["supports_prompt_caching", "promptCaching", () => l10n.t("caching")],
	["supports_reasoning", "reasoning", () => l10n.t("reasoning")],
] as const satisfies readonly (readonly [string, keyof DashboardModel, () => string])[];

export type CapabilityFilterKey = (typeof CAPABILITY_FLAGS)[number][1];

/**
 * What the model CAN do, in words: the row's spec line, and the chips in the
 * inspector's header. Empty when it can do none of them.
 */
export function capabilityList(model: DashboardModel): readonly string[] {
	return CAPABILITY_FLAGS.filter(([, property]) => model[property] === true).map(([, , label]) => label());
}

export type PriceFilterKey = "priced" | "unpriced";

/** The two price pills' words; "price unknown" is the row's own phrase for an unpriced model. */
export function priceFilterLabel(price: PriceFilterKey): string {
	return price === "priced" ? l10n.t("priced") : l10n.t("price unknown");
}

/**
 * Whether the list shows a price for this model: the same question the row's
 * second line answers, so the "priced" pill selects exactly the rows that
 * print a price.
 */
export function isPriced(model: DashboardModel): boolean {
	return model.inputCost !== undefined || model.outputCost !== undefined;
}

/**
 * The pills' state. Session-local by design: never persisted or pushed.
 * Servers are keyed by scopeKey, never by label: two provider groups can
 * carry the same label, and a label-keyed pill would silently select both.
 * The label rides along as the value because it is what the pill displays,
 * including for a selection whose server has since left the list.
 */
export interface ModelFilter {
	readonly families: ReadonlySet<string>;
	readonly servers: ReadonlyMap<string, string>;
	readonly prices: ReadonlySet<PriceFilterKey>;
	readonly capabilities: ReadonlySet<CapabilityFilterKey>;
}

export const EMPTY_MODEL_FILTER: ModelFilter = Object.freeze({
	families: new Set<string>(),
	servers: new Map<string, string>(),
	prices: new Set<PriceFilterKey>(),
	capabilities: new Set<CapabilityFilterKey>(),
});

export function isFilterActive(filter: ModelFilter): boolean {
	return filter.families.size > 0 || filter.servers.size > 0 || filter.prices.size > 0 || filter.capabilities.size > 0;
}

function toggledSet<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
	const next = new Set(set);
	if (next.has(value)) {
		next.delete(value);
	} else {
		next.add(value);
	}
	return next;
}

export function toggleFamily(filter: ModelFilter, family: string): ModelFilter {
	return { ...filter, families: toggledSet(filter.families, family) };
}

export function toggleServer(filter: ModelFilter, scopeKey: string, label: string): ModelFilter {
	const servers = new Map(filter.servers);
	if (servers.has(scopeKey)) {
		servers.delete(scopeKey);
	} else {
		servers.set(scopeKey, label);
	}
	return { ...filter, servers };
}

export function togglePrice(filter: ModelFilter, price: PriceFilterKey): ModelFilter {
	return { ...filter, prices: toggledSet(filter.prices, price) };
}

export function toggleCapability(filter: ModelFilter, capability: CapabilityFilterKey): ModelFilter {
	return { ...filter, capabilities: toggledSet(filter.capabilities, capability) };
}

/** The pills' verdict on one model; see the module comment for the composition rules. */
export function matchesFilter(model: DashboardModel, filter: ModelFilter): boolean {
	if (filter.families.size > 0 && !filter.families.has(model.family)) {
		return false;
	}
	if (filter.servers.size > 0 && !filter.servers.has(model.scopeKey)) {
		return false;
	}
	if (filter.prices.size > 0 && !filter.prices.has(isPriced(model) ? "priced" : "unpriced")) {
		return false;
	}
	for (const capability of filter.capabilities) {
		if (model[capability] !== true) {
			return false;
		}
	}
	return true;
}

/** The text filter's reach: the strings the row itself surfaces, nothing hidden. */
function matchesQuery(model: DashboardModel, needle: string): boolean {
	return (
		model.name.toLowerCase().includes(needle) ||
		model.id.toLowerCase().includes(needle) ||
		model.family.toLowerCase().includes(needle) ||
		model.serverLabel.toLowerCase().includes(needle)
	);
}

/**
 * Pills and the text filter together, one more AND: a model shows when every
 * active pill dimension admits it AND the query matches it. The query is
 * taken raw from the input; normalization (trim, case) happens here so every
 * caller means the same thing by "matches".
 */
export function filterModels(
	models: readonly DashboardModel[],
	filter: ModelFilter,
	query: string
): readonly DashboardModel[] {
	const needle = query.trim().toLowerCase();
	return models.filter((model) => matchesFilter(model, filter) && (needle.length === 0 || matchesQuery(model, needle)));
}

interface ServerFilterOption {
	readonly scopeKey: string;
	/** The raw server label: what toggleServer stores, never the numbered form. */
	readonly label: string;
	/** What the pill prints: the label, numbered apart when it collides. */
	readonly display: string;
}

interface CapabilityFilterOption {
	readonly key: CapabilityFilterKey;
	/** Resolved per call, never at module load: the l10n bundle configures after modules load. */
	readonly label: () => string;
}

export interface ModelFilterOptions {
	readonly families: readonly string[];
	readonly servers: readonly ServerFilterOption[];
	readonly prices: readonly PriceFilterKey[];
	readonly capabilities: readonly CapabilityFilterOption[];
}

const PRICE_KEYS: readonly PriceFilterKey[] = ["priced", "unpriced"];

/**
 * Server options in display order, duplicate labels numbered "(1)" onward in
 * the sorted order. The ordinal is a DISPLAY transform only, recomputed every
 * time: identity stays the scopeKey and the raw label is what filter state
 * stores - a stored numbered label would collide again when the numbering
 * shifts under it.
 */
function serverOptions(servers: ReadonlyMap<string, string>): readonly ServerFilterOption[] {
	const sorted = [...servers]
		.map(([scopeKey, label]) => ({ scopeKey, label }))
		.sort((a, b) => a.label.localeCompare(b.label) || a.scopeKey.localeCompare(b.scopeKey));
	const collisions = new Map<string, number>();
	for (const option of sorted) {
		collisions.set(option.label, (collisions.get(option.label) ?? 0) + 1);
	}
	const numbered = new Map<string, number>();
	return sorted.map((option) => {
		if ((collisions.get(option.label) ?? 0) < 2) {
			return { ...option, display: option.label };
		}
		const ordinal = (numbered.get(option.label) ?? 0) + 1;
		numbered.set(option.label, ordinal);
		return { ...option, display: `${option.label} (${ordinal})` };
	});
}

/**
 * Which pills to offer. One rule per dimension: a pill renders where it can
 * change the result (the list disagrees on the dimension) or where it is
 * already active, because an active pill must stay clearable even after the
 * models that justified it left the list. Orders are fixed so the row reads
 * the same across refreshes.
 */
export function modelFilterOptions(models: readonly DashboardModel[], active: ModelFilter): ModelFilterOptions {
	const families = new Set(models.map((model) => model.family));
	const servers = new Map(models.map((model) => [model.scopeKey, model.serverLabel]));
	for (const family of active.families) {
		families.add(family);
	}
	for (const [scopeKey, label] of active.servers) {
		if (!servers.has(scopeKey)) {
			servers.set(scopeKey, label);
		}
	}
	const priceClasses = new Set<PriceFilterKey>(active.prices);
	if (models.some((model) => isPriced(model))) {
		priceClasses.add("priced");
	}
	if (models.some((model) => !isPriced(model))) {
		priceClasses.add("unpriced");
	}
	return {
		families: families.size < 2 && active.families.size === 0 ? [] : [...families].sort((a, b) => a.localeCompare(b)),
		servers: servers.size < 2 && active.servers.size === 0 ? [] : serverOptions(servers),
		prices:
			priceClasses.size < 2 && active.prices.size === 0 ? [] : PRICE_KEYS.filter((price) => priceClasses.has(price)),
		capabilities: CAPABILITY_FLAGS.filter(
			([, property]) =>
				(models.some((model) => model[property] === true) && models.some((model) => model[property] !== true)) ||
				active.capabilities.has(property)
		).map(([, property, label]) => ({ key: property, label })),
	};
}
