/**
 * The dashboard's hover-help affordances. Two layers: a sweep over the
 * helpText module itself (plain ASCII strings, no template interpolation, so
 * help text can never carry server data and the secret sweeps stay
 * meaningful), and render assertions that every "?" glyph renders its own
 * tooltip element (the webview draws tooltips itself; native titles are
 * unreliable in the webview host), wires it as the trigger's accessible
 * description, and sits next to the control it explains. Visibility toggling
 * is pure CSS (hover/focus-visible), which happy-dom cannot compute, so the
 * tests pin the structure and class contract the stylesheet keys on.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "../../../webview/dashboard/app";
import * as helpText from "../../../webview/dashboard/helpText";
import {
	HELP_MODEL_PARAMETER_NAME,
	HELP_MODEL_PARAMETER_PREFIX,
	HELP_MODEL_PARAMETER_VALUE,
	HELP_MODEL_PARAMETERS_SECTION,
	HELP_MODELS_SECTION,
	HELP_SECRET_STORAGE,
	HELP_SERVERS_SECTION,
	HELP_SETTINGS_SECTION,
	SERVER_FIELD_HELP,
	SETTING_ROW_HELP,
} from "../../../webview/dashboard/helpText";
import { declaredWithSecrets, makeModel, makeSettings, makeState, statePush } from "../fixtures";
import { buttonByText, cleanup, fireClick, mount, pushToWebview, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

/** Every help string the module exports, flattened out of the keyed records. */
function allHelpStrings(): [name: string, text: string][] {
	const entries: [string, string][] = [];
	for (const [name, value] of Object.entries(helpText)) {
		if (typeof value === "string") {
			entries.push([name, value]);
			continue;
		}
		for (const [key, text] of Object.entries(value as Record<string, string>)) {
			entries.push([`${name}.${key}`, text]);
		}
	}
	return entries;
}

test("every help string is short, printable ASCII, and free of template interpolation", () => {
	const entries = allHelpStrings();
	expect(entries.length).toBeGreaterThan(0);
	for (const [name, text] of entries) {
		expect(typeof text, name).toBe("string");
		// A real explanation, not a placeholder - but a tooltip, not a manual.
		// One or two short sentences; longer text belongs in the docs.
		expect(text.length, name).toBeGreaterThan(40);
		expect(text.length, name).toBeLessThan(220);
		// Printable ASCII only (no curly quotes, dashes, or control characters).
		expect(text, name).toMatch(/^[\x20-\x7E]+$/);
		// No interpolation anywhere near help text: these strings must be
		// provably static so no server data can ride along into a tooltip.
		expect(text, name).not.toContain("${");
	}
});

/** A state that exercises every section: a server, a model, and a configured model-parameters group. */
function fullState() {
	return makeState({
		servers: [declaredWithSecrets({ apiKey: "secure" })],
		models: [makeModel()],
		settings: makeSettings({
			modelParameters: { editScope: "global", value: { "gpt-4": { temperature: 0.2 } }, otherScopes: [] },
		}),
	});
}

function helps(root: ParentNode): HTMLElement[] {
	return Array.from(root.querySelectorAll("button.help"));
}

/** The glyph's tooltip element, resolved through the aria-describedby wiring. */
function tipFor(glyph: HTMLElement): HTMLElement {
	const id = glyph.getAttribute("aria-describedby");
	if (id === null || id === "") {
		throw new Error("help glyph carries no aria-describedby");
	}
	const tip = document.getElementById(id);
	if (tip === null) {
		throw new Error(`aria-describedby ${id} resolves to no element`);
	}
	return tip;
}

/** The one help glyph inside the container, with its tooltip text asserted. */
function helpIn(container: ParentNode | null, expected: string): void {
	if (container === null) {
		throw new Error("no container to look for help in");
	}
	const found = helps(container as ParentNode);
	expect(found.length).toBe(1);
	expect(tipFor(found[0] as HTMLElement).textContent).toBe(expected);
}

test("every help glyph renders a tooltip element wired as its accessible description", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));
	// Open the edit form so the server form's field help renders too.
	fireClick(buttonByText(root, "Edit"));

	const glyphs = helps(document);
	// Sections (Servers, Models, Settings, Model parameters, Custom headers)
	// plus form fields; the exact count is asserted per component below.
	expect(glyphs.length).toBeGreaterThan(15);
	const tipIds = new Set<string>();
	for (const glyph of glyphs) {
		// The trigger is named "Help"; the long text is its description, not
		// its name, and no native title competes with the rendered tooltip.
		expect(glyph.getAttribute("aria-label")).toBe("Help");
		expect(glyph.hasAttribute("title")).toBe(false);
		expect(glyph.tabIndex).toBe(0);
		expect((glyph.textContent ?? "").trim()).toBe("?");

		const tip = tipFor(glyph);
		expect(tip.getAttribute("role")).toBe("tooltip");
		expect(tip.classList.contains("help-tip")).toBe(true);
		expect((tip.textContent ?? "").length).toBeGreaterThan(40);
		tipIds.add(tip.id);

		// The structure the stylesheet keys on: the tip is the button's next
		// sibling inside a .help-wrap, so `.help-wrap:hover .help-tip` and
		// `button.help:focus-visible + .help-tip` can reveal it.
		expect(glyph.parentElement?.classList.contains("help-wrap")).toBe(true);
		expect(glyph.nextElementSibling).toBe(tip);
	}
	// Descriptions stay unambiguous: no two triggers share a tooltip id.
	expect(tipIds.size).toBe(glyphs.length);
});

test("each section heading carries its own help", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));

	const headingByTitle = (title: string): HTMLElement => {
		const heading = Array.from(root.querySelectorAll("h2, h3")).find((candidate) =>
			(candidate.textContent ?? "").trim().startsWith(title)
		);
		if (heading === undefined) {
			throw new Error(`no heading starting with ${title}`);
		}
		return heading as HTMLElement;
	};
	helpIn(headingByTitle("Servers"), HELP_SERVERS_SECTION);
	helpIn(headingByTitle("Models"), HELP_MODELS_SECTION);
	helpIn(headingByTitle("Settings"), HELP_SETTINGS_SECTION);
	helpIn(headingByTitle("Model parameters"), HELP_MODEL_PARAMETERS_SECTION);
	helpIn(headingByTitle("Custom headers"), helpText.HELP_CUSTOM_HEADERS_SECTION);

	// Placement: the Servers heading sits in the page's top band, so its tip
	// flips below the trigger; everything further down keeps the default
	// above placement.
	const wrapOf = (title: string) => helps(headingByTitle(title))[0]?.parentElement as HTMLElement;
	expect(wrapOf("Servers").classList.contains("below")).toBe(true);
	for (const title of ["Models", "Settings", "Model parameters", "Custom headers"]) {
		expect(wrapOf(title).classList.contains("below"), title).toBe(false);
	}
});

test("every server form field label has its help glyph beside it, and the storage choice its own", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));
	fireClick(buttonByText(root, "Edit"));

	const labelRows = Array.from(root.querySelectorAll(".form-card .label-row"));
	const byLabel = new Map(labelRows.map((row) => [(row.querySelector("label")?.textContent ?? "").trim(), row]));
	for (const [field, label] of [
		["label", "Label"],
		["baseUrl", "Base URL"],
		["apiKey", "API key"],
		["oauthTokenUrl", "OAuth token URL"],
		["oauthClientId", "OAuth client ID"],
		["oauthClientSecret", "OAuth client secret"],
		["oauthScopes", "OAuth scopes"],
		["virtualKeyHeader", "Virtual key header"],
		["virtualKeyValue", "Virtual key value"],
	] as const) {
		const row = byLabel.get(label) ?? null;
		if (row === null) {
			throw new Error(`no label row for ${label}`);
		}
		helpIn(row, SERVER_FIELD_HELP[field]);
	}

	// Each secret field's storage radiogroup explains inline vs secure once.
	const whereGroups = Array.from(root.querySelectorAll(".form-card .secret-where[role='radiogroup']"));
	expect(whereGroups.length).toBe(3);
	for (const group of whereGroups) {
		helpIn(group, HELP_SECRET_STORAGE);
	}
});

test("the model-parameters editor explains prefix, parameter name, and JSON value on their inputs", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));

	const section = Array.from(root.querySelectorAll("section")).find((candidate) =>
		(candidate.querySelector("h3")?.textContent ?? "").startsWith("Model parameters")
	);
	if (section === undefined) {
		throw new Error("no Model parameters section");
	}
	const prefixCell = section.querySelector("input.key[placeholder^='Model prefix']")?.closest(".cell") ?? null;
	helpIn(prefixCell, HELP_MODEL_PARAMETER_PREFIX);
	const nameCell = section.querySelector("input.key[placeholder^='Parameter']")?.closest(".cell") ?? null;
	helpIn(nameCell, HELP_MODEL_PARAMETER_NAME);
	const valueCell = section.querySelector("input.value[placeholder^='JSON value']")?.closest(".cell") ?? null;
	helpIn(valueCell, HELP_MODEL_PARAMETER_VALUE);
});

test("settings rows show help only where the one-line description is not enough", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));

	const rowFor = (id: string) => root.querySelector(`#setting-${CSS.escape(id)}`)?.closest(".setting-row") ?? null;
	for (const id of Object.keys(SETTING_ROW_HELP)) {
		const row = rowFor(id);
		if (row === null) {
			throw new Error(`no settings row for ${id}`);
		}
		const expected = SETTING_ROW_HELP[id as keyof typeof SETTING_ROW_HELP];
		helpIn(row.querySelector(".setting-head"), expected ?? "");
	}
	// A row with a self-sufficient description stays clean: no duplicate "?".
	const plain = rowFor("defaultContextLength");
	expect(plain).not.toBeNull();
	expect(helps(plain as ParentNode).length).toBe(0);
});
