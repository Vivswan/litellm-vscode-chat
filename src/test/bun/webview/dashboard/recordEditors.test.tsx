/**
 * The record editors' matcher-table redesign over the unchanged
 * draft-and-apply lifecycle (useDraftRows): the table's cascade-sorted VIEW
 * (storage order never rewritten), the combined field chips with flag
 * badges, the chip popovers and the [+] add popover, the full matcher
 * editor overlay, the Edit-as-JSON side door, the read-only other-scope
 * tables, and the lifecycle itself - a dirty draft survives state pushes,
 * Apply posts the parsed record tagged with a requestId, the correlated ack
 * resolves the phase, a correlated failure reopens the draft, and invalid
 * rows block Apply.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { CONSUMED_CAPABILITY_FIELDS } from "../../../../shared/config/capabilityResolution";
import { App } from "../../../../webview/dashboard/app";
import { helpModelParameterPrefix } from "../../../../webview/dashboard/helpText";
import { CatalogPicker, capabilityKeySuggestions } from "../../../../webview/dashboard/recordEditors";
import { SettingsSection } from "../../../../webview/dashboard/settings";
import { makeModel, makeSettings, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireCheck,
	fireClick,
	fireFocus,
	fireInput,
	fireKeyDown,
	lastRequest,
	mount,
	postedCalls,
	postedMessages,
	pushToWebview,
	resetPosted,
	respondTo,
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

function settingsWithCaps(value: Record<string, Record<string, unknown>>) {
	return makeSettings({ modelCapabilities: { editScope: "global", value, otherScopes: [], effective: value } });
}

/** The posted record writes as method+value pairs (each envelope id asserted present); Apply mints a fresh id per post. */
function postedRecordWrites(): { type: string; value: unknown }[] {
	return postedMessages.map((message) => {
		expect(typeof message.id).toBe("string");
		return { type: message.method, value: (message.payload as { value: unknown }).value };
	});
}

/** The last posted write's correlation id, for pushing its correlated outcome notice. */
function lastRequestId(): string {
	return (postedMessages.at(-1) as { id: string }).id;
}

/** Ack the last posted record write, as the panel does right before its reflecting push. */
function ackLastWrite(method: "setModelParameters" | "setModelCapabilities" = "setModelParameters"): void {
	pushToWebview({ kind: "ack", id: lastRequestId(), method });
}

/** The open matcher editor overlay inside the scope; throws when none is open. */
function overlayOf(scope: HTMLElement): HTMLElement {
	const overlay = scope.querySelector<HTMLElement>(".matcher-editor");
	if (overlay === null) {
		throw new Error("no matcher editor overlay is open");
	}
	return overlay;
}

/** Open the full matcher editor for one table row through its pencil action. */
function openEditorFor(scope: HTMLElement, prefix: string): HTMLElement {
	const pencil = Array.from(scope.querySelectorAll("button")).find(
		(candidate) => candidate.getAttribute("aria-label") === `Open the full editor for "${prefix}"`
	);
	if (pencil === undefined) {
		throw new Error(`no pencil for matcher ${prefix}`);
	}
	fireClick(pencil as HTMLButtonElement);
	return overlayOf(scope);
}

/** The field chip button whose visible key matches (editable tables render chips as buttons). */
function chipFor(scope: HTMLElement, key: string): HTMLButtonElement {
	const chip = Array.from(scope.querySelectorAll("button.chip-field")).find(
		(candidate) => candidate.querySelector(".chip-key")?.textContent === key
	);
	if (chip === undefined) {
		throw new Error(`no chip for field ${key}`);
	}
	return chip as HTMLButtonElement;
}

/** The open chip popover inside the scope; throws when none is open. */
function popoverOf(scope: HTMLElement): HTMLElement {
	const popover = scope.querySelector<HTMLElement>(".chip-popover");
	if (popover === null) {
		throw new Error("no chip popover is open");
	}
	return popover;
}

/** The table rows' matcher keys in DISPLAY order. */
function matcherKeys(scope: HTMLElement): string[] {
	return Array.from(scope.querySelectorAll(".record-table .matcher-key")).map((cell) => cell.textContent ?? "");
}

/** The visible field-chip keys of the table (add chips excluded), flag badges not included. */
function chipKeys(scope: HTMLElement): string[] {
	return Array.from(scope.querySelectorAll(".record-table .chip-field:not(.chip-add) .chip-key")).map(
		(key) => key.textContent ?? ""
	);
}

/** The flag badges riding on the chip that carries the given key. */
function chipFlagsOf(scope: HTMLElement, key: string): string[] {
	const chip = Array.from(scope.querySelectorAll(".chip-field")).find(
		(candidate) => candidate.querySelector(".chip-key")?.textContent === key
	);
	if (chip === undefined) {
		throw new Error(`no chip for field ${key}`);
	}
	return Array.from(chip.querySelectorAll(".chip-flag")).map((flag) => flag.textContent ?? "");
}

/**
 * Build a fresh one-field draft through the real UI: Add matcher opens the
 * overlay, the matcher input names it, Add parameter creates the row, and
 * Done returns to the table with the draft dirty but unapplied.
 */
function draftOneParam(section: () => HTMLElement, prefix: string, key: string, value: string): void {
	fireClick(buttonByText(section(), "Add model matcher"));
	const editor = () => overlayOf(section());
	fireInput(editor().querySelector("input.key") as HTMLInputElement, prefix);
	fireClick(buttonByText(editor(), "Add parameter"));
	fireInput(Array.from(editor().querySelectorAll("input.key")).at(-1) as HTMLInputElement, key);
	fireInput(editor().querySelector("input.value") as HTMLInputElement, value);
	fireClick(buttonByText(editor(), "Done"));
}

// === The table view ===

test("rows display in precedence order, lowest first, while the stored key order is never rewritten", () => {
	const root = mount(<App />);
	// Storage order is deliberately scrambled; regex precedence IS declaration
	// order, so the JSON must keep exactly this order while the VIEW sorts.
	const record = {
		"gpt-4": { temperature: 1 },
		"/gpt-.*/": { top_p: 0.5 },
		"*": { temperature: 0.7 },
		"gpt-4-turbo*": { seed: 1 },
		"gpt-4*": { temperature: 0.3 },
	};
	pushToWebview(statePush(makeState({ settings: settingsWithParams(record) })));
	const section = () => sectionByHeading(root, "Model parameters");

	// Catch-all first, then the regex, then globs shorter-prefix-first, then
	// the exact ID: the cascade reads baseline at the top, overrides below.
	expect(matcherKeys(section())).toEqual(["*", "/gpt-.*/", "gpt-4*", "gpt-4-turbo*", "gpt-4"]);
	// Kind annotations name each tier.
	const kinds = Array.from(section().querySelectorAll(".matcher-kind")).map((el) => el.textContent);
	expect(kinds).toEqual(["matches all models", "regex", "prefix match", "prefix match", "exact ID"]);

	// The view order is not an edit: nothing is dirty, and the JSON side door
	// shows the stored order verbatim.
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
	fireClick(buttonByText(section(), "Edit as JSON"));
	expect(Object.keys(JSON.parse((section().querySelector("textarea") as HTMLTextAreaElement).value))).toEqual(
		Object.keys(record)
	);
});

test("an invalid matcher key sorts last and shows the invalid annotation", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "bad*key": { temperature: 1 }, "*": { top_p: 0.9 } }) }))
	);
	const section = sectionByHeading(root, "Model parameters");
	expect(matcherKeys(section)).toEqual(["*", "bad*key"]);
	const kinds = Array.from(section.querySelectorAll(".matcher-kind")).map((el) => el.textContent);
	expect(kinds).toEqual(["matches all models", "invalid matcher"]);
});

test("fields render as combined chips: key, value preview, and flag badges from the directive rows", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				settings: settingsWithParams({
					"gpt-5*": { temperature: 0.3, top_p: 0.9, _force: ["temperature"], _inheritable: ["top_p"] },
				}),
			})
		)
	);
	const section = sectionByHeading(root, "Model parameters");

	// The directive rows are absorbed: no _force or _inheritable chips; their
	// state rides the field chips as badges.
	expect(chipKeys(section)).toEqual(["temperature", "top_p"]);
	expect(chipFlagsOf(section, "temperature")).toEqual(["force"]);
	expect(chipFlagsOf(section, "top_p")).toEqual(["inheritable"]);
});

test("directives the controls cannot fully represent keep a raw chip instead of vanishing", () => {
	// _force naming a parameter no row sets is a stranded mark no badge can
	// carry, and 42 is no _inheritable value: both keep raw chips.
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				settings: settingsWithParams({
					"gpt-4": { temperature: 0.2, _force: ["ghost"] },
					"gpt-5*": { temperature: 0.3, _inheritable: 42 },
				}),
			})
		)
	);
	const section = sectionByHeading(root, "Model parameters");
	expect(chipKeys(section)).toContain("_force");
	expect(chipKeys(section)).toContain("_inheritable");
});

test("the Inherits column reads default, everything, barrier, the listed keys, or custom", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				settings: settingsWithParams({
					"*": { top_p: 0.9 },
					"gpt-4*": { temperature: 0.3, _inherit_from: true },
					"gpt-5*": { temperature: 0.3, _inherit_from: false },
					"gpt-5-mini*": { temperature: 0.2, _inherit_from: ["*"] },
					"claude-4": { temperature: 1, _inherit_from: ["a,b"] },
				}),
			})
		)
	);
	const section = sectionByHeading(root, "Model parameters");
	const inherits = Array.from(section.querySelectorAll(".inherit-cell")).map((cell) => cell.textContent);
	// Display order: *, gpt-4*, gpt-5*, gpt-5-mini*, claude-4.
	expect(inherits).toEqual(["default", "everything", "barrier", "*", "custom"]);
	// The comma-containing key the Inherits control cannot round-trip keeps
	// its raw chip; the readable list is absorbed into the column.
	expect(chipKeys(section)).toContain("_inherit_from");
	const gpt5MiniRow = Array.from(section.querySelectorAll(".record-table tbody tr")).find((row) =>
		row.querySelector(".matcher-key")?.textContent?.includes("gpt-5-mini")
	);
	expect(Array.from(gpt5MiniRow?.querySelectorAll(".chip-key") ?? []).map((el) => el.textContent)).toEqual([
		"temperature",
	]);
});

test("the catalog directive renders as a distinct catalog chip with its ID as the value", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({ settings: settingsWithCaps({ "my-alias": { _openrouter_model: "anthropic/claude-sonnet-4" } }) })
		)
	);
	const section = sectionByHeading(root, "Model capabilities");
	const chip = section.querySelector(".chip-field.chip-catalog");
	if (chip === null) {
		throw new Error("no catalog chip rendered");
	}
	expect(chip.querySelector(".chip-key")?.textContent).toBe("catalog");
	expect(chip.querySelector(".chip-value")?.textContent).toBe("anthropic/claude-sonnet-4");
});

test("other-scope records render as the same table without edit affordances, chips as plain spans", () => {
	const root = mount(<App />);
	const settings = makeSettings({
		modelParameters: {
			editScope: "global",
			value: {},
			otherScopes: [{ scope: "workspace", value: { "gpt-4": { temperature: 0.2, _force: ["temperature"] } } }],
			effective: { "gpt-4": { temperature: 0.2, _force: ["temperature"] } },
		},
	});
	pushToWebview(statePush(makeState({ settings })));

	const other = sectionByHeading(root, "Model parameters").querySelector(".other-scope") as HTMLElement;
	expect(other.textContent).toContain("Set in Workspace settings - edit there.");
	// The state is information: the force mark shows as a badge on its chip.
	expect(matcherKeys(other)).toEqual(["gpt-4"]);
	expect(chipFlagsOf(other, "temperature")).toEqual(["force"]);
	// No edit affordances: no chip buttons, no add chip, no pencil column.
	expect(other.querySelector("button.chip-field")).toBeNull();
	expect(other.querySelector(".chip-add")).toBeNull();
	expect(other.querySelector(".edit-cell")).toBeNull();
});

// === The chip popover ===

test("a chip click opens the popover; editing the value writes the draft live and Apply posts it", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(chipFor(section(), "temperature"));
	const popover = () => popoverOf(section());
	const value = () => popover().querySelector("input.value") as HTMLInputElement;
	expect(value().value).toBe("0.2");
	fireInput(value(), "0.7");

	// The chip preview follows the draft keystroke for keystroke.
	expect(section().querySelector(".chip-field .chip-value")?.textContent).toBe("0.7");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.7 } } }]);
});

test("popover validation: a bad value marks the chip and blocks Apply; the message renders in the popover", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(chipFor(section(), "temperature"));
	fireInput(popoverOf(section()).querySelector("input.value") as HTMLInputElement, "not json");
	expect(popoverOf(section()).textContent).toContain("Not valid JSON");
	expect(chipFor(section(), "temperature").classList.contains("invalid")).toBe(true);
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
});

test("the popover's force toggle writes the _force list without a raw chip, and unmarking removes it", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(chipFor(section(), "temperature"));
	const force = () => popoverOf(section()).querySelector(`input[aria-label='Force "temperature"']`) as HTMLInputElement;
	expect(force().checked).toBe(false);
	fireCheck(force(), true);
	// The badge is the mark's representation; no _force chip materializes.
	expect(chipFlagsOf(section(), "temperature")).toEqual(["force"]);
	expect(chipKeys(section())).toEqual(["temperature"]);
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2, _force: ["temperature"] } } },
	]);

	// Unmarking the last field drops the directive key entirely.
	fireCheck(force(), false);
	expect(chipFlagsOf(section(), "temperature")).toEqual([]);
});

test("the popover disables force for provider-owned keys with the reason in its help", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { model: "other" } }) })));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(chipFor(section(), "model"));
	const force = popoverOf(section()).querySelector<HTMLInputElement>(`input[aria-label='Force "model"']`);
	expect(force?.disabled).toBe(true);
	expect(popoverOf(section()).textContent).toContain("Cannot be forced: provider-owned fields like model");
});

test("Remove field lives in the popover and drops the row from the draft", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2, top_p: 0.9 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(chipFor(section(), "top_p"));
	fireClick(buttonByText(popoverOf(section()), "Remove field"));
	expect(chipKeys(section())).toEqual(["temperature"]);
	expect(section().querySelector(".chip-popover")).toBeNull();
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2 } } }]);
});

test("Escape closes the popover and keeps its edits (they already live in the draft)", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(chipFor(section(), "temperature"));
	fireInput(popoverOf(section()).querySelector("input.value") as HTMLInputElement, "0.9");
	fireKeyDown(popoverOf(section()), "Escape");
	expect(section().querySelector(".chip-popover")).toBeNull();
	expect(section().querySelector(".chip-field .chip-value")?.textContent).toBe("0.9");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);
});

test("an open popover with a dirty draft survives a state push; without a draft a vanished field closes it", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	// Dirty draft: the push must not clobber the draft or drop the popover.
	fireClick(chipFor(section(), "temperature"));
	fireInput(popoverOf(section()).querySelector("input.value") as HTMLInputElement, "0.9");
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	expect((popoverOf(section()).querySelector("input.value") as HTMLInputElement).value).toBe("0.9");

	// Pristine popover over store rows: a push that removes the field closes
	// the popover instead of leaving it editing a stale row.
	fireClick(buttonByText(section(), "Discard"));
	fireClick(chipFor(section(), "temperature"));
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { top_p: 0.9 } }) })));
	expect(section().querySelector(".chip-popover")).toBeNull();
});

test("the catalog chip's popover edits the ID through the catalog picker", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({ settings: settingsWithCaps({ "my-alias": { _openrouter_model: "anthropic/claude-sonnet-4" } }) })
		)
	);
	const section = () => sectionByHeading(root, "Model capabilities");
	// The catalog chip's visible key is the plain-language "catalog".
	fireClick(chipFor(section(), "catalog"));
	const picker = popoverOf(section()).querySelector(".catalog-picker input") as HTMLInputElement;
	expect(picker.value).toBe("anthropic/claude-sonnet-4");
	fireInput(picker, "openai/gpt-4o");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelCapabilities", value: { "my-alias": { _openrouter_model: "openai/gpt-4o" } } },
	]);
});

// === The [+] add popover ===

test("the add popover assembles key, value, and flags locally and commits them as one draft update", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(section().querySelector("button.chip-add") as HTMLButtonElement);
	const popover = () => popoverOf(section());
	fireInput(popover().querySelector("input.key") as HTMLInputElement, "top_p");
	fireInput(popover().querySelector("input.value") as HTMLInputElement, "0.9");
	fireCheck(popover().querySelector(`input[aria-label='Force "top_p"']`) as HTMLInputElement, true);

	// Nothing lands until Add: the chip list still shows only temperature.
	expect(chipKeys(section())).toEqual(["temperature"]);
	fireClick(buttonByText(popover(), "Add field"));
	expect(chipKeys(section())).toEqual(["temperature", "top_p"]);
	expect(chipFlagsOf(section(), "top_p")).toEqual(["force"]);
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2, top_p: 0.9, _force: ["top_p"] } } },
	]);
});

test("the add popover refuses an invalid candidate: the error renders in place and nothing leaks into the draft", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(section().querySelector("button.chip-add") as HTMLButtonElement);
	const popover = () => popoverOf(section());
	// A duplicate key is refused by the same parse the editor runs.
	fireInput(popover().querySelector("input.key") as HTMLInputElement, "temperature");
	fireInput(popover().querySelector("input.value") as HTMLInputElement, "1");
	expect(popover().textContent).toContain("Duplicate parameter name");
	const add = buttonByText(popover(), "Add field") as HTMLButtonElement;
	expect(add.disabled).toBe(true);
	fireClick(add);
	expect(chipKeys(section())).toEqual(["temperature"]);
	// So is a bad value.
	fireInput(popover().querySelector("input.key") as HTMLInputElement, "top_p");
	fireInput(popover().querySelector("input.value") as HTMLInputElement, "not json");
	expect((buttonByText(popover(), "Add field") as HTMLButtonElement).disabled).toBe(true);
	// The draft never went dirty.
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
});

test("the capability add popover seeds a support flag true and offers the fallback mark", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithCaps({ "*": { context_length: 131072 } }) })));
	const section = () => sectionByHeading(root, "Model capabilities");

	fireClick(section().querySelector("button.chip-add") as HTMLButtonElement);
	const popover = () => popoverOf(section());
	fireInput(popover().querySelector("input.key") as HTMLInputElement, "supports_vision");
	// The boolean value control appears seeded true (the row-switch rule).
	expect((popover().querySelector(".capability-flag input") as HTMLInputElement).checked).toBe(true);
	fireCheck(popover().querySelector(`input[aria-label='Fall back for "supports_vision"']`) as HTMLInputElement, true);
	fireClick(buttonByText(popover(), "Add field"));
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{
			type: "setModelCapabilities",
			value: { "*": { context_length: 131072, supports_vision: true, _fallback: ["supports_vision"] } },
		},
	]);
});

test("an open add popover follows its matcher key through a push that reorders the record", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 }, "*": { top_p: 0.9 } }) }))
	);
	const section = () => sectionByHeading(root, "Model parameters");

	// Open [+] on the gpt-4 row (second in display order) and half-type a key.
	fireClick(Array.from(section().querySelectorAll("button.chip-add")).at(-1) as HTMLButtonElement);
	fireInput(popoverOf(section()).querySelector("input.key") as HTMLInputElement, "seed");

	// No draft is pinned yet, so the push replaces the rows - reordered. The
	// popover is addressed by the MATCHER KEY: it must stay open on gpt-4 with
	// its half-typed field intact, not retarget or remount.
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "*": { top_p: 0.9 }, "gpt-4": { temperature: 0.2 } }) }))
	);
	expect((popoverOf(section()).querySelector("input.key") as HTMLInputElement).value).toBe("seed");

	fireInput(popoverOf(section()).querySelector("input.value") as HTMLInputElement, "7");
	fireClick(buttonByText(popoverOf(section()), "Add field"));
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelParameters", value: { "*": { top_p: 0.9 }, "gpt-4": { temperature: 0.2, seed: 7 } } },
	]);
});

test("a chip's accessible name is its content: the hidden action prefix plus key, value, and badges", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2, _force: ["temperature"] } }) }))
	);
	const chip = chipFor(sectionByHeading(root, "Model parameters"), "temperature");
	// No aria-label: it would mask the value and the flag badges.
	expect(chip.getAttribute("aria-label")).toBeNull();
	expect(chip.querySelector(".visually-hidden")?.textContent).toBe("Edit field");
	expect(chip.textContent).toContain("temperature");
	expect(chip.textContent).toContain("0.2");
	expect(chip.textContent).toContain("force");
});

test("the add popover under a literal true directive shows the implied mark and never explodes the literal", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2, _force: true, _inheritable: true } }) })
		)
	);
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(section().querySelector("button.chip-add") as HTMLButtonElement);
	const popover = () => popoverOf(section());
	fireInput(popover().querySelector("input.key") as HTMLInputElement, "top_p");
	// A literal true covers the new field the moment it lands: the boxes must
	// say so instead of showing unchecked marks that then appear as badges.
	expect((popover().querySelector(`input[aria-label='Force "top_p"']`) as HTMLInputElement).checked).toBe(true);
	expect((popover().querySelector(`input[aria-label='Mark "top_p" inheritable']`) as HTMLInputElement).checked).toBe(
		true
	);

	// Untouched boxes leave the literals verbatim - no exploding true into a
	// list on commit.
	fireInput(popover().querySelector("input.value") as HTMLInputElement, "0.9");
	fireClick(buttonByText(popover(), "Add field"));
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{
			type: "setModelParameters",
			value: { "gpt-4": { temperature: 0.2, _force: true, _inheritable: true, top_p: 0.9 } },
		},
	]);
});

test("unchecking an implied mark in the add popover rewrites the literal as the explicit remainder", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2, _force: true } }) }))
	);
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(section().querySelector("button.chip-add") as HTMLButtonElement);
	const popover = () => popoverOf(section());
	fireInput(popover().querySelector("input.key") as HTMLInputElement, "top_p");
	fireInput(popover().querySelector("input.value") as HTMLInputElement, "0.9");
	fireCheck(popover().querySelector(`input[aria-label='Force "top_p"']`) as HTMLInputElement, false);
	fireClick(buttonByText(popover(), "Add field"));
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	// The explicit choice rewrites the literal over the eligible remainder,
	// exactly like unchecking a box in the full editor.
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2, _force: ["temperature"], top_p: 0.9 } } },
	]);
});

test("duplicate field keys: each chip answers its own popover, and Remove field deletes the clicked row", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	// Mint a duplicate through the overlay (the parse blocks it, but it stays
	// representable and editable).
	openEditorFor(section(), "gpt-4");
	const editor = () => overlayOf(section());
	fireClick(buttonByText(editor(), "Add parameter"));
	fireInput(Array.from(editor().querySelectorAll(".rows input.key")).at(-1) as HTMLInputElement, "temperature");
	fireInput(Array.from(editor().querySelectorAll(".rows input.value")).at(-1) as HTMLInputElement, "0.9");
	fireKeyDown(editor(), "Escape");

	const chips = Array.from(section().querySelectorAll("button.chip-field")).filter(
		(chip) => chip.querySelector(".chip-key")?.textContent === "temperature"
	);
	expect(chips).toHaveLength(2);
	// The SECOND chip's popover edits the second row, not the first.
	fireClick(chips[1] as HTMLButtonElement);
	expect(chips[1]?.getAttribute("aria-expanded")).toBe("true");
	expect(chips[0]?.getAttribute("aria-expanded")).toBe("false");
	expect((popoverOf(section()).querySelector("input.value") as HTMLInputElement).value).toBe("0.9");
	fireClick(buttonByText(popoverOf(section()), "Remove field"));
	expect(section().querySelector(".chip-field .chip-value")?.textContent).toBe("0.2");
});

test("a pristine overlay follows its matcher key through a push that reorders the record", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 }, "*": { top_p: 0.9 } }) }))
	);
	const section = () => sectionByHeading(root, "Model parameters");

	openEditorFor(section(), "gpt-4");
	// No draft pinned yet: the push replaces AND reorders the rows. The
	// overlay is re-anchored by its matcher key, so it must stay on gpt-4
	// instead of silently retargeting whatever slid into its index.
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "*": { top_p: 0.9 }, "gpt-4": { temperature: 0.2 } }) }))
	);
	expect((overlayOf(section()).querySelector("input.key") as HTMLInputElement).value).toBe("gpt-4");
	// Editing from here lands on the right record.
	fireInput(overlayOf(section()).querySelector("input.value") as HTMLInputElement, "0.7");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelParameters", value: { "*": { top_p: 0.9 }, "gpt-4": { temperature: 0.7 } } },
	]);

	// A push that removes the edited record closes the overlay instead.
	fireClick(buttonByText(overlayOf(section()), "Done"));
	fireClick(buttonByText(section(), "Discard"));
	openEditorFor(section(), "gpt-4");
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "*": { top_p: 0.9 } }) })));
	expect(section().querySelector(".matcher-editor")).toBeNull();
});

test("raw-key identity: a popover on a trim-collided matcher survives a reorder without retargeting", () => {
	// "gpt-4" and "gpt-4 " are raw-distinct stored keys (the grammar trims
	// nothing). Trimmed identity would transfer between them on a reorder;
	// raw identity must not.
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 }, "gpt-4 ": { temperature: 0.9 } }) })
		)
	);
	const section = () => sectionByHeading(root, "Model parameters");
	const chips = () =>
		Array.from(section().querySelectorAll("button.chip-field")).filter(
			(chip) => chip.querySelector(".chip-key")?.textContent === "temperature"
		);
	expect(chips()).toHaveLength(2);
	fireClick(chips()[1] as HTMLButtonElement);
	expect((popoverOf(section()).querySelector("input.value") as HTMLInputElement).value).toBe("0.9");

	// A pristine push reverses the stored order; the popover must stay on the
	// "gpt-4 " record it was opened on.
	pushToWebview(
		statePush(
			makeState({ settings: settingsWithParams({ "gpt-4 ": { temperature: 0.9 }, "gpt-4": { temperature: 0.2 } }) })
		)
	);
	expect((popoverOf(section()).querySelector("input.value") as HTMLInputElement).value).toBe("0.9");
	fireInput(popoverOf(section()).querySelector("input.value") as HTMLInputElement, "1.1");
	// The edit landed on the right record: display order is now storage order
	// (both exact keys), "gpt-4 " first.
	const values = Array.from(section().querySelectorAll(".chip-field .chip-value")).map((el) => el.textContent);
	expect(values).toEqual(["1.1", "0.2"]);
});

test("a failed write's notice never resurfaces on a draft minted after a value-equal revert", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(chipFor(section(), "temperature"));
	const value = () => popoverOf(section()).querySelector("input.value") as HTMLInputElement;
	fireInput(value(), "0.7");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	pushToWebview({
		kind: "fail",
		id: lastRequestId(),
		method: "setModelParameters",
		message: "old refusal.",
		failureKind: "validation",
	});
	expect(section().textContent).toContain("old refusal.");

	// Typing exactly back to the store value drops the draft AND the failed
	// write's correlation; a brand-new draft must not dredge the notice up.
	fireInput(value(), "0.2");
	expect(section().textContent).not.toContain("old refusal.");
	fireInput(value(), "0.9");
	expect(section().textContent).not.toContain("old refusal.");
});

test("opening another chip's popover keeps focus there; the closed popover's deferred restore yields", async () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2, top_p: 0.9 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	const first = chipFor(section(), "temperature");
	first.focus();
	fireClick(first);
	// Switching chips: the outside-press listener closes the first popover,
	// the click opens the second, whose input takes focus.
	const second = chipFor(section(), "top_p");
	void act(() => {
		second.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	});
	fireClick(second);
	await new Promise((resolve) => setTimeout(resolve, 5));
	// The first popover's deferred restore must not steal focus back.
	expect((document.activeElement as HTMLElement | null)?.classList.contains("value")).toBe(true);
	expect((popoverOf(section()).querySelector("input.value") as HTMLInputElement).value).toBe("0.9");
});

test("Remove field hands focus to the row's add chip once the opening chip is gone", async () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2, top_p: 0.9 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	const chip = chipFor(section(), "top_p");
	chip.focus();
	fireClick(chip);
	fireClick(buttonByText(popoverOf(section()), "Remove field"));
	// The restore is deferred past the removing commit.
	await new Promise((resolve) => setTimeout(resolve, 5));
	// Node identity as a boolean: feeding happy-dom nodes to the matcher's
	// printer stalls the runner for seconds.
	expect(document.activeElement === section().querySelector("button.chip-add")).toBe(true);
});

// === The full matcher editor overlay ===

test("the pencil opens the full editor; Remove matcher inside it drops the group and closes", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 }, "*": { top_p: 0.9 } }) }))
	);
	const section = () => sectionByHeading(root, "Model parameters");

	const editor = openEditorFor(section(), "gpt-4");
	// The overlay carries the matcher input, the Inherits control, and the
	// field rows with their flag checkboxes.
	expect((editor.querySelector("input.key") as HTMLInputElement).value).toBe("gpt-4");
	expect(editor.querySelector(".inherit-from select")).not.toBeNull();
	expect(editor.querySelector(`.directive-flag input[aria-label='Force "temperature"']`)).not.toBeNull();

	fireClick(buttonByText(editor, "Remove matcher"));
	expect(section().querySelector(".matcher-editor")).toBeNull();
	expect(matcherKeys(section())).toEqual(["*"]);
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([{ type: "setModelParameters", value: { "*": { top_p: 0.9 } } }]);
});

test("the overlay opens in the uniform slide-over panel with no width variant", () => {
	// Every panel shares one width (html.ts .slide-over); a resurrected
	// per-panel `wide` class would silently fork the layout again.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	const editor = openEditorFor(section(), "gpt-4");
	const panel = editor.closest(".slide-over");
	expect(panel).not.toBeNull();
	expect(panel?.className).toBe("slide-over");
});

test("a group whose rows are all absorbed renders no field column heads", () => {
	// The Inherits select fully represents the lone `_inherit_from` row, so
	// the FIELDS grid is empty: heads over nothing would label a void.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { _inherit_from: false } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	const editor = openEditorFor(section(), "gpt-4");
	expect(editor.querySelectorAll(".col-head").length).toBe(0);
	expect(buttonByText(editor, "Add parameter")).not.toBeNull();
});

test("Add model matcher opens the overlay on a fresh group; closing it pristine sweeps the empty row", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "*": { top_p: 0.9 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(buttonByText(section(), "Add model matcher"));
	const editor = overlayOf(section());
	expect((editor.querySelector("input.key") as HTMLInputElement).value).toBe("");
	// Closing without typing anything leaves no stranded invalid row behind.
	fireClick(buttonByText(editor, "Done"));
	expect(section().querySelector(".matcher-editor")).toBeNull();
	expect(matcherKeys(section())).toEqual(["*"]);
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
});

test("the pristine sweep resets the draft outright, so later store pushes keep reflecting", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(buttonByText(section(), "Add model matcher"));
	fireClick(buttonByText(overlayOf(section()), "Done"));
	// A pinned value-equal draft would swallow this push with Discard disabled
	// (nothing looks dirty); the sweep must reset instead of pinning.
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.9 } }) })));
	expect(section().querySelector(".chip-field .chip-value")?.textContent).toBe("0.9");

	// Remove matcher back to the store value resets the same way.
	fireClick(buttonByText(section(), "Add model matcher"));
	const editor = () => overlayOf(section());
	fireInput(editor().querySelector("input.key") as HTMLInputElement, "claude-4");
	fireClick(buttonByText(editor(), "Remove matcher"));
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.4 } }) })));
	expect(section().querySelector(".chip-field .chip-value")?.textContent).toBe("0.4");

	// And so does a field added via [+] then removed through its own chip
	// popover: no path may strand a value-equal pinned draft.
	fireClick(section().querySelector("button.chip-add") as HTMLButtonElement);
	fireInput(popoverOf(section()).querySelector("input.key") as HTMLInputElement, "seed");
	fireInput(popoverOf(section()).querySelector("input.value") as HTMLInputElement, "7");
	fireClick(buttonByText(popoverOf(section()), "Add field"));
	fireClick(chipFor(section(), "seed"));
	fireClick(buttonByText(popoverOf(section()), "Remove field"));
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.5 } }) })));
	expect(section().querySelector(".chip-field .chip-value")?.textContent).toBe("0.5");
});

test("a fresh matcher built in the overlay slots into sorted display position and applies", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 1 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	draftOneParam(section, "*", "top_p", "0.9");
	// The broader catch-all displays ABOVE the exact ID even though it was
	// appended to storage last.
	expect(matcherKeys(section())).toEqual(["*", "gpt-4"]);
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	// Storage order: the new matcher appended, never re-sorted.
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelParameters", value: { "gpt-4": { temperature: 1 }, "*": { top_p: 0.9 } } },
	]);
});

test("the overlay's Escape closes only the matcher editor, with the draft intact", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	const editor = openEditorFor(section(), "gpt-4");
	fireInput(editor.querySelector("input.value") as HTMLInputElement, "0.5");
	fireKeyDown(editor, "Escape");
	expect(section().querySelector(".matcher-editor")).toBeNull();
	expect(section().querySelector(".chip-field .chip-value")?.textContent).toBe("0.5");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);
});

test("the Inherits select in the overlay writes the barrier without a raw row and back to default", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4*": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	openEditorFor(section(), "gpt-4*");
	const select = () => overlayOf(section()).querySelector(".inherit-from select") as HTMLSelectElement;
	expect(select().value).toBe("default");
	void act(() => {
		select().value = "none";
		select().dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(select().value).toBe("none");
	// The select is the barrier's single representation: no _inherit_from row
	// in the overlay, and the table's Inherits column reads it.
	const rowKeys = Array.from(overlayOf(section()).querySelectorAll(".rows input.key")).map(
		(input) => (input as HTMLInputElement).value
	);
	expect(rowKeys).not.toContain("_inherit_from");
	expect(section().querySelector(".inherit-cell")?.textContent).toBe("barrier");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelParameters", value: { "gpt-4*": { temperature: 0.2, _inherit_from: false } } },
	]);
	void act(() => {
		select().value = "default";
		select().dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(select().value).toBe("default");
});

test("the overlay's keys mode edits _inherit_from through the comma input; an unknown name hints without blocking", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				settings: settingsWithParams({ "*": { top_p: 0.9 }, "gpt-4*": { temperature: 0.2, _inherit_from: ["*"] } }),
			})
		)
	);
	const section = () => sectionByHeading(root, "Model parameters");

	openEditorFor(section(), "gpt-4*");
	const editor = () => overlayOf(section());
	const select = editor().querySelector(".inherit-from select") as HTMLSelectElement;
	expect(select.value).toBe("keys");
	const keysInput = () => editor().querySelector("input.inherit-keys") as HTMLInputElement;
	expect(keysInput().value).toBe("*");

	fireInput(keysInput(), "nope, *");
	expect(editor().querySelector(".inherit-from span.hint")?.textContent).toBe(
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

test("renaming a forced key in the overlay hints about the stranded mark without blocking", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2, _force: ["temperature"] } }) }))
	);
	const section = () => sectionByHeading(root, "Model parameters");

	openEditorFor(section(), "gpt-4");
	const keyInput = Array.from(overlayOf(section()).querySelectorAll(".rows input.key")).find(
		(input) => (input as HTMLInputElement).value === "temperature"
	) as HTMLInputElement;
	fireInput(keyInput, "temp2");
	expect(overlayOf(section()).textContent).toContain('"temperature" is not a parameter this record sets');
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);
});

test("a directive row typed in the overlay absorbs only on blur, never mid-edit under the cursor", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");
	openEditorFor(section(), "gpt-4");
	const editor = () => overlayOf(section());
	fireClick(buttonByText(editor(), "Add parameter"));

	const keyInput = () => Array.from(editor().querySelectorAll(".rows input.key")).at(-1) as HTMLInputElement;
	const valueInput = () => Array.from(editor().querySelectorAll(".rows input.value")).at(-1) as HTMLInputElement;
	void act(() => {
		keyInput().dispatchEvent(new Event("focusin", { bubbles: true }));
	});
	fireInput(keyInput(), "_force");
	fireInput(valueInput(), '["temperature"]');

	// Readable and control-representable, but the row must not unmount under
	// the cursor (that would steal focus mid-edit).
	const rowKeys = () =>
		Array.from(editor().querySelectorAll(".rows input.key")).map((input) => (input as HTMLInputElement).value);
	expect(rowKeys()).toContain("_force");

	// Focus moving between the row's own inputs is not a blur: the hold stands.
	void act(() => {
		valueInput().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: keyInput() }));
	});
	expect(rowKeys()).toContain("_force");

	// Leaving the row lets it absorb; the checkbox now carries the mark.
	void act(() => {
		valueInput().dispatchEvent(new Event("focusout", { bubbles: true }));
	});
	expect(rowKeys()).not.toContain("_force");
	const box = editor().querySelector<HTMLInputElement>(`.directive-flag input[aria-label='Force "temperature"']`);
	expect(box?.checked).toBe(true);
});

test("removing an overlay row voids the focus hold instead of pinning the row that shifts into its slot", () => {
	// Rows inside the overlay are positional: with top_p's value focused,
	// removing top_p slides the absorbed _force row into the held index. The
	// hold is stamped with the row-count shape, so the structural change
	// voids it and _force stays absorbed (no focusout fires for a removed
	// element).
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				settings: settingsWithParams({ "gpt-4": { temperature: 0.2, top_p: 0.9, _force: ["temperature"] } }),
			})
		)
	);
	const section = () => sectionByHeading(root, "Model parameters");
	openEditorFor(section(), "gpt-4");
	const editor = () => overlayOf(section());
	const rowKeys = () =>
		Array.from(editor().querySelectorAll(".rows input.key")).map((input) => (input as HTMLInputElement).value);
	expect(rowKeys()).toEqual(["temperature", "top_p"]);

	const topPValue = Array.from(editor().querySelectorAll(".rows input.value")).at(-1) as HTMLInputElement;
	void act(() => {
		topPValue.dispatchEvent(new Event("focusin", { bubbles: true }));
	});
	const removeButtons = Array.from(editor().querySelectorAll(".rows button")).filter((b) =>
		(b.getAttribute("aria-label") ?? "").startsWith("Remove")
	);
	fireClick(removeButtons.at(-1) as HTMLButtonElement);
	expect(rowKeys()).toEqual(["temperature"]);

	// Nor does the void hold resurrect when a later change restores the same
	// row counts: adding a row brings the count back, and _force stays absorbed.
	fireClick(buttonByText(editor(), "Add parameter"));
	expect(rowKeys()).toEqual(["temperature", ""]);
});

/** The dev-seed demo shape: every control-backed directive at once. */
const ABSORBED_DIRECTIVES_RECORD = {
	"gpt-5*": { temperature: 0.3, _inheritable: true, _inherit_from: false, _force: ["temperature"] },
};

test("absorbed directives round-trip: a popover value edit preserves their exact shapes", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams(ABSORBED_DIRECTIVES_RECORD) })));
	const section = () => sectionByHeading(root, "Model parameters");

	// The table carries their state: one chip with both badges, the barrier
	// in the Inherits column, no directive chips.
	expect(chipKeys(section())).toEqual(["temperature"]);
	expect(chipFlagsOf(section(), "temperature")).toEqual(["force", "inheritable"]);
	expect(section().querySelector(".inherit-cell")?.textContent).toBe("barrier");

	// Edit only the value: _inheritable stays the literal true (never exploded
	// into a field list), _force keeps its list shape, the barrier survives.
	fireClick(chipFor(section(), "temperature"));
	fireInput(popoverOf(section()).querySelector("input.value") as HTMLInputElement, "0.4");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{
			type: "setModelParameters",
			value: { "gpt-5*": { temperature: 0.4, _inheritable: true, _inherit_from: false, _force: ["temperature"] } },
		},
	]);
});

test("Edit as JSON shows the absorbed directives verbatim", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams(ABSORBED_DIRECTIVES_RECORD) })));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section(), "Edit as JSON"));
	expect(JSON.parse((section().querySelector("textarea") as HTMLTextAreaElement).value)).toEqual(
		ABSORBED_DIRECTIVES_RECORD
	);
});

test("model capabilities: fallback and inheritable absorb into badges; unmarking via the popover posts without them", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				settings: settingsWithCaps({
					"*": { _inheritable: true, _fallback: ["context_length"], context_length: 131072 },
					"my-alias": { _openrouter_model: "anthropic/claude-sonnet-4" },
				}),
			})
		)
	);
	const section = () => sectionByHeading(root, "Model capabilities");

	expect(chipKeys(section())).toEqual(["context_length", "catalog"]);
	expect(chipFlagsOf(section(), "context_length")).toEqual(["fallback", "inheritable"]);

	fireClick(chipFor(section(), "context_length"));
	const fallback = popoverOf(section()).querySelector(
		`input[aria-label='Fall back for "context_length"']`
	) as HTMLInputElement;
	expect(fallback.checked).toBe(true);
	fireCheck(fallback, false);
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{
			type: "setModelCapabilities",
			value: {
				"*": { _inheritable: true, context_length: 131072 },
				"my-alias": { _openrouter_model: "anthropic/claude-sonnet-4" },
			},
		},
	]);
});

test("a capability chip popover types its value control by the key: number input for token counts", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithCaps({ "*": { context_length: 131072 } }) })));
	const section = () => sectionByHeading(root, "Model capabilities");
	fireClick(chipFor(section(), "context_length"));
	const input = popoverOf(section()).querySelector("input.value") as HTMLInputElement;
	expect(input.type).toBe("number");
	fireInput(input, "0");
	expect(popoverOf(section()).textContent).toContain("Enter a positive whole number of tokens");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
});

// === The draft-and-apply lifecycle ===

test("a dirty draft wins over pushed state, Apply posts parsed rows, the ack and reflecting push drop the draft", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");

	draftOneParam(section, "gpt-4", "temperature", "0.2");

	// A background refresh must not clobber the half-edited draft.
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	expect(matcherKeys(section())).toEqual(["gpt-4"]);
	expect(chipKeys(section())).toEqual(["temperature"]);

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
	expect(matcherKeys(section())).toEqual(["gpt-4"]);
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
});

test("an intentFailed after Apply reopens the draft dirty with the failure note", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");

	draftOneParam(section, "gpt-4", "temperature", "0.2");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);

	pushToWebview({
		kind: "fail",
		id: lastRequestId(),
		method: "setModelParameters",
		message: "gpt-4: refused by validation.",
		failureKind: "validation",
	});
	// The draft returns dirty and retryable; a failed write must not render as
	// applied. Headline and the extension's message render as separate lines.
	expect(section().textContent).toContain(
		"Saving failed - your edits are kept. Fix the problem below and Apply again."
	);
	expect(section().textContent).toContain("gpt-4: refused by validation.");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);
});

test("a draft edited back to the store value counts as unchanged: Apply and Discard disable, nothing posts", () => {
	// The scalar rows' unchanged-posts-nothing rule, in draft form: writing a
	// value the store already holds is not a change worth posting.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(chipFor(section(), "temperature"));
	const value = () => popoverOf(section()).querySelector("input.value") as HTMLInputElement;
	fireInput(value(), "0.7");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);
	fireInput(value(), "0.2");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
	expect((buttonByText(section(), "Discard") as HTMLButtonElement).disabled).toBe(true);
	resetPosted();
	fireKeyDown(value(), "Enter");
	expect(postedMessages).toEqual([]);
});

test("rows that assemble to the stored record cannot be applied, even under a different spelling or key order", () => {
	// "1e1" is a different text for the stored 10; applying it would write a
	// value the store already holds (unchanged-posts-nothing).
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { max_tokens: 10 } }) })));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(chipFor(section(), "max_tokens"));
	fireInput(popoverOf(section()).querySelector("input.value") as HTMLInputElement, "1e1");
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
		kind: "fail",
		id: lastRequestId(),
		method: "setModelParameters",
		message: "refused.",
		failureKind: "validation",
	});
	expect(JSON.parse(textarea().value)).toEqual({ mine: { kept: 1 } });
});

test("Enter applies from an overlay row input once the draft is clean; a highlighted suggestion is accepted instead", () => {
	// The key inputs carry their own suggestion listboxes: Enter with a
	// highlighted suggestion accepts it and must NOT double as Apply (the
	// half-typed row would post); Enter with nothing highlighted applies.
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ models: [makeModel({ id: "gpt-test" })] })));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section(), "Add model matcher"));
	const editor = () => overlayOf(section());
	fireClick(buttonByText(editor(), "Add parameter"));
	const inputs = () => editor().querySelectorAll("input");
	fireInput(inputs()[0] as HTMLInputElement, "gpt");
	fireInput(Array.from(editor().querySelectorAll("input.key")).at(-1) as HTMLInputElement, "temperature");
	fireInput(editor().querySelector("input.value") as HTMLInputElement, "0.2");

	// Highlight the prefix suggestion; Enter accepts it without applying.
	const prefixInput = () => editor().querySelector("input.key[placeholder^='Model ID or matcher']") as HTMLInputElement;
	resetPosted();
	fireKeyDown(prefixInput(), "ArrowDown");
	fireKeyDown(prefixInput(), "Enter");
	expect(prefixInput().value).toBe("gpt-test");
	expect(postedMessages).toEqual([]);

	// Nothing highlighted: Enter applies the clean draft from a key input too.
	fireKeyDown(editor().querySelector("input.key[placeholder^='Parameter']") as HTMLInputElement, "Enter");
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

	fireClick(chipFor(section(), "temperature"));
	fireInput(popoverOf(section()).querySelector("input.value") as HTMLInputElement, "0.7");
	expect(discard().disabled).toBe(false);
	resetPosted();
	fireClick(discard());
	expect(postedMessages).toEqual([]);
	expect(section().querySelector(".chip-field .chip-value")?.textContent).toBe("0.2");
	expect(discard().disabled).toBe(true);
});

test("Apply feedback: Applying... until the ack resolves it to a transient Saved that the next edit clears", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");
	const status = () => section().querySelector(".apply-status")?.textContent ?? "";

	expect(status()).toBe("");
	draftOneParam(section, "gpt-4", "temperature", "0.2");
	expect(status()).toBe("");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(status()).toBe("Applying...");

	// The ack resolves the phase; the draft rows keep rendering until the
	// reflecting push (no flash of the pre-apply value in between).
	ackLastWrite();
	expect(status()).toBe("Saved");
	expect(matcherKeys(section())).toEqual(["gpt-4"]);

	pushToWebview(statePush(makeState({ settings: settingsWithParams({ "gpt-4": { temperature: 0.2 } }) })));
	expect(status()).toBe("Saved");

	fireClick(chipFor(section(), "temperature"));
	fireInput(popoverOf(section()).querySelector("input.value") as HTMLInputElement, "0.9");
	expect(status()).toBe("");
});

test("Apply feedback: a failure ends the Applying... window along with reopening the draft", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");

	draftOneParam(section, "gpt-4", "temperature", "0.2");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(section().querySelector(".apply-status")?.textContent).toBe("Applying...");

	pushToWebview({
		kind: "fail",
		id: lastRequestId(),
		method: "setModelParameters",
		message: "refused.",
		failureKind: "validation",
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

	draftOneParam(section, "gpt-4", "temperature", "0.2");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(status()).toBe("Applying...");

	// Another surface's ack (a server save) and a failure with a foreign
	// requestId must not resolve or reopen this draft.
	pushToWebview({ kind: "ack", id: "someone-else", method: "saveServerSetting" });
	expect(status()).toBe("Applying...");
	pushToWebview({
		kind: "fail",
		id: "someone-else",
		method: "setModelParameters",
		message: "not this write.",
		failureKind: "validation",
	});
	expect(status()).toBe("Applying...");
	expect(section().textContent).not.toContain("not this write.");

	// A concurrent state push is not this write's success signal either.
	pushToWebview(statePush(makeState({ settings: settingsWithParams({ other: { top_p: 0.9 } }) })));
	expect(status()).toBe("Applying...");

	ackLastWrite();
	expect(status()).toBe("Saved");
});

test("Discard is the escape hatch of an applying draft whose ack never arrives", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");

	draftOneParam(section, "gpt-4", "temperature", "0.2");
	fireClick(buttonByText(section(), "Apply"));
	expect(section().querySelector(".apply-status")?.textContent).toBe("Applying...");

	const discard = buttonByText(section(), "Discard");
	expect(discard.disabled).toBe(false);
	fireClick(discard);
	expect(section().querySelector(".apply-status")?.textContent).toBe("");
	expect(section().querySelector(".record-table")).toBeNull();
	expect(section().textContent).toContain("No model parameters configured in this scope.");
});

test("a discarded draft's failure notice never resurfaces on the next edit", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithParams({}) })));
	const section = () => sectionByHeading(root, "Model parameters");

	draftOneParam(section, "gpt-4", "temperature", "0.2");
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	pushToWebview({
		kind: "fail",
		id: lastRequestId(),
		method: "setModelParameters",
		message: "stale refusal.",
		failureKind: "validation",
	});
	expect(section().textContent).toContain("stale refusal.");

	// Discard drops the draft; a brand-new edit must not dredge the old
	// notice back up (its failure belongs to the discarded write).
	fireClick(buttonByText(section(), "Discard"));
	fireClick(buttonByText(section(), "Add model matcher"));
	fireInput(overlayOf(section()).querySelector("input.key") as HTMLInputElement, "claude-4");
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

test("an overlay row problem marks only the offending input: bad JSON flags the value, a bad name the name", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section(), "Add model matcher"));
	const editor = () => overlayOf(section());
	fireInput(editor().querySelector("input.key") as HTMLInputElement, "gpt-4");
	fireClick(buttonByText(editor(), "Add parameter"));
	const nameInput = () => editor().querySelector("input.key[placeholder^='Parameter']") as HTMLInputElement;
	const valueInput = () => editor().querySelector("input.value") as HTMLInputElement;

	fireInput(nameInput(), "temperature");
	fireInput(valueInput(), "not json");
	expect(valueInput().classList.contains("invalid")).toBe(true);
	expect(valueInput().getAttribute("aria-invalid")).toBe("true");
	expect(nameInput().classList.contains("invalid")).toBe(false);

	fireInput(valueInput(), "0.2");
	fireInput(nameInput(), "__proto__");
	expect(editor().textContent).toContain("reserved name");
	expect(nameInput().classList.contains("invalid")).toBe(true);
	expect(valueInput().classList.contains("invalid")).toBe(false);
});

test("the global editor's matcher copy points server records at entries (the entry editor's must not)", () => {
	// The overlay takes its prefix placeholder and help as props because the
	// two surfaces differ for real: the global editor's help routes
	// server-specific records to the entry's models.parameters, the per-entry
	// editor's says URL keys never match (servers.test.tsx pins that side).
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const section = () => sectionByHeading(root, "Model parameters");
	fireClick(buttonByText(section(), "Add model matcher"));

	const prefixInput = overlayOf(section()).querySelector<HTMLInputElement>(
		"input.key[placeholder^='Model ID or matcher']"
	);
	if (prefixInput === null) {
		throw new Error("no prefix input rendered");
	}
	expect(prefixInput.placeholder).toBe("Model ID or matcher, e.g. gpt-4 or gpt-4*");
	// The matcher help rides the MATCHER section label since the overlay
	// redesign (labels above inputs), not the input's own cell.
	const glyph = prefixInput.closest(".editor-section")?.querySelector("button.help");
	const tip = document.getElementById(glyph?.getAttribute("aria-describedby") ?? "");
	expect(tip?.textContent).toBe(helpModelParameterPrefix());
});

test("model parameters: invalid JSON in the overlay blocks Apply; fixing it applies the parsed value", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const section = () => sectionByHeading(root, "Model parameters");

	fireClick(buttonByText(section(), "Add model matcher"));
	const editor = () => overlayOf(section());
	fireInput(editor().querySelector("input.key") as HTMLInputElement, "gpt-4");
	fireClick(buttonByText(editor(), "Add parameter"));
	fireInput(Array.from(editor().querySelectorAll("input.key")).at(-1) as HTMLInputElement, "temperature");
	fireInput(editor().querySelector("input.value") as HTMLInputElement, "not json");

	expect(editor().textContent).toContain("Not valid JSON");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(true);
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedMessages).toEqual([]);

	fireInput(editor().querySelector("input.value") as HTMLInputElement, "0.2");
	expect((buttonByText(section(), "Apply") as HTMLButtonElement).disabled).toBe(false);
	fireClick(buttonByText(section(), "Apply"));
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
	// The table and its add action stand down while the textarea is up.
	expect(section().querySelector(".record-table")).toBeNull();
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
	expect(matcherKeys(section())).toEqual(["gpt-4"]);
});

test("each editor heading carries a settings.json jump posting revealSetting with its record key", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));

	const jumpOf = (heading: string) => sectionByHeading(root, heading).querySelector("button.reveal-json");
	const paramsJump = jumpOf("Model parameters");
	expect(paramsJump?.getAttribute("aria-label")).toBe("Open Model parameters in settings.json");
	resetPosted();
	fireClick(paramsJump as HTMLButtonElement);
	expect(postedCalls()).toEqual([{ method: "revealSetting", payload: { setting: "models.parameters" } }]);
});

test("the settings filter hides an editor with a dirty draft via hidden, and the draft applies after unhiding", () => {
	const root = mount(<SettingsSection settings={settingsWithParams({})} models={[]} />);
	const section = () => sectionByHeading(root, "Model parameters");

	// A half-typed draft (built through the overlay)...
	draftOneParam(section, "gpt-4", "temperature", "0.9");

	// ...is hidden by a non-matching filter, never unmounted...
	const filter = root.querySelector<HTMLInputElement>(".filterbar input") as HTMLInputElement;
	fireInput(filter, "no such setting");
	expect(section().hidden).toBe(true);
	expect(matcherKeys(section())).toEqual(["gpt-4"]);

	// ...and works untouched once the filter clears: Apply posts the draft.
	fireInput(filter, "");
	expect(section().hidden).toBe(false);
	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.9 } } }]);
});

test("the capabilities editor applies via setModelCapabilities through the same overlay flow", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ settings: settingsWithCaps({}) })));
	const section = () => sectionByHeading(root, "Model capabilities");

	fireClick(buttonByText(section(), "Add capability matcher"));
	const editor = () => overlayOf(section());
	fireInput(editor().querySelector("input.key") as HTMLInputElement, "gpt-4*");
	fireClick(buttonByText(editor(), "Add capability"));
	fireInput(Array.from(editor().querySelectorAll("input.key")).at(-1) as HTMLInputElement, "context_length");
	fireInput(editor().querySelector("input.value") as HTMLInputElement, "200000");
	fireClick(buttonByText(editor(), "Done"));

	resetPosted();
	fireClick(buttonByText(section(), "Apply"));
	expect(postedRecordWrites()).toEqual([
		{ type: "setModelCapabilities", value: { "gpt-4*": { context_length: 200000 } } },
	]);
});

// === The catalog picker component ===

test("the catalog picker debounces searchCatalog and picking a result writes the ID", async () => {
	const picked: string[] = [];
	const root = mount(
		<CatalogPicker value="gpt" disabled={false} invalid={false} onValue={(next) => picked.push(next)} debounceMs={1} />
	);
	const input = root.querySelector("input") as HTMLInputElement;
	fireFocus(input);
	// Under the debounce window nothing is posted yet.
	expect(postedMessages).toEqual([]);
	// The debounce timer's state update must land inside act.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const request = lastRequest("searchCatalog");
	expect(request.payload.query).toBe("gpt");

	// The correlated response renders the result list; picking writes the ID.
	respondTo(request, { results: [{ id: "openai/gpt-4o", name: "GPT-4o" }] });
	const option = root.querySelector(".catalog-results button") as HTMLButtonElement;
	expect(option?.textContent).toContain("openai/gpt-4o");
	void act(() => {
		option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	});
	expect(picked).toEqual(["openai/gpt-4o"]);
});

test("a stale catalog response for another request renders no result list", async () => {
	const root = mount(<CatalogPicker value="gpt" disabled={false} invalid={false} onValue={() => {}} debounceMs={1} />);
	const input = root.querySelector("input") as HTMLInputElement;
	fireFocus(input);
	// The debounce timer's state update must land inside act.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	pushToWebview({
		kind: "response",
		id: "stale",
		method: "searchCatalog",
		payload: { results: [{ id: "x", name: "X" }] },
	});
	expect(root.querySelector(".catalog-results")).toBeNull();
});

test("the catalog picker is keyboard-operable: arrows move the highlight, Enter picks, Escape closes and is consumed", async () => {
	const picked: string[] = [];
	const escapes: string[] = [];
	const listener = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			escapes.push(event.key);
		}
	};
	document.addEventListener("keydown", listener);
	const root = mount(
		<CatalogPicker value="gpt" disabled={false} invalid={false} onValue={(id) => picked.push(id)} debounceMs={1} />
	);
	const input = root.querySelector("input") as HTMLInputElement;
	fireFocus(input);
	// The debounce timer's state update must land inside act.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	respondTo(lastRequest("searchCatalog"), {
		results: [
			{ id: "openai/gpt-4o", name: "GPT-4o" },
			{ id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
		],
	});
	try {
		// An open result list consumes Escape (inside a chip popover or a
		// slide-over it must close only the results); a closed one lets it
		// bubble to the surface above.
		fireKeyDown(input, "Escape");
		expect(root.querySelector(".catalog-results")).toBeNull();
		expect(escapes).toEqual([]);
		fireKeyDown(input, "Escape");
		expect(escapes).toEqual(["Escape"]);

		// Reopen with a fresh correlated response for the keyboard pick path
		// (closing orphaned the in-flight request, so the old response went stale).
		fireFocus(input);
		// The debounce timer's state update must land inside act.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		respondTo(lastRequest("searchCatalog"), {
			results: [
				{ id: "openai/gpt-4o", name: "GPT-4o" },
				{ id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
			],
		});
		fireKeyDown(input, "ArrowDown");
		fireKeyDown(input, "ArrowDown");
		expect(root.querySelector(".catalog-results button.active")?.textContent).toContain("gpt-4o-mini");
		fireKeyDown(input, "Enter");
		expect(picked).toEqual(["openai/gpt-4o-mini"]);
		expect(root.querySelector(".catalog-results")).toBeNull();
	} finally {
		document.removeEventListener("keydown", listener);
	}
});

test("capabilityKeySuggestions: consumed vocabulary first in curated order, server keys sorted after, directives last", () => {
	const staticList = capabilityKeySuggestions();
	const consumed = Object.keys(CONSUMED_CAPABILITY_FIELDS);
	// The no-evidence list: exactly the consumed vocabulary plus the directives.
	expect(staticList).toEqual([...consumed, "_fallback", "_openrouter_model"]);
	// undefined and an empty set both mean no evidence.
	expect(capabilityKeySuggestions([])).toEqual(staticList);

	// Server-observed keys slot between the consumed block and the directives,
	// deduped and code-unit sorted; a key the consumed vocabulary already
	// carries never repeats, and duplicates collapse.
	const merged = capabilityKeySuggestions(["mode", "litellm_provider", "mode", "context_length", "base_model"]);
	expect(merged).toEqual([...consumed, "base_model", "litellm_provider", "mode", "_fallback", "_openrouter_model"]);
});

test("capabilityKeySuggestions: underscore-led observed keys (a __proto__ report included) stay out, harmlessly", () => {
	// Observed names are server-derived strings. They only ever become
	// suggestion TEXT - and `_`-led names are dropped outright: a capability
	// record reads them as directives, never as overrides, so suggesting one
	// would suggest a key the record cannot carry. `__proto__` falls out on
	// the same rule, and building the list never touches Object.prototype.
	const merged = capabilityKeySuggestions(["__proto__", "_secret", "custom_rank"]);
	expect(merged).toContain("custom_rank");
	expect(merged).not.toContain("__proto__");
	expect(merged).not.toContain("_secret");
	// The directives at the tail are the extension's own, never observed ones.
	expect(merged.filter((key) => key.startsWith("_"))).toEqual(["_fallback", "_openrouter_model"]);
	// Prototype-named keys pass through as ordinary suggestions: the dedup is
	// a real Set, where a plain-object membership check would misread these.
	const prototypeNamed = capabilityKeySuggestions(["toString", "constructor", "toString"]);
	expect(prototypeNamed.filter((key) => key === "toString")).toEqual(["toString"]);
	expect(prototypeNamed).toContain("constructor");
});
