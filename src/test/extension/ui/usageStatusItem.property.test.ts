import * as assert from "node:assert";
import * as fc from "fast-check";
import type { BudgetStatus } from "../../../extension/servers/usage/budget";
import { resolveBudget } from "../../../extension/servers/usage/budget";
import { isUsageFresh, usageFreshnessWindowMs } from "../../../extension/servers/usage/freshness";
import type { ServerUsageState, UsageEndpointState } from "../../../extension/servers/usage/store";
import { UNPROBED_ENDPOINTS } from "../../../extension/servers/usage/store";
import { renderUsageStatus } from "../../../extension/ui/usageStatusItem";
import type { UsageStatusBarMode } from "../../../shared/config/settings";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

/**
 * Property coverage for the status bar's whole rendering decision
 * (docs/usage.md#the-status-bar): hidden exactly per the documented rules,
 * severity and the shown percentage derived from the worst FRESH server only
 * (stale servers never contribute, past-100% ratios show literally), and the
 * tooltip breakdown carrying exactly the expected line count for the server
 * set. The oracle restates the documented rules on top of the real freshness
 * module; the unit suite (usageStatusItem.test.ts) pins the concrete examples.
 */

const NOW = Date.UTC(2026, 7, 1, 12);

interface GeneratedServer {
	readonly keyInfo: UsageEndpointState;
	readonly hasKey: boolean;
	/** spendUpdatedAt as an age in freshness-window units; undefined means never updated. */
	readonly ageInWindows: number | undefined;
	readonly spend: number | undefined;
	readonly entryBudget: number | undefined;
	readonly keyBudget: number | undefined;
	readonly budgetResetAt: number | undefined;
}

const amountArb = fc.oneof(
	fc.double({ min: 0, max: 1000, noNaN: true }),
	fc.constantFrom(0, 0.004, 1, 42, 56, 112, 1e6)
);
const budgetArb = fc.option(fc.oneof(fc.double({ min: 0.01, max: 1000, noNaN: true }), fc.constantFrom(50, 100)), {
	nil: undefined,
});

const serverArb: fc.Arbitrary<GeneratedServer> = fc.record({
	keyInfo: fc.oneof(
		{ weight: 5, arbitrary: fc.constant<UsageEndpointState>({ kind: "ok" }) },
		{
			weight: 1,
			arbitrary: fc.constantFrom<UsageEndpointState>(
				{ kind: "unknown" },
				{ kind: "error" },
				{ kind: "unavailable", reason: "unsupported" }
			),
		}
	),
	hasKey: fc.boolean(),
	// Ages straddle the staleness boundary on purpose: strictly inside the
	// window is fresh, exactly the window is already stale.
	ageInWindows: fc.option(
		fc.oneof(fc.double({ min: 0, max: 3, noNaN: true }), fc.constantFrom(0, 0.5, 0.999, 1, 1.001, 2)),
		{ nil: undefined }
	),
	spend: fc.option(amountArb, { nil: undefined }),
	entryBudget: budgetArb,
	keyBudget: budgetArb,
	budgetResetAt: fc.option(fc.constant(Date.UTC(2026, 7, 31)), { nil: undefined }),
});

/**
 * A fresh server whose spend fraction lands EXACTLY on a common threshold
 * constant: these integer quotients (50/100, 80/100, 95/100, 100/100, 40/50)
 * are bit-identical to the 0.5/0.8/0.95/1 doubles thresholdsArb generates, so
 * the "reaching a threshold counts as crossing it" boundary (worst >= t) is
 * really exercised - a >=-to-> regression must fail the run.
 */
const boundaryServerArb: fc.Arbitrary<GeneratedServer> = fc
	.tuple(
		fc.constantFrom<[number, number]>([50, 100], [80, 100], [95, 100], [100, 100], [40, 50]),
		fc.option(fc.constant(Date.UTC(2026, 7, 31)), { nil: undefined })
	)
	.map(([[spend, budget], budgetResetAt]) => ({
		keyInfo: { kind: "ok" as const },
		hasKey: true,
		ageInWindows: 0.5,
		spend,
		entryBudget: undefined,
		keyBudget: budget,
		budgetResetAt,
	}));

const anyServerArb = fc.oneof({ weight: 4, arbitrary: serverArb }, { weight: 1, arbitrary: boundaryServerArb });

/** Threshold lists as the setting could carry them: usable fractions, junk, duplicates, empty. */
const thresholdsArb = fc.array(
	fc.oneof(
		{ weight: 5, arbitrary: fc.double({ min: 0.05, max: 1, noNaN: true }) },
		{ weight: 2, arbitrary: fc.constantFrom(0.5, 0.8, 0.8, 0.95, 1) },
		{ weight: 1, arbitrary: fc.constantFrom(0, -0.5, 2, Number.NaN, Number.POSITIVE_INFINITY) }
	),
	{ maxLength: 5 }
);

const modeArb = fc.constantFrom<UsageStatusBarMode>("always", "alerts-only", "off");
const pollIntervalArb = fc.constantFrom(0, 1_000, 60_000, 300_000);
const clockSkewArb = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });

function toState(server: GeneratedServer, label: string, nowMs: number, windowMs: number): ServerUsageState {
	const key = server.hasKey
		? {
				spend: server.spend,
				maxBudget: server.keyBudget,
				softBudget: undefined,
				budgetResetAt: server.budgetResetAt,
				hasUser: false,
			}
		: undefined;
	const spendUpdatedAt = server.ageInWindows === undefined ? undefined : nowMs - server.ageInWindows * windowMs;
	const budget: BudgetStatus = resolveBudget({
		entryBudget: server.entryBudget,
		keyBudget: server.hasKey ? server.keyBudget : undefined,
		spend: server.hasKey ? server.spend : undefined,
		budgetResetAt: server.hasKey ? server.budgetResetAt : undefined,
		thresholds: [],
	});
	return {
		label,
		baseUrl: `http://${label}.test`,
		endpoints: { ...UNPROBED_ENDPOINTS, keyInfo: server.keyInfo },
		availability: server.keyInfo.kind === "ok" ? "available" : "unknown",
		lastUpdatedAt: spendUpdatedAt,
		spendUpdatedAt,
		lastAttemptAt: nowMs,
		key,
		daily: undefined,
		user: undefined,
		budget,
	};
}

const scenarioArb = fc
	.record({
		servers: fc.array(anyServerArb, { maxLength: 6 }),
		thresholds: thresholdsArb,
		mode: modeArb,
		pollIntervalMs: pollIntervalArb,
		clockSkew: clockSkewArb,
	})
	.map(({ servers, thresholds, mode, pollIntervalMs, clockSkew }) => {
		const nowMs = NOW + clockSkew;
		const windowMs = usageFreshnessWindowMs(pollIntervalMs);
		return {
			states: servers.map((server, index) => toState(server, `s${index}`, nowMs, windowMs)),
			thresholds,
			mode,
			pollIntervalMs,
			nowMs,
		};
	});

/** The documented aggregation rules, restated: who contributes, the worst ratio, and the severity scale. */
function oracle(
	states: readonly ServerUsageState[],
	nowMs: number,
	pollIntervalMs: number,
	thresholds: readonly number[]
) {
	const contributing = states.filter(
		(state) => isUsageFresh(state, nowMs, pollIntervalMs) && state.budget.spentFraction !== undefined
	);
	const fractions = contributing.map((state) => state.budget.spentFraction ?? 0);
	const worst = fractions.length > 0 ? Math.max(...fractions) : undefined;
	const usable = [...new Set(thresholds.filter((t) => Number.isFinite(t) && t > 0 && t <= 1))].sort((a, b) => a - b);
	const lowest = usable[0];
	const highest = usable.at(-1);
	const severity =
		worst === undefined
			? undefined
			: highest !== undefined && worst >= highest
				? "error"
				: lowest !== undefined && worst >= lowest
					? "warning"
					: "plain";
	return { fractions, worst, lowest, highest, severity };
}

suite("extension/ui renderUsageStatus properties", () => {
	test("hidden exactly per the documented rules; otherwise the worst fresh ratio shows literally", () => {
		fc.assert(
			fc.property(scenarioArb, ({ states, thresholds, mode, pollIntervalMs, nowMs }) => {
				const view = renderUsageStatus(states, nowMs, pollIntervalMs, thresholds, mode, "$");
				const { worst, severity } = oracle(states, nowMs, pollIntervalMs, thresholds);

				const expectHidden = mode === "off" || worst === undefined || (mode === "alerts-only" && severity === "plain");
				if (expectHidden) {
					assert.strictEqual(view, "hidden");
					return;
				}
				assert.ok(view !== "hidden", "a contributing server must render");
				// The literal worst-fresh ratio: 112% stays 112%, no clamping.
				assert.strictEqual(view.text, `${Math.round((worst as number) * 100)}%`);
				assert.strictEqual(view.severity, severity);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("severity escalates at the usable thresholds only: warning at the lowest, error at the highest, single-threshold lists alarm directly", () => {
		// Self-enforcing coverage: the boundary arm must actually land runs with
		// worst EXACTLY on a usable threshold, and the warning band must fire.
		let boundaryHits = 0;
		let warnings = 0;
		fc.assert(
			fc.property(scenarioArb, ({ states, thresholds, pollIntervalMs, nowMs }) => {
				const view = renderUsageStatus(states, nowMs, pollIntervalMs, thresholds, "always", "$");
				const { worst, lowest, highest, severity } = oracle(states, nowMs, pollIntervalMs, thresholds);
				if (view === "hidden" || worst === undefined) {
					return;
				}
				if (thresholds.includes(worst)) {
					boundaryHits += 1;
				}
				assert.strictEqual(view.severity, severity);
				if (view.severity === "warning") {
					warnings += 1;
				}
				if (lowest === undefined) {
					assert.strictEqual(view.severity, "plain", "an empty usable list renders plain forever");
				}
				if (lowest !== undefined && lowest === highest) {
					assert.strictEqual(
						view.severity,
						worst >= lowest ? "error" : "plain",
						"a single-threshold list goes straight to error, never warning"
					);
				}
				if (view.severity === "error") {
					assert.ok(highest !== undefined && worst >= highest);
				}
				if (view.severity === "warning") {
					assert.ok(lowest !== undefined && worst >= lowest && (highest === undefined || worst < highest));
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
		if (NUM_RUNS >= 200) {
			assert.ok(boundaryHits > 0, "no run landed a fraction exactly on a threshold; the boundary arm regressed");
			assert.ok(warnings > 0, "no run rendered the warning band; the generators regressed");
		}
	});

	test("adding stale or budget-less servers never changes visibility, the number, or the severity", () => {
		const spoilerArb = fc.constantFrom<"stale" | "no-key" | "endpoint-error" | "no-spend">(
			"stale",
			"no-key",
			"endpoint-error",
			"no-spend"
		);
		fc.assert(
			fc.property(
				scenarioArb,
				fc.array(fc.tuple(anyServerArb, spoilerArb), { minLength: 1, maxLength: 3 }),
				(scenario, extras) => {
					const { states, thresholds, mode, pollIntervalMs, nowMs } = scenario;
					const windowMs = usageFreshnessWindowMs(pollIntervalMs);
					// Each extra is spoiled out of the aggregation by construction (no
					// filter: the property always exercises a non-empty addition), one
					// spoiler per documented exclusion rule.
					const nonContributing = extras.map(([extra, spoiler], index) => {
						const spoiled: GeneratedServer =
							spoiler === "stale"
								? { ...extra, ageInWindows: 2 }
								: spoiler === "no-key"
									? { ...extra, hasKey: false }
									: spoiler === "endpoint-error"
										? { ...extra, keyInfo: { kind: "error" } }
										: { ...extra, spend: undefined };
						const state = toState(spoiled, `x${index}`, nowMs, windowMs);
						assert.ok(
							!(isUsageFresh(state, nowMs, pollIntervalMs) && state.budget.spentFraction !== undefined),
							"a spoiled extra must never contribute"
						);
						return state;
					});
					const before = renderUsageStatus(states, nowMs, pollIntervalMs, thresholds, mode, "$");
					const after = renderUsageStatus(
						[...states, ...nonContributing],
						nowMs,
						pollIntervalMs,
						thresholds,
						mode,
						"$"
					);
					if (before === "hidden") {
						assert.strictEqual(after, "hidden", "servers outside the aggregation cannot summon the item");
						return;
					}
					assert.ok(after !== "hidden", "servers outside the aggregation cannot hide the item");
					assert.strictEqual(after.text, before.text, "a stale server must never drive the number");
					assert.strictEqual(after.severity, before.severity, "a stale server must never drive the color");
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("the tooltip carries the expected line count for the server set", () => {
		fc.assert(
			fc.property(scenarioArb, ({ states, thresholds, mode, pollIntervalMs, nowMs }) => {
				const view = renderUsageStatus(states, nowMs, pollIntervalMs, thresholds, mode, "$");
				if (view === "hidden") {
					return;
				}
				// Every server with spend data keeps its row, stale or not: one
				// headline line, plus one detail line when a reset or update stamp
				// exists; plus at most one trailing "others over threshold" line.
				const perServer = states.reduce((sum, state) => {
					if (state.budget.spend === undefined) {
						return sum;
					}
					const hasDetails = state.budget.budgetResetAt !== undefined || state.spendUpdatedAt !== undefined;
					return sum + (hasDetails ? 2 : 1);
				}, 0);
				const { fractions, worst, lowest } = oracle(states, nowMs, pollIntervalMs, thresholds);
				const overCount = lowest === undefined ? 0 : fractions.filter((fraction) => fraction >= lowest).length;
				const others = overCount - (worst !== undefined && lowest !== undefined && worst >= lowest ? 1 : 0);
				const expected = perServer + (others > 0 ? 1 : 0);
				assert.strictEqual(
					view.tooltipLines.length,
					expected,
					`tooltip must carry ${expected} lines for this server set`
				);
				for (const line of view.tooltipLines) {
					assert.ok(
						!line.includes("NaN") && !line.includes("undefined"),
						`a tooltip line must never render junk: ${line}`
					);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
