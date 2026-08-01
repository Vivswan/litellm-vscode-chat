/**
 * The Diagnostics tab: the connection summary (same classification the hero
 * renders), the feedback actions, and the external links. Mirrors
 * docsLinks.test.tsx's layering: a source-level sweep over feedbackLinks.ts
 * (literal ASCII strings only, so a link can never carry server data), an
 * identity check deriving the marketplace review URL from package.json (a
 * renamed publisher or extension fails here instead of serving a dead link),
 * and render assertions over the tab itself.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { App } from "../../../webview/dashboard/app";
import { DOCS_LINK_GETTING_STARTED } from "../../../webview/dashboard/docsLinks";
import * as feedbackLinks from "../../../webview/dashboard/feedbackLinks";
import {
	FEEDBACK_LINK_FEATURE_REQUEST,
	FEEDBACK_LINK_RATE,
	FEEDBACK_LINK_REPOSITORY,
} from "../../../webview/dashboard/feedbackLinks";
import { makeDeclaredServer, makeModel, makeState, statePush } from "../fixtures";
import { buttonByText, cleanup, fireClick, mount, postedMessages, pushToWebview, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");

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

test("the connection block renders the hero's verdict wording with per-server outcome lines", () => {
	const root = mountDiagnostics({
		servers: [
			makeDeclaredServer({ label: "Prod", modelCount: 2 }),
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
	expect(panel.textContent).toContain("Degraded (2 models, some servers failed)");
	expect(panel.textContent).toContain("OK (2 models)");
	expect(panel.textContent).toContain("Error: connect ECONNREFUSED");
	expect(panel.textContent).toContain("http://localhost:4001");
});

test("the summary block stands alone: server count, absolute last-checked time, and its relative echo", () => {
	const lastChecked = "2026-07-26T01:02:03.000Z";
	const root = mountDiagnostics({
		servers: [
			makeDeclaredServer({ label: "Prod", modelCount: 2, lastChecked }),
			makeDeclaredServer({ label: "Staging", baseUrl: "http://localhost:4001", modelCount: 0 }),
		],
		models: [makeModel(), makeModel({ id: "second", name: "Second" })],
	});
	const panel = root.querySelector("#panel-diagnostics") as HTMLElement;
	expect(panel.textContent).toContain("Servers configured: 2");
	// The absolute timestamp is the copyable fact; the relative echo rides
	// beside it as a muted hint.
	expect(panel.textContent).toContain(`Last checked: ${new Date(lastChecked).toLocaleString()}`);
	const hint = panel.querySelector(".diag-facts .hint");
	expect(hint?.textContent).toMatch(/ago|just now/);
	expect(panel.textContent).toContain("Check the LiteLLM output channel for detailed logs.");
});

test("with nothing checked yet the summary says Never and carries no relative echo", () => {
	const root = mountDiagnostics({
		servers: [makeDeclaredServer({ label: "New", state: "unchecked", modelCount: 0 })],
	});
	const panel = root.querySelector("#panel-diagnostics") as HTMLElement;
	expect(panel.textContent).toContain("Waiting for first sync");
	expect(panel.textContent).toContain("Servers configured: 1");
	expect(panel.textContent).toContain("Last checked: Never");
	expect(panel.querySelector(".diag-facts .hint")).toBeNull();
});

test("legacy registry leftovers get their line, and a legacy-only world names the registry in the verdict", () => {
	const root = mountDiagnostics({ legacyServerCount: 2 });
	const panel = root.querySelector("#panel-diagnostics") as HTMLElement;
	expect(panel.textContent).toContain("Legacy registry only (2 servers)");
	expect(panel.textContent).toContain("Servers configured: 0");
	expect(panel.textContent).toContain("Legacy registry servers: 2");
	expect(panel.textContent).not.toContain("Not configured");
	// litellm.testConnection still sweeps the legacy registry, so the button
	// must not read the legacy-only world as nothing-to-test.
	expect(buttonByText(root, "Test connection").disabled).toBe(false);
});

test("an empty legacy registry earns no legacy line", () => {
	const root = mountDiagnostics();
	const panel = root.querySelector("#panel-diagnostics") as HTMLElement;
	expect(panel.textContent).not.toContain("Legacy registry");
});

test("Test connection posts its command, and disables with nothing configured", () => {
	const root = mountDiagnostics();
	resetPosted();
	fireClick(buttonByText(root, "Test connection"));
	expect(postedMessages).toEqual([{ type: "executeCommand", command: "testConnection" }]);

	cleanup();
	const empty = mountDiagnostics({});
	expect(buttonByText(empty, "Test connection").disabled).toBe(true);
});

test("a params-inactive notice rides on its server's outcome line", () => {
	const root = mountDiagnostics({
		servers: [makeDeclaredServer({ label: "Prod", modelCount: 2, notice: "entry-params-inactive" })],
		models: [makeModel(), makeModel({ id: "second", name: "Second" })],
	});
	const panel = root.querySelector("#panel-diagnostics") as HTMLElement;
	expect(panel.textContent).toContain("OK (2 models) - per-entry modelParameters are not applied");
});

test("Report a bug posts the reportIssue command from the feedback list", () => {
	const root = mountDiagnostics();
	resetPosted();
	const button = Array.from(root.querySelectorAll<HTMLButtonElement>("#panel-diagnostics button.linkish")).find(
		(candidate) => (candidate.textContent ?? "").trim() === "Report a bug"
	);
	expect(button).toBeDefined();
	fireClick(button as HTMLButtonElement);
	expect(postedMessages).toEqual([{ type: "executeCommand", command: "reportIssue" }]);
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
