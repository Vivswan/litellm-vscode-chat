/**
 * The headers and modelParameters editors' draft-and-apply lifecycle
 * (useDraftRows): a dirty draft survives state pushes, Apply posts the parsed
 * record, the reflecting push drops the applied draft, a failure reopens it
 * dirty, and invalid rows block Apply.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "../../../webview/dashboard/app";
import { makeSettings, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireClick,
	fireInput,
	mount,
	postedMessages,
	pushToWebview,
	resetPosted,
} from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

/** The <section> whose h3 heading matches; both editors render Apply/Reset, so queries must scope. */
function sectionByHeading(root: ParentNode, heading: string): HTMLElement {
	const section = Array.from(root.querySelectorAll("section")).find(
		(candidate) => (candidate.querySelector("h3")?.textContent ?? "").trim() === heading
	);
	if (section === undefined) {
		throw new Error(`no section titled ${heading}`);
	}
	return section as HTMLElement;
}

function settingsWithHeaders(value: Record<string, string | number | boolean>) {
	return makeSettings({ headers: { editScope: "global", value, otherScopes: [] } });
}

test("headers: a dirty draft wins over pushed state, Apply posts parsed rows, the reflecting push drops the applied draft", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({ "x-existing": "keep-me" }) })));
	const section = () => sectionByHeading(root, "Custom headers");

	fireClick(buttonByText(section(), "Add header"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[2] as HTMLInputElement, "x-new");
	fireInput(inputs[3] as HTMLInputElement, "42");

	// A background refresh must not clobber the half-edited draft.
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({ "x-existing": "keep-me" }) })));
	const namesAfterPush = Array.from(section().querySelectorAll("input.key")).map(
		(input) => (input as HTMLInputElement).value
	);
	expect(namesAfterPush).toEqual(["x-existing", "x-new"]);

	// Apply posts the whole parsed record; the scalar "42" parses as a number.
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedMessages).toEqual([{ type: "setHeaders", value: { "x-existing": "keep-me", "x-new": 42 } }]);

	// Applied but not yet reflected: still rendering, no longer dirty.
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);

	// The reflecting push drops the draft; the store value renders.
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({ "x-existing": "keep-me", "x-new": 42 }) })));
	const reflected = Array.from(section().querySelectorAll("input.key")).map(
		(input) => (input as HTMLInputElement).value
	);
	expect(reflected).toEqual(["x-existing", "x-new"]);
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
});

test("headers: an intentFailed after Apply reopens the draft dirty with the failure note", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({}) })));
	const section = () => sectionByHeading(root, "Custom headers");

	fireClick(buttonByText(section(), "Add header"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "x-token");
	fireInput(inputs[1] as HTMLInputElement, "abc");
	fireClick(buttonByText(section(), "Apply"));
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);

	pushToWebview({
		type: "intentFailed",
		intentType: "setHeaders",
		message: "x-token: refused by validation.",
		kind: "validation",
	});
	// The draft returns dirty and retryable; a failed write must not render as applied.
	expect(section().textContent).toContain("Saving failed: x-token: refused by validation.");
	expect(section().textContent).toContain("Your edits are kept");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);
});

test("model parameters: invalid JSON blocks Apply with the row problem; fixing it applies the parsed value", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(buttonByText(section(), "Add model prefix"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt-4");
	fireInput(inputs[1] as HTMLInputElement, "temperature");
	fireInput(inputs[2] as HTMLInputElement, "not json");

	expect(section().textContent).toContain("Not valid JSON");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedMessages).toEqual([]);

	fireInput(section().querySelectorAll("input")[2] as HTMLInputElement, "0.2");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);
	fireClick(buttonByText(section(), "Apply"));
	expect(postedMessages).toEqual([{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2 } } }]);
});
