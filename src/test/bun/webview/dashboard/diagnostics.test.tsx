/**
 * The Diagnostics destination's support section and links, plus the guard that
 * the per-server outcome grid stays deleted. The connection facts are asserted
 * through Copy diagnostics here; servers.test.tsx pins their on-screen twins.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { App } from "../../../../webview/dashboard/app";
import { DOCS_LINK_GETTING_STARTED } from "../../../../webview/dashboard/docsLinks";
import * as feedbackLinks from "../../../../webview/dashboard/feedbackLinks";
import {
	FEEDBACK_LINK_FEATURE_REQUEST,
	FEEDBACK_LINK_RATE,
	FEEDBACK_LINK_REPOSITORY,
} from "../../../../webview/dashboard/feedbackLinks";
import { makeDeclaredServer, makeModel, makeState, statePush } from "../fixtures";
import { buttonByText, cleanup, fireClick, mount, postedCalls, pushToWebview, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..", "..");

test("every feedback URL is ASCII, and the module is literal strings only", () => {
	const entries = Object.entries(feedbackLinks).filter(([, value]) => typeof value === "string") as [string, string][];
	expect(entries.length).toBeGreaterThan(1);
	for (const [name, value] of entries) {
		expect(value, name).toMatch(/^https:\/\/[\x20-\x7E]+$/);
	}
	const source = fs.readFileSync(path.join(repoRoot, "src", "webview", "dashboard", "feedbackLinks.ts"), "utf8");
	expect(source).not.toContain("`");
	expect(source).not.toContain("${");
	const declarations = source.match(/^export const FEEDBACK_LINK_\w+ =[\s\S]*?;/gm) ?? [];
	expect(declarations.length).toBe(entries.length);
	for (const declaration of declarations) {
		// Printable ASCII minus the quote itself, so a concatenation like
		// "a" + "b" cannot hide inside the character class.
		expect(declaration).toMatch(/^export const FEEDBACK_LINK_\w+ =\s*"[\x20-\x21\x23-\x7E]*";$/m);
	}
});

test("the review link names the extension package.json publishes, and the GitHub links its repository", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
		publisher: string;
		name: string;
		repository: { url: string };
	};
	expect(FEEDBACK_LINK_RATE).toBe(
		`https://marketplace.visualstudio.com/items?itemName=${manifest.publisher}.${manifest.name}&ssr=false#review-details`
	);
	expect(FEEDBACK_LINK_REPOSITORY).toBe(manifest.repository.url);
	expect(FEEDBACK_LINK_FEATURE_REQUEST.startsWith(`${manifest.repository.url}/issues/new?`)).toBe(true);
});

function mountDiagnostics(overrides?: Parameters<typeof makeState>[0]) {
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState(
				overrides ?? {
					servers: [makeDeclaredServer({ label: "Prod", servedModelCount: 2 })],
					models: [makeModel(), makeModel({ id: "second", name: "Second" })],
				}
			)
		)
	);
	// By id, not by text: a rail item's text includes its badge count, so
	// matching "Diagnostics" exactly finds nothing the moment the state under
	// test carries a diagnostic.
	fireClick(root.querySelector("#tab-diagnostics") as HTMLElement);
	return root;
}

function anchorByText(root: ParentNode, text: string): HTMLAnchorElement {
	const found = Array.from(root.querySelectorAll<HTMLAnchorElement>("#panel-diagnostics a")).find(
		(candidate) => (candidate.textContent ?? "").trim() === text
	);
	if (found === undefined) {
		throw new Error(`no Diagnostics anchor with text ${text}`);
	}
	return found;
}

/** Copies through the button and returns what landed on the clipboard. */
function copyDiagnostics(root: ParentNode): string {
	const written: string[] = [];
	Object.defineProperty(navigator, "clipboard", {
		value: {
			writeText: (text: string) => {
				written.push(text);
				return Promise.resolve();
			},
		},
		configurable: true,
	});
	fireClick(buttonByText(root, "Copy diagnostics"));
	return written[0] ?? "";
}

test("the per-server outcome grid is gone: the server rows own every fact it repeated", () => {
	const root = mountDiagnostics({
		servers: [
			makeDeclaredServer({ label: "Prod", servedModelCount: 2, lastChecked: Date.now() }),
			makeDeclaredServer({
				label: "Broken",
				baseUrl: "http://localhost:4001",
				state: "error",
				error: "connect ECONNREFUSED",
			}),
		],
		models: [makeModel(), makeModel({ id: "second", name: "Second" })],
	});
	const panel = root.querySelector("#panel-diagnostics") as HTMLElement;
	expect(panel.querySelector("table.diag-grid")).toBeNull();
	// Not merely the table: none of its facts are restated here. The row on the
	// Servers destination is where a status, a URL, a model count, an error and
	// a last-checked reading now live, next to the controls that fix them.
	expect(panel.textContent).not.toContain("connect ECONNREFUSED");
	expect(panel.textContent).not.toContain("http://localhost:4001");
	expect(panel.textContent).not.toContain("Servers configured");
	expect(panel.textContent).not.toContain("Last checked");
	// The destination opens on what the reader can act on: one page-level
	// header, the vertical action stack, then the sections. Support is not a
	// section - its links close the stack as a quiet nav, with no heading.
	const pageHeadings = Array.from(panel.querySelectorAll("h2")).map((h) => (h.textContent ?? "").trim());
	expect(pageHeadings).toEqual(["Diagnostics"]);
	const headings = Array.from(panel.querySelectorAll("h3")).map((h) => (h.textContent ?? "").trim());
	expect(headings).toEqual(["Configuration", "Resolution"]);
});

test("Copy diagnostics puts the connection block on the clipboard as plain text and flashes a check", () => {
	const lastChecked = Date.now() - 5 * 60 * 1000;
	const root = mountDiagnostics({
		servers: [
			makeDeclaredServer({ label: "Prod", servedModelCount: 2, lastChecked }),
			makeDeclaredServer({
				label: "Broken",
				baseUrl: "http://localhost:4001",
				state: "error",
				error: "connect ECONNREFUSED",
			}),
		],
		models: [makeModel(), makeModel({ id: "second", name: "Second" })],
	});
	const button = buttonByText(root, "Copy diagnostics");
	const iconPath = () => button.querySelector("svg path")?.getAttribute("d") ?? "";
	const copyIconPath = iconPath();

	// The exact plain-text format: verdict, facts, one line per server through
	// serverOutcomeText, then the configuration diagnostics. Fully English by
	// policy, timestamp included: a plain ISO instant, never a locale date.
	expect(copyDiagnostics(root)).toBe(
		[
			"Degraded (2 models, some servers failed)",
			"Servers configured: 2",
			`Last checked: ${new Date(lastChecked).toISOString()}`,
			"Prod (http://localhost:4000): OK (2 models)",
			"Broken (http://localhost:4001): Error: connect ECONNREFUSED",
			"Configuration diagnostics: 0",
		].join("\n")
	);
	expect(iconPath()).not.toBe(copyIconPath);
});

test("Copy diagnostics never carries URL credentials", () => {
	// The copy block is a paste-into-issues surface: a base URL configured
	// with userinfo must land on the clipboard without it.
	const root = mountDiagnostics({
		servers: [makeDeclaredServer({ label: "Prod", baseUrl: "http://user:sekret@localhost:4000", servedModelCount: 1 })],
		models: [makeModel()],
	});
	const text = copyDiagnostics(root);
	expect(text).not.toContain("sekret");
	expect(text).toContain("Prod (http://localhost:4000):");
});

test("Copy diagnostics carries the configuration diagnostics, worst first, in English", () => {
	// The page's subject is configuration, and for as long as this action
	// existed the copy carried only connections - so an issue about an inert
	// matcher key pasted a report that never mentioned it.
	const root = mountDiagnostics({
		servers: [makeDeclaredServer({ label: "Prod", servedModelCount: 1 })],
		models: [makeModel()],
		diagnostics: [
			{
				kind: "record",
				setting: "models.capabilities",
				diagnostic: { kind: "unrecognized-key", recordKey: "gpt-4", key: "supports_web_search" },
				severity: "advisory",
			},
			{ kind: "thresholds", dropped: 2, severity: "warning" },
			{
				kind: "record",
				setting: "models.parameters",
				entryLabel: "prod",
				diagnostic: { kind: "invalid-matcher", recordKey: "gpt*5", key: "gpt*5" },
				severity: "warning",
			},
			// Dropped, exactly as on screen: a reject with a row of its own has
			// its problems on that row.
			{
				kind: "entry",
				label: "broken",
				position: 2,
				problems: ["bad auth shape"],
				misconfigured: true,
				rowOwned: true,
				severity: "warning",
			},
		],
	});
	const copied = copyDiagnostics(root);
	expect(copied).toContain(
		[
			"Configuration diagnostics: 3",
			'  blocking models.parameters (entry "prod") invalid-matcher "gpt*5"',
			"  degraded usage.alertThresholds: 2 dropped",
			'  advisory models.capabilities unrecognized-key "gpt-4" / "supports_web_search"',
		].join("\n")
	);
	// Composed from classifications and structural keys, never translated from
	// the on-screen sentences, so a Chinese UI copies this same block.
	expect(copied).not.toContain("Nothing in record");
	expect(copied).not.toContain("bad auth shape");
});

test("the copied verdict quotes the served count, not the model-table row count", () => {
	// A plumbing pin on a hand-built state: the two counts are deliberately
	// unequal so the wire is discriminated (production's divergence runs the
	// other way - a multi-claimant snapshot's rows overcount the served sum).
	// The paste must quote the served window (state.servedModelCount), and the
	// per-server line must name the same total with the declared subset as
	// qualifier.
	const root = mountDiagnostics({
		servers: [
			makeDeclaredServer({
				label: "Gateway",
				state: "error",
				error: "404 on /models",
				expected: true,
				servedModelCount: 5,
				declaredModelCount: 2,
			}),
		],
		models: [makeModel()],
	});
	const copied = copyDiagnostics(root);
	expect(copied).toContain("Connected (5 models)");
	expect(copied).toContain("Gateway (http://localhost:4000): OK (5 models, 2 declared) - 404 on /models (expected)");
});

test("the copied block says Never with nothing checked yet, and drops the legacy line with an empty registry", () => {
	const root = mountDiagnostics({
		servers: [makeDeclaredServer({ label: "New", state: "unchecked", servedModelCount: 0 })],
	});
	const copied = copyDiagnostics(root);
	expect(copied).toContain("Waiting for first sync");
	expect(copied).toContain("Servers configured: 1");
	expect(copied).toContain("Last checked: Never");
});

test("a world with no server rows reads not configured and disables Test connection", () => {
	const root = mountDiagnostics({});
	const copied = copyDiagnostics(root);
	expect(copied).toContain("Not configured");
	expect(copied).toContain("Servers configured: 0");
	// With no server rows there is nothing a connection test could reach.
	expect(buttonByText(root, "Test connection").disabled).toBe(true);
});

test("Copy diagnostics substitutes a row's English error mirror", () => {
	// The copied block lands in public issue reports, which stay English by
	// policy; the localized error the chat UI showed renders on the server row.
	const root = mountDiagnostics({
		servers: [
			makeDeclaredServer({
				label: "Broken",
				state: "error",
				error: "LOCALIZED transport failure",
				errorEnglish: "ENGLISH transport failure",
			}),
		],
		models: [],
	});
	const copied = copyDiagnostics(root);
	expect(copied).toContain("Broken (http://localhost:4000): Error: ENGLISH transport failure");
	expect(copied).not.toContain("LOCALIZED");
});

test("Test connection posts its command, and disables with nothing configured", () => {
	const root = mountDiagnostics();
	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	expect(postedCalls()).toEqual([{ method: "executeCommand", payload: { command: "testConnection" } }]);

	cleanup();
	const empty = mountDiagnostics({});
	expect(buttonByText(empty, "Test connection").disabled).toBe(true);
});

test("Open output log posts the openOutput command in place of the old output-channel hint", () => {
	const root = mountDiagnostics();
	const panel = root.querySelector("#panel-diagnostics") as HTMLElement;
	expect(panel.textContent).not.toContain("Check the LiteLLM output channel");
	resetPosted();
	fireClick(buttonByText(root, "Open output log"));
	expect(postedCalls()).toEqual([{ method: "executeCommand", payload: { command: "openOutput" } }]);
});

test("Copy diagnostics never pastes a base URL: legacy leftovers and URL-scoped record keys are redacted", () => {
	// migrations/settingsRedesign/hints.ts: base URLs and header names "must
	// never reach logs or issue reports". A URL-scoped key IS a base URL and can
	// carry credentials, so the copy keeps the classification and drops the value.
	const root = mountDiagnostics({
		servers: [makeDeclaredServer({ label: "Prod", servedModelCount: 1 })],
		models: [makeModel()],
		diagnostics: [
			{
				kind: "legacy",
				hint: "inert-url-scoped-key",
				oldKey: "https://admin:hunter2@litellm.internal/gpt-4",
				detail: "models.parameters",
				severity: "warning",
			},
			{
				kind: "legacy",
				hint: "parked-global-headers",
				oldKey: "headers",
				detail: "x-tenant-id, x-internal-route",
				severity: "warning",
			},
			// A record key can be URL-shaped too - that is exactly what the
			// legacy leftover IS - so the redaction cannot live only on the
			// legacy arm.
			{
				kind: "record",
				setting: "models.parameters",
				diagnostic: {
					kind: "invalid-value",
					recordKey: "https://admin:hunter2@litellm.internal/gpt-4",
					key: "temperature",
				},
				severity: "warning",
			},
		],
	});
	const copied = copyDiagnostics(root);
	expect(copied).not.toContain("hunter2");
	expect(copied).not.toContain("litellm.internal");
	expect(copied).not.toContain("x-tenant-id");
	expect(copied).not.toContain("x-internal-route");
	// The classification and the setting survive, which is what makes the line
	// worth pasting at all.
	expect(copied).toContain("blocking inert-url-scoped-key (models.parameters)");
	expect(copied).toContain("degraded parked-global-headers (headers)");
	expect(copied).toContain('degraded models.parameters invalid-value <url-scoped key> / "temperature"');
	// The page itself still shows the real key: local is not a public issue.
	const panel = root.querySelector("#panel-diagnostics") as HTMLElement;
	expect(panel.textContent).toContain("litellm.internal");
});

test("Copy diagnostics reports an entry whose problems no server row states, and the hidden-group count", () => {
	// The entry branch splices the parser's free-form English problems, and
	// hidden groups contribute no server row at all - a hidden-only install
	// would otherwise paste "Configuration diagnostics: 0". The count reads
	// state.hiddenGroups (the same source the verdict reads), never the
	// hidden-groups diagnostic's labels.
	const root = mountDiagnostics({
		servers: [makeDeclaredServer({ label: "Prod", servedModelCount: 1 })],
		hiddenGroups: [
			{ label: "retired-eu", baseUrl: "http://eu.test" },
			{ label: "retired-us", baseUrl: "http://us.test" },
		],
		models: [makeModel()],
		diagnostics: [
			{
				kind: "entry",
				position: 3,
				problems: ["no usable label", "no base URL"],
				misconfigured: true,
				rowOwned: false,
				severity: "warning",
			},
			{ kind: "hidden-groups", labels: ["retired-eu", "retired-us"], severity: "warning" },
		],
	});
	const copied = copyDiagnostics(root);
	expect(copied).toContain("blocking servers entry #3: no usable label; no base URL");
	// Count only: the labels are user text.
	expect(copied).toContain("Hidden provider groups: 2");
	expect(copied).not.toContain("retired-eu");
});

test("Report a bug posts the reportIssue command from the support tools", () => {
	const root = mountDiagnostics();
	resetPosted();
	fireClick(buttonByText(root, "Report a bug"));
	expect(postedCalls()).toEqual([{ method: "executeCommand", payload: { command: "reportIssue" } }]);
});

test("the external rows link the pinned destinations with decorative glyphs", () => {
	const root = mountDiagnostics();
	const expectations: [string, string][] = [
		["Rate this extension", FEEDBACK_LINK_RATE],
		["Request a feature", FEEDBACK_LINK_FEATURE_REQUEST],
		["GitHub repository", FEEDBACK_LINK_REPOSITORY],
		["Documentation", DOCS_LINK_GETTING_STARTED],
	];
	for (const [text, href] of expectations) {
		const anchor = anchorByText(root, text);
		expect(anchor.getAttribute("href"), text).toBe(href);
		// Both glyphs (the leading subject icon and the trailing external-link
		// marker) stay decorative; the visible text is the accessible name.
		for (const icon of Array.from(anchor.querySelectorAll("svg.icon"))) {
			expect(icon.getAttribute("aria-hidden"), text).toBe("true");
		}
		expect(anchor.querySelectorAll("svg.icon").length, text).toBe(2);
	}
	// Label plus icon plus external-link glyph names each destination, so no
	// muted gloss beside it. Pinned: a link list is where explanatory one-liners
	// regrow. The links close the page's action stack in a heading-less nav.
	const support = root.querySelector('#panel-diagnostics nav[aria-label="Support"]') as HTMLElement;
	expect(support).not.toBeNull();
	expect(support.querySelector("h3")).toBeNull();
	expect(support.querySelectorAll(".feedback-links .hint")).toHaveLength(0);
	expect(support.textContent).not.toContain("Leave a review");
	expect(support.textContent).not.toContain("Source code, releases");
	// The Support section's own standing paragraph went the same way; the
	// tools' explanation lives on the PAGE header's help affordance, beside
	// the heading of the page whose tools it describes.
	expect(support.querySelectorAll("p.hint")).toHaveLength(0);
	const pageHead = root.querySelector("#diagnostics-section > .section-head") as HTMLElement;
	expect(pageHead.querySelector(".tip-bubble")?.textContent).toContain("Copy diagnostics");
	// The four tools open the stack as their own vertical list (plain <ul>: the
	// buttons name themselves and list semantics carry the count) before the
	// Support links, with the header's actions slot empty.
	expect(pageHead.querySelector(".section-actions")).toBeNull();
	const tools = root.querySelector("#panel-diagnostics ul.diagnostics-tools") as HTMLElement;
	expect(tools).not.toBeNull();
	// One button per list item: the list-semantics claim (a reader hears
	// "list, 4 items") holds only while each tool is its own <li>.
	expect(tools.querySelectorAll(":scope > li")).toHaveLength(4);
	expect(Array.from(tools.querySelectorAll("button")).map((button) => (button.textContent ?? "").trim())).toEqual([
		"Test connection",
		"Open output log",
		"Copy diagnostics",
		"Report a bug",
	]);
	// All four tools carry the primary rank: they are the page's whole content,
	// with nothing louder to rank under, and the Support links below them take
	// the quiet link tier - the rank order the stack reads in.
	for (const button of Array.from(tools.querySelectorAll("button"))) {
		expect(button.getAttribute("data-variant"), (button.textContent ?? "").trim()).toBe("default");
	}
	expect(support.querySelector(".toolbar")).toBeNull();
	expect(support.querySelectorAll("button")).toHaveLength(0);
	expect(tools.compareDocumentPosition(support) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	const configuration = root.querySelector("#config-diagnostics-section");
	expect(configuration).not.toBeNull();
	expect(support.compareDocumentPosition(configuration as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
