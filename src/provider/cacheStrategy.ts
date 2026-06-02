/**
 * Prompt-caching strategy resolver.
 *
 * Translates the user-facing `promptCaching.mode` setting (plus the advanced
 * fine-tuners) into a concrete per-anchor caching plan: for each of the four
 * Anthropic breakpoints (tools / system / first-user / rolling-last) it decides
 * whether to place a `cache_control` marker and, if so, which TTL ("5m" or
 * "1h") to request.
 *
 * This module is intentionally pure (no VS Code / network dependencies) so the
 * policy can be unit-tested in isolation.
 */

export type CacheMode = "off" | "chat" | "agent" | "auto";
export type CacheTtl = "5m" | "1h";
export type RollingPlacement = "always" | "stableTurnsOnly" | "never";

/** Resolved plan for a single static anchor. */
export interface AnchorPlan {
	/** Whether to place a cache_control marker on this anchor. */
	enabled: boolean;
	/** TTL to request when enabled. */
	ttl: CacheTtl;
}

/** Resolved plan for the rolling-last anchor. */
export interface RollingPlan extends AnchorPlan {
	/** Where the rolling marker may be placed (orthogonal to mode/TTL). */
	placement: RollingPlacement;
}

/** Full resolved caching plan for one request. */
export interface CachePlan {
	mode: CacheMode;
	tools: AnchorPlan;
	system: AnchorPlan;
	firstUser: AnchorPlan;
	rolling: RollingPlan;
}

/** Estimated token sizes of each anchor's block, used for `auto` gating. */
export interface AnchorSizes {
	/** Estimated tokens of the tools array. */
	tools: number;
	/** Estimated tokens of the system prompt block. */
	system: number;
	/** Estimated tokens of the first user message block. */
	firstUser: number;
}

/** Inputs that drive the resolver. */
export interface CacheStrategyInput {
	/** Top-level mode. */
	mode: CacheMode;
	/** Whether the target model advertises prompt-caching support. */
	supportsPromptCaching: boolean;
	/** Rolling-anchor placement (orthogonal to mode). */
	rollingPlacement: RollingPlacement;
	/** 5m↔1h size threshold in tokens (auto mode only). */
	tokenSizeAutoBreakpoint: number;
	/** nocache↔5m floor in tokens (all modes). Anchors below this are skipped. */
	minCacheTokens: number;
	/** Estimated anchor sizes (for auto gating + min-floor checks). */
	sizes: AnchorSizes;
}

const DISABLED: CachePlan = {
	mode: "off",
	tools: { enabled: false, ttl: "5m" },
	system: { enabled: false, ttl: "5m" },
	firstUser: { enabled: false, ttl: "5m" },
	rolling: { enabled: false, ttl: "5m", placement: "never" },
};

/**
 * Resolve a concrete {@link CachePlan} from the user settings + measured sizes.
 *
 * Mode → TTL matrix:
 *  - off:   nothing is cached.
 *  - chat:  all four anchors at 5m.
 *  - agent: system / firstUser / tools at 1h; rolling at 5m.
 *  - auto:  system 1h; firstUser & tools 1h iff their block ≥ breakpoint, else 5m;
 *           rolling always 5m.
 *
 * Universal rules (all modes):
 *  - If the model does not support prompt caching, returns the disabled plan.
 *  - A static anchor whose estimated block size is below `minCacheTokens` is
 *    suppressed (the provider would not cache it anyway). This also handles the
 *    degenerate "tiny / missing system prompt" case.
 *  - The rolling anchor's *placement* comes from `rollingPlacement` and is
 *    orthogonal to `mode`. `placement === "never"` disables the rolling anchor
 *    regardless of mode.
 */
export function resolveCachePlan(input: CacheStrategyInput): CachePlan {
	const { mode, supportsPromptCaching, rollingPlacement, tokenSizeAutoBreakpoint, minCacheTokens, sizes } = input;

	if (mode === "off" || !supportsPromptCaching) {
		return { ...DISABLED, mode: mode === "off" ? "off" : mode };
	}

	// Per-mode TTL decisions for the static anchors.
	const ttlFor = (size: number): CacheTtl => {
		switch (mode) {
			case "chat":
				return "5m";
			case "agent":
				return "1h";
			case "auto":
				return size >= tokenSizeAutoBreakpoint ? "1h" : "5m";
			default:
				return "5m";
		}
	};

	// In auto mode the system prompt is always 1h when present (most-reused,
	// never changes) — but still subject to the minCacheTokens floor below.
	const systemTtl: CacheTtl = mode === "auto" ? "1h" : ttlFor(sizes.system);

	const meetsFloor = (size: number) => size >= minCacheTokens;

	const system: AnchorPlan = {
		enabled: meetsFloor(sizes.system),
		ttl: systemTtl,
	};
	const firstUser: AnchorPlan = {
		enabled: meetsFloor(sizes.firstUser),
		ttl: ttlFor(sizes.firstUser),
	};
	const tools: AnchorPlan = {
		enabled: meetsFloor(sizes.tools),
		ttl: ttlFor(sizes.tools),
	};

	// Rolling-last anchor is always 5m (volatile tail). Placement is orthogonal.
	const rolling: RollingPlan = {
		enabled: rollingPlacement !== "never",
		ttl: "5m",
		placement: rollingPlacement,
	};

	return { mode, tools, system, firstUser, rolling };
}

/** Coerce an arbitrary string into a valid {@link CacheMode} (default "auto"). */
export function normalizeMode(raw: unknown): CacheMode {
	return raw === "off" || raw === "chat" || raw === "agent" || raw === "auto" ? raw : "auto";
}

/** Coerce an arbitrary string into a {@link RollingPlacement} (default "stableTurnsOnly"). */
export function normalizeRollingPlacement(raw: unknown): RollingPlacement {
	return raw === "always" || raw === "never" || raw === "stableTurnsOnly" ? raw : "stableTurnsOnly";
}

/** Clamp the 5m↔1h breakpoint into the supported 4k–16k range (default 8000). */
export function normalizeAutoBreakpoint(raw: unknown): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 8000;
	return Math.min(16000, Math.max(4000, Math.round(n)));
}

/** Clamp the nocache↔5m floor into the supported 256–4096 range (default 1024). */
export function normalizeMinCacheTokens(raw: unknown): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 1024;
	return Math.min(4096, Math.max(256, Math.round(n)));
}
