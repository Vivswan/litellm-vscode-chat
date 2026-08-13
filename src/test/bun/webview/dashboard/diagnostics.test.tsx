/**
 * The Diagnostics destination's support section and its external links, plus
 * the guard that the per-server outcome grid stays deleted. Mirrors
 * docsLinks.test.tsx's layering: a source-level sweep over feedbackLinks.ts
 * (literal ASCII strings only, so a link can never carry server data), an
 * identity check deriving the marketplace review URL from package.json (a
 * renamed publisher or extension fails here instead of serving a dead link),
 * and render assertions over the destination itself.
 *
 * The connection facts - verdict, server count, last checked, one outcome
 * line per server - are asserted through Copy diagnostics, which is now their
 * only reader here. The on-screen renderings of the same facts live on the
 * server rows, and servers.test.tsx pins them there.
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
					servers: [makeDeclaredServer({ label: "Prod", modelCount: 2 })],
					models: [makeModel(), makeModel({ id: "second", name: "Second" })],
				}
			)
		)
	);
	const diagnosticsTab = Array.from(root.querySelectorAll("[role='tab']")).find(
		(candidate) => (candidate.textContent ?? "").trim() === "Diagnostics"
	) as HTMLElement;
	fireClick(diagnosticsTab);
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
			makeDeclaredServer({ label: "Prod", modelCount: 2, lastChecked: new Date().toISOString() }),
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
	// The destination opens on what the reader can act on, not on a summary.
	const headings = Array.from(panel.querySelectorAll("h2")).map((h) => (h.textContent ?? "").trim());
	expect(headings).toEqual(["Configuration", "Resolution", "Support"]);
});

test("Copy diagnostics puts the connection block on the clipboard as plain text and flashes a check", () => {
	const lastChecked = new Date(Date.now() - 5 * 60 * 1000).toISOString();
	const root = mountDiagnostics({
		servers: [
			makeDeclaredServer({ label: "Prod", modelCount: 2, lastChecked }),
			makeDeclaredServer({
				label: "Broken",
				baseUrl: "http://localhost:4001",
				state: "error",
				error: "connect ECONNREFUSED",
			}),
		],
		models: [makeModel(), makeModel({ id: "second", name: "Second" })],
		legacyServerCount: 1,
	});
	const button = buttonByText(root, "Copy diagnostics");
	const iconPath = () => button.querySelector("svg path")?.getAttribute("d") ?? "";
	const copyIconPath = iconPath();

	// The exact plain-text format: the verdict, the facts, and one line per
	// server through serverOutcomeText - nothing beyond them. Fully English by
	// policy, timestamp included: a plain ISO instant, never a locale-shaped
	// date or a relative echo.
	expect(copyDiagnostics(root)).toBe(
		[
			"Degraded (2 models, some servers failed)",
			"Servers configured: 2",
			`Last checked: ${new Date(lastChecked).toISOString()}`,
			"Legacy registry servers: 1",
			"Prod (http://localhost:4000): OK (2 models)",
			"Broken (http://localhost:4001): Error: connect ECONNREFUSED",
		].join("\n")
	);
	expect(iconPath()).not.toBe(copyIconPath);
});

test("the copied block says Never with nothing checked yet, and drops the legacy line with an empty registry", () => {
	const root = mountDiagnostics({ servers: [makeDeclaredServer({ label: "New", state: "unchecked", modelCount: 0 })] });
	const copied = copyDiagnostics(root);
	expect(copied).toContain("Waiting for first sync");
	expect(copied).toContain("Servers configured: 1");
	expect(copied).toContain("Last checked: Never");
	expect(copied).not.toContain("Legacy registry");
});

test("a legacy-only world names the registry in the copied verdict and disables Test connection", () => {
	const root = mountDiagnostics({ legacyServerCount: 2 });
	const copied = copyDiagnostics(root);
	expect(copied).toContain("Legacy registry only (2 servers)");
	expect(copied).toContain("Servers configured: 0");
	expect(copied).toContain("Legacy registry servers: 2");
	expect(copied).not.toContain("Not configured");
	// The registry's serving path retires with this release train, so a
	// registry-only world has nothing durable a connection test could reach.
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
});
