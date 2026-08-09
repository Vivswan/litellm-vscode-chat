/**
 * The headers and modelParameters editors' draft-and-apply lifecycle
 * (useDraftRows): a dirty draft survives state pushes, Apply posts the parsed
 * record tagged with a requestId, the correlated ack resolves the phase, the
 * reflecting push drops the acked draft, a correlated failure reopens it
 * dirty, and invalid rows block Apply. Plus the surfaces around that
 * lifecycle: Discard, the Applying/Saved feedback, field-aligned header
 * problems, the other-scope read-only grids, the suggestion listboxes,
 * Enter-to-apply, and the Edit-as-JSON side door.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { App } from "../../../webview/dashboard/app";
import { helpModelParameterPrefix } from "../../../webview/dashboard/helpText";
import { CatalogPicker } from "../../../webview/dashboard/recordEditors";
import { SettingsSection } from "../../../webview/dashboard/settings";
import { makeModel, makeSettings, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireCheck,
	fireClick,
	fireFocus,
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

function settingsWithParams(value: Record<string, Record<string, unknown>>) {
	return makeSettings({ modelParameters: { editScope: "global", value, otherScopes: [], effective: value } });
}

/** The posted record writes with their requestIds stripped (each asserted present); Apply mints a fresh ID per post. */
function postedRecordWrites(): { type: string; value: unknown }[] {
	return postedMessages.map((message) => {
		const { requestId, ...rest } = message as { requestId?: unknown; type: string; value: unknown };
		expect(typeof requestId).toBe("string");
		return rest;
	});
}

/** The last posted write's requestId, for pushing its correlated outcome notice. */
function lastRequestId(): string {
	return (postedMessages.at(-1) as { requestId: string }).requestId;
}

/** Ack the last posted record write, as the panel does right before its reflecting push. */
function ackLastWrite(intentType: "setModelParameters" | "setModelCapabilities" = "setModelParameters"): void {
	pushToWebview({ type: "intentSucceeded", intentType, requestId: lastRequestId() });
}

test("force checkbox: marking a row writes the explicit _force list and Apply posts it", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	const box = section().querySelector<HTMLInputElement>(".directive-flag input");
	if (box === null) {
		throw new Error("the force checkbox did not render");
	}
	expect(box.checked).toBe(false);
	fireCheck(box, true);

	// The mark materializes as the _force row's explicit list, visible as text.
	const values = Array.from(section().querySelectorAll("input.value")).map((i) => (i as HTMLInputElement).value);
	expect(values).toContain('["temperature"]');

	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2, _force: ["temperature"] } } },
	]);
});

test("force checkbox: unmarking the last field removes the _force row entirely", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2, _force: ["temperature"] } }) }))
	);
	const section = () => sectionByHeading(root, "Model parameters");

	const box = section().querySelector<HTMLInputElement>(".directive-flag input");
	if (box === null) {
		throw new Error("the force checkbox did not render");
	}
	expect(box.checked).toBe(true);
	fireCheck(box, false);

	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2 } } }]);
});

test("force checkbox: provider-owned and underscore keys disable with the reason; the _force row has no box", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				settings: settingsWithParams({ "gpt-4": { model: "other", _meta: 1, temperature: 0.2, _force: true } }),
			})
		)
	);
	const section = sectionByHeading(root, "Model parameters");

	// One force box per non-directive row: model and temperature. Directive
	// rows (keys starting "_", here _meta and _force) carry no flag checkboxes
	// at all (the inheritable boxes are their own directive-flag cells, scoped
	// out by the aria-label).
	const boxes = Array.from(
		section.querySelectorAll(".directive-flag input[aria-label^='Force']")
	) as HTMLInputElement[];
	expect(boxes.length).toBe(2);
	const byLabel = (key: string) =>
		boxes.find((box) => box.getAttribute("aria-label") === `Force "${key}"`) as HTMLInputElement;
	expect(byLabel("model").disabled).toBe(true);
	expect(byLabel("model").checked).toBe(false);
	// A literal true marks exactly the eligible keys.
	expect(byLabel("temperature").disabled).toBe(false);
	expect(byLabel("temperature").checked).toBe(true);
	// The disabled boxes' help names why; the tooltip text is mounted in the DOM.
	expect(section.textContent).toContain("Cannot be forced: provider-owned fields like model");

	// A hand-written true is preserved on load: nothing was toggled, so the
	// directive row still reads true and the draft stays clean (Apply disabled).
	const values = Array.from(section.querySelectorAll("input.value")).map((i) => (i as HTMLInputElement).value);
	expect(values).toContain("true");
	expect((buttonByText(section, "Apply") as HTMLButtonElement).disabled).toBe(true);
});

test("force checkbox: unchecking one field under a literal true rewrites the explicit remainder", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2, top_p: 0.9, _force: true } }) }))
	);
	const section = () => sectionByHeading(root, "Model parameters");

	const boxes = Array.from(section().querySelectorAll(".directive-flag input")) as HTMLInputElement[];
	const topP = boxes.find((box) => box.getAttribute("aria-label") === 'Force "top_p"') as HTMLInputElement;
	fireCheck(topP, false);

	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2, top_p: 0.9, _force: ["temperature"] } } },
	]);
});

test("a malformed _force value blocks Apply with the example-led message", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { _force: ["x"] } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	const valueInput = Array.from(section().querySelectorAll("input.value")).find(
		(input) => (input as HTMLInputElement).value === '["x"]'
	) as HTMLInputElement;
	fireInput(valueInput, '"temperature"');
	expect(section().textContent).toContain('Enter true or a list of parameter names, e.g. ["temperature"]');
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
});

test("a partly invalid _force list still checks its string entries while the row blocks", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				settings: settingsWithParams({ "gpt-4": { temperature: 0.2, _force: [42, "temperature"] } }),
			})
		)
	);
	const section = sectionByHeading(root, "Model parameters");

	// The resolver salvages the string entries, so the box reflects them; the
	// strict row parse still blocks Apply until the junk entry is fixed.
	const box = section.querySelector<HTMLInputElement>("label input[type='checkbox']");
	expect(box?.checked).toBe(true);
	expect(section.textContent).toContain('Enter true or a list of parameter names, e.g. ["temperature"]');
	expect((buttonByText(section, "Apply") as HTMLButtonElement).disabled).toBe(true);
});

test("an unnamed row carries no force box, and renaming a forced key hints about the stranded mark", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2, _force: ["temperature"] } }) }))
	);
	const section = () => sectionByHeading(root, "Model parameters");

	// Renaming the forced row's key strands "temperature" in the list; the row
	// hints (resolution ignores the stray name) without blocking Apply.
	const keyInput = Array.from(section().querySelectorAll("input.key")).find(
		(input) => (input as HTMLInputElement).value === "temperature"
	) as HTMLInputElement;
	fireInput(keyInput, "temp2");
	expect(section().textContent).toContain('"temperature" is not a parameter this record sets');
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);

	// A fresh row has no key yet, so no box renders for it (the renamed row
	// keeps its own; the empty row's missing name blocks Apply separately).
	fireClick(buttonByText(section(), "Add parameter"));
	expect(section().querySelectorAll(".directive-flag input[aria-label^='Force']").length).toBe(1);
});

/** The group's inheritable box for one row key; the aria-label carries the key in quotes. */
function inheritableBox(section: HTMLElement, key: string): HTMLInputElement {
	const box = Array.from(section.querySelectorAll(".directive-flag input")).find(
		(candidate) => candidate.getAttribute("aria-label") === `Mark "${key}" inheritable`
	);
	if (box === undefined) {
		throw new Error(`no inheritable box for ${key}`);
	}
	return box as HTMLInputElement;
}

/** Pick a select option and fire the change event preact listens for. */
function fireSelect(element: HTMLSelectElement, value: string): void {
	void act(() => {
		element.value = value;
		element.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

/** The group div whose prefix input holds the given matcher key. */
function groupByPrefix(section: HTMLElement, prefix: string): HTMLElement {
	const group = Array.from(section.querySelectorAll(".group")).find(
		(candidate) => (candidate.querySelector("input.key") as HTMLInputElement | null)?.value === prefix
	);
	if (group === undefined) {
		throw new Error(`no group with prefix ${prefix}`);
	}
	return group as HTMLElement;
}

test("inheritable checkbox: marking a row writes the explicit _inheritable list and Apply posts it", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4*": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	const box = inheritableBox(section(), "temperature");
	expect(box.checked).toBe(false);
	fireCheck(box, true);

	// The mark materializes as the _inheritable row's explicit list, visible as text.
	const values = Array.from(section().querySelectorAll("input.value")).map((i) => (i as HTMLInputElement).value);
	expect(values).toContain('["temperature"]');

	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelParameters", value: { "gpt-4*": { temperature: 0.2, _inheritable: ["temperature"] } } },
	]);
});

test("inheritable checkbox: unmarking the last field removes the _inheritable row entirely", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({ settings: settingsWithParams({ "gpt-4*": { temperature: 0.2, _inheritable: ["temperature"] } }) })
		)
	);
	const section = () => sectionByHeading(root, "Model parameters");

	const box = inheritableBox(section(), "temperature");
	expect(box.checked).toBe(true);
	fireCheck(box, false);

	const keys = Array.from(section().querySelectorAll("input.key")).map((i) => (i as HTMLInputElement).value);
	expect(keys).not.toContain("_inheritable");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([{ type: "setModelParameters", value: { "gpt-4*": { temperature: 0.2 } } }]);
});

test("the Inherits select writes the _inherit_from barrier row and removes it again on default", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4*": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	const select = () => section().querySelector(".inherit-from select") as HTMLSelectElement;
	expect(select().value).toBe("default");
	fireSelect(select(), "none");

	// The barrier materializes as the visible _inherit_from row, value false.
	const rowTexts = () =>
		Array.from(section().querySelectorAll(".rows .row")).map((row) => {
			const key = row.querySelector("input.key") as HTMLInputElement | null;
			const value = row.querySelector("input.value") as HTMLInputElement | null;
			return `${key?.value ?? ""}=${value?.value ?? ""}`;
		});
	expect(rowTexts()).toContain("_inherit_from=false");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelParameters", value: { "gpt-4*": { temperature: 0.2, _inherit_from: false } } },
	]);

	// Back to default: the directive row disappears and the draft matches the
	// (still un-reflected) store again, so Apply disables.
	fireSelect(select(), "default");
	expect(rowTexts()).not.toContain("_inherit_from=false");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
});

test("the keys mode edits the _inherit_from list through the comma input, and an unknown name hints without blocking", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				settings: settingsWithParams({ "*": { top_p: 0.9 }, "gpt-4*": { temperature: 0.2, _inherit_from: ["*"] } }),
			})
		)
	);
	const section = () => sectionByHeading(root, "Model parameters");
	const group = () => groupByPrefix(section(), "gpt-4*");

	// A stored list reads back as the keys mode with the joined text.
	const select = group().querySelector(".inherit-from select") as HTMLSelectElement;
	expect(select.value).toBe("keys");
	const keysInput = () => group().querySelector("input.inherit-keys") as HTMLInputElement;
	expect(keysInput().value).toBe("*");

	// Naming a record that does not exist hints (the resolver skips the name
	// and applies the rest) and must not block Apply.
	fireInput(keysInput(), "nope, *");
	expect(section().textContent).toContain(
		'"nope" is not a record key here; that name is skipped and the rest still applies'
	);
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{
			type: "setModelParameters",
			value: { "*": { top_p: 0.9 }, "gpt-4*": { temperature: 0.2, _inherit_from: ["nope", "*"] } },
		},
	]);
});

test("a dirty draft wins over pushed state, Apply posts parsed rows, the ack and reflecting push drop the draft", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(buttonByText(section(), "Add model matcher"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt-4");
	fireInput(inputs[1] as HTMLInputElement, "temperature");
	fireInput(inputs[2] as HTMLInputElement, "0.2");

	// A background refresh must not clobber the half-edited draft.
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const namesAfterPush = Array.from(section().querySelectorAll("input.key")).map(
		(input) => (input as HTMLInputElement).value
	);
	expect(namesAfterPush).toEqual(["gpt-4", "temperature"]);

	// Apply posts the whole parsed record; the JSON "0.2" parses as a number.
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2 } } }]);

	// In flight, then acked but not yet reflected: still rendering, not dirty.
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
	ackLastWrite();
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);

	// The reflecting push drops the draft; the store value renders.
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const reflected = Array.from(section().querySelectorAll("input.key")).map(
		(input) => (input as HTMLInputElement).value
	);
	expect(reflected).toEqual(["gpt-4", "temperature"]);
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
});

test("an intentFailed after Apply reopens the draft dirty with the failure note", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(buttonByText(section(), "Add model matcher"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt-4");
	fireInput(inputs[1] as HTMLInputElement, "temperature");
	fireInput(inputs[2] as HTMLInputElement, "0.2");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);

	pushToWebview({
		type: "intentFailed",
		intentType: "setModelParameters",
		message: "gpt-4: refused by validation.",
		kind: "validation",
		requestId: lastRequestId(),
	});
	// The draft returns dirty and retryable; a failed write must not render as
	// applied. Headline and the extension's message render as separate lines.
	expect(section().textContent).toContain(
		"Saving failed - your edits are kept. Fix the problem below and Apply again."
	);
	expect(section().textContent).toContain("gpt-4: refused by validation.");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);
});

test("model parameters: invalid JSON blocks Apply with the row problem; fixing it applies the parsed value", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(buttonByText(section(), "Add model matcher"));
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
	expect(postedRecordWrites()).toEqual([{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2 } } }]);
});

test("model parameters: the global editor's matcher copy points server records at entries (the entry editor's must not)", () => {
	// The shared ParamGroupsFields takes its prefix placeholder and help as
	// required props because the two surfaces differ for real: the global
	// editor's help routes server-specific records to the entry's
	// models.parameters, the per-entry editor's says URL keys never match
	// (servers.test.tsx pins that side). This pins the global side so the two
	// cannot silently re-merge onto one copy.
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const section = sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section, "Add model matcher"));

	const prefixInput = section.querySelector<HTMLInputElement>("input.key[placeholder^='Model ID or matcher']");
	if (prefixInput === null) {
		throw new Error("no prefix input rendered");
	}
	expect(prefixInput.placeholder).toBe("Model ID or matcher, e.g. gpt-4 or gpt-4*");
	const glyph = prefixInput.closest(".cell")?.querySelector("button.help");
	const tip = document.getElementById(glyph?.getAttribute("aria-describedby") ?? "");
	expect(tip?.textContent).toBe(helpModelParameterPrefix());
});

test("a draft edited back to the store value counts as unchanged: Apply and Discard disable, nothing posts", () => {
	// The scalar rows' unchanged-posts-nothing rule, in draft form: writing a
	// value the store already holds is not a change worth posting.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");
	const valueInput = () => section().querySelector("input.value") as HTMLInputElement;

	fireInput(valueInput(), "0.7");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);
	fireInput(valueInput(), "0.2");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
	expect((buttonByText(section(), "Discard") as HTMLButtonElement).disabled).toBe(true);
	resetPosted();
	fireKeyDown(valueInput(), "Enter");
	expect(postedMessages).toEqual([]);
});

test("rows that assemble to the stored record cannot be applied, even under a different spelling or key order", () => {
	// "1e1" is a different text for the stored 10; applying it would write a
	// value the store already holds (unchanged-posts-nothing).
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { max_tokens: 10 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");
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
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ a: { x: 1 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section(), "Edit as JSON"));
	const textarea = () => section().querySelector("textarea") as HTMLTextAreaElement;

	// Untouched, the textarea must not go stale and overwrite newer settings on a later Apply.
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ a: { x: 1 }, b: { y: 2 } }) })));
	expect(JSON.parse(textarea().value)).toEqual({ a: { x: 1 }, b: { y: 2 } });

	// Edited, it pins like a dirty rows draft.
	fireInput(textarea(), '{"mine": {"kept": 1}}');
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ a: { x: 9 } }) })));
	expect(JSON.parse(textarea().value)).toEqual({ mine: { kept: 1 } });

	// Applied text holds through the applying window and a failure: resyncing
	// there would flash the pre-apply value back into the textarea.
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(JSON.parse(textarea().value)).toEqual({ mine: { kept: 1 } });
	pushToWebview({
		type: "intentFailed",
		intentType: "setModelParameters",
		message: "refused.",
		kind: "validation",
		requestId: lastRequestId(),
	});
	expect(JSON.parse(textarea().value)).toEqual({ mine: { kept: 1 } });
});

test("Enter applies from any row input once the draft is clean; a highlighted suggestion is accepted instead", () => {
	// The key inputs carry their own suggestion listboxes now: Enter with a
	// highlighted suggestion accepts it and must NOT double as Apply (the
	// half-typed row would post); Enter with nothing highlighted applies.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ models: [makeModel({ id: "gpt-test" })] })));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section(), "Add model matcher"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt");
	fireInput(inputs[1] as HTMLInputElement, "temperature");
	fireInput(inputs[2] as HTMLInputElement, "0.2");

	// Highlight the prefix suggestion; Enter accepts it without applying.
	const prefixInput = () =>
		section().querySelector("input.key[placeholder^='Model ID or matcher']") as HTMLInputElement;
	resetPosted();
	fireKeyDown(prefixInput(), "ArrowDown");
	fireKeyDown(prefixInput(), "Enter");
	expect(prefixInput().value).toBe("gpt-test");
	expect(postedMessages).toEqual([]);

	// Nothing highlighted: Enter applies the clean draft from a key input too.
	fireKeyDown(section().querySelector("input.key[placeholder^='Parameter']") as HTMLInputElement, "Enter");
	expect(postedRecordWrites()).toEqual([{ type: "setModelParameters", value: { "gpt-test": { temperature: 0.2 } } }]);
});

test("Discard drops a dirty draft back to the store value without posting, under a distinct accessible name", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	// The draft button is Discard, never Reset: on the scalar rows above,
	// Reset deletes a persisted value, and one word must not mean both.
	expect(Array.from(section().querySelectorAll("button")).map((b) => (b.textContent ?? "").trim())).not.toContain(
		"Reset"
	);
	const discard = () => buttonByText(section(), "Discard");
	expect(discard().disabled).toBe(true);
	expect(discard().getAttribute("aria-label")).toBe("Discard the unapplied model parameter edits");

	fireInput(section().querySelector("input.value") as HTMLInputElement, "0.7");
	expect(discard().disabled).toBe(false);
	resetPosted();
	fireClick(discard());
	expect(postedMessages).toEqual([]);
	expect((section().querySelector("input.value") as HTMLInputElement).value).toBe("0.2");
	expect(discard().disabled).toBe(true);
});

test("Apply feedback: Applying... until the ack resolves it to a transient Saved that the next edit clears", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");
	const status = () => section().querySelector(".apply-status")?.textContent ?? "";

	expect(status()).toBe("");
	fireClick(buttonByText(section(), "Add model matcher"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt-4");
	fireInput(inputs[1] as HTMLInputElement, "temperature");
	fireInput(inputs[2] as HTMLInputElement, "0.2");
	expect(status()).toBe("");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(status()).toBe("Applying...");

	// The ack resolves the phase; the draft rows keep rendering until the
	// reflecting push (no flash of the pre-apply value in between).
	ackLastWrite();
	expect(status()).toBe("Saved");
	const names = Array.from(section().querySelectorAll("input.key")).map((input) => (input as HTMLInputElement).value);
	expect(names).toEqual(["gpt-4", "temperature"]);

	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	expect(status()).toBe("Saved");

	fireInput(section().querySelector("input.value") as HTMLInputElement, "0.9");
	expect(status()).toBe("");
});

test("Apply feedback: a failure ends the Applying... window along with reopening the draft", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(buttonByText(section(), "Add model matcher"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt-4");
	fireInput(inputs[1] as HTMLInputElement, "temperature");
	fireInput(inputs[2] as HTMLInputElement, "0.2");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(section().querySelector(".apply-status")?.textContent).toBe("Applying...");

	pushToWebview({
		type: "intentFailed",
		intentType: "setModelParameters",
		message: "refused.",
		kind: "validation",
		requestId: lastRequestId(),
	});
	expect(section().querySelector(".apply-status")?.textContent).toBe("");
	expect(section().textContent).toContain("Saving failed - your edits are kept.");
	expect(section().textContent).toContain("refused.");
});

test("a foreign ack or foreign failure leaves an applying draft alone; only its own outcome resolves it", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");
	const status = () => section().querySelector(".apply-status")?.textContent ?? "";

	fireClick(buttonByText(section(), "Add model matcher"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt-4");
	fireInput(inputs[1] as HTMLInputElement, "temperature");
	fireInput(inputs[2] as HTMLInputElement, "0.2");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(status()).toBe("Applying...");

	// Another surface's ack (a server save) and a failure with a foreign
	// requestId must not resolve or reopen this draft.
	pushToWebview({ type: "intentSucceeded", intentType: "saveServerSetting", requestId: "someone-else" });
	expect(status()).toBe("Applying...");
	pushToWebview({
		type: "intentFailed",
		intentType: "setModelParameters",
		message: "not this write.",
		kind: "validation",
		requestId: "someone-else",
	});
	expect(status()).toBe("Applying...");
	expect(section().textContent).not.toContain("not this write.");

	// A concurrent state push is not this write's success signal either: the
	// old drift heuristic would have rendered this as Saved.
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ other: { top_p: 0.9 } }) })));
	expect(status()).toBe("Applying...");

	ackLastWrite();
	expect(status()).toBe("Saved");
});

test("Discard is the escape hatch of an applying draft whose ack never arrives", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(buttonByText(section(), "Add model matcher"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt-4");
	fireInput(inputs[1] as HTMLInputElement, "temperature");
	fireInput(inputs[2] as HTMLInputElement, "0.2");
	fireClick(buttonByText(section(), "Apply"));
	expect(section().querySelector(".apply-status")?.textContent).toBe("Applying...");

	const discard = buttonByText(section(), "Discard");
	expect(discard.disabled).toBe(false);
	fireClick(discard);
	expect(section().querySelector(".apply-status")?.textContent).toBe("");
	const names = Array.from(section().querySelectorAll("input.key")).map((input) => (input as HTMLInputElement).value);
	expect(names).toEqual([]);
});

test("a discarded draft's failure notice never resurfaces on the next edit", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(buttonByText(section(), "Add model matcher"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt-4");
	fireInput(inputs[1] as HTMLInputElement, "temperature");
	fireInput(inputs[2] as HTMLInputElement, "0.2");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	pushToWebview({
		type: "intentFailed",
		intentType: "setModelParameters",
		message: "stale refusal.",
		kind: "validation",
		requestId: lastRequestId(),
	});
	expect(section().textContent).toContain("stale refusal.");

	// Discard drops the draft; a brand-new edit must not dredge the old
	// notice back up (its failure belongs to the discarded write).
	fireClick(buttonByText(section(), "Discard"));
	fireClick(buttonByText(section(), "Add model matcher"));
	fireInput(section().querySelector("input.key") as HTMLInputElement, "claude-4");
	expect(section().textContent).not.toContain("stale refusal.");
});

test("the JSON textarea holds its applied text through the acked window until the reflecting push", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ a: { x: 1 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section(), "Edit as JSON"));
	const textarea = () => section().querySelector("textarea") as HTMLTextAreaElement;

	fireInput(textarea(), '{"mine": {"kept": 1}}');
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));

	// Acked but not yet reflected: resyncing here would flash the pre-apply
	// store value back into the textarea.
	ackLastWrite();
	expect(JSON.parse(textarea().value)).toEqual({ mine: { kept: 1 } });

	pushToWebview(statePush(makeState({ settings: settingsWithParams({ mine: { kept: 1 } }) })));
	expect(JSON.parse(textarea().value)).toEqual({ mine: { kept: 1 } });
});

test("a parameter-row problem marks only the offending input: bad JSON flags the value, a bad name the name", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section(), "Add model matcher"));
	const nameInput = () => section().querySelector("input.key[placeholder^='Parameter']") as HTMLInputElement;
	const valueInput = () => section().querySelector("input.value") as HTMLInputElement;

	fireInput(section().querySelector("input.key[placeholder^='Model ID or matcher']") as HTMLInputElement, "gpt-4");
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
	});
	pushToWebview(statePush(makeState({ settings })));

	const paramsOther = sectionByHeading(root, "Model parameters").querySelector(".other-scope");
	expect(paramsOther?.textContent).toContain("Set in Workspace settings - edit there.");
	const paramValues = Array.from(paramsOther?.querySelectorAll('input:not([type="checkbox"])') ?? []).map(
		(i) => (i as HTMLInputElement).value
	);
	expect(paramValues).toEqual(["gpt-4", "temperature", "0.2"]);
	for (const input of Array.from(paramsOther?.querySelectorAll("input") ?? [])) {
		expect((input as HTMLInputElement).disabled).toBe(true);
	}
	// The force box renders in the static grid too - state is information -
	// but inert like every other input there (the loop above covers it).
	expect(paramsOther?.querySelector('.directive-flag input[type="checkbox"]')).not.toBeNull();
	// A static display offers no row mutations.
	expect(paramsOther?.querySelector("button.quiet:not(.help)")).toBeNull();
});

test("the prefix and parameter-name inputs offer suggestion listboxes: discovered model IDs and the common parameter names", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ models: [makeModel({ id: "gpt-test" }), makeModel({ id: "claude-x", name: "Claude X" })] }))
	);
	const section = sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section, "Add model matcher"));

	// No native datalists anywhere: the webview host renders them all-bold and
	// unstylable, which is the bug the custom listbox replaces.
	expect(document.querySelector("datalist")).toBeNull();

	const prefixInput = section.querySelector("input.key[placeholder^='Model ID or matcher']") as HTMLInputElement;
	expect(prefixInput.getAttribute("role")).toBe("combobox");
	fireFocus(prefixInput);
	const prefixList = document.getElementById(prefixInput.getAttribute("aria-controls") ?? "");
	expect(prefixList?.getAttribute("role")).toBe("listbox");
	expect(Array.from(prefixList?.querySelectorAll("[role='option']") ?? []).map((o) => o.textContent)).toEqual([
		"gpt-test",
		"claude-x",
	]);

	const nameInput = section.querySelector("input.key[placeholder^='Parameter']") as HTMLInputElement;
	fireFocus(nameInput);
	const nameList = document.getElementById(nameInput.getAttribute("aria-controls") ?? "");
	expect(nameList?.getAttribute("role")).toBe("listbox");
	const names = Array.from(nameList?.querySelectorAll("[role='option']") ?? []).map((o) => o.textContent);
	expect(names).toContain("temperature");
	expect(names).toContain("reasoning_effort");
});

test("Enter in a record-row input applies a clean draft and does nothing while it is invalid", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const params = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(params(), "Add model matcher"));
	const paramInputs = params().querySelectorAll("input");
	fireInput(paramInputs[0] as HTMLInputElement, "gpt-4");
	fireInput(paramInputs[1] as HTMLInputElement, "temperature");
	fireInput(paramInputs[2] as HTMLInputElement, "not json");
	resetPosted();
	fireKeyDown(params().querySelector("input.value") as HTMLInputElement, "Enter");
	expect(postedMessages).toEqual([]);

	fireInput(params().querySelector("input.value") as HTMLInputElement, "0.2");
	fireKeyDown(params().querySelector("input.value") as HTMLInputElement, "Enter");
	expect(postedRecordWrites()).toEqual([{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2 } } }]);
});

test("each editor's hint names the seam between the two save models: rows apply together via Apply", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	expect(sectionByHeading(root, "Model parameters").textContent).toContain(
		"Rows here apply together via the Apply button"
	);
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
		"Add model matcher"
	);
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);

	fireInput(textarea(), '{"gpt-4": {"temperature": 1}, "claude": {"max_tokens": 100}}');
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
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
	expect((section().querySelector("input.key[placeholder^='Model ID or matcher']") as HTMLInputElement).value).toBe(
		"gpt-4"
	);
});

test("each editor heading carries a settings.json jump posting revealSetting with its record key", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));

	const jumpOf = (heading: string) => sectionByHeading(root, heading).querySelector("button.reveal-json");
	const paramsJump = jumpOf("Model parameters");
	expect(paramsJump?.getAttribute("aria-label")).toBe("Open Model parameters in settings.json");
	resetPosted();
	fireClick(paramsJump as HTMLButtonElement);
	expect(postedMessages).toEqual([{ type: "revealSetting", setting: "models.parameters" }]);
});

test("the settings filter hides an editor with a dirty draft via hidden, and the draft applies after unhiding", () => {
	const root = mount(<SettingsSection settings={settingsWithParams({})} models={[]} failures={{}} />);
	const section = () => sectionByHeading(root, "Model parameters");

	// A half-typed parameter draft...
	fireClick(buttonByText(section(), "Add model matcher"));
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt-4");
	fireInput(inputs[1] as HTMLInputElement, "temperature");
	fireInput(inputs[2] as HTMLInputElement, "0.9");

	// ...is hidden by a non-matching filter, never unmounted...
	const filter = root.querySelector<HTMLInputElement>(".filterbar input") as HTMLInputElement;
	fireInput(filter, "no such setting");
	expect(section().hidden).toBe(true);
	expect((section().querySelectorAll("input")[0] as HTMLInputElement).value).toBe("gpt-4");

	// ...and works untouched once the filter clears: Apply posts the draft.
	fireInput(filter, "");
	expect(section().hidden).toBe(false);
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.9 } } }]);
});

test("the catalog picker debounces searchCatalog and picking a result writes the ID", async () => {
	const root = mount(
		<CatalogPicker value="gpt" disabled={false} invalid={false} results={undefined} onValue={() => {}} debounceMs={1} />
	);
	const input = root.querySelector("input") as HTMLInputElement;
	void act(() => {
		input.dispatchEvent(new Event("focus"));
	});
	// Under the debounce window nothing is posted yet.
	expect(postedMessages).toEqual([]);
	await new Promise((resolve) => setTimeout(resolve, 20));
	const request = postedMessages.at(-1) as unknown as { type: string; query: string; requestId: string };
	expect(request.type).toBe("searchCatalog");
	expect(request.query).toBe("gpt");

	// The correlated response renders the result list; picking writes the ID.
	const picked: string[] = [];
	void act(() => {
		render(
			<CatalogPicker
				value="gpt"
				disabled={false}
				invalid={false}
				results={{
					type: "catalogSearchResults",
					requestId: request.requestId,
					results: [{ id: "openai/gpt-4o", name: "GPT-4o" }],
				}}
				onValue={(next) => picked.push(next)}
				debounceMs={1}
			/>,
			root
		);
	});
	const option = root.querySelector(".catalog-results button") as HTMLButtonElement;
	expect(option?.textContent).toContain("openai/gpt-4o");
	void act(() => {
		option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	});
	expect(picked).toEqual(["openai/gpt-4o"]);
});

test("a stale catalog response for another request renders no result list", () => {
	const root = mount(
		<CatalogPicker
			value="gpt"
			disabled={false}
			invalid={false}
			results={{ type: "catalogSearchResults", requestId: "stale", results: [{ id: "x", name: "X" }] }}
			onValue={() => {}}
			debounceMs={1}
		/>
	);
	expect(root.querySelector(".catalog-results")).toBeNull();
});

test("the catalog picker is keyboard-operable: arrows move the highlight, Enter picks, Escape closes", async () => {
	const picked: string[] = [];
	const root = mount(
		<CatalogPicker
			value="gpt"
			disabled={false}
			invalid={false}
			results={undefined}
			onValue={(id) => picked.push(id)}
			debounceMs={1}
		/>
	);
	const input = root.querySelector("input") as HTMLInputElement;
	void act(() => {
		input.dispatchEvent(new Event("focus"));
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	const request = postedMessages.at(-1) as unknown as { requestId: string };
	void act(() => {
		render(
			<CatalogPicker
				value="gpt"
				disabled={false}
				invalid={false}
				results={{
					type: "catalogSearchResults",
					requestId: request.requestId,
					results: [
						{ id: "openai/gpt-4o", name: "GPT-4o" },
						{ id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
					],
				}}
				onValue={(id) => picked.push(id)}
				debounceMs={1}
			/>,
			root
		);
	});
	fireKeyDown(input, "ArrowDown");
	fireKeyDown(input, "ArrowDown");
	expect(root.querySelector(".catalog-results button.active")?.textContent).toContain("gpt-4o-mini");
	fireKeyDown(input, "Enter");
	expect(picked).toEqual(["openai/gpt-4o-mini"]);
	expect(root.querySelector(".catalog-results")).toBeNull();
});
