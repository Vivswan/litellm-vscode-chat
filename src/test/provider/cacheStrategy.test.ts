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

	test("normalizeMinCacheTokens clamps to 256-4096 and defaults to 4096", () => {
		assert.equal(normalizeMinCacheTokens(1024), 1024);
		assert.equal(normalizeMinCacheTokens(0), 256);
		assert.equal(normalizeMinCacheTokens(99999), 4096);
		assert.equal(normalizeMinCacheTokens("x"), 4096);
		assert.equal(normalizeMinCacheTokens(undefined), 4096);
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
		const plan = resolveCachePlan(
			input({ mode: "auto", minCacheTokens: 1024, sizes: { tools: 2000, system: 2000, firstUser: 2000 } })
		);
		assert.equal(plan.system.ttl, "1h", "system is 1h in auto even when small (still > minCacheTokens)");
		assert.equal(plan.rolling.ttl, "5m");
	});

	test("auto mode: all stable anchors are 1h regardless of size (size only gates the floor)", () => {
		// Fix #7: in auto mode TTL is no longer tied to tokenSizeAutoBreakpoint.
		// Every stable anchor (tools / system / firstUser) that clears the
		// minCacheTokens floor uses 1h, because a 1h cache read costs the same as a
		// 5m read and refreshes for free — a longer lifetime is strictly better.
		const below = resolveCachePlan(
			input({ mode: "auto", minCacheTokens: 1024, sizes: { tools: 5000, system: 5000, firstUser: 5000 } })
		);
		assert.equal(below.tools.ttl, "1h", "tools -> 1h regardless of size");
		assert.equal(below.system.ttl, "1h", "system -> 1h regardless of size");
		assert.equal(below.firstUser.ttl, "1h", "firstUser -> 1h regardless of size");

		const above = resolveCachePlan(
			input({ mode: "auto", minCacheTokens: 1024, sizes: { tools: 12000, system: 5000, firstUser: 9000 } })
		);
		assert.equal(above.tools.ttl, "1h");
		assert.equal(above.system.ttl, "1h");
		assert.equal(above.firstUser.ttl, "1h");
	});

	test("auto mode: tokenSizeAutoBreakpoint no longer affects TTL selection", () => {
		// Sweeping the breakpoint must not change any anchor's TTL in auto mode.
		for (const bp of [4000, 8000, 16000]) {
			const plan = resolveCachePlan(
				input({
					mode: "auto",
					tokenSizeAutoBreakpoint: bp,
					minCacheTokens: 1024,
					sizes: { tools: 5000, system: 5000, firstUser: 5000 },
				})
			);
			assert.equal(plan.tools.ttl, "1h", `bp=${bp} tools`);
			assert.equal(plan.system.ttl, "1h", `bp=${bp} system`);
			assert.equal(plan.firstUser.ttl, "1h", `bp=${bp} firstUser`);
		}
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
		const plan = resolveCachePlan(
			input({ mode: "auto", minCacheTokens: 1024, sizes: { tools: 12000, system: 0, firstUser: 12000 } })
		);
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

	test("auto mode: anchors at/above floor are 1h (size no longer relevant to TTL)", () => {
		const plan = resolveCachePlan(
			input({ mode: "auto", minCacheTokens: 1024, sizes: { tools: 8000, system: 8000, firstUser: 8000 } })
		);
		assert.equal(plan.firstUser.ttl, "1h");
		assert.equal(plan.tools.ttl, "1h");
		assert.equal(plan.system.ttl, "1h");
	});
});

suite("cacheStrategy TTL ordering invariant (Bedrock/Anthropic)", () => {
	// Processing order on the wire is tools -> system -> firstUser -> rolling.
	// Bedrock rejects any request where a 1h block comes *after* a 5m block:
	//   "a ttl='1h' cache_control block must not come after a ttl='5m' block".
	// Across only the *enabled* anchors, TTL longevity must be non-increasing.
	const rank = (ttl: "5m" | "1h") => (ttl === "1h" ? 1 : 0);

	function assertNonIncreasing(plan: ReturnType<typeof resolveCachePlan>) {
		const ordered = [plan.tools, plan.system, plan.firstUser, plan.rolling].filter((a) => a.enabled);
		for (let i = 1; i < ordered.length; i++) {
			assert.ok(
				rank(ordered[i].ttl) <= rank(ordered[i - 1].ttl),
				`anchor #${i} (${ordered[i].ttl}) must not have a longer TTL than its predecessor (${ordered[i - 1].ttl})`
			);
		}
	}

	test("regression: auto mode with small tools + large system never emits 5m-before-1h (opus-4-7 400)", () => {
		// Exact shape that produced the fatal 400: tools below breakpoint (would be
		// 5m) followed by the always-1h system prompt.
		const plan = resolveCachePlan(input({ mode: "auto", sizes: { tools: 1500, system: 12000, firstUser: 1500 } }));
		assert.equal(plan.system.ttl, "1h");
		assert.equal(plan.tools.enabled, true);
		assert.equal(plan.tools.ttl, "1h", "tools must be promoted to 1h so it does not precede the 1h system block");
		assertNonIncreasing(plan);
	});

	test("invariant holds across a grid of modes and sizes", () => {
		const modes: CacheMode[] = ["chat", "agent", "auto"];
		const sizeOptions = [0, 500, 1500, 8000, 12000];
		for (const mode of modes) {
			for (const tools of sizeOptions) {
				for (const system of sizeOptions) {
					for (const firstUser of sizeOptions) {
						for (const rollingPlacement of ["always", "stableTurnsOnly", "never"] as const) {
							const plan = resolveCachePlan(input({ mode, rollingPlacement, sizes: { tools, system, firstUser } }));
							assertNonIncreasing(plan);
						}
					}
				}
			}
		}
	});

	test("disabled anchors do not participate in ordering (5m firstUser after suppressed system is fine)", () => {
		// System suppressed by the floor; tools 5m, firstUser large -> 1h. Because
		// system carries no marker, the only enabled blocks are tools(?) and
		// firstUser; ensure no violation is introduced.
		const plan = resolveCachePlan(
			input({ mode: "chat", minCacheTokens: 1024, sizes: { tools: 5000, system: 200, firstUser: 5000 } })
		);
		assert.equal(plan.system.enabled, false);
		assertNonIncreasing(plan);
	});
});
