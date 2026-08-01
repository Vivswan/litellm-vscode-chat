/**
 * The headers and modelParameters editors' draft-and-apply lifecycle
 * (useDraftRows): a dirty draft survives state pushes, Apply posts the parsed
 * record, the reflecting push drops the applied draft, a failure reopens it
 * dirty, and invalid rows block Apply. Plus the surfaces around that
 * lifecycle: Discard, the Applying/Saved feedback, field-aligned header
 * problems, the other-scope read-only grids, the datalists, Enter-to-apply,
 * and the Edit-as-JSON side door.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "../../../webview/dashboard/app";
import { helpModelParameterPrefix } from "../../../webview/dashboard/helpText";
import { SettingsSection } from "../../../webview/dashboard/settings";
import { makeModel, makeSettings, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireClick,
	fireInput,
	fireKeyDown,
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
	// startsWith, not equality: the heading also carries its help "?" glyph.
	const section = Array.from(root.querySelectorAll("section")).find((candidate) =>
		(candidate.querySelector("h3")?.textContent ?? "").trim().startsWith(heading)
	);
	if (section === undefined) {
		throw new Error(`no section titled ${heading}`);
	}
	return section as HTMLElement;
}

function settingsWithHeaders(value: Record<string, string | number | boolean>) {
	return makeSettings({ headers: { editScope: "global", value, otherScopes: [], effective: value } });
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

test("model parameters: the global editor's prefix copy advertises URL scoping (the entry editor's must not)", () => {
	// The shared ParamGroupsFields takes its prefix placeholder and help as
	// required props because the two surfaces differ for real: global keys may
	// lead with a base URL, per-entry keys match model IDs only (URL prefixes
	// are inert there; servers.test.tsx pins that side). This pins the global
	// side so the two cannot silently re-merge onto one copy.
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const section = sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section, "Add model prefix"));

	const prefixInput = section.querySelector<HTMLInputElement>("input.key[placeholder^='Model prefix']");
	if (prefixInput === null) {
		throw new Error("no prefix input rendered");
	}
	expect(prefixInput.placeholder).toBe("Model prefix, e.g. gpt-4 or http://host:4000/gpt-4");
	const glyph = prefixInput.closest(".cell")?.querySelector("button.help");
	const tip = document.getElementById(glyph?.getAttribute("aria-describedby") ?? "");
	expect(tip?.textContent).toBe(helpModelParameterPrefix());
});

test("a draft edited back to the store value counts as unchanged: Apply and Discard disable, nothing posts", () => {
	// A no-op write would never produce the reflecting push that ends the
	// applying phase, so an unchanged draft must not be appliable at all
	// (the scalar rows' unchanged-posts-nothing rule, in draft form).
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({ "x-keep": "v" }) })));
	const section = () => sectionByHeading(root, "Custom headers");
	const valueInput = () => section().querySelector("input.value") as HTMLInputElement;

	fireInput(valueInput(), "changed");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);
	fireInput(valueInput(), "v");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
	expect((buttonByText(section(), "Discard") as HTMLButtonElement).disabled).toBe(true);
	resetPosted();
	fireKeyDown(valueInput(), "Enter");
	expect(postedMessages).toEqual([]);
});

test("rows that assemble to the stored record cannot be applied, even under a different spelling or key order", () => {
	// "1e1" is a different text for the stored 10; applying it would write a
	// value the store already holds and no reflecting push would ever arrive.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({ "x-count": 10 }) })));
	const section = () => sectionByHeading(root, "Custom headers");
	fireInput(section().querySelector("input.value") as HTMLInputElement, "1e1");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
	expect((buttonByText(section(), "Discard") as HTMLButtonElement).disabled).toBe(false);

	// Key order is not a value change either: a reordered JSON paste stays unappliable.
	const settings = makeSettings({
		modelParameters: { editScope: "global", value: { a: { x: 1 }, b: { y: 2 } }, otherScopes: [], effective: {} },
	});
	pushToWebview(statePush(makeState({ settings })));
	const params = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(params(), "Edit as JSON"));
	fireInput(params().querySelector("textarea") as HTMLTextAreaElement, '{"b": {"y": 2}, "a": {"x": 1}}');
	expect((buttonByText(params(), "Apply") as HTMLButtonElement).disabled).toBe(true);
});

test("a pristine JSON view follows store pushes; one with local edits is pinned", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({ "x-a": "1" }) })));
	const section = () => sectionByHeading(root, "Custom headers");
	fireClick(buttonByText(section(), "Edit as JSON"));
	const textarea = () => section().querySelector("textarea") as HTMLTextAreaElement;

	// Untouched, the textarea must not go stale and overwrite newer settings on a later Apply.
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({ "x-a": "1", "x-b": "2" }) })));
	expect(JSON.parse(textarea().value)).toEqual({ "x-a": "1", "x-b": "2" });

	// Edited, it pins like a dirty rows draft.
	fireInput(textarea(), '{"x-mine": "kept"}');
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({ "x-a": "other" }) })));
	expect(JSON.parse(textarea().value)).toEqual({ "x-mine": "kept" });

	// Applied text holds through the applying window and a failure: resyncing
	// there would flash the pre-apply value back into the textarea.
	fireClick(buttonByText(section(), "Apply"));
	expect(JSON.parse(textarea().value)).toEqual({ "x-mine": "kept" });
	pushToWebview({ type: "intentFailed", intentType: "setHeaders", message: "refused.", kind: "validation" });
	expect(JSON.parse(textarea().value)).toEqual({ "x-mine": "kept" });
});

test("Enter stays off the datalist-bearing inputs; the value input still applies", () => {
	// Enter is also how a datalist suggestion is accepted, and the keydown
	// outruns the input event that commits it: an Enter-apply on those inputs
	// would post the half-typed value.
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section(), "Add model prefix"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt-4");
	fireInput(inputs[1] as HTMLInputElement, "temperature");
	fireInput(inputs[2] as HTMLInputElement, "0.2");

	resetPosted();
	fireKeyDown(section().querySelector("input.key[placeholder^='Model prefix']") as HTMLInputElement, "Enter");
	fireKeyDown(section().querySelector("input.key[placeholder^='Parameter']") as HTMLInputElement, "Enter");
	expect(postedMessages).toEqual([]);
	fireKeyDown(section().querySelector("input.value") as HTMLInputElement, "Enter");
	expect(postedMessages).toEqual([{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2 } } }]);
});

test("Discard drops a dirty draft back to the store value without posting, under a distinct accessible name", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({ "x-keep": "v" }) })));
	const section = () => sectionByHeading(root, "Custom headers");

	// The draft button is Discard, never Reset: on the scalar rows above,
	// Reset deletes a persisted value, and one word must not mean both.
	expect(Array.from(section().querySelectorAll("button")).map((b) => (b.textContent ?? "").trim())).not.toContain(
		"Reset"
	);
	const discard = () => buttonByText(section(), "Discard");
	expect(discard().disabled).toBe(true);
	expect(discard().getAttribute("aria-label")).toBe("Discard the unapplied header edits");
	const paramsDiscard = buttonByText(sectionByHeading(root, "Model parameters"), "Discard");
	expect(paramsDiscard.getAttribute("aria-label")).toBe("Discard the unapplied model parameter edits");

	fireInput(section().querySelector("input.value") as HTMLInputElement, "changed");
	expect(discard().disabled).toBe(false);
	resetPosted();
	fireClick(discard());
	expect(postedMessages).toEqual([]);
	expect((section().querySelector("input.value") as HTMLInputElement).value).toBe("v");
	expect(discard().disabled).toBe(true);
});

test("Apply feedback: Applying... until the reflecting push, then a transient Saved that the next edit clears", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({}) })));
	const section = () => sectionByHeading(root, "Custom headers");
	const status = () => section().querySelector(".apply-status")?.textContent ?? "";

	expect(status()).toBe("");
	fireClick(buttonByText(section(), "Add header"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "x-token");
	fireInput(inputs[1] as HTMLInputElement, "abc");
	expect(status()).toBe("");
	fireClick(buttonByText(section(), "Apply"));
	expect(status()).toBe("Applying...");

	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({ "x-token": "abc" }) })));
	expect(status()).toBe("Saved");

	fireInput(section().querySelector("input.value") as HTMLInputElement, "next");
	expect(status()).toBe("");
});

test("Apply feedback: a failure ends the Applying... window along with reopening the draft", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({}) })));
	const section = () => sectionByHeading(root, "Custom headers");

	fireClick(buttonByText(section(), "Add header"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "x-token");
	fireInput(inputs[1] as HTMLInputElement, "abc");
	fireClick(buttonByText(section(), "Apply"));
	expect(section().querySelector(".apply-status")?.textContent).toBe("Applying...");

	pushToWebview({ type: "intentFailed", intentType: "setHeaders", message: "refused.", kind: "validation" });
	expect(section().querySelector(".apply-status")?.textContent).toBe("");
	expect(section().textContent).toContain("Saving failed: refused.");
});

test("a header problem marks only the offending input: bad values flag the value field, bad names the name field", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({}) })));
	const section = () => sectionByHeading(root, "Custom headers");

	fireClick(buttonByText(section(), "Add header"));
	const nameInput = () => section().querySelector("input.key") as HTMLInputElement;
	const valueInput = () => section().querySelector("input.value") as HTMLInputElement;

	// A value with a control octet can never travel as a header; the VALUE
	// input carries the invalid mark, not the name next to it. (BEL, not \n:
	// the input element's value setter strips newlines.)
	fireInput(nameInput(), "x-ok");
	fireInput(valueInput(), "bad\u0007value");
	expect(section().textContent).toContain("This value cannot be sent as an HTTP header");
	expect(valueInput().classList.contains("invalid")).toBe(true);
	expect(nameInput().classList.contains("invalid")).toBe(false);

	fireInput(valueInput(), "fine");
	fireInput(nameInput(), "bad header");
	expect(section().textContent).toContain("Not a valid HTTP header name");
	expect(nameInput().classList.contains("invalid")).toBe(true);
	expect(valueInput().classList.contains("invalid")).toBe(false);
});

test("a parameter-row problem marks only the offending input: bad JSON flags the value, a bad name the name", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section(), "Add model prefix"));
	const nameInput = () => section().querySelector("input.key[placeholder^='Parameter']") as HTMLInputElement;
	const valueInput = () => section().querySelector("input.value") as HTMLInputElement;

	fireInput(section().querySelector("input.key[placeholder^='Model prefix']") as HTMLInputElement, "gpt-4");
	fireInput(nameInput(), "temperature");
	fireInput(valueInput(), "not json");
	expect(valueInput().classList.contains("invalid")).toBe(true);
	expect(valueInput().getAttribute("aria-invalid")).toBe("true");
	expect(nameInput().classList.contains("invalid")).toBe(false);

	fireInput(valueInput(), "0.2");
	fireInput(nameInput(), "__proto__");
	expect(section().textContent).toContain("reserved name");
	expect(nameInput().classList.contains("invalid")).toBe(true);
	expect(valueInput().classList.contains("invalid")).toBe(false);
});

test("other-scope records render as the disabled row grid with the edit-there hint, not as prose", () => {
	const root = mount(<App />);
	const settings = makeSettings({
		modelParameters: {
			editScope: "global",
			value: {},
			otherScopes: [{ scope: "workspace", value: { "gpt-4": { temperature: 0.2 } } }],
			effective: { "gpt-4": { temperature: 0.2 } },
		},
		headers: {
			editScope: "global",
			value: {},
			otherScopes: [{ scope: "workspace", value: { "x-ws": "from-workspace" } }],
			effective: { "x-ws": "from-workspace" },
		},
	});
	pushToWebview(statePush(makeState({ settings })));

	const paramsOther = sectionByHeading(root, "Model parameters").querySelector(".other-scope");
	expect(paramsOther?.textContent).toContain("Set in Workspace settings - edit there.");
	const paramValues = Array.from(paramsOther?.querySelectorAll("input") ?? []).map(
		(i) => (i as HTMLInputElement).value
	);
	expect(paramValues).toEqual(["gpt-4", "temperature", "0.2"]);
	for (const input of Array.from(paramsOther?.querySelectorAll("input") ?? [])) {
		expect((input as HTMLInputElement).disabled).toBe(true);
	}
	// A static display offers no row mutations.
	expect(paramsOther?.querySelector("button.quiet:not(.help)")).toBeNull();

	const headersOther = sectionByHeading(root, "Custom headers").querySelector(".other-scope");
	expect(headersOther?.textContent).toContain("Set in Workspace settings - edit there.");
	const headerInputs = Array.from(headersOther?.querySelectorAll("input") ?? []) as HTMLInputElement[];
	expect(headerInputs.map((input) => input.value)).toEqual(["x-ws", "from-workspace"]);
	expect(headerInputs.every((input) => input.disabled)).toBe(true);
	expect(headersOther?.querySelector("button")).toBeNull();
});

test("the prefix and parameter-name inputs offer datalists: discovered model IDs and the common parameter names", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ models: [makeModel({ id: "gpt-test" }), makeModel({ id: "claude-x", name: "Claude X" })] }))
	);
	const section = sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section, "Add model prefix"));

	const prefixInput = section.querySelector("input.key[placeholder^='Model prefix']") as HTMLInputElement;
	const prefixList = document.getElementById(prefixInput.getAttribute("list") ?? "");
	expect(prefixList?.tagName.toLowerCase()).toBe("datalist");
	expect(Array.from(prefixList?.querySelectorAll("option") ?? []).map((o) => o.getAttribute("value"))).toEqual([
		"gpt-test",
		"claude-x",
	]);

	const nameInput = section.querySelector("input.key[placeholder^='Parameter']") as HTMLInputElement;
	const nameList = document.getElementById(nameInput.getAttribute("list") ?? "");
	expect(nameList?.tagName.toLowerCase()).toBe("datalist");
	const names = Array.from(nameList?.querySelectorAll("option") ?? []).map((o) => o.getAttribute("value"));
	expect(names).toContain("temperature");
	expect(names).toContain("reasoning_effort");
});

test("Enter in a record-row input applies a clean draft and does nothing while it is invalid", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({}) })));
	const section = () => sectionByHeading(root, "Custom headers");

	fireClick(buttonByText(section(), "Add header"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "bad header");
	fireInput(inputs[1] as HTMLInputElement, "v");
	resetPosted();
	fireKeyDown(inputs[0] as HTMLInputElement, "Enter");
	expect(postedMessages).toEqual([]);

	fireInput(section().querySelector("input.key") as HTMLInputElement, "x-fine");
	fireKeyDown(section().querySelector("input.key") as HTMLInputElement, "Enter");
	expect(postedMessages).toEqual([{ type: "setHeaders", value: { "x-fine": "v" } }]);

	// The model-parameters rows follow the same convention.
	const params = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(params(), "Add model prefix"));
	const paramInputs = params().querySelectorAll("input");
	fireInput(paramInputs[0] as HTMLInputElement, "gpt-4");
	fireInput(paramInputs[1] as HTMLInputElement, "temperature");
	fireInput(paramInputs[2] as HTMLInputElement, "0.2");
	resetPosted();
	fireKeyDown(params().querySelector("input.value") as HTMLInputElement, "Enter");
	expect(postedMessages).toEqual([{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2 } } }]);
});

test("each editor's hint names the seam between the two save models: rows apply together via Apply", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	for (const heading of ["Model parameters", "Custom headers"]) {
		expect(sectionByHeading(root, heading).textContent).toContain("Rows here apply together via the Apply button");
	}
});

test("Edit as JSON: the textarea seeds from the record, and a valid edit applies through the same parse", () => {
	const root = mount(<App />);
	const settings = makeSettings({
		modelParameters: { editScope: "global", value: { "gpt-4": { temperature: 0.2 } }, otherScopes: [], effective: {} },
	});
	pushToWebview(statePush(makeState({ settings })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(buttonByText(section(), "Edit as JSON"));
	const textarea = () => section().querySelector("textarea") as HTMLTextAreaElement;
	expect(JSON.parse(textarea().value)).toEqual({ "gpt-4": { temperature: 0.2 } });
	// The rows grid and its add action stand down while the textarea is up.
	expect(section().querySelector(".row")).toBeNull();
	expect(Array.from(section().querySelectorAll("button")).map((b) => (b.textContent ?? "").trim())).not.toContain(
		"Add model prefix"
	);
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);

	fireInput(textarea(), '{"gpt-4": {"temperature": 1}, "claude": {"max_tokens": 100}}');
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedMessages).toEqual([
		{ type: "setModelParameters", value: { "gpt-4": { temperature: 1 }, claude: { max_tokens: 100 } } },
	]);
	expect(section().querySelector(".apply-status")?.textContent).toBe("Applying...");
});

test("Edit as JSON: invalid input blocks Apply and the way back to rows, with the row parsers' own strictness", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section(), "Edit as JSON"));
	const textarea = () => section().querySelector("textarea") as HTMLTextAreaElement;
	const apply = () => buttonByText(section(), "Apply") as HTMLButtonElement;

	fireInput(textarea(), "not json");
	expect(section().textContent).toContain("Not valid JSON.");
	expect(apply().disabled).toBe(true);
	expect((buttonByText(section(), "Edit as rows") as HTMLButtonElement).disabled).toBe(true);

	fireInput(textarea(), '{"gpt-4": 3}');
	expect(section().textContent).toContain("Expected an object of parameters");
	expect(apply().disabled).toBe(true);

	// The identical validation the rows get: reserved names stay rejected.
	fireInput(textarea(), '{"__proto__": {"a": 1}}');
	expect(section().textContent).toContain("reserved name");
	expect(apply().disabled).toBe(true);

	fireInput(textarea(), '{"gpt-4": {"temperature": 1}}');
	expect(apply().disabled).toBe(false);
	fireClick(buttonByText(section(), "Edit as rows"));
	expect((section().querySelector("input.key[placeholder^='Model prefix']") as HTMLInputElement).value).toBe("gpt-4");
});

test("Edit as JSON on headers: scalar-only values, and Discard reseeds the textarea from the store", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithHeaders({ "x-keep": "v" }) })));
	const section = () => sectionByHeading(root, "Custom headers");
	fireClick(buttonByText(section(), "Edit as JSON"));
	const textarea = () => section().querySelector("textarea") as HTMLTextAreaElement;
	expect(JSON.parse(textarea().value)).toEqual({ "x-keep": "v" });

	fireInput(textarea(), '{"x-keep": {"nested": 1}}');
	expect(section().textContent).toContain("Header values must be a string, number, or boolean");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);

	// Discard is the escape hatch even from unparseable text.
	resetPosted();
	fireClick(buttonByText(section(), "Discard"));
	expect(postedMessages).toEqual([]);
	expect(JSON.parse(textarea().value)).toEqual({ "x-keep": "v" });
	expect((buttonByText(section(), "Discard") as HTMLButtonElement).disabled).toBe(true);
});

test("each editor heading carries a settings.json jump posting revealSetting with its record key", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));

	const jumpOf = (heading: string) => sectionByHeading(root, heading).querySelector("button.reveal-json");
	const paramsJump = jumpOf("Model parameters");
	expect(paramsJump?.getAttribute("aria-label")).toBe("Open Model parameters in settings.json");
	resetPosted();
	fireClick(paramsJump as HTMLButtonElement);
	expect(postedMessages).toEqual([{ type: "revealSetting", setting: "modelParameters" }]);

	const headersJump = jumpOf("Custom headers");
	expect(headersJump?.getAttribute("aria-label")).toBe("Open Custom headers in settings.json");
	resetPosted();
	fireClick(headersJump as HTMLButtonElement);
	expect(postedMessages).toEqual([{ type: "revealSetting", setting: "headers" }]);
});

test("the settings filter hides an editor with a dirty draft via hidden, and the draft applies after unhiding", () => {
	const root = mount(<SettingsSection settings={settingsWithHeaders({})} models={[]} failures={{}} />);
	const section = () => sectionByHeading(root, "Custom headers");

	// A half-typed header draft...
	fireClick(buttonByText(section(), "Add header"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "x-draft");
	fireInput(inputs[1] as HTMLInputElement, "survives");

	// ...is hidden by a non-matching filter, never unmounted...
	const filter = root.querySelector<HTMLInputElement>(".filterbar input") as HTMLInputElement;
	fireInput(filter, "no such setting");
	expect(section().hidden).toBe(true);
	expect((section().querySelectorAll("input")[0] as HTMLInputElement).value).toBe("x-draft");

	// ...and works untouched once the filter clears: Apply posts the draft.
	fireInput(filter, "");
	expect(section().hidden).toBe(false);
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedMessages).toEqual([{ type: "setHeaders", value: { "x-draft": "survives" } }]);
});
