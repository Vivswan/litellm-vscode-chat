/**
 * The dashboard's hover-help affordances. Two layers: a sweep over the
 * helpText module itself (plain ASCII strings, no template interpolation, so
 * help text can never carry server data and the secret sweeps stay
 * meaningful), and render assertions that every "?" glyph carries its text
 * and sits next to the control it explains.
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

test("every help string is substantial, printable ASCII, and free of template interpolation", () => {
	const entries = allHelpStrings();
	expect(entries.length).toBeGreaterThan(0);
	for (const [name, text] of entries) {
		expect(typeof text, name).toBe("string");
		// Documentation, not a placeholder: long enough to actually explain.
		expect(text.length, name).toBeGreaterThan(60);
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
	return Array.from(root.querySelectorAll(".help"));
}

/** The one .help inside the container, with its title asserted. */
function helpIn(container: ParentNode | null, expected: string): void {
	if (container === null) {
		throw new Error("no container to look for help in");
	}
	const found = helps(container as ParentNode);
	expect(found.length).toBe(1);
	expect(found[0]?.getAttribute("title")).toBe(expected);
}

test("every rendered help glyph carries a non-empty title, a matching aria-label, and is focusable", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));
	// Open the edit form so the server form's field help renders too.
	fireClick(buttonByText(root, "Edit"));

	const glyphs = helps(document);
	// Sections (Servers, Models, Settings, Model parameters, Custom headers)
	// plus form fields; the exact count is asserted per component below.
	expect(glyphs.length).toBeGreaterThan(15);
	for (const glyph of glyphs) {
		const title = glyph.getAttribute("title") ?? "";
		expect(title.length).toBeGreaterThan(0);
		expect(glyph.getAttribute("aria-label")).toBe(title);
		expect(glyph.tabIndex).toBe(0);
		expect((glyph.textContent ?? "").trim()).toBe("?");
	}
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
