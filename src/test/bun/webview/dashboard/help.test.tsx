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
import { SERVER_FORM_FIELD_ORDER } from "../../../../dashboard/serverForm";
import { BOOLEAN_SETTING_IDS, NUMBER_SETTING_IDS } from "../../../../dashboard/viewModels";
import { DEFAULT_API_VERSION } from "../../../../shared/util/baseUrl";
import { App } from "../../../../webview/dashboard/app";
import { Help } from "../../../../webview/dashboard/help";
import * as helpText from "../../../../webview/dashboard/helpText";
import {
	helpModelParameterName,
	helpModelParameterPrefix,
	helpModelParametersSection,
	helpModelParameterValue,
	helpModelsSection,
	helpOauthCompanionApiKey,
	helpSecretStorage,
	helpServersSection,
	helpSettingsSection,
	SETTING_ROW_HELP_IDS,
	serverFieldHelp,
	settingRowHelp,
} from "../../../../webview/dashboard/helpText";
import { declaredWithSecrets, makeModel, makeSettings, makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireCheck,
	fireClick,
	fireMouseEnter,
	mount,
	pushToWebview,
	resetPosted,
	stubBoundingRect,
} from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

/**
 * Every help string the module exports, resolved through its lazy function
 * exports (the parametrized ones fanned out over their full key sets). The
 * suite runs with l10n unconfigured, so these are the ENGLISH texts the
 * guards below judge.
 */
function allHelpStrings(): [name: string, text: string][] {
	const entries: [string, string][] = [];
	for (const [name, value] of Object.entries(helpText)) {
		if (typeof value !== "function") {
			// SETTING_ROW_HELP_IDS: a key list, not help text.
			continue;
		}
		if (name === "serverFieldHelp") {
			for (const field of SERVER_FORM_FIELD_ORDER) {
				entries.push([`${name}(${field})`, serverFieldHelp(field)]);
			}
			continue;
		}
		if (name === "settingRowHelp") {
			for (const id of SETTING_ROW_HELP_IDS) {
				entries.push([`${name}(${id})`, settingRowHelp(id) ?? ""]);
			}
			continue;
		}
		entries.push([name, (value as () => string)()]);
	}
	return entries;
}

test("SETTING_ROW_HELP_IDS names exactly the settings whose settingRowHelp answers", () => {
	// The id list is static (module scope may not localize) while the strings
	// live in the switch; this closes the drift between the two.
	expect([...SETTING_ROW_HELP_IDS]).toEqual(
		[...NUMBER_SETTING_IDS, ...BOOLEAN_SETTING_IDS].filter((id) => settingRowHelp(id) !== undefined)
	);
});

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
			modelParameters: {
				editScope: "global",
				value: { "gpt-4": { temperature: 0.2 } },
				otherScopes: [],
				effective: {},
			},
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
		// The trigger is named "Help", or "Help: <what it explains>" where one
		// page shows many; the long text is its description, not
		// its name, and no native title competes with the rendered tooltip.
		expect(glyph.getAttribute("aria-label")).toMatch(/^Help(: .+)?$/);
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
	// The Section primitive hangs the glyph off the header LINE, as a sibling
	// of the heading rather than inside it; a hand-rolled heading still carries
	// its own. Resolve whichever container this section uses, so the contract
	// reads the same through the migration.
	const headOf = (title: string): HTMLElement => {
		const heading = headingByTitle(title);
		return (heading.closest(".section-head") as HTMLElement | null) ?? heading;
	};
	helpIn(headOf("Servers"), helpServersSection());
	helpIn(headOf("Models"), helpModelsSection());
	helpIn(headOf("Settings"), helpSettingsSection());
	helpIn(headOf("Model parameters"), helpModelParametersSection());

	// Placement: the Servers heading sits in the page's top band, so its tip
	// flips below the trigger; everything further down keeps the default
	// above placement.
	const wrapOf = (title: string) => helps(headOf(title))[0]?.parentElement as HTMLElement;
	expect(wrapOf("Servers").classList.contains("below")).toBe(true);
	for (const title of ["Models", "Settings", "Model parameters"]) {
		expect(wrapOf(title).classList.contains("below"), title).toBe(false);
	}
});

test("every server form field carries its help glyph, trailing and named for the field it explains", () => {
	// Two things at once, because one without the other is not the contract:
	// the glyph exists for every field, and it sits AFTER the hint rather than
	// beside the label. Its accessible name is what identifies it now that
	// proximity does not.
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));
	fireClick(buttonByText(root, "Edit"));

	const glyphFor = (field: Parameters<typeof serverFieldHelp>[0], label: string): HTMLElement => {
		const button = Array.from(root.querySelectorAll<HTMLElement>("button.help")).find(
			(candidate) => candidate.getAttribute("aria-label") === `Help: ${label}`
		);
		if (button === undefined) {
			throw new Error(`no help glyph for ${label}`);
		}
		expect(button.parentElement?.querySelector(".help-tip")?.textContent).toBe(serverFieldHelp(field));
		return button;
	};
	const trailing = (field: Parameters<typeof serverFieldHelp>[0], label: string, id: string) => {
		const button = glyphFor(field, label);
		// In the hint's cell, and NOT in the label's: the position is the point.
		const hintCell = document.getElementById(`server-${id}-error`)?.parentElement;
		expect(hintCell?.contains(button)).toBe(true);
		const labelRow = document.querySelector(`label[for="server-${id}"]`)?.parentElement;
		expect(labelRow?.querySelector("button.help")).toBeNull();
	};

	// The stored key derives the API-key form: identity, the key, and its
	// virtual-key companion pair render, each with its glyph.
	trailing("label", "Label", "label");
	trailing("baseUrl", "Base URL", "baseUrl");
	trailing("apiKey", "API key", "apiKey");
	trailing("virtualKeyHeader", "Virtual key header", "virtualKeyHeader");
	trailing("virtualKeyValue", "Virtual key value", "virtualKeyValue");
	trailing("budget", "Budget (USD)", "budget");
	glyphFor("apiVersion", "API version");
	glyphFor("declaredModels", "Declared models");
	glyphFor("expectedFailures", "Expected failures");

	// Two secrets on this shape, each with its own storage choice and glyph.
	expect(root.querySelectorAll(".secret-where").length).toBe(2);
	for (const tip of root.querySelectorAll(".secret-where .help-tip")) {
		expect(tip.textContent).toBe(helpSecretStorage());
	}

	// OAuth swaps in four fields of its own, plus a companion API key that
	// explains itself differently from the API-key form's own.
	const oauth = Array.from(root.querySelectorAll(".auth-selector label")).find(
		(label) => (label.textContent ?? "").trim() === "OAuth"
	);
	fireCheck(oauth?.querySelector("input") as HTMLInputElement, true);
	trailing("oauthTokenUrl", "OAuth token URL", "oauthTokenUrl");
	trailing("oauthClientId", "OAuth client ID", "oauthClientId");
	trailing("oauthClientSecret", "OAuth client secret", "oauthClientSecret");
	trailing("oauthScopes", "OAuth scopes", "oauthScopes");
	const companionTip = Array.from(root.querySelectorAll<HTMLElement>("button.help"))
		.find((candidate) => candidate.getAttribute("aria-label") === "Help: API key")
		?.parentElement?.querySelector(".help-tip");
	expect(companionTip?.textContent).toBe(helpOauthCompanionApiKey());
	// Three secrets under OAuth: the client secret plus both companions.
	expect(root.querySelectorAll(".secret-where").length).toBe(3);
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
	// The row inputs live in the matcher editor overlay since the table
	// redesign; open it through the record's pencil action.
	const pencil = Array.from(section.querySelectorAll("button")).find(
		(candidate) => candidate.getAttribute("aria-label") === 'Open the full editor for "gpt-4"'
	);
	if (pencil === undefined) {
		throw new Error("no pencil for the gpt-4 record");
	}
	fireClick(pencil as HTMLButtonElement);
	// Since the overlay redesign the matcher help rides the MATCHER section
	// label, and the key/value help moved onto the FIELDS grid's column heads
	// (one glyph per column, not one per row).
	const matcherSection =
		section.querySelector("input.key[placeholder^='Model ID or matcher']")?.closest(".editor-section") ?? null;
	helpIn(matcherSection, helpModelParameterPrefix());
	const colHeads = Array.from(section.querySelectorAll(".matcher-editor .col-head"));
	expect(colHeads.length).toBe(2);
	helpIn(colHeads[0] ?? null, helpModelParameterName());
	helpIn(colHeads[1] ?? null, helpModelParameterValue());
});

test("settings rows show help only where the one-line description is not enough", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));

	const rowFor = (id: string) => root.querySelector(`#setting-${CSS.escape(id)}`)?.closest(".setting-row") ?? null;
	for (const id of SETTING_ROW_HELP_IDS) {
		const row = rowFor(id);
		if (row === null) {
			throw new Error(`no settings row for ${id}`);
		}
		helpIn(row.querySelector(".setting-hint"), settingRowHelp(id) ?? "");
	}
	// A row with a self-sufficient description stays clean: no duplicate "?".
	const plain = rowFor("ui.maskSecretInputs");
	expect(plain).not.toBeNull();
	expect(helps(plain as ParentNode).length).toBe(0);
});

test("a shown tip pins itself with fixed coordinates, so scroll containers cannot clip it", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));

	// Before any hover the tip has no inline placement: the stylesheet's
	// absolute positioning is the resting default.
	const wrap = root.querySelector(".help-wrap") as HTMLElement;
	const tip = wrap.querySelector(".help-tip") as HTMLElement;
	expect(tip.style.position).toBe("");

	// Hover measures the trigger and re-anchors the tip to the viewport;
	// fixed positioning is what escapes the tables' overflow clipping. One
	// vertical side pins to the trigger's edge, the other stands down
	// (which is which depends on the wrapper's above/below placement).
	fireMouseEnter(wrap);
	expect(tip.style.position).toBe("fixed");
	expect([tip.style.top, tip.style.bottom]).toContain("auto");
	expect([tip.style.top, tip.style.bottom].some((edge) => edge.endsWith("px"))).toBe(true);
	expect(tip.style.left.endsWith("px")).toBe(true);
});

// The placement arithmetic below runs on real trigger geometry, which
// happy-dom never produces (every rect is zeros), so each test stubs the
// wrapper's getBoundingClientRect before the hover that measures it.

test("a tip in normal position sits 8px left of its trigger with its bottom pinned above it", () => {
	const root = mount(<Help text={helpModelsSection()} />);
	const wrap = root.querySelector(".help-wrap") as HTMLElement;
	stubBoundingRect(wrap, { left: 200, top: 300, bottom: 320 });
	fireMouseEnter(wrap);

	const tip = wrap.querySelector(".help-tip") as HTMLElement;
	// Unclamped: rect.left - 8 wins over both viewport bounds. The guard makes
	// the assumption explicit rather than silently depending on happy-dom's
	// default viewport width.
	expect(window.innerWidth - 350).toBeGreaterThan(192);
	expect(tip.style.left).toBe("192px");
	// Default placement anchors the tip's bottom to the trigger's top edge
	// (plus the 6px gap), keeping the tip's unknown height out of the math.
	expect(tip.style.bottom).toBe(`${window.innerHeight - 300 + 6}px`);
	expect(tip.style.top).toBe("auto");
	expect(tip.style.position).toBe("fixed");
});

test("the horizontal clamp keeps the tip's 350px box inside the viewport at both edges", () => {
	// The clamp's two branches must be distinct for the assertions to mean
	// anything: a viewport narrower than 358px would collapse them.
	expect(window.innerWidth - 350).toBeGreaterThan(8);

	// Near the right edge, rect.left - 8 would push the tip's 320px max-width
	// box (plus padding, border, and margin) off-screen; innerWidth - 350 wins.
	const right = mount(<Help text={helpModelsSection()} />);
	const rightWrap = right.querySelector(".help-wrap") as HTMLElement;
	stubBoundingRect(rightWrap, { left: window.innerWidth - 20, top: 300, bottom: 320 });
	fireMouseEnter(rightWrap);
	expect((rightWrap.querySelector(".help-tip") as HTMLElement).style.left).toBe(`${window.innerWidth - 350}px`);

	// Near the left edge, rect.left - 8 would go negative; the 8px viewport
	// margin wins.
	const left = mount(<Help text={helpModelsSection()} />);
	const leftWrap = left.querySelector(".help-wrap") as HTMLElement;
	stubBoundingRect(leftWrap, { left: 4, top: 300, bottom: 320 });
	fireMouseEnter(leftWrap);
	expect((leftWrap.querySelector(".help-tip") as HTMLElement).style.left).toBe("8px");
});

// Drift guard for helpText's no-interpolation contract: the apiVersion help
// spells the auto default as a literal, so flipping DEFAULT_API_VERSION must
// fail here until the help text (and its translations) name the new default.
test("the apiVersion help text names the real auto default", () => {
	expect(serverFieldHelp("apiVersion")).toContain(`Auto adds /${DEFAULT_API_VERSION}`);
});

test("the below variant pins the tip's top under the trigger and stands the bottom down", () => {
	const root = mount(<Help below text={helpServersSection()} />);
	const wrap = root.querySelector(".help-wrap") as HTMLElement;
	stubBoundingRect(wrap, { left: 200, top: 10, bottom: 30 });
	fireMouseEnter(wrap);

	const tip = wrap.querySelector(".help-tip") as HTMLElement;
	// Below flips the anchored edge: top pins to the trigger's bottom edge
	// plus the 6px gap, and bottom stands down instead of top.
	expect(tip.style.top).toBe("36px");
	expect(tip.style.bottom).toBe("auto");
	// The horizontal rule is the same in both variants.
	expect(tip.style.left).toBe("192px");
	expect(tip.style.position).toBe("fixed");
});
