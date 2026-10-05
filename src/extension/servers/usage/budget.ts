/**
 * Budget resolution and threshold-crossing state, pure so the unit and property suites drive them without a server or
 * a clock.
 *
 *   when BOTH exist the entry value wins for alerting and bars while the key-reported number stays in the status
 *     -> the UI can show it beside the effective one
 */

import { usableThresholds } from "../../../shared/config/settingSpec";

type BudgetSource = "entry" | "key" | "none";

export interface BudgetStatus {
	/** The declared entry's manual budget (USD), when set. */
	readonly entryBudget: number | undefined;
	/** The key-reported max_budget, when the key carries one; retained even when the entry wins. */
	readonly keyBudget: number | undefined;
	/** The budget alerting and bars run against: entry over key. */
	readonly effectiveBudget: number | undefined;
	readonly budgetSource: BudgetSource;
	readonly spend: number | undefined;
	readonly spentFraction: number | undefined;
	/** The key-reported reset instant (epoch ms), when the key carries one. */
	readonly budgetResetAt: number | undefined;
	readonly crossedThresholds: readonly number[];
}

export interface ResolveBudgetInput {
	readonly entryBudget: number | undefined;
	readonly keyBudget: number | undefined;
	readonly spend: number | undefined;
	readonly budgetResetAt: number | undefined;
	readonly thresholds: readonly number[];
}

function usableAmount(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * A usable budget: positive only. LiteLLM's zero-means-unlimited convention makes max_budget 0 "no budget", never a
 * fully-spent one; entry budgets are parsed as > 0 already, so this guards the key-reported side.
 */
function usableBudget(value: number | undefined): number | undefined {
	const amount = usableAmount(value);
	return amount !== undefined && amount > 0 ? amount : undefined;
}

export function resolveBudget(input: ResolveBudgetInput): BudgetStatus {
	const entryBudget = usableBudget(input.entryBudget);
	const keyBudget = usableBudget(input.keyBudget);
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
 * Which fractions participate is the shared usableThresholds rule, so a raw threshold list cannot smuggle a NaN or a
 * zero that every spend would "cross".
 */
export function crossedThresholds(spentFraction: number | undefined, thresholds: readonly number[]): number[] {
	if (spentFraction === undefined || !Number.isFinite(spentFraction)) {
		return [];
	}
	return usableThresholds(thresholds).filter((t) => spentFraction >= t);
}

/**
 * The thresholds crossed NOW that were not crossed before: the store's once-per-crossing dedup. Staying above a
 * threshold yields nothing new; dropping below it (a budget reset, a raised budget) re-arms it.
 */
export function newlyCrossedThresholds(previous: readonly number[], current: readonly number[]): readonly number[] {
	const before = new Set(previous);
	return current.filter((t) => !before.has(t));
}
