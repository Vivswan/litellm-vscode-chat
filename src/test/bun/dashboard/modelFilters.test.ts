/**
 * The models list's filter semantics, pinned exhaustively: AND across
 * dimensions, OR within family/server/price, AND within capabilities, and the
 * text filter as one more AND on top. The webview renders these rules; this
 * suite is where they are defined.
 */
import { describe, expect, test } from "bun:test";
import type { CapabilityFilterKey, ModelFilter, PriceFilterKey } from "../../../dashboard/modelFilters";
import {
	CAPABILITY_FLAGS,
	EMPTY_MODEL_FILTER,
	filterModels,
	isFilterActive,
	isPriced,
	matchesFilter,
	modelFilterOptions,
	priceFilterLabel,
	toggleCapability,
	toggleFamily,
	togglePrice,
	toggleServer,
} from "../../../dashboard/modelFilters";
import { makeModel } from "../webview/fixtures";

const CAPABILITY_KEYS = CAPABILITY_FLAGS.map(([, property]) => property);

/** Every subset of the four capability keys: 16 filters, 16 model shapes. */
function capabilitySubsets(): readonly (readonly CapabilityFilterKey[])[] {
	const subsets: CapabilityFilterKey[][] = [[]];
	for (const key of CAPABILITY_KEYS) {
		for (const subset of [...subsets]) {
			subsets.push([...subset, key]);
		}
	}
	return subsets;
}

function withCapabilities(keys: readonly CapabilityFilterKey[]) {
	return makeModel({
		toolCalling: keys.includes("toolCalling"),
		imageInput: keys.includes("imageInput"),
		promptCaching: keys.includes("promptCaching"),
		reasoning: keys.includes("reasoning"),
	});
}

function capabilityFilter(keys: readonly CapabilityFilterKey[]): ModelFilter {
	return keys.reduce((filter, key) => toggleCapability(filter, key), EMPTY_MODEL_FILTER);
}

describe("capability pills", () => {
	test("compose AND, exhaustively: a model matches iff it has every selected capability", () => {
		// All 16 filter subsets against all 16 capability combinations: the
		// verdict is subset inclusion, nothing else.
		for (const selected of capabilitySubsets()) {
			const filter = capabilityFilter(selected);
			for (const owned of capabilitySubsets()) {
				const model = withCapabilities(owned);
				const expected = selected.every((key) => owned.includes(key));
				expect(matchesFilter(model, filter)).toBe(expected);
			}
		}
	});
});

describe("family pills", () => {
	test("compose OR within the dimension", () => {
		const gpt = makeModel({ family: "gpt" });
		const claude = makeModel({ family: "claude" });
		const gemini = makeModel({ family: "gemini" });
		const one = toggleFamily(EMPTY_MODEL_FILTER, "gpt");
		expect([gpt, claude, gemini].filter((model) => matchesFilter(model, one)).map((m) => m.family)).toEqual(["gpt"]);
		const two = toggleFamily(one, "claude");
		expect([gpt, claude, gemini].filter((model) => matchesFilter(model, two)).map((m) => m.family)).toEqual([
			"gpt",
			"claude",
		]);
	});
});

describe("server pills", () => {
	test("key on scopeKey, never on label: two servers sharing a label stay two filters", () => {
		// The label is NOT an identity - two provider groups can carry the same
		// label - so a label-keyed pill would silently merge them.
		const a = makeModel({ id: "m-a", scopeKey: "s1", serverLabel: "prod" });
		const b = makeModel({ id: "m-b", scopeKey: "s2", serverLabel: "prod" });
		const filter = toggleServer(EMPTY_MODEL_FILTER, "s1", "prod");
		expect(matchesFilter(a, filter)).toBe(true);
		expect(matchesFilter(b, filter)).toBe(false);
		// OR within the dimension: both selected admits both.
		const both = toggleServer(filter, "s2", "prod");
		expect(matchesFilter(a, both)).toBe(true);
		expect(matchesFilter(b, both)).toBe(true);
	});
});

describe("price pills", () => {
	test("isPriced answers exactly as the row does: any of the two headline costs", () => {
		expect(isPriced(makeModel({}))).toBe(false);
		expect(isPriced(makeModel({ inputCost: 1 }))).toBe(true);
		expect(isPriced(makeModel({ outputCost: 2 }))).toBe(true);
		// A user-written 0 prices as genuinely free, which is a price.
		expect(isPriced(makeModel({ inputCost: 0, outputCost: 0 }))).toBe(true);
		// Cache-only costs do not make a model "priced": the row prints
		// "price unknown" when both headline costs are absent.
		expect(isPriced(makeModel({ cacheReadCost: 0.1 }))).toBe(false);
	});

	test("compose OR within the dimension; both selected is every model, none selected is every model", () => {
		const priced = makeModel({ id: "p", inputCost: 1 });
		const unpriced = makeModel({ id: "u" });
		const models = [priced, unpriced];
		const only = (filter: ModelFilter) => models.filter((model) => matchesFilter(model, filter)).map((m) => m.id);
		expect(only(togglePrice(EMPTY_MODEL_FILTER, "priced"))).toEqual(["p"]);
		expect(only(togglePrice(EMPTY_MODEL_FILTER, "unpriced"))).toEqual(["u"]);
		expect(only(togglePrice(togglePrice(EMPTY_MODEL_FILTER, "priced"), "unpriced"))).toEqual(["p", "u"]);
		expect(only(EMPTY_MODEL_FILTER)).toEqual(["p", "u"]);
	});

	test("labels speak the row's own vocabulary", () => {
		expect(priceFilterLabel("priced")).toBe("priced");
		expect(priceFilterLabel("unpriced")).toBe("price unknown");
	});
});

describe("composition across dimensions", () => {
	test("server + tools + vision means: that server, having both", () => {
		const match = makeModel({ id: "yes", scopeKey: "prod", toolCalling: true, imageInput: true });
		const wrongServer = makeModel({ id: "srv", scopeKey: "dev", toolCalling: true, imageInput: true });
		const noVision = makeModel({ id: "novis", scopeKey: "prod", toolCalling: true, imageInput: false });
		const filter = toggleCapability(
			toggleCapability(toggleServer(EMPTY_MODEL_FILTER, "prod", "Prod"), "toolCalling"),
			"imageInput"
		);
		const kept = filterModels([match, wrongServer, noVision], filter, "").map((m) => m.id);
		expect(kept).toEqual(["yes"]);
	});

	test("the text filter is one more AND: trimmed, case-insensitive, over name, id, family, and server label", () => {
		const models = [
			makeModel({ id: "gpt-4o", name: "Omni", family: "gpt", serverLabel: "Prod", toolCalling: true }),
			makeModel({ id: "claude-s", name: "Sonnet", family: "claude", serverLabel: "Prod", toolCalling: true }),
			makeModel({ id: "gpt-mini", name: "Mini", family: "gpt", serverLabel: "Prod", toolCalling: false }),
		];
		const tools = toggleCapability(EMPTY_MODEL_FILTER, "toolCalling");
		// Text alone reaches all four row strings.
		expect(filterModels(models, EMPTY_MODEL_FILTER, "  OMNI ").map((m) => m.id)).toEqual(["gpt-4o"]);
		expect(filterModels(models, EMPTY_MODEL_FILTER, "claude-s").map((m) => m.id)).toEqual(["claude-s"]);
		expect(filterModels(models, EMPTY_MODEL_FILTER, "prod").length).toBe(3);
		// Pills and text intersect: family "gpt" via text, tools via pill.
		expect(filterModels(models, tools, "gpt").map((m) => m.id)).toEqual(["gpt-4o"]);
		// An empty (or blank) query is no condition at all.
		expect(filterModels(models, tools, "   ").length).toBe(2);
	});
});

describe("filter state", () => {
	test("every toggle is its own inverse and never mutates its input", () => {
		const model = makeModel({ scopeKey: "s9", family: "f", inputCost: 1, toolCalling: true });
		const once = toggleFamily(
			togglePrice(toggleServer(toggleCapability(EMPTY_MODEL_FILTER, "toolCalling"), "s9", "L"), "priced"),
			"f"
		);
		expect(isFilterActive(once)).toBe(true);
		expect(matchesFilter(model, once)).toBe(true);
		const undone = toggleFamily(
			togglePrice(toggleServer(toggleCapability(once, "toolCalling"), "s9", "L"), "priced"),
			"f"
		);
		expect(isFilterActive(undone)).toBe(false);
		// EMPTY_MODEL_FILTER stayed empty through it all.
		expect(isFilterActive(EMPTY_MODEL_FILTER)).toBe(false);
		expect(EMPTY_MODEL_FILTER.families.size).toBe(0);
		expect(EMPTY_MODEL_FILTER.servers.size).toBe(0);
	});
});

describe("offered pills", () => {
	test("a dimension's pills render only where the list disagrees on it", () => {
		// One family, one server, all unpriced, uniform capabilities: nothing to
		// narrow, so nothing is offered.
		const uniform = [makeModel({ id: "a" }), makeModel({ id: "b" })];
		const none = modelFilterOptions(uniform, EMPTY_MODEL_FILTER);
		expect(none.families).toEqual([]);
		expect(none.servers).toEqual([]);
		expect(none.prices).toEqual([]);
		expect(none.capabilities).toEqual([]);

		const mixed = [
			makeModel({ id: "a", family: "gpt", scopeKey: "s1", serverLabel: "B-server", inputCost: 1, toolCalling: true }),
			makeModel({ id: "b", family: "claude", scopeKey: "s2", serverLabel: "A-server", toolCalling: false }),
		];
		const options = modelFilterOptions(mixed, EMPTY_MODEL_FILTER);
		// Families and servers alphabetical; prices priced-then-unknown;
		// capabilities in the flags' fixed order, only the contested ones.
		expect(options.families).toEqual(["claude", "gpt"]);
		expect(options.servers).toEqual([
			{ scopeKey: "s2", label: "A-server", display: "A-server" },
			{ scopeKey: "s1", label: "B-server", display: "B-server" },
		]);
		expect(options.prices).toEqual(["priced", "unpriced"]);
		expect(options.capabilities.map((option) => option.key)).toEqual(["toolCalling"]);
	});

	test("two servers sharing a label are two offered pills, numbered apart in display only", () => {
		const models = [
			makeModel({ id: "a", scopeKey: "s1", serverLabel: "prod" }),
			makeModel({ id: "b", scopeKey: "s2", serverLabel: "prod" }),
			makeModel({ id: "c", scopeKey: "s3", serverLabel: "staging" }),
		];
		const options = modelFilterOptions(models, EMPTY_MODEL_FILTER);
		// Identity stays the scopeKey and the RAW label stays the label - the
		// ordinal lives only in the display string, so nothing numbered can leak
		// into filter state. A label without a collision carries no number.
		expect(options.servers).toEqual([
			{ scopeKey: "s1", label: "prod", display: "prod (1)" },
			{ scopeKey: "s2", label: "prod", display: "prod (2)" },
			{ scopeKey: "s3", label: "staging", display: "staging" },
		]);
	});

	test("numbering never round-trips: an orphaned selection cannot collide with a live pill's display", () => {
		// Three groups labelled "prod"; the user presses the one shown first,
		// then its server leaves the list. The orphaned selection re-enters the
		// options from filter state - which stored the RAW label, so the
		// numbering pass still sees three colliding "prod"s and hands out three
		// DISTINCT ordinals. Storing the displayed "prod (1)" instead would
		// renumber the two live servers to (1) and (2) and put two pills reading
		// "prod (1)" side by side, one pressed and one not.
		const all = [
			makeModel({ id: "a", scopeKey: "sA", serverLabel: "prod" }),
			makeModel({ id: "b", scopeKey: "sB", serverLabel: "prod" }),
			makeModel({ id: "c", scopeKey: "sC", serverLabel: "prod" }),
		];
		const before = modelFilterOptions(all, EMPTY_MODEL_FILTER);
		const pressed = before.servers[0] as { scopeKey: string; label: string; display: string };
		expect(pressed.display).toBe("prod (1)");
		// The pill's toggle stores the raw label, exactly as the component wires it.
		const active = toggleServer(EMPTY_MODEL_FILTER, pressed.scopeKey, pressed.label);
		const after = modelFilterOptions(
			all.filter((model) => model.scopeKey !== pressed.scopeKey),
			active
		);
		const displays = after.servers.map((server) => server.display);
		expect(new Set(displays).size).toBe(displays.length);
		expect(after.servers.every((server) => server.label === "prod")).toBe(true);
		// The pressed pill is still among the options, still clearable.
		expect(after.servers.some((server) => server.scopeKey === pressed.scopeKey)).toBe(true);
	});

	test("an active pill stays offered after the models that justified it leave, so it stays clearable", () => {
		const active: ModelFilter = {
			families: new Set(["gone-family"]),
			servers: new Map([["gone-scope", "Gone label"]]),
			prices: new Set<PriceFilterKey>(["unpriced"]),
			capabilities: new Set<CapabilityFilterKey>(["imageInput"]),
		};
		// The remaining list is uniform AND disjoint from every selection. The
		// selections stay offered (they must stay clearable), and their presence
		// activates the dimension, so the list's own value is offered beside
		// them - pressing it now changes the result.
		const options = modelFilterOptions([makeModel({ inputCost: 1 })], active);
		expect(options.families).toEqual(["gone-family", "gpt"]);
		expect(options.servers).toEqual([
			{ scopeKey: "gone-scope", label: "Gone label", display: "Gone label" },
			{ scopeKey: "s0", label: "Prod", display: "Prod" },
		]);
		expect(options.prices).toEqual(["priced", "unpriced"]);
		expect(options.capabilities.map((option) => option.key)).toEqual(["imageInput"]);
	});

	test("capability options carry the row's own words", () => {
		const models = [makeModel({ id: "a", toolCalling: true }), makeModel({ id: "b", toolCalling: false })];
		const options = modelFilterOptions(models, EMPTY_MODEL_FILTER);
		expect(options.capabilities.map((option) => option.label())).toEqual(["tools"]);
	});
});
