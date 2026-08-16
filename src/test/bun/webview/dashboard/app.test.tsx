/**
 * App-level behavior: the ready handshake, the message guard, the state fan out, and which failure notices a state
 * push retires (the acked-method contract documented on App and the endpoint table).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { App } from "../../../../webview/dashboard/app";
import { makeDeclaredServer, makeModel, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireClick,
	lastRequest,
	mount,
	postedCalls,
	postedRequests,
	pushToWebview,
	resetPosted,
	respondTo,
	textOf,
} from "../harness";

/**
 * Every rail item's label and count, each read from the element that holds it: the button's text run also carries
 * the tip the collapsed rail shows, so it is not a label by itself.
 */
function railCounts(root: ParentNode): Record<string, string | undefined> {
	return Object.fromEntries(
		Array.from(root.querySelectorAll("[role='tab']")).map((item) => {
			const count = item.querySelector(".rail-count")?.textContent ?? "";
			return [(item.querySelector(".rail-label")?.textContent ?? "").trim(), count === "" ? undefined : count];
		})
	);
}

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

test("mount posts the ready handshake and renders the loading skeleton until the first state push", () => {
	const root = mount(<App />);
	expect(postedCalls()).toEqual([{ method: "ready", payload: null }]);
	expect(root.querySelector("main[aria-label='Loading']")).not.toBeNull();
	expect(root.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
	expect(root.querySelector("h1")).toBeNull();

	pushToWebview(statePush(makeState()));
	expect(root.querySelector("main[aria-label='Loading']")).toBeNull();
	expect(textOf(root, "h1")).toBe("LiteLLM");
});

test("a full state push replaces the skeleton with the rail's verdict and counts", () => {
	const root = mount(<App />);
	const state = makeState({
		servers: [
			makeDeclaredServer({ label: "Ok", state: "ok" }),
			makeDeclaredServer({ label: "Broken", state: "error", error: "connect ECONNREFUSED" }),
		],
		models: [makeModel({ id: "a" }), makeModel({ id: "b" }), makeModel({ id: "c" })],
	});
	pushToWebview(statePush(state));

	const overall = root.querySelector(".rail-status");
	expect(overall?.classList.contains("tone-warn")).toBe(true);
	expect(overall?.textContent).toContain("Degraded");
	// Diagnostics carries no count here because there is nothing to fix - an absent badge is a fact, a zero is
	// furniture.
	const counts = railCounts(root);
	expect(counts.Servers).toBe("2");
	expect(counts.Models).toBe("3");
	expect(counts.Diagnostics).toBeUndefined();
	// The state fanned out to the sections.
	expect(root.textContent).toContain("Broken");
	expect(root.textContent).toContain("connect ECONNREFUSED");
});

test("unknown message types and non-object event data are ignored without crashing or clearing state", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Kept" })] })));
	expect(root.textContent).toContain("Kept");

	pushToWebview({ type: "totallyUnknown", state: makeState() });
	pushToWebview("a bare string");
	pushToWebview(null);
	pushToWebview(42);
	pushToWebview({ noType: true });

	// Prior state persists: a guard that swallowed the listener would blank it.
	expect(root.textContent).toContain("Kept");
	expect(root.querySelector("main[aria-label='Loading']")).toBeNull();

	// And a subsequent valid push still applies.
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer({ label: "Applied" })] })));
	expect(root.textContent).toContain("Applied");
	expect(root.textContent).not.toContain("Kept");
});

test("a setNumberSetting intentFailed lands on the Settings page and the next state push retires it", () => {
	// Scalar-write failures render inside the settings section (placed by
	// owning row, or its top line for an unclaimed id like this one) rather
	// than on the shared pane top; the store still retires them on push.
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	pushToWebview({
		kind: "fail",
		id: "req-1",
		method: "setNumberSetting",
		message: "the write was refused",
		failureKind: "validation",
	});
	const notice = root.querySelector("#panel-settings p.error[role='alert']");
	expect(notice?.textContent).toContain("The last change did not apply: the write was refused");

	pushToWebview(statePush(makeState()));
	expect(root.textContent).not.toContain("The last change did not apply");
});

test("an executeCommand intentFailed keeps the pane-top line: it is posted from every tab and owns no row", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	pushToWebview({
		kind: "fail",
		id: "req-9",
		method: "executeCommand",
		message: "the command bounced",
		failureKind: "operation",
	});
	// Announced on arrival: an error line with no live role is invisible to a
	// reader who is anywhere else on the page.
	const notice = root.querySelector(".pane > p.error[role='alert']");
	expect(notice?.textContent).toContain("The last change did not apply: the command bounced");

	pushToWebview(statePush(makeState()));
	expect(root.textContent).not.toContain("The last change did not apply");
});

test("a refused write is visible from another tab, and announced exactly once per failure", () => {
	// A rail click can be the blur that commits the failing write, so the fail envelope lands after the settings panel
	// is hidden, and a hidden subtree neither paints nor announces. The VISIBLE line follows the reader; the
	// ANNOUNCEMENT does not - one role="alert" mount per failure seq, however often navigation re-mounts it.
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	pushToWebview({
		kind: "fail",
		id: "req-2",
		method: "setCurrencySymbol",
		message: "the write was refused",
		failureKind: "operation",
	});
	// The default tab is Servers, so the away line stands, announced.
	const away = root.querySelector(".pane > p.error[role='alert']");
	expect(away?.textContent).toContain("The last change did not apply: the write was refused");

	// On Settings the page owns the notice and the away line stands down; the
	// failure was already spoken, so the page's line renders WITHOUT the role.
	const settingsTab = root.querySelector("#tab-settings");
	if (!(settingsTab instanceof HTMLElement)) {
		throw new Error("no settings rail tab");
	}
	fireClick(settingsTab);
	expect(root.querySelector(".pane > p.error")).toBeNull();
	const claimed = root.querySelector("#panel-settings p.error");
	expect(claimed?.textContent).toContain("The last change did not apply: the write was refused");
	expect(claimed?.getAttribute("role")).toBeNull();

	// Navigating away again re-mounts the pane-top line for the SAME standing
	// failure: still visible, still silent.
	const serversTab = root.querySelector("#tab-overview");
	if (!(serversTab instanceof HTMLElement)) {
		throw new Error("no servers rail tab");
	}
	fireClick(serversTab);
	const remounted = root.querySelector(".pane > p.error");
	expect(remounted?.textContent).toContain("The last change did not apply: the write was refused");
	expect(remounted?.getAttribute("role")).toBeNull();

	// A REPEAT failure is a fresh seq, and a fresh seq announces afresh.
	pushToWebview({
		kind: "fail",
		id: "req-3",
		method: "setCurrencySymbol",
		message: "the write was refused",
		failureKind: "operation",
	});
	expect(root.querySelector(".pane > p.error[role='alert']")?.textContent).toContain(
		"The last change did not apply: the write was refused"
	);
});

test("a saveServerSetting fail notice survives a subsequent state push", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	pushToWebview({
		kind: "fail",
		id: "req-1",
		method: "saveServerSetting",
		message: "the group upsert failed; delete the stale group from the models file",
		failureKind: "operation",
	});
	expect(root.textContent).toContain("the group upsert failed");

	// The save's own sync pushes state moments later; the warning must survive.
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	expect(root.textContent).toContain("the group upsert failed");

	// Its own success is what retires it.
	pushToWebview({ kind: "ack", id: "req-2", method: "saveServerSetting" });
	expect(root.textContent).not.toContain("the group upsert failed");
});

test("Sync models refuses with zero servers and posts the acked syncModels intent when enabled", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	// aria-disabled rather than the attribute, and the handler refuses: `disabled` takes the control out of the tab
	// order and stops every pointer event, which on the collapsed rail leaves an icon-only button whose label - drawn
	// on hover or focus - can never be shown. A first run has no servers, so that is the state a new reader meets.
	const idle = buttonByText(root, "Sync models");
	expect(idle.getAttribute("aria-disabled")).toBe("true");
	expect(idle.disabled).toBe(false);
	resetPosted();
	fireClick(idle);
	expect(postedCalls()).toEqual([]);

	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	const button = buttonByText(root, "Sync models");
	expect(button.getAttribute("aria-disabled")).toBe("false");
	resetPosted();
	fireClick(button);
	// The acked method rather than a fire-and-forget command post: on the command route this rode the chained channel
	// and held every later dashboard message for the whole pass.
	expect(postedCalls()).toEqual([{ method: "syncModels", payload: null }]);
});

test("the rail carries one quiet Report-a-bug action that posts the reportIssue command", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));

	const button = buttonByText(root, "Report a bug");
	expect((button.textContent ?? "").trim()).toBe("Report a bug");
	// secondary at compact size, not a variant of its own.
	expect(button.getAttribute("data-variant")).toBe("secondary");
	expect(button.className).toContain("px-1.5");
	resetPosted();
	fireClick(button);
	expect(postedCalls()).toEqual([{ method: "executeCommand", payload: { command: "reportIssue" } }]);
});

test("with only legacy-registry servers the rail says so instead of claiming not configured", () => {
	// The Diagnostics tab's verdict treats the legacy registry as real
	// configuration (overallStatusText); the rail mirrors that rule, so the
	// rail and the tab can never disagree about the same install.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ legacyServerCount: 2 })));
	const pill = root.querySelector(".rail-status");
	expect(pill?.textContent).toContain("Legacy registry only");
	expect(pill?.classList.contains("tone-muted")).toBe(true);

	pushToWebview(statePush(makeState()));
	expect(root.querySelector(".rail-status")?.textContent).toContain("Not configured");
});

test("the Diagnostics table's inspector opens in place over the tab and closing stays there", () => {
	// The inspector is an App-level overlay: opening it from the Resolved-models
	// table must not switch to the overview tab, and closing it must leave the
	// Diagnostics page exactly as the reader left it.
	const model = makeModel({ id: "gpt-4o", rawId: "gpt-4o", name: "Omni", scopeKey: "s0" });
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()], models: [model] })));

	fireClick(root.querySelector("#tab-diagnostics") as HTMLButtonElement);
	const diagnosticsTab = () => root.querySelector("#tab-diagnostics") as HTMLButtonElement;
	expect(diagnosticsTab().getAttribute("aria-selected")).toBe("true");

	// Answer the tab's readResolvedModels with one row for the model.
	respondTo(lastRequest("readResolvedModels"), {
		view: {
			trees: [],
			recordCount: 0,
			rows: [
				{
					serverLabel: "Prod",
					rawId: "gpt-4o",
					scopeKey: "s0",
					matchedKeys: [],
					parameters: [],
					capabilities: [],
				},
			],
		},
	});

	const row = root.querySelector("table.resolved-models tbody tr") as HTMLElement;
	fireClick(buttonByText(row, "Inspect"));
	expect(document.querySelector("[role='dialog']")).not.toBeNull();
	// No tab switch: the overlay rides over the Diagnostics page.
	expect(diagnosticsTab().getAttribute("aria-selected")).toBe("true");
	// The merged panel asks both feeds about exactly the clicked row.
	for (const method of ["readModelParameters", "readModelCapabilities"] as const) {
		const read = postedRequests(method).at(-1);
		expect(read).not.toBeUndefined();
		expect(read?.payload.scopeKey).toBe("s0");
	}

	fireClick(document.querySelector("[role='dialog'] button[aria-label='Close']") as HTMLButtonElement);
	expect(document.querySelector("[role='dialog']")).toBeNull();
	expect(diagnosticsTab().getAttribute("aria-selected")).toBe("true");
	expect(root.querySelector("table.resolved-models")).not.toBeNull();
});

test("the rail counts what each destination holds, and says nothing when it holds nothing", () => {
	// Every number is one a reader would go to that destination to find out, and every absence is a fact rather than
	// a gap. Spend is no rail figure: the Servers page header meta carries the worst fresh budget instead.
	const root = mount(<App />);

	// An install with no servers: the destination shows a guided start with no models table, so a "0" would count
	// something that is not rendered.
	act(() => {
		pushToWebview(statePush(makeState()));
	});
	expect(railCounts(root).Servers).toBeUndefined();
	expect(railCounts(root).Models).toBeUndefined();
	expect(railCounts(root).Diagnostics).toBeUndefined();
	expect(railCounts(root)).not.toContainKey("Usage");

	act(() => {
		pushToWebview(
			statePush(
				makeState({
					servers: [makeDeclaredServer({ label: "a" })],
					models: [makeModel({ id: "m1" }), makeModel({ id: "m2" })],
				})
			)
		);
	});
	const counts = railCounts(root);
	expect(counts.Servers).toBe("1");
	expect(counts.Models).toBe("2");
});
