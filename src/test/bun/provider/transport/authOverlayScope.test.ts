/**
 * The fail-closed census on the auth-overlay scope: applyAuthOverlay captures
 * the sent OAuth token inside the scope it returns, and the ONE duty left at
 * each token-sending call site is routing the request's classified failure
 * through scope.fail. That routing cannot be made unforgettable by types (a
 * returned scope can be dropped), so this census pins it: every shipped call
 * site of applyAuthOverlay is registered here with its expected fail routing
 * count, and a new call site - or a site whose routing was removed - fails
 * this suite until the registry says what its invalidation story is. The
 * SEMANTICS of each routing are pinned behaviorally beside the transports
 * (oneShotClient.test.ts, oauthGroups.test.ts, spendClient.test.ts: a 401
 * makes the next call exchange afresh); this census is the guard that no
 * token-sending path exists outside those pins.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../util/repoRoot";

/** The module that DEFINES applyAuthOverlay; excluded from the call-site walk. */
const OVERLAY_MODULE = "src/provider/transport/authOverlay.ts";

interface CallSiteRegistration {
	/** How many applyAuthOverlay calls the file makes. */
	readonly overlayCalls: number;
	/** How many `.fail(` routings the file carries for them. */
	readonly failRoutings: number;
	/** Why a file may carry fewer routings than calls; required exactly then. */
	readonly pairlessBecause?: string;
}

const REGISTRY: Record<string, CallSiteRegistration> = {
	// One overlay application (resolveAuthHeaders) serves two request paths;
	// fetchModels and send each route their classified failure.
	"src/provider/transport/chatClient.ts": { overlayCalls: 1, failRoutings: 2 },
	// postJson routes its mapped failure; authHeaders composes headers the
	// EDITOR sends, so no response of ours ever comes back to route.
	"src/provider/transport/oneShotClient.ts": {
		overlayCalls: 2,
		failRoutings: 1,
		pairlessBecause: "authHeaders hands composed headers to the editor; the editor owns every response to them",
	},
	// getJson routes the non-ok usage rejection before throwing it.
	"src/extension/servers/usage/spendClient.ts": { overlayCalls: 1, failRoutings: 1 },
};

/** Every shipped .ts/.tsx source file, the test tree excluded. */
function shippedSourceFiles(): string[] {
	const srcDir = path.join(REPO_ROOT, "src");
	const testDir = path.join(srcDir, "test");
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				return full === testDir ? [] : walk(full);
			}
			return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
		});
	return walk(srcDir);
}

function countMatches(source: string, pattern: RegExp): number {
	return source.match(pattern)?.length ?? 0;
}

describe("provider/transport auth-overlay scope census", () => {
	test("every shipped applyAuthOverlay call site is registered with its fail routing", () => {
		const observed = new Map<string, { overlayCalls: number; failRoutings: number }>();
		for (const file of shippedSourceFiles()) {
			const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
			if (relative === OVERLAY_MODULE) {
				continue;
			}
			const source = readFileSync(file, "utf8");
			const overlayCalls = countMatches(source, /applyAuthOverlay\(/g);
			if (overlayCalls === 0) {
				continue;
			}
			// `.fail(` is the scope's one member; these transports use no other
			// fail-named API, so the count is the routing count.
			observed.set(relative, { overlayCalls, failRoutings: countMatches(source, /\.fail\(/g) });
		}

		expect([...observed.keys()].sort()).toEqual(Object.keys(REGISTRY).sort());
		for (const [file, registered] of Object.entries(REGISTRY)) {
			const counts = observed.get(file);
			expect(counts, `${file} no longer calls applyAuthOverlay; retire its registry row`).toBeDefined();
			expect(counts?.overlayCalls, `${file}: applyAuthOverlay call count drifted from the registry`).toBe(
				registered.overlayCalls
			);
			expect(counts?.failRoutings, `${file}: scope.fail routing count drifted from the registry`).toBe(
				registered.failRoutings
			);
		}
	});

	test("the registry itself is coherent: fewer routings than calls requires a stated reason", () => {
		for (const [file, registered] of Object.entries(REGISTRY)) {
			if (registered.failRoutings < registered.overlayCalls) {
				expect(
					registered.pairlessBecause,
					`${file} carries fewer fail routings than overlay calls without saying why`
				).toBeDefined();
			} else {
				expect(
					registered.pairlessBecause,
					`${file} pairs every call; a pairless reason there would rot into cover for a real omission`
				).toBeUndefined();
			}
		}
	});
});

/**
 * The module that DECLARES TimeoutBudget; its `setting:` union member list
 * would read as a mint to the sweep below, so it is excluded and its own
 * totality is guarded in-code (timeoutError's satisfies-never default).
 */
const BUDGET_MODULE = "src/provider/transport/auth.ts";

/**
 * Every shipped TimeoutBudget mint: which setting identity each caller states
 * where it reads its timeout number. The advice pipeline renders whatever the
 * budget says, so THIS registry is where a wrong pairing is caught: a new
 * mint, a moved mint, or a changed setting fails here until the row says
 * which clock really bounds that caller. Reviewed against the read beside it
 * (e.g. getRequestTimeout pairs with "chat.timeout", getDiscoveryTimeout with
 * "discovery.timeout", a fixed in-code bound with undefined).
 */
const BUDGET_MINTS: Record<string, { readonly [setting in "chat.timeout" | "discovery.timeout" | "fixed"]?: number }> =
	{
		// The one-shot chat features' whole-call bound is the chat request timeout.
		"src/extension/features/featureChatSend.ts": { "chat.timeout": 1 },
		// The FIM bound is fixed in code; no setting can raise it.
		"src/extension/features/inline/wiring.ts": { fixed: 1 },
		// The MCP publisher's header composition is bounded like discovery.
		"src/extension/features/mcp/provider.ts": { "discovery.timeout": 1 },
		// Both chat-client surfaces bound the exchange by the discovery timeout
		// (auth plumbing with its own budget): fetchModels and send.
		"src/provider/transport/chatClient.ts": { "discovery.timeout": 2 },
		// Usage polling follows the discovery transport conventions.
		"src/extension/servers/usage/spendClient.ts": { "discovery.timeout": 1 },
	};

describe("provider/transport timeout budget mints", () => {
	test("every shipped TimeoutBudget mint is registered with the setting its clock is really owned by", () => {
		const observed = new Map<string, Record<string, number>>();
		for (const file of shippedSourceFiles()) {
			const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
			if (relative === BUDGET_MODULE) {
				continue;
			}
			const source = readFileSync(file, "utf8");
			const counts: Record<string, number> = {};
			const chat = countMatches(source, /\bsetting: "chat\.timeout"/g);
			const discovery = countMatches(source, /\bsetting: "discovery\.timeout"/g);
			const fixed = countMatches(source, /\bsetting: undefined\b/g);
			if (chat > 0) {
				counts["chat.timeout"] = chat;
			}
			if (discovery > 0) {
				counts["discovery.timeout"] = discovery;
			}
			if (fixed > 0) {
				counts.fixed = fixed;
			}
			if (Object.keys(counts).length > 0) {
				observed.set(relative, counts);
			}
		}

		expect([...observed.keys()].sort()).toEqual(Object.keys(BUDGET_MINTS).sort());
		for (const [file, registered] of Object.entries(BUDGET_MINTS)) {
			expect(observed.get(file), `${file}: the minted budget settings drifted from the registry`).toEqual(
				registered as Record<string, number>
			);
		}
	});
});
