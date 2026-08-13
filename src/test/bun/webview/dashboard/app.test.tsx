/**
 * App-level behavior: the ready handshake, the message guard, the state fan
 * out, and which failure notices a state push retires (the acked-method
 * contract documented on App and the endpoint table).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { App } from "../../../../webview/dashboard/app";
import { makeDeclaredServer, makeModel, makeState, makeUsage, makeUsageServer, statePush } from "../fixtures";
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
 * Every rail item's label and count. Sliced by length rather than by replacing
 * the count text: a label that itself contained digits would otherwise have the
 * first match cut out of the middle of it.
 */
function railCounts(root: ParentNode): Record<string, string | undefined> {
	return Object.fromEntries(
		Array.from(root.querySelectorAll("[role='tab']")).map((item) => {
			const text = item.textContent ?? "";
			const count = item.querySelector(".rail-count")?.textContent ?? "";
			return [text.slice(0, text.length - count.length).trim(), count === "" ? undefined : count];
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
	// The counts live ON the rail items now, which is the rail's whole claim
	// over a tab strip: a strip can only say where you are, a count says
	// whether it is worth going. Diagnostics carries none here because there is
	// nothing to fix - an absent badge is a fact, a zero is furniture.
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

test("a setNumberSetting intentFailed renders the scalar failure line and the next state push retires it", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	pushToWebview({
		kind: "fail",
		id: "req-1",
		method: "setNumberSetting",
		message: "the write was refused",
		failureKind: "validation",
	});
	expect(root.textContent).toContain("The last change did not apply: the write was refused");

	pushToWebview(statePush(makeState()));
	expect(root.textContent).not.toContain("The last change did not apply");
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

test("Sync models disables with zero servers and posts the acked syncModels intent when enabled", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	expect(buttonByText(root, "Sync models").disabled).toBe(true);

	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	const button = buttonByText(root, "Sync models");
	expect(button.disabled).toBe(false);
	resetPosted();
	fireClick(button);
	// The acked method rather than the fire-and-forget command post: on the
	// command route this rode the chained channel and held every later
	// dashboard message for the whole pass.
	expect(postedCalls()).toEqual([{ method: "syncModels", payload: null }]);
});

test("the rail carries one quiet Report-a-bug action that posts the reportIssue command", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));

	const button = buttonByText(root, "Report a bug");
	expect((button.textContent ?? "").trim()).toBe("Report a bug");
	// secondary at compact size: what the old "quiet" variant was, now said as
	// the two things it actually is.
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
	// Every number here is one a reader would go to that destination to find
	// out, and every absence is a fact rather than a gap.
	const root = mount(<App />);

	// An install with no servers: the destination shows a guided start with no
	// models table, so a "0" would count something that is not rendered.
	act(() => {
		pushToWebview(statePush(makeState()));
	});
	expect(railCounts(root).Servers).toBeUndefined();
	expect(railCounts(root).Models).toBeUndefined();
	expect(railCounts(root).Usage).toBeUndefined();
	expect(railCounts(root).Diagnostics).toBeUndefined();

	// Spend is reported against a budget on one fresh server and a stale one:
	// the figure is the worst FRESH budget fraction, never a sum, because two
	// entries can authenticate with the same key.
	act(() => {
		pushToWebview(
			statePush(
				makeState({
					servers: [makeDeclaredServer({ label: "a" })],
					models: [makeModel({ id: "m1" }), makeModel({ id: "m2" })],
					usage: makeUsage({
						thresholds: [0.8, 0.95],
						servers: [
							{ ...makeUsageServer({ label: "a" }), spend: 45, effectiveBudget: 100, fresh: true },
							// A second FRESH server, so a sum and a maximum give different
							// answers: without it the assertion below cannot tell them apart.
							{ ...makeUsageServer({ label: "c" }), spend: 30, effectiveBudget: 100, fresh: true },
							{ ...makeUsageServer({ label: "b" }), spend: 900, effectiveBudget: 100, fresh: false },
						],
					}),
				})
			)
		);
	});
	const withUsage = railCounts(root);
	expect(withUsage.Servers).toBe("1");
	expect(withUsage.Models).toBe("2");
	// The worst fresh fraction: 45%. A sum would say 75%, and folding the stale
	// server in would say 975% - two entries can authenticate with the same key,
	// so spends cannot be added.
	expect(withUsage.Usage).toBe("45%");
});
