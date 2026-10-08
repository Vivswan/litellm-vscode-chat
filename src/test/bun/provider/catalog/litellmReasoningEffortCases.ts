/**
 * LiteLLM's own test vectors for resolve_supported_reasoning_efforts and intersect_supported_reasoning_efforts,
 * transcribed from BerriAI/litellm tests/unit/router_utils/test_reasoning_effort_capability.py at commit
 * e2971e0af4926b44248d7459bd456f5a85d49f77 (the resolver itself: litellm/router_utils/reasoning_effort_capability.py at
 * d80f8c28ca7e2fba4257b4b97457d3b313ff0d6a). Public test vectors, hand-copied; no user data. A case our mirror answers
 * differently is a bug in the mirror, never in the vector.
 *
 * Left out: every case that reads LiteLLM's bundled cost map (the unprefixed-twin lookups, the azure gpt-5 gate sweep,
 * the Kimi K3 and gpt-6 entries, the monkeypatched declaration) and nearest_declared_reasoning_effort, which is the
 * request path, not the menu. Those lookups are server-side only: the proxy's /v1/model/info hydrates each deployment
 * from its matching cost-map entry without the resolver's unprefixed-twin merge (litellm/utils.py
 * get_model_info_helper), so a prefixed entry whose flags live only on its twin reaches the wire flagless and resolves
 * to unknown here where LiteLLM's resolver would have inherited them. Where LiteLLM asserts only that "none" is in the
 * result, the vector here pins the whole list the same rule yields.
 */

export interface ResolveCase {
	readonly name: string;
	readonly modelInfo: Record<string, unknown>;
	readonly deploymentIsMapped: boolean;
	readonly expected: readonly string[] | undefined;
}

export const RESOLVE_CASES: readonly ResolveCase[] = [
	// TestProvenanceSeparatesUnknownFromNonReasoning
	{ name: "an off-map deployment resolves to unknown", modelInfo: {}, deploymentIsMapped: false, expected: undefined },
	{
		name: "an off-map deployment with supports_reasoning null resolves to unknown",
		modelInfo: { supports_reasoning: null },
		deploymentIsMapped: false,
		expected: undefined,
	},
	{
		name: "a mapped deployment the map calls non-reasoning supports no efforts",
		modelInfo: {},
		deploymentIsMapped: true,
		expected: [],
	},
	{
		name: "a mapped deployment with supports_reasoning null supports no efforts",
		modelInfo: { supports_reasoning: null },
		deploymentIsMapped: true,
		expected: [],
	},
	{
		name: "an explicit false supports no efforts off the map too",
		modelInfo: { supports_reasoning: false },
		deploymentIsMapped: false,
		expected: [],
	},
	// TestResolveSupportedReasoningEfforts
	{
		name: "a reasoning model with no flags at all resolves to unknown",
		modelInfo: { supports_reasoning: true },
		deploymentIsMapped: true,
		expected: undefined,
	},
	{
		name: "explicit false removes an opt-out level (the gpt-5.5-pro shape)",
		modelInfo: {
			supports_reasoning: true,
			supports_none_reasoning_effort: false,
			supports_minimal_reasoning_effort: false,
			supports_low_reasoning_effort: false,
			supports_xhigh_reasoning_effort: true,
		},
		deploymentIsMapped: true,
		expected: ["medium", "high", "xhigh"],
	},
	{
		name: "explicit true adds the opt-in levels (the claude-opus shape)",
		modelInfo: {
			supports_reasoning: true,
			supports_xhigh_reasoning_effort: true,
			supports_max_reasoning_effort: true,
		},
		deploymentIsMapped: true,
		expected: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
	},
	{
		name: "an opt-in flag set false stays excluded",
		modelInfo: {
			supports_reasoning: true,
			supports_minimal_reasoning_effort: true,
			supports_xhigh_reasoning_effort: false,
		},
		deploymentIsMapped: true,
		expected: ["none", "minimal", "low", "medium", "high"],
	},
	{
		name: "a per-level flag without supports_reasoning reads as implicit true",
		modelInfo: { supports_minimal_reasoning_effort: true },
		deploymentIsMapped: true,
		expected: ["none", "minimal", "low", "medium", "high"],
	},
	{
		name: "an explicit supports_reasoning false wins over per-level flags",
		modelInfo: { supports_reasoning: false, supports_minimal_reasoning_effort: true },
		deploymentIsMapped: true,
		expected: [],
	},
	// TestBareModelNameFallback: upstream also inherits the twin's flags from the cost map here; the entry's own flag
	// decides either way, so the expected list holds without that lookup.
	{
		name: "the prefixed entry's own flags decide (azure gpt-5 without a none flag)",
		modelInfo: {
			supports_reasoning: true,
			litellm_provider: "azure",
			key: "azure/gpt-5-mini",
			supports_xhigh_reasoning_effort: true,
		},
		deploymentIsMapped: true,
		expected: ["minimal", "low", "medium", "high", "xhigh"],
	},
	// TestNoneLevelPolarity
	{
		name: "none stays opt-out off azure",
		modelInfo: {
			supports_reasoning: true,
			litellm_provider: "openai",
			key: "openai/some-reasoner",
			supports_max_reasoning_effort: true,
		},
		deploymentIsMapped: true,
		expected: ["none", "minimal", "low", "medium", "high", "max"],
	},
	{
		name: "none stays opt-out on an azure model outside the gpt-5 family",
		modelInfo: {
			supports_reasoning: true,
			litellm_provider: "azure",
			key: "azure/o3",
			supports_max_reasoning_effort: true,
		},
		deploymentIsMapped: true,
		expected: ["none", "minimal", "low", "medium", "high", "max"],
	},
	{
		name: "azure gpt-5 without the flag does not advertise none",
		modelInfo: {
			supports_reasoning: true,
			litellm_provider: "azure",
			key: "azure/gpt-5-turbo",
			supports_minimal_reasoning_effort: true,
		},
		deploymentIsMapped: true,
		expected: ["minimal", "low", "medium", "high"],
	},
	{
		name: "azure gpt-5 with the flag advertises none",
		modelInfo: {
			supports_reasoning: true,
			litellm_provider: "azure",
			key: "azure/gpt-5-turbo",
			supports_none_reasoning_effort: true,
		},
		deploymentIsMapped: true,
		expected: ["none", "minimal", "low", "medium", "high"],
	},
	// TestDeclaredEffortList
	{
		name: "a declared list answers where no flag could",
		modelInfo: { supports_reasoning: true, reasoning_effort_levels: ["low", "high", "max"] },
		deploymentIsMapped: true,
		expected: ["low", "high", "max"],
	},
	{
		name: "a declared list wins whole over the flags",
		modelInfo: {
			supports_reasoning: true,
			reasoning_effort_levels: ["low", "high", "max"],
			supports_none_reasoning_effort: true,
			supports_minimal_reasoning_effort: true,
			supports_xhigh_reasoning_effort: true,
			supports_max_reasoning_effort: false,
		},
		deploymentIsMapped: true,
		expected: ["low", "high", "max"],
	},
	{
		name: "a declaration is reordered into the advertisement order",
		modelInfo: { supports_reasoning: true, reasoning_effort_levels: ["max", "low", "high"] },
		deploymentIsMapped: true,
		expected: ["low", "high", "max"],
	},
	{
		name: "a declared empty list empties the group",
		modelInfo: { supports_reasoning: true, reasoning_effort_levels: [] },
		deploymentIsMapped: true,
		expected: [],
	},
	{
		name: "an unknown level is dropped rather than raised: [low, bogus]",
		modelInfo: { supports_reasoning: true, reasoning_effort_levels: ["low", "bogus"] },
		deploymentIsMapped: true,
		expected: ["low"],
	},
	{
		name: "an unknown level is dropped rather than raised: [bogus]",
		modelInfo: { supports_reasoning: true, reasoning_effort_levels: ["bogus"] },
		deploymentIsMapped: true,
		expected: [],
	},
	{
		name: "an unknown level is dropped rather than raised: [low, 7, null]",
		modelInfo: { supports_reasoning: true, reasoning_effort_levels: ["low", 7, null] },
		deploymentIsMapped: true,
		expected: ["low"],
	},
	...["low,high,max", { low: true }, 3, true].map((malformed) => ({
		name: `a malformed declaration falls through to the flags: ${JSON.stringify(malformed)}`,
		modelInfo: { supports_reasoning: true, reasoning_effort_levels: malformed, supports_max_reasoning_effort: true },
		deploymentIsMapped: true,
		expected: ["none", "minimal", "low", "medium", "high", "max"],
	})),
	{
		name: "a model the map calls non-reasoning ignores its declaration",
		modelInfo: { supports_reasoning: false, reasoning_effort_levels: ["low", "high", "max"] },
		deploymentIsMapped: true,
		expected: [],
	},
];

export interface IntersectCase {
	readonly name: string;
	readonly current: readonly string[] | undefined;
	readonly resolved: readonly string[] | undefined;
	readonly expected: readonly string[] | undefined;
}

// TestIntersectSupportedReasoningEfforts
export const INTERSECT_CASES: readonly IntersectCase[] = [
	{
		name: "unknown never narrows: resolved unknown",
		current: ["medium", "high"],
		resolved: undefined,
		expected: ["medium", "high"],
	},
	{
		name: "unknown never narrows: current unknown",
		current: undefined,
		resolved: ["medium", "high"],
		expected: ["medium", "high"],
	},
	{ name: "unknown never narrows: both unknown", current: undefined, resolved: undefined, expected: undefined },
	{
		name: "the intersection keeps the canonical order",
		current: ["max", "high", "medium", "xhigh"],
		resolved: ["xhigh", "medium", "minimal"],
		expected: ["medium", "xhigh"],
	},
	{ name: "disjoint sets intersect to empty", current: ["max"], resolved: ["minimal"], expected: [] },
];
