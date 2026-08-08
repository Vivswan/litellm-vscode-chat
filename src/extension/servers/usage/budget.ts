/**
 * Budget resolution and threshold-crossing state, pure so the unit and
 * property suites drive them without a server or a clock.
 *
 * The precedence rule (settled in #232): the key-reported max_budget is the
 * truth when present, a declared entry's manual `budget` covers keys without
 * one, and when BOTH exist the entry value wins for alerting and bars while
 * the key-reported number stays in the status so the UI can show it beside
 * the effective one ("budget $50 (key reports $100)").
 */

/** Which source provided the effective budget. */
type BudgetSource = "entry" | "key" | "none";

/** One server's resolved budget position, numbers only. */
export interface BudgetStatus {
	/** The declared entry's manual budget (USD), when set. */
	readonly entryBudget: number | undefined;
	/** The key-reported max_budget, when the key carries one; retained even when the entry wins. */
	readonly keyBudget: number | undefined;
	/** The budget alerting and bars run against: entry over key. */
	readonly effectiveBudget: number | undefined;
	readonly budgetSource: BudgetSource;
	/** The key-reported spend the fraction is computed from. */
	readonly spend: number | undefined;
	/** spend / effectiveBudget, when both are known and the budget is positive. */
	readonly spentFraction: number | undefined;
	/** The key-reported reset instant (epoch ms), when the key carries one. */
	readonly budgetResetAt: number | undefined;
	/** The configured alert fractions the spend currently sits at or above, ascending. */
	readonly crossedThresholds: readonly number[];
}

export interface ResolveBudgetInput {
	readonly entryBudget: number | undefined;
	readonly keyBudget: number | undefined;
	readonly spend: number | undefined;
	readonly budgetResetAt: number | undefined;
	readonly thresholds: readonly number[];
}

/** A usable budget or spend number: finite and non-negative (budgets additionally positive to divide by). */
function usableAmount(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function resolveBudget(input: ResolveBudgetInput): BudgetStatus {
	const entryBudget = usableAmount(input.entryBudget);
	const keyBudget = usableAmount(input.keyBudget);
	const spend = usableAmount(input.spend);
	const effectiveBudget = entryBudget ?? keyBudget;
	const budgetSource: BudgetSource = entryBudget !== undefined ? "entry" : keyBudget !== undefined ? "key" : "none";
	const spentFraction =
		spend !== undefined && effectiveBudget !== undefined && effectiveBudget > 0 ? spend / effectiveBudget : undefined;
	return {
		entryBudget,
		keyBudget,
		effectiveBudget,
		budgetSource,
		spend,
		spentFraction,
		budgetResetAt: input.budgetResetAt,
		crossedThresholds: crossedThresholds(spentFraction, input.thresholds),
	};
}

/**
 * The configured alert fractions the spend fraction sits at or above,
 * deduplicated and ascending. An unknown fraction crosses nothing. Only
 * usable fractions participate (finite, in (0, 1]), so a raw threshold list
 * cannot smuggle a NaN or a zero that every spend would "cross".
 */
export function crossedThresholds(spentFraction: number | undefined, thresholds: readonly number[]): number[] {
	if (spentFraction === undefined || !Number.isFinite(spentFraction)) {
		return [];
	}
	const usable = thresholds.filter((t) => Number.isFinite(t) && t > 0 && t <= 1);
	return [...new Set(usable)].filter((t) => spentFraction >= t).sort((a, b) => a - b);
}

/**
 * The thresholds crossed NOW that were not crossed before: the store's
 * once-per-crossing dedup. Staying above a threshold yields nothing new;
 * dropping below it (a budget reset, a raised budget) re-arms it, so the next
 * crossing reports again. The previous list is intersected against the
 * current crossings implicitly: a threshold removed from the configuration
 * simply stops appearing on either side.
 */
export function newlyCrossedThresholds(previous: readonly number[], current: readonly number[]): readonly number[] {
	const before = new Set(previous);
	return current.filter((t) => !before.has(t));
}
