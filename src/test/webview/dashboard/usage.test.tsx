/**
 * The Usage tab (docs/usage.md#the-usage-panel): cards, budgets, the
 * refresh-now gate, the empty states, and the bar presentation math.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UsageServerView } from "../../../extension/dashboard/protocol";
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

	test("a stale age names its cause: transient failure, denied access, or merely old", () => {
		const at = NOW - 25 * 60_000;
		const failed = mount(
			<UsageSection
				usage={makeUsage({
					servers: [makeUsageServer({ fresh: false, lastUpdatedAt: at, keyInfo: { kind: "error", status: 429 } })],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(failed, ".usage-card-head")).toContain("last updated 25 min ago - last refresh failed");
		expect(textOf(failed, ".usage-detail")).toContain("LiteLLM /key/info: HTTP 429 on the last attempt");
		cleanup();
		const denied = mount(
			<UsageSection
				usage={makeUsage({
					servers: [
						makeUsageServer({
							fresh: false,
							lastUpdatedAt: at,
							keyInfo: { kind: "unavailable", reason: "forbidden", status: 403 },
						}),
					],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(denied, ".usage-card-head")).toContain("last updated 25 min ago - usage access denied");
		cleanup();
		const merelyOld = mount(
			<UsageSection
				usage={makeUsage({ servers: [makeUsageServer({ fresh: false, lastUpdatedAt: at })] })}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(merelyOld, ".usage-card-head")).toContain("last updated 25 min ago (stale)");
		expect(merelyOld.querySelector(".usage-detail")).toBeNull();
	});

	test("never-loaded spend explains itself per standing instead of 'never updated (stale)'", () => {
		const neverLoaded = (keyInfo: UsageServerView["keyInfo"]) =>
			makeUsage({
				servers: [makeUsageServer({ fresh: false, lastUpdatedAt: undefined, spend: undefined, keyInfo })],
			});
		const transient = mount(
			<UsageSection usage={neverLoaded({ kind: "error", classification: "network" })} serverCount={1} now={NOW} />
		);
		expect(textOf(transient, ".usage-card-head .hint")).toBe("Spend hasn't loaded for this server yet.");
		expect(textOf(transient, ".usage-spend")).toContain("the last check failed; it retries on the next poll");
		expect(textOf(transient, ".usage-detail")).toContain("LiteLLM /key/info: network error on the last attempt");
		cleanup();
		const forbidden = mount(
			<UsageSection
				usage={neverLoaded({ kind: "unavailable", reason: "forbidden", status: 401 })}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(forbidden, ".usage-card-head .hint")).toBe("This key isn't allowed to read its spend.");
		expect(textOf(forbidden, ".usage-spend")).toContain("This key can't read its own spend");
		expect(textOf(forbidden, ".usage-detail")).toContain("LiteLLM /key/info: HTTP 401");
		cleanup();
		const unsupported = mount(
			<UsageSection
				usage={neverLoaded({ kind: "unavailable", reason: "unsupported", status: 404 })}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(unsupported, ".usage-card-head .hint")).toBe("This server doesn't report spend.");
		expect(textOf(unsupported, ".usage-spend")).toContain("This server doesn't report spend for this key.");
		expect(textOf(unsupported, ".usage-detail")).toContain("not served on this server (HTTP 404)");
	});

	test("with polling off, the transient spend message points at Refresh now", () => {
		const root = mount(
			<UsageSection
				usage={makeUsage({
					pollIntervalMs: 0,
					servers: [
						makeUsageServer({ fresh: false, lastUpdatedAt: undefined, spend: undefined, keyInfo: { kind: "error" } }),
					],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(root, ".usage-spend")).toContain("use Refresh now to try again");
	});

	test("a timeout detail prints the whole-call bound and the setting to raise", () => {
		const root = mount(
			<UsageSection
				usage={makeUsage({
					discoveryTimeoutMs: 45_000,
					servers: [
						makeUsageServer({
							fresh: false,
							lastUpdatedAt: undefined,
							spend: undefined,
							keyInfo: { kind: "error", classification: "timeout" },
						}),
					],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		const detail = textOf(root, ".usage-detail");
		expect(detail).toContain("timed out after 45000ms");
		expect(detail).toContain("discovery.timeout");
	});

	test("a key that answers without a spend number reads as unreported, not unknown", () => {
		const root = mount(
			<UsageSection
				usage={makeUsage({
					servers: [makeUsageServer({ spend: undefined, keyInfo: { kind: "ok" } })],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(root, ".usage-spend")).toContain("This server doesn't report spend for this key.");
		expect(textOf(root, ".usage-detail")).toContain("LiteLLM /key/info: OK, no spend field");
	});

	test("retained request statistics carry an outdated marker while their endpoint is failing", () => {
		const retained = mount(
			<UsageSection
				usage={makeUsage({
					servers: [
						makeUsageServer({
							requests: { total: 96, successRate: 0.91 },
							dailyActivity: { kind: "error", status: 500, classification: "http" },
						}),
					],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		const stats = textOf(retained, ".usage-activity");
		expect(stats).toContain("96 requests in the last 30 days");
		expect(stats).toContain("may be outdated");
		expect(textOf(retained, ".usage-detail")).toContain("LiteLLM /user/daily/activity: HTTP 500");
		cleanup();
		const healthy = mount(
			<UsageSection
				usage={makeUsage({
					servers: [makeUsageServer({ requests: { total: 96 }, dailyActivity: { kind: "ok" } })],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(healthy, ".usage-activity")).not.toContain("may be outdated");
		expect(healthy.querySelector(".usage-detail")).toBeNull();
	});

	test("missing request statistics distinguish unsupported, forbidden, and transient", () => {
		const withActivity = (dailyActivity: UsageServerView["dailyActivity"]) =>
			makeUsage({ servers: [makeUsageServer({ dailyActivity })] });
		const unsupported = mount(
			<UsageSection
				usage={withActivity({ kind: "unavailable", reason: "unsupported", status: 404 })}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(unsupported, ".usage-activity")).toContain("this server does not serve /user/daily/activity");
		expect(unsupported.querySelector(".usage-detail")).toBeNull();
		cleanup();
		const forbidden = mount(
			<UsageSection
				usage={withActivity({ kind: "unavailable", reason: "forbidden", status: 401 })}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(forbidden, ".usage-activity")).toContain("This key isn't allowed to read request statistics");
		// The real status rides through - a 401 must not render as a hardcoded 403.
		expect(textOf(forbidden, ".usage-detail")).toContain("LiteLLM /user/daily/activity: HTTP 401");
		cleanup();
		const transient = mount(
			<UsageSection usage={withActivity({ kind: "error", classification: "network" })} serverCount={1} now={NOW} />
		);
		expect(textOf(transient, ".usage-activity")).toContain("Request statistics couldn't be fetched yet");
		expect(textOf(transient, ".usage-detail")).toContain("LiteLLM /user/daily/activity: network error");
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
