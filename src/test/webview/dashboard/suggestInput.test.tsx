/**
 * The record editors' suggestion listboxes (SuggestInput), the datalist
 * replacement: filtering as the user types (case-insensitive substring),
 * the combobox aria wiring, the keyboard paths (arrows move the highlight,
 * Enter accepts it, Escape closes), mousedown-to-accept, and close-on-blur -
 * exercised on all three inputs that carry suggestions: the capability key,
 * the matcher keys, and the parameter names.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { App } from "../../../webview/dashboard/app";
import { makeModel, makeSettings, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireBlur,
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

function sectionByHeading(root: ParentNode, heading: string): HTMLElement {
	const section = Array.from(root.querySelectorAll("section")).find((candidate) =>
		(candidate.querySelector("h3")?.textContent ?? "").trim().startsWith(heading)
	);
	if (section === undefined) {
		throw new Error(`no section titled ${heading}`);
	}
	return section as HTMLElement;
}

/** Mount App, open a fresh matcher's overlay in the named editor, and add one field row; returns the overlay getter. */
function mountEditor(heading: string, addButton: string): () => HTMLElement {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				models: [makeModel({ id: "gpt-test" }), makeModel({ id: "claude-x", name: "Claude X" })],
				settings: makeSettings(),
			})
		)
	);
	const section = () => sectionByHeading(root, heading);
	fireClick(buttonByText(section(), addButton));
	const overlay = () => {
		const editor = section().querySelector<HTMLElement>(".matcher-editor");
		if (editor === null) {
			throw new Error("no matcher editor overlay is open");
		}
		return editor;
	};
	// The suggestion inputs under test live on the overlay's field rows.
	fireClick(buttonByText(overlay(), heading === "Model parameters" ? "Add parameter" : "Add capability"));
	return overlay;
}

function listboxOf(input: HTMLInputElement): HTMLElement | null {
	return document.getElementById(input.getAttribute("aria-controls") ?? "");
}

function optionTexts(input: HTMLInputElement): string[] {
	return Array.from(listboxOf(input)?.querySelectorAll("[role='option']") ?? []).map((o) => o.textContent ?? "");
}

test("the capability key input filters its suggested vocabulary case-insensitively as the user types", () => {
	const section = mountEditor("Model capabilities", "Add capability matcher");
	const keyInput = section().querySelector("input.key[placeholder^='Capability']") as HTMLInputElement;
	expect(keyInput.getAttribute("role")).toBe("combobox");
	expect(keyInput.getAttribute("aria-autocomplete")).toBe("list");

	fireInput(keyInput, "SUP");
	expect(keyInput.getAttribute("aria-expanded")).toBe("true");
	const names = optionTexts(keyInput);
	expect(names.length).toBeGreaterThan(0);
	expect(names.every((name) => name.toLowerCase().includes("sup"))).toBe(true);
	// The suggestions span the consumed vocabulary: core flags and the
	// advisory-typed keys (caching flags, supported_openai_params) alike.
	expect(names).toContain("supports_vision");
	expect(names).toContain("supports_prompt_caching");
	expect(names).toContain("supported_openai_params");
	// Cost keys ride the list too.
	fireInput(keyInput, "cost");
	expect(optionTexts(keyInput)).toContain("input_cost_per_token");

	// Substring, not prefix: "router" hits the _openrouter_model directive.
	fireInput(keyInput, "router");
	expect(optionTexts(keyInput)).toEqual(["_openrouter_model"]);

	// No match closes the popup instead of showing an empty box.
	fireInput(keyInput, "zzz");
	expect(keyInput.getAttribute("aria-expanded")).toBe("false");
});

test("arrows move the highlight with wrap-around, Enter accepts, and aria-activedescendant tracks it", () => {
	const section = mountEditor("Model capabilities", "Add capability matcher");
	const keyInput = () => section().querySelector("input.key[placeholder^='Capability']") as HTMLInputElement;

	fireInput(keyInput(), "supports_v");
	expect(optionTexts(keyInput())).toEqual(["supports_vision"]);
	expect(keyInput().getAttribute("aria-activedescendant")).toBeNull();

	fireKeyDown(keyInput(), "ArrowDown");
	const active = listboxOf(keyInput())?.querySelector("[aria-selected='true']");
	expect(active?.textContent).toBe("supports_vision");
	expect(keyInput().getAttribute("aria-activedescendant")).toBe(active?.id ?? "");

	// ArrowUp from the top wraps to the last entry; ArrowDown wraps forward.
	fireKeyDown(keyInput(), "ArrowUp");
	expect(listboxOf(keyInput())?.querySelector("[aria-selected='true']")?.textContent).toBe("supports_vision");

	fireKeyDown(keyInput(), "Enter");
	expect(keyInput().value).toBe("supports_vision");
	expect(keyInput().getAttribute("aria-expanded")).toBe("false");
	// Accepting a support flag seeds its checkbox true (the row-switch rule).
	expect(section().querySelector<HTMLInputElement>(".capability-flag input")?.checked).toBe(true);
	// Accepting never posts: the draft still lands only through Apply.
	expect(postedMessages.filter((message) => message.type === "setModelCapabilities")).toEqual([]);
});

test("ArrowDown reaches every suggestion in a long list and wraps back to the top", () => {
	// The popup is max-height + scrollable; the highlight itself must still
	// visit every option from the keyboard (the scroll-follow rides on it).
	const section = mountEditor("Model capabilities", "Add capability matcher");
	const keyInput = () => section().querySelector("input.key[placeholder^='Capability']") as HTMLInputElement;

	fireFocus(keyInput());
	const options = optionTexts(keyInput());
	expect(options.length).toBeGreaterThan(5);
	const visited: string[] = [];
	for (let step = 0; step < options.length; step += 1) {
		fireKeyDown(keyInput(), "ArrowDown");
		visited.push(listboxOf(keyInput())?.querySelector("[aria-selected='true']")?.textContent ?? "");
	}
	expect(visited).toEqual([...options]);
	// One more wraps back to the first entry.
	fireKeyDown(keyInput(), "ArrowDown");
	expect(listboxOf(keyInput())?.querySelector("[aria-selected='true']")?.textContent).toBe(options[0] ?? "");
});

test("Escape closes the listbox without picking; ArrowDown reopens onto a highlight; blur closes", () => {
	const section = mountEditor("Model parameters", "Add model matcher");
	const nameInput = () => section().querySelector("input.key[placeholder^='Parameter']") as HTMLInputElement;

	fireInput(nameInput(), "te");
	expect(nameInput().getAttribute("aria-expanded")).toBe("true");
	fireKeyDown(nameInput(), "Escape");
	expect(nameInput().getAttribute("aria-expanded")).toBe("false");
	expect(nameInput().value).toBe("te");

	// Reopening by arrow lands straight on an option: an unhighlighted reopen
	// would send the very next Enter to Apply instead of accepting.
	fireKeyDown(nameInput(), "ArrowDown");
	expect(nameInput().getAttribute("aria-expanded")).toBe("true");
	const active = listboxOf(nameInput())?.querySelector("[aria-selected='true']");
	expect(active?.textContent).toBe("temperature");
	expect(nameInput().getAttribute("aria-activedescendant")).toBe(active?.id ?? "");
	fireKeyDown(nameInput(), "Enter");
	expect(nameInput().value).toBe("temperature");
	expect(postedMessages.filter((message) => message.type === "setModelParameters")).toEqual([]);

	fireBlur(nameInput());
	expect(nameInput().getAttribute("aria-expanded")).toBe("false");
});

test("an open listbox consumes Escape; a closed one lets it reach the enclosing overlay", () => {
	// These inputs render inside the matcher editor overlay (a slide-over
	// panel): with the listbox open, Escape must close only the suggestions;
	// with it closed, Escape is the panel's to consume - it closes the
	// overlay, never both at once.
	const section = mountEditor("Model parameters", "Add model matcher");
	const nameInput = () => section().querySelector("input.key[placeholder^='Parameter']") as HTMLInputElement;
	fireInput(nameInput(), "te");
	expect(nameInput().getAttribute("aria-expanded")).toBe("true");
	fireKeyDown(nameInput(), "Escape");
	expect(nameInput().getAttribute("aria-expanded")).toBe("false");
	// The overlay is still open: the listbox consumed that Escape.
	expect(document.querySelector(".matcher-editor")).not.toBeNull();

	// With nothing open, Escape is not the listbox's to consume: the overlay
	// closes instead.
	fireKeyDown(nameInput(), "Escape");
	expect(document.querySelector(".matcher-editor")).toBeNull();
});

test("the matcher key input suggests discovered model IDs; mousedown on an option accepts it", () => {
	const section = mountEditor("Model capabilities", "Add capability matcher");
	const matcher = () => section().querySelector("input.key[placeholder^='Model ID or matcher']") as HTMLInputElement;

	fireFocus(matcher());
	expect(optionTexts(matcher())).toEqual(["gpt-test", "claude-x"]);

	fireInput(matcher(), "claude");
	const option = listboxOf(matcher())?.querySelector("[role='option']") as HTMLElement;
	expect(option.textContent).toBe("claude-x");
	void act(() => {
		option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	});
	expect(matcher().value).toBe("claude-x");
	expect(matcher().getAttribute("aria-expanded")).toBe("false");
});

test("the parameter-name input offers the common names and Enter-accepts a highlighted one", () => {
	const section = mountEditor("Model parameters", "Add model matcher");
	const nameInput = () => section().querySelector("input.key[placeholder^='Parameter']") as HTMLInputElement;

	fireInput(nameInput(), "penalty");
	expect(optionTexts(nameInput())).toEqual(["frequency_penalty", "presence_penalty"]);
	fireKeyDown(nameInput(), "ArrowDown");
	fireKeyDown(nameInput(), "ArrowDown");
	fireKeyDown(nameInput(), "Enter");
	expect(nameInput().value).toBe("presence_penalty");
	expect(postedMessages.filter((message) => message.type === "setModelParameters")).toEqual([]);
});

test("the capabilities editor Enter-applies a clean draft too, from key and value inputs alike", () => {
	const section = mountEditor("Model capabilities", "Add capability matcher");
	const inputs = section().querySelectorAll("input");
	fireInput(inputs[0] as HTMLInputElement, "gpt-4");
	fireInput(inputs[1] as HTMLInputElement, "context_length");
	const valueInput = () => section().querySelector(".group input.value") as HTMLInputElement;
	fireInput(valueInput(), "128000");

	resetPosted();
	fireKeyDown(valueInput(), "Enter");
	const posted = postedMessages.filter((message) => message.type === "setModelCapabilities");
	expect(posted).toHaveLength(1);
	expect((posted[0] as { value: Record<string, unknown> }).value["gpt-4"]).toEqual({ context_length: 128000 });
});
