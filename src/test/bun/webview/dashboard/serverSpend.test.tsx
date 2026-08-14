/**
 * The Servers page's merged spend surface (docs/usage.md#the-usage-panel): the
 * per-row spend unit, the drawer each row opens onto, the absence rules (a dim
 * dash plus the reason, never a zero), the usage diagnostics' tiers - the
 * user-ruled degraded denials, the fully-rendered transient advisory, and the
 * counted budget pressure - the header's meta summary, and the refresh gate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DashboardServer, DashboardUsage, UsageServerView } from "../../../../dashboard/viewModels";
import { ServersSection } from "../../../../webview/dashboard/servers";
import { makeDeclaredServer, makeForbiddenUsageServer, makeUsage, makeUsageServer } from "../fixtures";
import { buttonByText, cleanup, fireClick, mount, postedCalls, resetPosted, textOf } from "../harness";

const NOW = 1_700_000_000_000;

beforeEach(resetPosted);
afterEach(cleanup);

/** One declared server whose label matches the default usage card's. */
function prodServer(overrides: Partial<Parameters<typeof makeDeclaredServer>[0]> = {}) {
	return makeDeclaredServer({ label: "Prod", baseUrl: "http://localhost:4000", ...overrides });
}

function mountServers(usage: DashboardUsage, servers: readonly DashboardServer[] = [prodServer()]) {
	return mount(
		<ServersSection
			currencySymbol="$"
			servers={servers}
			usage={usage}
			now={NOW}
			onEditServer={() => {}}
			onAdoptServer={() => {}}
			onAddServer={() => {}}
		/>
	);
}

/** Open the first (or nth) server row's drawer and return the row element, drawer included. */
function openRow(root: ParentNode, index = 0): HTMLElement {
	const row = Array.from(root.querySelectorAll(".server-item"))[index];
	if (!(row instanceof HTMLElement)) {
		throw new Error(`no server row at index ${index}`);
	}
	const line = row.querySelector("button.server-line");
	if (!(line instanceof HTMLElement)) {
		throw new Error("server row has no disclosure to open");
	}
	fireClick(line);
	return row;
}

/** The value cell of one labelled fact in an opened drawer, by its label text. */
function factOf(row: ParentNode, label: string): string {
	const terms = Array.from(row.querySelectorAll(".server-facts dt"));
	const term = terms.find((candidate) => (candidate.textContent ?? "").trim() === label);
	const value = term?.nextElementSibling;
	if (!(value instanceof HTMLElement)) {
		throw new Error(`no fact labelled "${label}"`);
	}
	return (value.textContent ?? "").trim();
}

describe("the spend unit", () => {
	test("shows the percentage with the shared severity tone and the meter beneath it", () => {
		const usageFor = (spentFraction: number) =>
			makeUsage({ servers: [makeUsageServer({ label: "Prod", spend: 21, spentFraction })] });
		const cases: readonly [number, string][] = [
			[0.42, "text-ok"],
			// Reaching a threshold counts as crossing it (the fixture thresholds
			// are 0.8 and 0.95); over budget shows the literal percentage.
			[0.8, "text-warn"],
			[1.12, "text-err"],
		];
		for (const [fraction, tone] of cases) {
			const root = mountServers(usageFor(fraction));
			const unit = root.querySelector(".server-usage .spend-unit") as HTMLElement;
			// The hidden noun is the number's name - there is no column header.
			expect(unit.querySelector(".visually-hidden")?.textContent).toContain("Budget spent");
			expect(unit.textContent).toContain(`${Math.round(fraction * 100)}%`);
			expect(unit.querySelector(`.${tone}`)).not.toBeNull();
			// The meter under the number: the axis marks the 100% extent and the
			// fill carries its forced-colors colour, so the meter can never read
			// as a measured zero when backgrounds flatten to Canvas.
			const meter = unit.querySelector(".spend-meter");
			expect(meter?.classList.contains("border-axis")).toBe(true);
			expect(meter?.classList.contains("border-b")).toBe(true);
			expect(meter?.querySelector(".forced-colors\\:bg-\\[Highlight\\]")).not.toBeNull();
			cleanup();
		}
	});

	test("spend without a budget renders as the plain amount with no meter, never a percentage", () => {
		const usage = makeUsage({
			servers: [
				makeUsageServer({
					label: "Prod",
					spend: 3.07,
					effectiveBudget: undefined,
					keyBudget: undefined,
					budgetSource: "none",
					spentFraction: undefined,
				}),
			],
		});
		const root = mountServers(usage);
		const unit = root.querySelector(".server-usage .spend-unit") as HTMLElement;
		expect(unit.querySelector(".visually-hidden")?.textContent).toContain("Spent");
		expect(unit.textContent).toContain("$3.07");
		expect(unit.textContent).not.toContain("%");
		// No axis either: a bare rule under no fill is a measured zero, which is
		// the one thing a server with no budget must not appear to be.
		expect(unit.querySelector(".spend-meter")).toBeNull();
	});

	test("a server without usage data gets an empty spend cell, not an unknown marker", () => {
		// The usage snapshot tracks a different entry (usage joins by the store's
		// label key), so this row has no numbers to show - and says nothing.
		const usage = makeUsage({ servers: [makeUsageServer({ label: "Other" })] });
		const root = mountServers(usage);
		const cell = root.querySelector(".server-row .server-usage") as HTMLElement;
		expect(cell).not.toBeNull();
		expect(cell.textContent).toBe("");
		expect(root.textContent).not.toContain("unknown");
	});

	test("every non-fresh spend unit wears the one-word stale qualifier, whatever the cause", () => {
		// The header's clause is "worst FRESH budget", so an unmarked stale
		// number right beneath it read as the header contradicting the page.
		// The word is a unit qualifier; the cause stays in the diagnostic line
		// or the drawer's Last updated fact.
		const stale = mountServers(makeUsage({ servers: [makeUsageServer({ label: "Prod", fresh: false })] }));
		expect(textOf(stale, ".spend-note")).toBe("stale");
		cleanup();
		const failed = mountServers(
			makeUsage({ servers: [makeUsageServer({ label: "Prod", fresh: false, keyInfo: { kind: "error" } })] })
		);
		expect(textOf(failed, ".spend-note")).toBe("stale");
		expect(failed.textContent).toContain("didn't refresh");
		cleanup();
		// Fresh numbers carry no qualifier: an always-present mark is furniture.
		const fresh = mountServers(makeUsage({ servers: [makeUsageServer({ label: "Prod", fresh: true })] }));
		expect(fresh.querySelector(".spend-note")).toBeNull();
	});
});

describe("the drawer", () => {
	test("opens onto the labelled inventory: entry facts first, then every usage fact", () => {
		const usage = makeUsage({
			servers: [
				makeUsageServer({
					label: "Prod",
					baseUrl: "http://localhost:4000",
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
		const root = mountServers(usage, [prodServer({ modelCount: 3, hasApiKey: true, lastChecked: undefined })]);
		const line = root.querySelector("button.server-line") as HTMLButtonElement;
		expect(line.getAttribute("aria-expanded")).toBe("false");
		expect(root.querySelector(".server-drawer")).toBeNull();
		// The disclosure mark is the model rows' chevron, not a text toggle: the
		// state lives on aria-expanded, so the words "open"/"close" must not
		// ride in the button's accessible name.
		expect(line.querySelector(".server-chevron")).not.toBeNull();
		expect(line.textContent).not.toContain("open");

		const row = openRow(root);
		expect(line.getAttribute("aria-expanded")).toBe("true");
		expect(row.querySelector(".server-drawer")).not.toBeNull();
		expect(factOf(row, "Base URL")).toBe("http://localhost:4000");
		expect(factOf(row, "Authentication")).toBe("API key");
		expect(factOf(row, "Models")).toBe("3 models");
		// Unchecked: no time to show, and the way forward in place.
		expect(factOf(row, "Last checked")).toContain("no discovery pass has seen it yet");
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
		expect(root.querySelector(".server-drawer")).toBeNull();
	});

	test("a configured currency symbol reaches every money figure on the row and in the drawer", () => {
		const usage = makeUsage({
			servers: [
				makeUsageServer({
					label: "Prod",
					spend: 40,
					effectiveBudget: 50,
					entryBudget: 50,
					keyBudget: 100,
					budgetSource: "entry",
					spentFraction: undefined,
					lastUpdatedAt: NOW - 60_000,
				}),
			],
		});
		const root = mount(
			<ServersSection
				currencySymbol="EUR "
				servers={[prodServer()]}
				usage={usage}
				now={NOW}
				onEditServer={() => {}}
				onAdoptServer={() => {}}
				onAddServer={() => {}}
			/>
		);
		expect(textOf(root, ".spend-unit")).toContain("EUR 40.00");
		const row = openRow(root);
		expect(factOf(row, "Spend")).toBe("EUR 40.00");
		expect(factOf(row, "Budget")).toContain("EUR 50.00");
		expect(factOf(row, "Budget")).toContain("EUR 100.00");
		expect(row.textContent).not.toContain("$");
	});

	test("a server without a budget says why in place, and a missing number is never a zero", () => {
		const usage = makeUsage({
			servers: [
				makeUsageServer({
					label: "Prod",
					spend: 3,
					effectiveBudget: undefined,
					keyBudget: undefined,
					entryBudget: undefined,
					budgetSource: "none",
					spentFraction: undefined,
				}),
			],
		});
		const row = openRow(mountServers(usage));
		expect(factOf(row, "Budget")).toContain("neither this entry nor the key sets one");
		expect(factOf(row, "Budget")).not.toContain("$0");
	});

	test("stale data stays visible, annotated on the row and labeled with its age in the drawer", () => {
		const usage = makeUsage({
			servers: [makeUsageServer({ label: "Prod", fresh: false, lastUpdatedAt: NOW - 25 * 60_000 })],
		});
		const root = mountServers(usage);
		expect(textOf(root, ".spend-note")).toBe("stale");
		const updated = factOf(openRow(root), "Last updated");
		expect(updated).toContain("possibly stale");
		expect(updated).toContain("25 min ago");
	});

	test("never-loaded spend explains itself per standing instead of 'never updated (stale)'", () => {
		const neverLoaded = (keyInfo: UsageServerView["keyInfo"]) =>
			makeUsage({
				servers: [
					makeUsageServer({ label: "Prod", fresh: false, lastUpdatedAt: undefined, spend: undefined, keyInfo }),
				],
			});
		const transientRow = openRow(mountServers(neverLoaded({ kind: "error", classification: "network" })));
		expect(factOf(transientRow, "Last updated")).toContain("spend hasn't loaded for this server yet");
		expect(factOf(transientRow, "Spend")).toContain(
			"the last check failed; it retries automatically with increasing delay"
		);
		cleanup();
		const unsupportedRow = openRow(
			mountServers(neverLoaded({ kind: "unavailable", reason: "unsupported", status: 404 }))
		);
		expect(factOf(unsupportedRow, "Last updated")).toContain("this server doesn't report spend");
		expect(factOf(unsupportedRow, "Spend")).toContain("this server doesn't report spend for this key");
		expect(textOf(unsupportedRow, ".usage-detail")).toContain("not served on this server (HTTP 404)");
	});

	test("a key that answers without a spend number reads as unreported, not unknown", () => {
		const usage = makeUsage({
			servers: [makeUsageServer({ label: "Prod", spend: undefined, keyInfo: { kind: "ok" } })],
		});
		const row = openRow(mountServers(usage));
		expect(factOf(row, "Spend")).toContain("this server doesn't report spend for this key");
		expect(textOf(row, ".usage-detail")).toContain("LiteLLM /key/info: OK, no spend field");
	});

	test("retained request statistics carry an outdated marker while their endpoint is failing", () => {
		const usage = makeUsage({
			servers: [
				makeUsageServer({
					label: "Prod",
					requests: { total: 96, successRate: 0.91 },
					dailyActivity: { kind: "error", status: 500, classification: "http" },
				}),
			],
		});
		const row = openRow(mountServers(usage));
		expect(factOf(row, "Requests, 30 days")).toContain("96");
		expect(factOf(row, "Requests, 30 days")).toContain("may be outdated");
		// A rate the window does not carry stays absent rather than reading zero.
		expect(factOf(row, "Cache hit rate")).toContain("-");
		expect(factOf(row, "Cache hit rate")).not.toContain("0%");
		expect(textOf(row, ".usage-detail")).toContain("LiteLLM /user/daily/activity: HTTP 500");
		// An activity error stays a fact annotation, never a diagnostic line.
		expect(row.querySelector(".row-diagnostic")).toBeNull();
	});

	test("missing request statistics distinguish unsupported and transient, with one reason for the trio", () => {
		const withActivity = (dailyActivity: UsageServerView["dailyActivity"]) =>
			makeUsage({ servers: [makeUsageServer({ label: "Prod", dailyActivity })] });
		const unsupportedRow = openRow(
			mountServers(withActivity({ kind: "unavailable", reason: "unsupported", status: 404 }))
		);
		expect(factOf(unsupportedRow, "Requests, 30 days")).toContain("does not serve /user/daily/activity");
		// The one cause is stated once, on the fact that owns the window: the
		// two computed rates beneath it stay bare dashes rather than repeating
		// the same clause in three consecutive cells.
		expect(factOf(unsupportedRow, "Success rate")).toBe("-not reported");
		expect(factOf(unsupportedRow, "Cache hit rate")).toBe("-not reported");
		expect(unsupportedRow.querySelector(".usage-detail")).toBeNull();
		cleanup();
		const transientRow = openRow(mountServers(withActivity({ kind: "error", classification: "network" })));
		expect(factOf(transientRow, "Requests, 30 days")).toContain("couldn't be fetched yet");
		expect(textOf(transientRow, ".usage-detail")).toContain("LiteLLM /user/daily/activity: network error");
	});

	test("a never-fetched server states the reason once, not once per fact", () => {
		const usage = makeUsage({
			servers: [
				makeUsageServer({ label: "Prod", lastUpdatedAt: undefined, spend: undefined, keyInfo: { kind: "unknown" } }),
			],
		});
		const row = openRow(mountServers(usage));
		const sentence = "spend hasn't loaded for this server yet";
		expect(factOf(row, "Spend")).toContain(sentence);
		expect((row.textContent ?? "").split(sentence).length - 1).toBe(1);
	});

	test("a denied card's drawer keeps the whole usage inventory, dashed - parity with a reporting server", () => {
		// One reason per refused endpoint, on the fact that owns it; the rows
		// computed from those stay bare dashes, and the remedy lives in the
		// row's counted diagnostic rather than being restated per line.
		const usage = makeUsage({
			servers: [makeForbiddenUsageServer({ label: "Prod", baseUrl: "http://localhost:4000" })],
		});
		const row = openRow(mountServers(usage));
		expect(factOf(row, "Spend")).toContain("this key isn't allowed to read its spend");
		expect(factOf(row, "Requests, 30 days")).toContain("this key isn't allowed to read request statistics");
		for (const label of ["Budget", "Next reset", "Success rate", "Cache hit rate", "Last updated"]) {
			expect(factOf(row, label)).toBe("-not reported");
		}
		// Mixed cards keep the per-endpoint truth: an unsupported partner reads
		// as unsupported, not as denied.
		cleanup();
		const mixed = makeUsage({
			servers: [
				makeForbiddenUsageServer({
					label: "Prod",
					baseUrl: "http://localhost:4000",
					keyInfo: { kind: "unavailable", reason: "unsupported", status: 404 },
					dailyActivity: { kind: "unavailable", reason: "forbidden", status: 403 },
				}),
			],
		});
		const mixedRow = openRow(mountServers(mixed));
		expect(factOf(mixedRow, "Spend")).toContain("this server doesn't report spend");
		expect(factOf(mixedRow, "Requests, 30 days")).toContain("this key isn't allowed to read request statistics");
	});

	test("an external row's drawer carries the provenance story the badge used to hide in a tip", () => {
		const root = mount(
			<ServersSection
				currencySymbol="$"
				servers={[
					{
						origin: "external",
						label: "Copilot",
						baseUrl: "http://copilot.example:4000",
						modelCount: 2,
						hasApiKey: true,
						hasOAuth: false,
						state: "ok",
						adoptHandle: "handle-abc",
						hideable: true,
					},
				]}
				now={NOW}
				onEditServer={() => {}}
				onAdoptServer={() => {}}
				onAddServer={() => {}}
			/>
		);
		// No focusable tip inside the disclosure button; the badge is plain.
		expect(root.querySelector("button.server-line .tip-wrap")).toBeNull();
		const row = openRow(root);
		expect(factOf(row, "Origin")).toContain("external");
		expect(factOf(row, "Origin")).toContain("added outside this extension");
	});
});

describe("the usage diagnostics", () => {
	test("a key denied all usage becomes a DEGRADED diagnostic: counted, warn-tinted, both endpoints stated", () => {
		// USER RULING (2026-08-14): denied usage keys are degraded, not advisory -
		// only a human can change a permission, so the row carries something to
		// act on and the attention count says so.
		const usage = makeUsage({
			servers: [makeForbiddenUsageServer({ label: "Prod", baseUrl: "http://localhost:4000" })],
		});
		const root = mountServers(usage);
		const line = root.querySelector(".row-diagnostic") as HTMLElement;
		expect(line.classList.contains("sev-degraded")).toBe(true);
		expect(line.textContent).toContain("Usage is unavailable for Prod: this key isn't allowed to read its usage.");
		expect(line.textContent).toContain("Ask whoever issued the key");
		const details = Array.from(line.querySelectorAll(".row-diagnostic-detail")).map((node) => node.textContent ?? "");
		expect(details).toEqual([
			"LiteLLM /key/info: HTTP 403 - this key may not read usage data",
			"LiteLLM /user/daily/activity: HTTP 403 - this key may not read usage data",
		]);
		// Counted: the meta line and the live region both carry the verdict.
		expect(textOf(root, ".section-meta")).toContain("1 needs attention");
		// The fix action posts the same fleet-wide refresh the header offers.
		resetPosted();
		fireClick(buttonByText(line, "Refresh now"));
		expect(postedCalls()).toEqual([{ method: "refreshUsage", payload: null }]);
		// No numbers anywhere: the row's spend cell stays empty.
		expect((root.querySelector(".server-row .server-usage") as HTMLElement).textContent).toBe("");
	});

	test("a mixed denial names the unsupported partner endpoint too", () => {
		const usage = makeUsage({
			servers: [
				makeForbiddenUsageServer({
					label: "Prod",
					keyInfo: { kind: "unavailable", reason: "unsupported", status: 404 },
					dailyActivity: { kind: "unavailable", reason: "forbidden", status: 403 },
				}),
			],
		});
		const line = mountServers(usage).querySelector(".row-diagnostic") as HTMLElement;
		const details = Array.from(line.querySelectorAll(".row-diagnostic-detail")).map((node) => node.textContent ?? "");
		expect(details).toEqual([
			"LiteLLM /key/info: not served on this server (HTTP 404)",
			"LiteLLM /user/daily/activity: HTTP 403 - this key may not read usage data",
		]);
	});

	test("statistics denied on an otherwise-serving key is its own degraded line, and counts", () => {
		const usage = makeUsage({
			servers: [
				makeUsageServer({ label: "Prod", dailyActivity: { kind: "unavailable", reason: "forbidden", status: 401 } }),
			],
		});
		const root = mountServers(usage);
		const line = root.querySelector(".row-diagnostic") as HTMLElement;
		expect(line.classList.contains("sev-degraded")).toBe(true);
		expect(line.textContent).toContain("Prod can't read request statistics");
		// The real status rides through - a 401 must not render as a hardcoded 403.
		expect(line.textContent).toContain("LiteLLM /user/daily/activity: HTTP 401");
		expect(textOf(root, ".section-meta")).toContain("1 needs attention");
	});

	test("spend denied while statistics still serve is degraded too: the user-ruled tier, per endpoint", () => {
		// The /key/info-only denial - the third denial shape beside the whole
		// card and the statistics-only one. Retained history keeps rendering
		// (the spend unit shows the last-known number) while the diagnostic
		// counts, because only a human can change the key's permission.
		const usage = makeUsage({
			servers: [
				makeUsageServer({
					label: "Prod",
					fresh: false,
					keyInfo: { kind: "unavailable", reason: "forbidden", status: 401 },
					dailyActivity: { kind: "ok" },
					requests: { total: 96, successRate: 0.91 },
				}),
			],
		});
		const root = mountServers(usage);
		const line = root.querySelector(".row-diagnostic") as HTMLElement;
		expect(line.classList.contains("sev-degraded")).toBe(true);
		expect(line.textContent).toContain("Prod can't read its spend");
		expect(line.textContent).toContain("LiteLLM /key/info: HTTP 401");
		expect(textOf(root, ".section-meta")).toContain("1 needs attention");
		// The retained number is not fresh, so it wears the one-word qualifier;
		// the denial itself lives in the diagnostic line, not beside the number.
		expect(textOf(root, ".spend-note")).toBe("stale");
		resetPosted();
		fireClick(buttonByText(line, "Refresh now"));
		expect(postedCalls()).toEqual([{ method: "refreshUsage", payload: null }]);
	});

	test("a transient refresh failure is ADVISORY and still renders in full: headline, detail, fix action", () => {
		// The spec requirement, not an implementation detail: only the tint and
		// the attention count are reduced on the quiet tier - the headline, the
		// English endpoint detail, and Refresh now all render exactly as a
		// degraded line's would.
		const usage = makeUsage({
			servers: [makeUsageServer({ label: "Prod", fresh: false, keyInfo: { kind: "error", status: 429 } })],
		});
		const root = mountServers(usage);
		const line = root.querySelector(".row-diagnostic") as HTMLElement;
		expect(line.classList.contains("sev-advisory")).toBe(true);
		expect(line.textContent).toContain("Prod's spend numbers didn't refresh");
		expect(line.textContent).toContain("retries automatically with increasing delay");
		expect(textOf(line, ".row-diagnostic-detail")).toContain("LiteLLM /key/info: HTTP 429 on the last attempt");
		resetPosted();
		fireClick(buttonByText(line, "Refresh now"));
		expect(postedCalls()).toEqual([{ method: "refreshUsage", payload: null }]);
		// NOT counted: it clears itself on the next poll.
		expect(textOf(root, ".section-meta")).not.toContain("needs attention");
	});

	test("with polling off, the transient headline names Refresh now instead of the automatic retry", () => {
		const usage = makeUsage({
			pollIntervalMs: 0,
			servers: [makeUsageServer({ label: "Prod", fresh: false, keyInfo: { kind: "error" } })],
		});
		const line = mountServers(usage).querySelector(".row-diagnostic") as HTMLElement;
		expect(line.textContent).toContain("background polling is off - use Refresh now to try again");
	});

	test("a timeout detail prints the whole-call bound and the setting to raise", () => {
		const usage = makeUsage({
			discoveryTimeoutMs: 45_000,
			servers: [
				makeUsageServer({ label: "Prod", fresh: false, keyInfo: { kind: "error", classification: "timeout" } }),
			],
		});
		const detail = textOf(
			mountServers(usage).querySelector(".row-diagnostic") as HTMLElement,
			".row-diagnostic-detail"
		);
		expect(detail).toContain("timed out after 45000ms");
		expect(detail).toContain("discovery.timeout");
	});

	test("budget pressure is a degraded line saying what the percentage cannot, and counts", () => {
		const usage = makeUsage({
			servers: [
				makeUsageServer({ label: "Prod", spend: 28, effectiveBudget: 25, spentFraction: 1.12 }),
				makeUsageServer({ label: "Gateway", spend: 43.5, effectiveBudget: 50, spentFraction: 0.87 }),
			],
		});
		const root = mountServers(usage, [prodServer(), prodServer({ label: "Gateway", baseUrl: "http://gw.test" })]);
		const lines = Array.from(root.querySelectorAll(".row-diagnostic")).map((line) => ({
			severity: [...line.classList].find((name) => name.startsWith("sev-")),
			text: (line.textContent ?? "").trim(),
		}));
		expect(lines).toEqual([
			{ severity: "sev-degraded", text: "Prod is over its budget by $3.00." },
			{ severity: "sev-degraded", text: "Gateway is close to its budget: $6.50 left." },
		]);
		expect(textOf(root, ".section-meta")).toContain("2 need attention");
	});

	test("a healthy budget raises no line at all", () => {
		const usage = makeUsage({
			servers: [makeUsageServer({ label: "Prod", spend: 5, effectiveBudget: 50, spentFraction: 0.1 })],
		});
		const root = mountServers(usage);
		expect(root.querySelector(".row-diagnostic")).toBeNull();
	});
});

describe("the header", () => {
	test("the meta line summarizes the one list: count, attention, worst fresh budget, polling", () => {
		const usage = makeUsage({
			pollIntervalMs: 0,
			servers: [
				makeUsageServer({ label: "Prod", spend: 43.5, effectiveBudget: 50, spentFraction: 0.87, fresh: true }),
				// Stale, so its 112% must stay out of the worst-budget clause.
				makeUsageServer({ label: "Gateway", spend: 28, effectiveBudget: 25, spentFraction: 1.12, fresh: false }),
			],
		});
		const root = mountServers(usage, [prodServer(), prodServer({ label: "Gateway", baseUrl: "http://gw.test" })]);
		const meta = textOf(root, ".section-meta");
		expect(meta).toContain("2 servers");
		// The over-budget row still counts (its numbers are last-known), and the
		// near-budget fresh row does too.
		expect(meta).toContain("2 need attention");
		// The worst FRESH fraction - a maximum, never a sum, never a stale one,
		// and the clause says "fresh" so the header cannot read as contradicting
		// a stale 112% on the row beneath it.
		expect(meta).toContain("worst fresh budget 87%");
		expect(meta).toContain("background polling off");
	});

	test("Refresh now posts the intent and disables while a pass is in flight", () => {
		const root = mountServers(makeUsage({ servers: [makeUsageServer({ label: "Prod" })] }));
		fireClick(buttonByText(root, "Refresh now"));
		expect(postedCalls()).toEqual([{ method: "refreshUsage", payload: null }]);
		cleanup();
		const busy = mountServers(makeUsage({ refreshing: true, servers: [makeUsageServer({ label: "Prod" })] }));
		const refreshing = Array.from(busy.querySelectorAll("button")).find((button) =>
			(button.textContent ?? "").includes("Refreshing")
		);
		expect(refreshing?.disabled).toBe(true);
	});
});
