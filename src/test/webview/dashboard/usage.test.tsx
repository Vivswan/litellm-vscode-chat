/**
 * The Usage tab (docs/usage.md#the-usage-panel): cards, budgets, the
 * refresh-now gate, the empty states, and the bar presentation math.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { barPresentation, formatPercent, formatUsd, UsageSection } from "../../../webview/dashboard/usage";
import { makeUsage, makeUsageServer } from "../fixtures";
import { buttonByText, cleanup, fireClick, mount, postedMessages, resetPosted, textOf } from "../harness";

const NOW = 1_700_000_000_000;

beforeEach(resetPosted);
afterEach(cleanup);

describe("barPresentation", () => {
	test("tones scale to the configured thresholds, crossing at >=", () => {
		expect(barPresentation(0.5, [0.8, 0.95]).tone).toBe("ok");
		expect(barPresentation(0.8, [0.8, 0.95]).tone).toBe("warn");
		expect(barPresentation(0.95, [0.8, 0.95]).tone).toBe("error");
	});

	test("a single-threshold list goes straight to error", () => {
		expect(barPresentation(0.5, [0.5]).tone).toBe("error");
	});

	test("an empty list never escalates and the fill clamps at 100%", () => {
		const over = barPresentation(1.12, []);
		expect(over.tone).toBe("ok");
		expect(over.widthPercent).toBe(100);
	});
});

describe("formatting", () => {
	test("percentages show the literal number past 100", () => {
		expect(formatPercent(1.12)).toBe("112%");
	});

	test("dollar amounts keep cents below $1000", () => {
		expect(formatUsd(12.5)).toBe("$12.50");
		expect(formatUsd(1500)).toBe("$1,500");
	});
});

describe("UsageSection", () => {
	test("renders one card per usage server with spend, percentage, and both budgets", () => {
		const usage = makeUsage({
			servers: [
				makeUsageServer({
					label: "prod",
					spend: 40,
					effectiveBudget: 50,
					entryBudget: 50,
					keyBudget: 100,
					budgetSource: "entry",
					spentFraction: 0.8,
					lastUpdatedAt: NOW - 60_000,
				}),
			],
		});
		const root = mount(<UsageSection usage={usage} serverCount={1} now={NOW} />);
		expect(textOf(root, ".usage-label")).toBe("prod");
		expect(textOf(root, ".usage-spend")).toContain("$40.00");
		expect(textOf(root, ".usage-percent")).toBe("80%");
		const budgetLine = textOf(root, ".usage-budget-line");
		expect(budgetLine).toContain("$50.00");
		// Both budgets stay in view when the entry's value wins (docs/usage.md#budgets).
		expect(budgetLine).toContain("$100.00");
	});

	test("a server without a budget shows spend and the no-percentage note", () => {
		const usage = makeUsage({
			servers: [
				makeUsageServer({
					spend: 3,
					effectiveBudget: undefined,
					keyBudget: undefined,
					entryBudget: undefined,
					budgetSource: "none",
					spentFraction: undefined,
				}),
			],
		});
		const root = mount(<UsageSection usage={usage} serverCount={1} now={NOW} />);
		expect(root.querySelector(".usage-percent")).toBeNull();
		expect(root.querySelector(".usage-bar")).toBeNull();
		expect(root.querySelector(".usage-card")?.textContent).toContain("No budget");
	});

	test("stale data stays visible, labeled stale with its age", () => {
		const usage = makeUsage({
			servers: [makeUsageServer({ fresh: false, lastUpdatedAt: NOW - 25 * 60_000 })],
		});
		const root = mount(<UsageSection usage={usage} serverCount={1} now={NOW} />);
		const head = textOf(root, ".usage-card-head");
		expect(head).toContain("stale");
		expect(head).toContain("25");
	});

	test("Refresh now posts the intent and disables while a pass is in flight", () => {
		const root = mount(<UsageSection usage={makeUsage({ servers: [makeUsageServer()] })} serverCount={1} now={NOW} />);
		fireClick(buttonByText(root, "Refresh now"));
		expect(postedMessages).toEqual([{ type: "refreshUsage" }]);
		cleanup();
		const busy = mount(
			<UsageSection usage={makeUsage({ refreshing: true, servers: [makeUsageServer()] })} serverCount={1} now={NOW} />
		);
		const refreshing = Array.from(busy.querySelectorAll("button")).find((button) =>
			(button.textContent ?? "").includes("Refreshing")
		);
		expect(refreshing?.disabled).toBe(true);
	});

	test("the empty states distinguish no servers from no usage-tracking servers", () => {
		const none = mount(<UsageSection usage={makeUsage()} serverCount={0} now={NOW} />);
		expect(none.textContent).toContain("No servers configured");
		cleanup();
		const noUsage = mount(<UsageSection usage={makeUsage()} serverCount={2} now={NOW} />);
		expect(noUsage.textContent).toContain("None of your servers serves usage data");
	});

	test("the data-follows-the-key note renders on the tab", () => {
		const root = mount(<UsageSection usage={makeUsage()} serverCount={1} now={NOW} />);
		expect(root.textContent).toContain("rotating an entry's key switches its numbers");
	});
});
