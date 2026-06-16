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
	/** Deprecated compatibility setting; no longer affects auto TTL selection. */
	tokenSizeAutoBreakpoint: number;
	/** nocache↔5m floor in tokens (all modes). Anchors below this are skipped. */
	minCacheTokens: number;
	/** Estimated anchor sizes for min-floor checks. */
	sizes: AnchorSizes;
	/**
	 * Whether the target backend silently downgrades the *tools* cache_control
	 * block to the 5m tier even when 1h is requested (observed on AWS Bedrock,
	 * which honors 1h on `system`/messages but not on the tools cachePoint).
	 *
	 * When true, a 1h tools marker that precedes a 1h `system`/message block on
	 * the wire would arrive as "5m tools → 1h system" and trip Bedrock's
	 * non-increasing-TTL ordering invariant (a fatal 400). The resolver repairs
	 * this by dropping the tools marker entirely so the honored-1h `system`
	 * block leads. Defaults to false (direct Anthropic honors tools 1h).
	 */
	toolsCache1hUnsupported?: boolean;
	/**
	 * Whether the target backend rejects Anthropic-style inline `cache_control`
	 * markers entirely (observed on Google Vertex AI / Gemini). Vertex implements
	 * caching via a separate `CachedContent` handle and forbids sending tools /
	 * tool_config / system instruction in a request that also references cached
	 * content — so any `cache_control` marker we add makes LiteLLM's vertex_ai
	 * adapter switch into cached-content mode and the still-present tools/system
	 * trigger a fatal 400 ("Tool config, tools and system instruction should not
	 * be set in the request when using cached content").
	 *
	 * When true the resolver returns the fully disabled plan: we emit no markers
	 * and let Vertex's own implicit server-side caching handle reuse (which it
	 * does automatically — observed cache_read without any markers).
	 */
	cacheControlIncompatible?: boolean;
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
 * `tokenSizeAutoBreakpoint` is retained for backward compatibility but no
 * longer selects the TTL tier in `auto` mode.
 *
 * Universal rules (all modes):
 *  - If the model does not support prompt caching, returns the disabled plan.
 *  - If the backend rejects inline `cache_control` markers entirely
 *    (`cacheControlIncompatible`, e.g. Google Vertex / Gemini), returns the
 *    disabled plan and relies on the backend's implicit server-side caching.
 *  - A static anchor whose estimated block size is below `minCacheTokens` is
 *    suppressed (the provider would not cache it anyway). This also handles the
 *    degenerate "tiny / missing system prompt" case.
 *  - The rolling anchor's *placement* comes from `rollingPlacement` and is
 *    orthogonal to `mode`. `placement === "never"` disables the rolling anchor
 *    regardless of mode.
 */
export function resolveCachePlan(input: CacheStrategyInput): CachePlan {
	const { mode, supportsPromptCaching, rollingPlacement, minCacheTokens, sizes } = input;

	// Vertex / Gemini reject inline cache_control markers entirely; emit none and
	// rely on the backend's implicit server-side caching. Checked before the
	// supportsPromptCaching gate so the disabled plan still preserves `mode`.
	if (input.cacheControlIncompatible === true) {
		return { ...DISABLED, mode: mode === "off" ? "off" : mode };
	}

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
	enforceTtlOrdering(plan);
	return dropUnsafeToolsAnchor(plan, input.toolsCache1hUnsupported === true);
}

/**
 * Work around backends (AWS Bedrock) that downgrade the *tools* cache_control
 * block to 5m even when 1h is requested.
 *
 * Bedrock processes cache blocks tools → system → messages and rejects any 1h
 * block that follows a 5m block. Because the tools cachePoint is silently
 * downgraded to 5m while `system`/messages keep their requested 1h, a uniform
 * 1h plan still arrives on the wire as the illegal "5m tools → 1h system"
 * sequence — a fatal 400 we cannot prevent by tuning the requested TTL.
 *
 * The only safe repair is to drop the tools marker entirely whenever a later
 * (still-1h) anchor exists, so the honored-1h `system` block becomes the first
 * cached block. When no later anchor is 1h, the tools marker is harmless (it is
 * simply honored as 5m by the backend) and is left in place.
 */
function dropUnsafeToolsAnchor(plan: CachePlan, toolsCache1hUnsupported: boolean): CachePlan {
	if (!toolsCache1hUnsupported || !plan.tools.enabled || plan.tools.ttl !== "1h") {
		return plan;
	}
	// Only the stable anchors can hold a 1h TTL today; the rolling-last anchor is
	// always 5m (volatile tail), so it can never be the "later 1h block" that
	// forces the tools drop and is intentionally excluded here.
	const laterHas1h =
		(plan.system.enabled && plan.system.ttl === "1h") || (plan.firstUser.enabled && plan.firstUser.ttl === "1h");
	if (laterHas1h) {
		plan.tools = { enabled: false, ttl: plan.tools.ttl };
	}
	return plan;
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
 * Earlier versions of the resolver could mix 5m and 1h static anchors in a way
 * that produced an illegal "5m tools → 1h system" sequence for Bedrock-routed
 * models (e.g. claude-opus-4-7). Keep this guard so future mode or setting
 * changes cannot reintroduce that fatal 400.
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

/** Clamp the deprecated compatibility breakpoint into the supported 4k–16k range (default 8000). */
export function normalizeAutoBreakpoint(raw: unknown): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 8000;
	return Math.min(16000, Math.max(4000, Math.round(n)));
}

/** Clamp the nocache↔5m floor into the supported 256–4096 range (default 4096). */
export function normalizeMinCacheTokens(raw: unknown): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 4096;
	return Math.min(4096, Math.max(256, Math.round(n)));
}
