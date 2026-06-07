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
 *  - auto:  all three stable anchors (system / firstUser / tools) at 1h;
 *           rolling always 5m.
 *
 * Why `auto` no longer ties TTL to block size: for a *stable* prefix anchor a
 * read from a 1h cache costs the same as a read from a 5m cache, and each cache
 * hit refreshes the entry's lifetime for free. So once an anchor is worth
 * caching at all, the 1h tier is essentially always the better economic choice —
 * it only extends how long the (free-to-refresh) entry survives idle gaps. The
 * size question is therefore "is this anchor big enough to bother caching?",
 * which is exactly what the `minCacheTokens` floor answers — not "5m vs 1h".
 * `tokenSizeAutoBreakpoint` is retained for backward compatibility and advanced
 * tuning but no longer selects the TTL tier in `auto` mode.
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
	const { mode, supportsPromptCaching, rollingPlacement, minCacheTokens, sizes } = input;

	if (mode === "off" || !supportsPromptCaching) {
		return { ...DISABLED, mode: mode === "off" ? "off" : mode };
	}

	// Per-mode TTL for the static (stable-prefix) anchors. In `auto` we lean 1h
	// for every stable anchor: a 1h read costs the same as a 5m read and hits
	// refresh the entry for free, so a longer lifetime is strictly better once
	// an anchor clears the minCacheTokens floor. Size only gates whether to
	// cache at all (the floor below), not the TTL tier.
	const stableTtl: CacheTtl = mode === "chat" ? "5m" : "1h";

	const meetsFloor = (size: number) => size >= minCacheTokens;

	const system: AnchorPlan = {
		enabled: meetsFloor(sizes.system),
		ttl: stableTtl,
	};
	const firstUser: AnchorPlan = {
		enabled: meetsFloor(sizes.firstUser),
		ttl: stableTtl,
	};
	const tools: AnchorPlan = {
		enabled: meetsFloor(sizes.tools),
		ttl: stableTtl,
	};

	// Rolling-last anchor is always 5m (volatile tail). Placement is orthogonal.
	const rolling: RollingPlan = {
		enabled: rollingPlacement !== "never",
		ttl: "5m",
		placement: rollingPlacement,
	};

	const plan: CachePlan = { mode, tools, system, firstUser, rolling };
	return enforceTtlOrdering(plan);
}

/**
 * Enforce Anthropic/Bedrock's cache_control ordering invariant.
 *
 * Bedrock processes cache_control blocks in a fixed order — tools, then system,
 * then messages (first-user, …, rolling-last) — and rejects any request where a
 * longer TTL ("1h") appears *after* a shorter one ("5m"):
 *
 *   "a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block"
 *
 * In `auto` mode this is easy to trip: the system prompt is always 1h, but the
 * (earlier-processed) tools anchor drops to 5m whenever the tools block is below
 * the size breakpoint — producing the illegal "5m tools → 1h system" sequence
 * that returns a fatal 400 for Bedrock-routed models (e.g. claude-opus-4-7).
 *
 * We repair the plan by walking the anchors in processing order from the tail
 * backwards and promoting any earlier *enabled* anchor whose TTL is shorter than
 * a later enabled anchor's TTL up to that longer TTL. Promotion (rather than
 * demotion) preserves the longest cache lifetime the user asked for while
 * guaranteeing TTLs are non-increasing in processing order.
 *
 * Disabled anchors carry no cache_control marker, so they are skipped (they do
 * not participate in the on-the-wire ordering).
 */
function enforceTtlOrdering(plan: CachePlan): CachePlan {
	// Processing order on the wire: tools, system, firstUser, rolling-last.
	const ordered: AnchorPlan[] = [plan.tools, plan.system, plan.firstUser, plan.rolling];
	const rank = (ttl: CacheTtl): number => (ttl === "1h" ? 1 : 0);

	// Track the maximum TTL rank seen among later (enabled) anchors and promote
	// earlier enabled anchors up to it.
	let maxLaterRank = 0;
	for (let i = ordered.length - 1; i >= 0; i--) {
		const anchor = ordered[i];
		if (!anchor.enabled) {
			continue;
		}
		if (rank(anchor.ttl) < maxLaterRank) {
			anchor.ttl = "1h";
		}
		maxLaterRank = Math.max(maxLaterRank, rank(anchor.ttl));
	}

	return plan;
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

/** Clamp the nocache↔5m floor into the supported 256–4096 range (default 4096). */
export function normalizeMinCacheTokens(raw: unknown): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 4096;
	return Math.min(4096, Math.max(256, Math.round(n)));
}
