import * as assert from "assert";
import {
	resolveCachePlan,
	normalizeMode,
	normalizeRollingPlacement,
	normalizeAutoBreakpoint,
	normalizeMinCacheTokens,
	type CacheStrategyInput,
	type CacheMode,
} from "../../provider/cacheStrategy";

function input(overrides: Partial<CacheStrategyInput> = {}): CacheStrategyInput {
	return {
		mode: "auto",
		supportsPromptCaching: true,
		rollingPlacement: "stableTurnsOnly",
		tokenSizeAutoBreakpoint: 8000,
		minCacheTokens: 1024,
		sizes: { tools: 12000, system: 5000, firstUser: 5000 },
		...overrides,
	};
}

suite("cacheStrategy normalizers", () => {
	test("normalizeMode defaults to auto for unknown values", () => {
		assert.equal(normalizeMode("off"), "off");
		assert.equal(normalizeMode("chat"), "chat");
		assert.equal(normalizeMode("agent"), "agent");
		assert.equal(normalizeMode("auto"), "auto");
		assert.equal(normalizeMode("nonsense"), "auto");
		assert.equal(normalizeMode(undefined), "auto");
	});

	test("normalizeRollingPlacement defaults to stableTurnsOnly", () => {
		assert.equal(normalizeRollingPlacement("always"), "always");
		assert.equal(normalizeRollingPlacement("never"), "never");
		assert.equal(normalizeRollingPlacement("stableTurnsOnly"), "stableTurnsOnly");
		assert.equal(normalizeRollingPlacement("garbage"), "stableTurnsOnly");
		assert.equal(normalizeRollingPlacement(123), "stableTurnsOnly");
	});

	test("normalizeAutoBreakpoint clamps to 4000-16000 and defaults to 8000", () => {
		assert.equal(normalizeAutoBreakpoint(8000), 8000);
		assert.equal(normalizeAutoBreakpoint(100), 4000);
		assert.equal(normalizeAutoBreakpoint(999999), 16000);
		assert.equal(normalizeAutoBreakpoint("nope"), 8000);
		assert.equal(normalizeAutoBreakpoint(NaN), 8000);
		assert.equal(normalizeAutoBreakpoint(8000.6), 8001);
	});

	test("normalizeMinCacheTokens clamps to 256-4096 and defaults to 1024", () => {
		assert.equal(normalizeMinCacheTokens(1024), 1024);
		assert.equal(normalizeMinCacheTokens(0), 256);
		assert.equal(normalizeMinCacheTokens(99999), 4096);
		assert.equal(normalizeMinCacheTokens("x"), 1024);
		assert.equal(normalizeMinCacheTokens(undefined), 1024);
	});
});

suite("cacheStrategy resolveCachePlan", () => {
	test("off mode disables everything", () => {
		const plan = resolveCachePlan(input({ mode: "off" }));
		assert.equal(plan.mode, "off");
		assert.equal(plan.tools.enabled, false);
		assert.equal(plan.system.enabled, false);
		assert.equal(plan.firstUser.enabled, false);
		assert.equal(plan.rolling.enabled, false);
	});

	test("unsupported model disables everything regardless of mode", () => {
		for (const mode of ["chat", "agent", "auto"] as CacheMode[]) {
			const plan = resolveCachePlan(input({ mode, supportsPromptCaching: false }));
			assert.equal(plan.tools.enabled, false, `${mode} tools`);
			assert.equal(plan.system.enabled, false, `${mode} system`);
			assert.equal(plan.firstUser.enabled, false, `${mode} firstUser`);
			assert.equal(plan.rolling.enabled, false, `${mode} rolling`);
		}
	});

	test("chat mode caches all four anchors at 5m", () => {
		const plan = resolveCachePlan(input({ mode: "chat" }));
		assert.equal(plan.tools.enabled, true);
		assert.equal(plan.tools.ttl, "5m");
		assert.equal(plan.system.ttl, "5m");
		assert.equal(plan.firstUser.ttl, "5m");
		assert.equal(plan.rolling.enabled, true);
		assert.equal(plan.rolling.ttl, "5m");
	});

	test("agent mode caches head at 1h and rolling at 5m", () => {
		const plan = resolveCachePlan(input({ mode: "agent" }));
		assert.equal(plan.tools.ttl, "1h");
		assert.equal(plan.system.ttl, "1h");
		assert.equal(plan.firstUser.ttl, "1h");
		assert.equal(plan.rolling.ttl, "5m");
	});

	test("auto mode: system always 1h, rolling always 5m", () => {
		const plan = resolveCachePlan(input({ mode: "auto", sizes: { tools: 2000, system: 2000, firstUser: 2000 } }));
		assert.equal(plan.system.ttl, "1h", "system is 1h in auto even when small (still > minCacheTokens)");
		assert.equal(plan.rolling.ttl, "5m");
	});

	test("auto mode: firstUser and tools gated by tokenSizeAutoBreakpoint", () => {
		const below = resolveCachePlan(input({ mode: "auto", sizes: { tools: 5000, system: 5000, firstUser: 5000 } }));
		assert.equal(below.firstUser.ttl, "5m", "firstUser below 8k -> 5m");
		assert.equal(below.tools.ttl, "5m", "tools below 8k -> 5m");

		const above = resolveCachePlan(input({ mode: "auto", sizes: { tools: 12000, system: 5000, firstUser: 9000 } }));
		assert.equal(above.firstUser.ttl, "1h", "firstUser above 8k -> 1h");
		assert.equal(above.tools.ttl, "1h", "tools above 8k -> 1h");
	});

	test("minCacheTokens floor suppresses anchors below the floor in every mode", () => {
		for (const mode of ["chat", "agent", "auto"] as CacheMode[]) {
			const plan = resolveCachePlan(
				input({ mode, minCacheTokens: 1024, sizes: { tools: 500, system: 500, firstUser: 500 } })
			);
			assert.equal(plan.tools.enabled, false, `${mode} tiny tools suppressed`);
			assert.equal(plan.system.enabled, false, `${mode} tiny system suppressed`);
			assert.equal(plan.firstUser.enabled, false, `${mode} tiny firstUser suppressed`);
			// rolling does not depend on static sizes; placement-driven.
			assert.equal(plan.rolling.enabled, true, `${mode} rolling unaffected by static floor`);
		}
	});

	test("degenerate absent system prompt (size 0) is not cached", () => {
		const plan = resolveCachePlan(input({ mode: "auto", sizes: { tools: 12000, system: 0, firstUser: 12000 } }));
		assert.equal(plan.system.enabled, false, "absent system prompt must not be tagged");
		assert.equal(plan.firstUser.enabled, true);
		assert.equal(plan.tools.enabled, true);
	});

	test("rolling placement 'never' disables rolling anchor in all modes", () => {
		for (const mode of ["chat", "agent", "auto"] as CacheMode[]) {
			const plan = resolveCachePlan(input({ mode, rollingPlacement: "never" }));
			assert.equal(plan.rolling.enabled, false, `${mode}`);
			assert.equal(plan.rolling.placement, "never");
		}
	});

	test("rolling placement is passed through orthogonally to mode", () => {
		const plan = resolveCachePlan(input({ mode: "agent", rollingPlacement: "always" }));
		assert.equal(plan.rolling.placement, "always");
		assert.equal(plan.rolling.enabled, true);
		// mode still controls head TTL
		assert.equal(plan.system.ttl, "1h");
	});

	test("auto mode boundary: exactly at breakpoint counts as 1h (>=)", () => {
		const plan = resolveCachePlan(
			input({ mode: "auto", tokenSizeAutoBreakpoint: 8000, sizes: { tools: 8000, system: 8000, firstUser: 8000 } })
		);
		assert.equal(plan.firstUser.ttl, "1h", "size == breakpoint -> 1h");
		assert.equal(plan.tools.ttl, "1h", "size == breakpoint -> 1h");
	});
});
