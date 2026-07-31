/**
 * App-level behavior: the ready handshake, the message guard, the state fan
 * out, and which failure notices a state push retires (the ACKED_INTENT_TYPES
 * contract documented on App).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "../../../webview/dashboard/app";
import { makeDeclaredServer, makeModel, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireClick,
	mount,
	postedMessages,
	pushToWebview,
	resetPosted,
	textOf,
} from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

test("mount posts the ready handshake and renders the loading skeleton until the first state push", () => {
	const root = mount(<App />);
	expect(postedMessages).toEqual([{ type: "ready" }]);
	expect(root.querySelector("main[aria-label='Loading']")).not.toBeNull();
	expect(root.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
	expect(root.querySelector("h1")).toBeNull();

	pushToWebview(statePush(makeState()));
	expect(root.querySelector("main[aria-label='Loading']")).toBeNull();
	expect(textOf(root, "h1")).toBe("LiteLLM Dashboard");
});

test("a full state push replaces the skeleton with hero verdict and counts", () => {
	const root = mount(<App />);
	const state = makeState({
		servers: [
			makeDeclaredServer({ label: "Ok", state: "ok" }),
			makeDeclaredServer({ label: "Broken", state: "error", error: "connect ECONNREFUSED" }),
		],
		models: [makeModel({ id: "a" }), makeModel({ id: "b" }), makeModel({ id: "c" })],
	});
	pushToWebview(statePush(state));

	const overall = root.querySelector(".hero .pill");
	expect(overall?.classList.contains("tone-warn")).toBe(true);
	expect(overall?.textContent).toContain("Degraded");
	const stats = Array.from(root.querySelectorAll(".stat")).map((stat) => (stat.textContent ?? "").trim());
	expect(stats).toContain("2 servers");
	expect(stats).toContain("3 models");
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
		type: "intentFailed",
		intentType: "setNumberSetting",
		message: "the write was refused",
		kind: "validation",
	});
	expect(root.textContent).toContain("The last change did not apply: the write was refused");

	pushToWebview(statePush(makeState()));
	expect(root.textContent).not.toContain("The last change did not apply");
});

test("a saveServerSetting intentFailed survives a subsequent state push", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	pushToWebview({
		type: "intentFailed",
		intentType: "saveServerSetting",
		message: "the group upsert failed; remove the stale group in the native editor",
		kind: "operation",
		requestId: "req-1",
	});
	expect(root.textContent).toContain("the group upsert failed");

	// The save's own sync pushes state moments later; the warning must survive.
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	expect(root.textContent).toContain("the group upsert failed");

	// Its own success is what retires it.
	pushToWebview({ type: "intentSucceeded", intentType: "saveServerSetting", requestId: "req-2" });
	expect(root.textContent).not.toContain("the group upsert failed");
});

test("Sync models disables with zero servers and posts the executeCommand intent when enabled", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	expect(buttonByText(root, "Sync models").disabled).toBe(true);

	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	const button = buttonByText(root, "Sync models");
	expect(button.disabled).toBe(false);
	resetPosted();
	fireClick(button);
	expect(postedMessages).toEqual([{ type: "executeCommand", command: "syncModels" }]);
});
