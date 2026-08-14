/**
 * The Usage tab (docs/usage.md#the-usage-panel): the one-line-per-server
 * list, the inventory each line opens onto, the absence rules (a dim dash
 * plus the reason, never a zero), the refresh-now gate, and the empty states.
 * The pure formatter suite lives in spendFormat.test.ts with the formatters.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UsageServerView } from "../../../../dashboard/viewModels";
import { UsageSection } from "../../../../webview/dashboard/usage";
import { makeForbiddenUsageServer, makeUsage, makeUsageServer } from "../fixtures";
import { buttonByText, cleanup, fireClick, mount, postedCalls, resetPosted, textOf } from "../harness";

const NOW = 1_700_000_000_000;

beforeEach(resetPosted);
afterEach(cleanup);

/** Open the first (or nth) server row and return the row element, panel included. */
function openRow(root: ParentNode, index = 0): HTMLElement {
	const row = Array.from(root.querySelectorAll(".usage-row"))[index];
	if (!(row instanceof HTMLElement)) {
		throw new Error(`no usage row at index ${index}`);
	}
	const line = row.querySelector(".usage-line");
	if (!(line instanceof HTMLElement)) {
		throw new Error("usage row has no line to open");
	}
	fireClick(line);
	return row;
}

/** The value cell of one labelled fact in an opened panel, by its label text. */
function factOf(row: ParentNode, label: string): string {
	const terms = Array.from(row.querySelectorAll(".usage-facts dt"));
	const term = terms.find((candidate) => (candidate.textContent ?? "").trim() === label);
	const value = term?.nextElementSibling;
	if (!(value instanceof HTMLElement)) {
		throw new Error(`no fact labelled "${label}"`);
	}
	return (value.textContent ?? "").trim();
}

describe("UsageSection", () => {
	test("renders one line per usage server with spend against budget, and the percentage", () => {
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
		const root = mount(<UsageSection currencySymbol="$" usage={usage} serverCount={1} now={NOW} />);
		expect(textOf(root, ".usage-label")).toBe("prod");
		expect(textOf(root, ".usage-spend")).toContain("$40.00");
		expect(textOf(root, ".usage-spend")).toContain("$50.00");
		expect(textOf(root, ".usage-percent")).toBe("80%");
	});

	test("a configured currency symbol reaches every money figure on the row and in the panel", () => {
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
		const root = mount(<UsageSection currencySymbol="EUR " usage={usage} serverCount={1} now={NOW} />);
		expect(textOf(root, ".usage-spend")).toContain("EUR 40.00");
		expect(textOf(root, ".usage-spend")).toContain("EUR 50.00");
		expect(textOf(root, ".usage-spend")).not.toContain("$");
		const row = openRow(root);
		expect(factOf(row, "Spend")).toBe("EUR 40.00");
		expect(factOf(row, "Budget")).toContain("EUR 50.00");
		expect(factOf(row, "Budget")).toContain("EUR 100.00");
	});

	test("the line opens onto the labelled inventory, and both budgets stay in view there", () => {
		const usage = makeUsage({
			servers: [
				makeUsageServer({
					label: "prod",
					baseUrl: "https://litellm.example.com",
					spend: 40,
					effectiveBudget: 50,
					entryBudget: 50,
					keyBudget: 100,
					budgetSource: "entry",
					spentFraction: 0.8,
					budgetResetAt: NOW + 4 * 86_400_000,
					requests: { total: 1841, successRate: 0.98, cacheHitRate: 0.37 },
					dailyActivity: { kind: "ok" },
					lastUpdatedAt: NOW - 60_000,
				}),
			],
		});
		const root = mount(<UsageSection currencySymbol="$" usage={usage} serverCount={1} now={NOW} />);
		// A budgeted row carries the axis marking its 100% extent, and the fill
		// carries the forced-colors colour that keeps the meter from reading as a
		// measured zero when backgrounds flatten to Canvas. The no-budget test
		// below asserts the axis is absent; without this one, deleting the axis
		// outright would leave both green.
		const meter = root.querySelector(".usage-meter");
		expect(meter?.classList.contains("border-axis")).toBe(true);
		expect(meter?.classList.contains("border-b")).toBe(true);
		expect(root.querySelector(".usage-meter-fill")?.classList.contains("forced-colors:bg-[Highlight]")).toBe(true);
		const line = root.querySelector(".usage-line") as HTMLButtonElement;
		expect(line.getAttribute("aria-expanded")).toBe("false");
		expect(root.querySelector(".usage-panel")).toBeNull();
		// The disclosure mark is the model rows' chevron, not a text toggle: the
		// state lives on aria-expanded, so the words "open"/"close" must not
		// ride in the button's accessible name.
		expect(line.querySelector(".usage-chevron")).not.toBeNull();
		expect(line.textContent).not.toContain("open");

		const row = openRow(root);
		expect(line.getAttribute("aria-expanded")).toBe("true");
		expect(line.textContent).not.toContain("close");
		expect(factOf(row, "Base URL")).toBe("https://litellm.example.com");
		expect(factOf(row, "Spend")).toBe("$40.00");
		// Both budgets stay in view when the entry's value wins (docs/usage.md#budgets).
		expect(factOf(row, "Budget")).toContain("$50.00");
		expect(factOf(row, "Budget")).toContain("$100.00");
		expect(factOf(row, "Requests, 30 days")).toBe("1,841");
		expect(factOf(row, "Success rate")).toBe("98%");
		expect(factOf(row, "Cache hit rate")).toBe("37%");
		expect(factOf(row, "Last updated")).toBe("1 min ago");

		// And it closes again.
		fireClick(line);
		expect(line.getAttribute("aria-expanded")).toBe("false");
		expect(root.querySelector(".usage-panel")).toBeNull();
	});

	test("a server without a budget shows spend, a dash for the percentage, and says why in place", () => {
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
		const root = mount(<UsageSection currencySymbol="$" usage={usage} serverCount={1} now={NOW} />);
		expect(textOf(root, ".usage-percent")).toBe("-");
		expect(root.querySelector(".usage-meter-fill")).toBeNull();
		// Nor the baseline axis. It marks the 100% extent, so a full-width rule
		// under no fill is a measured zero - which is the one thing a server with
		// no budget must not appear to be. The cell stays reserved and blank.
		expect(root.querySelector(".usage-meter")?.className).not.toContain("border-b");
		expect(textOf(root, ".usage-tail")).toBe("no budget set");
		const row = openRow(root);
		expect(factOf(row, "Budget")).toContain("neither this entry nor the key sets one");
		// A missing number is never a zero.
		expect(factOf(row, "Budget")).not.toContain("$0");
	});

	test("stale data stays visible, marked on the line and labeled with its age in the panel", () => {
		const usage = makeUsage({
			servers: [makeUsageServer({ fresh: false, lastUpdatedAt: NOW - 25 * 60_000 })],
		});
		const root = mount(<UsageSection currencySymbol="$" usage={usage} serverCount={1} now={NOW} />);
		expect(textOf(root, ".usage-tail")).toBe("possibly stale");
		const updated = factOf(openRow(root), "Last updated");
		expect(updated).toContain("possibly stale");
		expect(updated).toContain("25 min ago");
	});

	test("a stale age names its cause: transient failure, denied access, or merely old", () => {
		const at = NOW - 25 * 60_000;
		const failed = mount(
			<UsageSection
				currencySymbol="$"
				usage={makeUsage({
					servers: [makeUsageServer({ fresh: false, lastUpdatedAt: at, keyInfo: { kind: "error", status: 429 } })],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(failed, ".usage-tail")).toBe("last refresh failed");
		const failedRow = openRow(failed);
		expect(factOf(failedRow, "Last updated")).toBe("25 min agolast refresh failed");
		expect(textOf(failedRow, ".usage-detail")).toContain("LiteLLM /key/info: HTTP 429 on the last attempt");
		cleanup();
		const denied = mount(
			<UsageSection
				currencySymbol="$"
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
		expect(textOf(denied, ".usage-tail")).toBe("usage access denied");
		expect(factOf(openRow(denied), "Last updated")).toBe("25 min agousage access denied");
		cleanup();
		const merelyOld = mount(
			<UsageSection
				currencySymbol="$"
				usage={makeUsage({ servers: [makeUsageServer({ fresh: false, lastUpdatedAt: at })] })}
				serverCount={1}
				now={NOW}
			/>
		);
		const oldRow = openRow(merelyOld);
		expect(factOf(oldRow, "Last updated")).toBe("25 min agopossibly stale");
		expect(oldRow.querySelector(".usage-detail")).toBeNull();
	});

	test("never-loaded spend explains itself per standing instead of 'never updated (stale)'", () => {
		const neverLoaded = (keyInfo: UsageServerView["keyInfo"]) =>
			makeUsage({
				servers: [makeUsageServer({ fresh: false, lastUpdatedAt: undefined, spend: undefined, keyInfo })],
			});
		const transient = mount(
			<UsageSection
				currencySymbol="$"
				usage={neverLoaded({ kind: "error", classification: "network" })}
				serverCount={1}
				now={NOW}
			/>
		);
		const transientRow = openRow(transient);
		expect(factOf(transientRow, "Last updated")).toContain("Spend hasn't loaded for this server yet.");
		expect(factOf(transientRow, "Spend")).toContain(
			"the last check failed; it retries automatically with increasing delay"
		);
		expect(textOf(transientRow, ".usage-detail")).toContain("LiteLLM /key/info: network error on the last attempt");
		cleanup();
		const forbidden = mount(
			<UsageSection
				currencySymbol="$"
				usage={neverLoaded({ kind: "unavailable", reason: "forbidden", status: 401 })}
				serverCount={1}
				now={NOW}
			/>
		);
		const forbiddenRow = openRow(forbidden);
		expect(factOf(forbiddenRow, "Last updated")).toContain("This key isn't allowed to read its spend.");
		expect(factOf(forbiddenRow, "Spend")).toContain("This key can't read its own spend");
		expect(textOf(forbiddenRow, ".usage-detail")).toContain("LiteLLM /key/info: HTTP 401");
		cleanup();
		const unsupported = mount(
			<UsageSection
				currencySymbol="$"
				usage={neverLoaded({ kind: "unavailable", reason: "unsupported", status: 404 })}
				serverCount={1}
				now={NOW}
			/>
		);
		const unsupportedRow = openRow(unsupported);
		expect(factOf(unsupportedRow, "Last updated")).toContain("This server doesn't report spend.");
		expect(factOf(unsupportedRow, "Spend")).toContain("This server doesn't report spend for this key.");
		expect(textOf(unsupportedRow, ".usage-detail")).toContain("not served on this server (HTTP 404)");
	});

	test("with polling off, the transient spend message points at Refresh now", () => {
		const root = mount(
			<UsageSection
				currencySymbol="$"
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
		expect(factOf(openRow(root), "Spend")).toContain("use Refresh now to try again");
	});

	test("a timeout detail prints the whole-call bound and the setting to raise", () => {
		const root = mount(
			<UsageSection
				currencySymbol="$"
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
		const detail = textOf(openRow(root), ".usage-detail");
		expect(detail).toContain("timed out after 45000ms");
		expect(detail).toContain("discovery.timeout");
	});

	test("a key that answers without a spend number reads as unreported, not unknown", () => {
		const root = mount(
			<UsageSection
				currencySymbol="$"
				usage={makeUsage({
					servers: [makeUsageServer({ spend: undefined, keyInfo: { kind: "ok" } })],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		const row = openRow(root);
		expect(factOf(row, "Spend")).toContain("This server doesn't report spend for this key.");
		expect(textOf(row, ".usage-detail")).toContain("LiteLLM /key/info: OK, no spend field");
	});

	test("retained request statistics carry an outdated marker while their endpoint is failing", () => {
		const retained = mount(
			<UsageSection
				currencySymbol="$"
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
		const retainedRow = openRow(retained);
		expect(factOf(retainedRow, "Requests, 30 days")).toContain("96");
		expect(factOf(retainedRow, "Requests, 30 days")).toContain("may be outdated");
		// A rate the window does not carry stays absent rather than reading zero.
		expect(factOf(retainedRow, "Cache hit rate")).toContain("-");
		expect(factOf(retainedRow, "Cache hit rate")).not.toContain("0%");
		expect(textOf(retainedRow, ".usage-detail")).toContain("LiteLLM /user/daily/activity: HTTP 500");
		cleanup();
		const healthy = mount(
			<UsageSection
				currencySymbol="$"
				usage={makeUsage({
					servers: [makeUsageServer({ requests: { total: 96 }, dailyActivity: { kind: "ok" } })],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		const healthyRow = openRow(healthy);
		expect(factOf(healthyRow, "Requests, 30 days")).not.toContain("may be outdated");
		expect(healthyRow.querySelector(".usage-detail")).toBeNull();
	});

	test("missing request statistics distinguish unsupported, forbidden, and transient", () => {
		const withActivity = (dailyActivity: UsageServerView["dailyActivity"]) =>
			makeUsage({ servers: [makeUsageServer({ dailyActivity })] });
		const unsupported = mount(
			<UsageSection
				currencySymbol="$"
				usage={withActivity({ kind: "unavailable", reason: "unsupported", status: 404 })}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(unsupported, ".usage-tail")).toBe("no request statistics");
		const unsupportedRow = openRow(unsupported);
		expect(factOf(unsupportedRow, "Requests, 30 days")).toContain("does not serve /user/daily/activity");
		expect(unsupportedRow.querySelector(".usage-detail")).toBeNull();
		cleanup();
		const forbidden = mount(
			<UsageSection
				currencySymbol="$"
				usage={withActivity({ kind: "unavailable", reason: "forbidden", status: 401 })}
				serverCount={1}
				now={NOW}
			/>
		);
		const forbiddenRow = openRow(forbidden);
		expect(factOf(forbiddenRow, "Requests, 30 days")).toContain("This key isn't allowed to read request statistics");
		// The real status rides through - a 401 must not render as a hardcoded 403.
		expect(textOf(forbiddenRow, ".usage-detail")).toContain("LiteLLM /user/daily/activity: HTTP 401");
		cleanup();
		const transient = mount(
			<UsageSection
				currencySymbol="$"
				usage={withActivity({ kind: "error", classification: "network" })}
				serverCount={1}
				now={NOW}
			/>
		);
		const transientRow = openRow(transient);
		expect(factOf(transientRow, "Requests, 30 days")).toContain("Request statistics couldn't be fetched yet");
		expect(textOf(transientRow, ".usage-detail")).toContain("LiteLLM /user/daily/activity: network error");
	});

	test("a server with no readable usage behind a forbidden key states the block and shows no numbers", () => {
		const root = mount(
			<UsageSection
				currencySymbol="$"
				usage={makeUsage({ servers: [makeForbiddenUsageServer({ label: "locked", baseUrl: "http://locked.test" })] })}
				serverCount={1}
				now={NOW}
			/>
		);
		expect(textOf(root, ".usage-label")).toBe("locked");
		expect(textOf(root, ".usage-tail")).toBe("usage access denied");
		const row = openRow(root);
		expect(row.textContent).toContain("Usage unavailable: this key isn't allowed to read its usage.");
		expect(row.textContent).toContain("Ask whoever issued the key");
		const details = Array.from(row.querySelectorAll(".usage-detail")).map((node) => node.textContent ?? "");
		expect(details).toEqual([
			"LiteLLM /key/info: HTTP 403 - this key may not read usage data; Refresh now re-probes",
			"LiteLLM /user/daily/activity: HTTP 403 - this key may not read usage data; Refresh now re-probes",
		]);
		// No meter fill, no facts grid, no fake numbers.
		expect(row.querySelector(".usage-meter-fill")).toBeNull();
		expect(row.querySelector(".usage-facts")).toBeNull();
		expect(row.textContent).not.toContain("$");
		// And it counts as a row: the no-usage-servers empty state must not show.
		expect(root.textContent).not.toContain("None of your servers serves usage data");
	});

	test("the forbidden row names an unsupported partner endpoint and skips transient ones", () => {
		const mixed = mount(
			<UsageSection
				currencySymbol="$"
				usage={makeUsage({
					servers: [
						makeForbiddenUsageServer({
							keyInfo: { kind: "unavailable", reason: "unsupported", status: 404 },
							dailyActivity: { kind: "unavailable", reason: "forbidden", status: 403 },
						}),
					],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		const mixedDetails = Array.from(openRow(mixed).querySelectorAll(".usage-detail")).map(
			(node) => node.textContent ?? ""
		);
		expect(mixedDetails).toEqual([
			"LiteLLM /key/info: not served on this server (HTTP 404)",
			"LiteLLM /user/daily/activity: HTTP 403 - this key may not read usage data; Refresh now re-probes",
		]);
		cleanup();
		const transientPartner = mount(
			<UsageSection
				currencySymbol="$"
				usage={makeUsage({
					servers: [makeForbiddenUsageServer({ dailyActivity: { kind: "error", classification: "network" } })],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		const details = Array.from(openRow(transientPartner).querySelectorAll(".usage-detail")).map(
			(node) => node.textContent ?? ""
		);
		expect(details).toEqual(["LiteLLM /key/info: HTTP 403 - this key may not read usage data; Refresh now re-probes"]);
	});

	test("budget pressure speaks on the line, and counts as needing attention", () => {
		// The percentage column already carries the ratio, so the tail says what a
		// percentage cannot: how much room is left, or how far past the line this
		// is. And the header's count reads the same verdict the tail paints, so a
		// fresh server at 112% can never be red on its row and absent from the
		// count.
		const over = mount(
			<UsageSection
				currencySymbol="$"
				usage={makeUsage({
					servers: [
						makeUsageServer({ label: "research", spend: 28, effectiveBudget: 25, spentFraction: 1.12 }),
						makeUsageServer({ label: "gateway", spend: 43.5, effectiveBudget: 50, spentFraction: 0.87 }),
					],
				})}
				serverCount={2}
				now={NOW}
			/>
		);
		const tails = Array.from(over.querySelectorAll(".usage-tail")).map((node) => (node.textContent ?? "").trim());
		expect(tails).toEqual(["over budget by $3.00", "$6.50 left"]);
		expect(textOf(over, ".section-meta")).toContain("2 need attention");
	});

	test("a failing statistics endpoint marks the line even while the spend side is healthy", () => {
		const root = mount(
			<UsageSection
				currencySymbol="$"
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
		expect(textOf(root, ".usage-tail")).toBe("statistics may be outdated");
		expect(textOf(root, ".section-meta")).toContain("1 needs attention");
	});

	test("a never-fetched server states the reason once, not once per fact", () => {
		const root = mount(
			<UsageSection
				currencySymbol="$"
				usage={makeUsage({
					servers: [makeUsageServer({ lastUpdatedAt: undefined, spend: undefined, keyInfo: { kind: "unknown" } })],
				})}
				serverCount={1}
				now={NOW}
			/>
		);
		const row = openRow(root);
		const sentence = "Spend hasn't loaded for this server yet.";
		expect(factOf(row, "Spend")).toContain(sentence);
		expect((row.textContent ?? "").split(sentence).length - 1).toBe(1);
	});

	test("the header summarizes the list: how many servers, how many need attention, whether polling runs", () => {
		const root = mount(
			<UsageSection
				currencySymbol="$"
				usage={makeUsage({
					pollIntervalMs: 0,
					servers: [
						makeUsageServer({ label: "prod" }),
						makeUsageServer({ label: "gateway", keyInfo: { kind: "error", status: 500 } }),
					],
				})}
				serverCount={2}
				now={NOW}
			/>
		);
		const meta = textOf(root, ".section-meta");
		expect(meta).toContain("2 servers");
		expect(meta).toContain("1 needs attention");
		expect(meta).toContain("background polling off");
	});

	test("Refresh now posts the intent and disables while a pass is in flight", () => {
		const root = mount(
			<UsageSection currencySymbol="$" usage={makeUsage({ servers: [makeUsageServer()] })} serverCount={1} now={NOW} />
		);
		fireClick(buttonByText(root, "Refresh now"));
		expect(postedCalls()).toEqual([{ method: "refreshUsage", payload: null }]);
		cleanup();
		const busy = mount(
			<UsageSection
				currencySymbol="$"
				usage={makeUsage({ refreshing: true, servers: [makeUsageServer()] })}
				serverCount={1}
				now={NOW}
			/>
		);
		const refreshing = Array.from(busy.querySelectorAll("button")).find((button) =>
			(button.textContent ?? "").includes("Refreshing")
		);
		expect(refreshing?.disabled).toBe(true);
	});

	test("the empty states distinguish no servers from no usage-tracking servers", () => {
		const none = mount(<UsageSection currencySymbol="$" usage={makeUsage()} serverCount={0} now={NOW} />);
		expect(none.textContent).toContain("No servers configured");
		cleanup();
		const noUsage = mount(<UsageSection currencySymbol="$" usage={makeUsage()} serverCount={2} now={NOW} />);
		expect(noUsage.textContent).toContain("None of your servers serves usage data");
	});

	test("the data-follows-the-key note renders on the tab", () => {
		const root = mount(<UsageSection currencySymbol="$" usage={makeUsage()} serverCount={1} now={NOW} />);
		expect(root.textContent).toContain("key switches its numbers to the new key's spend");
	});
});
