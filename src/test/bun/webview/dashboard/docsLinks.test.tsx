/**
 * The dashboard's "learn more" links into the docs, in three layers: a source sweep over docsLinks (literal ASCII
 * only, no template syntax anywhere, so a link can never carry server data), a resolution check that every path and
 * #anchor exists under docs/, and render assertions per section. Plain anchors need no plumbing or CSP grant.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DashboardSectionId } from "../../../../dashboard/viewModels";
import type { SetupHintKind } from "../../../../shared/errorClassification";
import { SETUP_HINT_KINDS } from "../../../../shared/errorClassification";
import * as links from "../../../../shared/util/links";
import { App } from "../../../../webview/dashboard/app";
import * as docsLinks from "../../../../webview/dashboard/docsLinks";
import {
	DOCS_LINK_CHECK_BASE_URL,
	DOCS_LINK_CONFIGURE_API_KEY,
	DOCS_LINK_MODEL_CAPABILITIES,
	DOCS_LINK_MODEL_PARAMETERS,
	DOCS_LINK_MODELS,
	DOCS_LINK_PARAMS_INACTIVE,
	DOCS_LINK_PROXY_NOT_RUNNING,
	DOCS_LINK_SERVER_FORM,
	DOCS_LINK_SERVERS,
	DOCS_LINK_SETTINGS,
} from "../../../../webview/dashboard/docsLinks";
import { makeSettings } from "../../../dashboardSettingsFixture";
import { declaredWithSecrets, makeDeclaredServer, makeModel, makeState, statePush } from "../fixtures";
import { buttonByText, cleanup, fireClick, mount, pushToWebview, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..", "..");
const DOCS_BASE = `${links.GITHUB_REPO_URL}/blob/main/docs/`;

/**
 * Every host-side link the links module exports: flat string constants plus the values of record exports. Swept
 * from a namespace import, so a future host link cannot escape the checks by not being hand-listed.
 */
function hostLinkUrls(): [name: string, url: string][] {
	return Object.entries(links).flatMap(([name, value]): [string, string][] => {
		if (typeof value === "string") {
			return [[name, value]];
		}
		if (typeof value === "object" && value !== null) {
			return Object.entries(value)
				.filter((entry): entry is [string, string] => typeof entry[1] === "string")
				.map(([key, url]) => [`${name}.${key}`, url]);
		}
		return [];
	});
}

/** Every docs URL the code ships: the webview constants plus the host-side links rooted under docs/. */
function allDocsUrls(): [name: string, url: string][] {
	const entries = Object.entries(docsLinks).filter(([, value]) => typeof value === "string") as [string, string][];
	return [...entries, ...hostLinkUrls().filter(([, url]) => url.startsWith(DOCS_BASE))];
}

test("every host-side link is ASCII and rooted at the repository", () => {
	const entries = hostLinkUrls();
	expect(entries.length).toBeGreaterThan(1);
	for (const [name, value] of entries) {
		// Enforces the links module's GitHub-only docstring: a future non-GitHub link failing here is a policy decision
		// to make, not a link-integrity bug.
		expect(value, name).toStartWith(links.GITHUB_REPO_URL);
		expect(value, name).toMatch(/^[\x20-\x7E]+$/);
	}
	// The docs-rooted subset feeds the file/anchor sweep below; if this count drops, a docs link stopped being swept
	// rather than stopped existing.
	expect(hostLinkUrls().filter(([, url]) => url.startsWith(DOCS_BASE)).length).toBeGreaterThanOrEqual(4);
});

test("every docs URL is ASCII and rooted at the repository's docs folder", () => {
	const entries = allDocsUrls();
	expect(entries.length).toBeGreaterThan(1);
	for (const [name, value] of entries) {
		expect(value, name).toStartWith(DOCS_BASE);
		expect(value, name).toMatch(/^[\x20-\x7E]+$/);
	}
});

test("the host's per-cause hint links and the dashboard's docsLinks constants agree", () => {
	// The webview cannot consume SETUP_HINT_DOCS_URLS (layering plus the literal-strings-only contract force
	// docsLinks.ts to ship its own copies), so this pin keeps the toast and the dashboard on the same heading. The
	// Record type makes it exhaustive: a new hint id fails to compile until mapped.
	const mirrored: Record<SetupHintKind, string> = {
		"check-base-url": DOCS_LINK_CHECK_BASE_URL,
		"proxy-not-running": DOCS_LINK_PROXY_NOT_RUNNING,
		"configure-api-key": DOCS_LINK_CONFIGURE_API_KEY,
		"use-bare-localhost": DOCS_LINK_PROXY_NOT_RUNNING,
	};
	for (const hint of SETUP_HINT_KINDS) {
		expect(links.SETUP_HINT_DOCS_URLS[hint], hint).toBe(mirrored[hint]);
	}
});

test("the docsLinks module is literal strings only, with no template syntax", () => {
	// The render sweep checks evaluated values, which a computed expression could still produce; the source is the
	// proof. Every export must be one double-quoted literal, so DocsUrl can never silently widen to string.
	const source = fs.readFileSync(path.join(repoRoot, "src", "webview", "dashboard", "docsLinks.ts"), "utf8");
	expect(source).not.toContain("`");
	expect(source).not.toContain("${");
	const declarations = source.match(/^export const DOCS_LINK_\w+ =[\s\S]*?;/gm) ?? [];
	expect(declarations.length).toBe(Object.keys(docsLinks).length);
	for (const declaration of declarations) {
		// Printable ASCII minus the quote itself, so a concatenation like
		// "a" + "b" cannot hide inside the character class.
		expect(declaration).toMatch(/^export const DOCS_LINK_\w+ =\s*"[\x20-\x21\x23-\x7E]*";$/);
	}
});

/** A markdown heading as GitHub's anchor slugger renders it. */
function slug(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/[^\w\- ]/g, "")
		.trim()
		.replace(/ /g, "-");
}

test("every docs URL resolves to an existing file, and its #anchor to a real heading", () => {
	for (const [name, url] of allDocsUrls()) {
		const [file, fragment] = url.slice(DOCS_BASE.length).split("#");
		const target = path.join(repoRoot, "docs", file ?? "");
		expect(fs.existsSync(target), `${name}: docs/${file} exists`).toBe(true);
		if (fragment !== undefined) {
			const headings = fs
				.readFileSync(target, "utf8")
				.split("\n")
				.flatMap((line) => {
					const match = /^#+\s+(.*)$/.exec(line);
					return match?.[1] === undefined ? [] : [slug(match[1])];
				});
			expect(headings, `${name}: docs/${file}#${fragment}`).toContain(fragment);
		}
	}
});

function fullState() {
	return makeState({
		servers: [declaredWithSecrets({ apiKey: "secure" })],
		models: [makeModel()],
		settings: makeSettings({
			modelParameters: {
				editScope: "global",
				value: { "gpt-4": { temperature: 0.2 } },
				otherScopes: [],
				effective: { "gpt-4": { temperature: 0.2 } },
			},
		}),
	});
}

/** The one docs anchor inside the container, with href, name, and glyph asserted. */
function docsLinkIn(container: ParentNode | null, href: string, label: string): HTMLAnchorElement {
	if (container === null) {
		throw new Error("no container to look for a docs link in");
	}
	const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.docs-link"));
	expect(anchors.length).toBe(1);
	const anchor = anchors[0] as HTMLAnchorElement;
	expect(anchor.getAttribute("href")).toBe(href);
	expect(anchor.getAttribute("aria-label")).toBe(label);
	// The external-link glyph: decorative (the label names the destination).
	const icon = anchor.querySelector("svg.icon");
	expect(icon).not.toBeNull();
	expect(icon?.getAttribute("aria-hidden")).toBe("true");
	return anchor;
}

function headingByTitle(root: ParentNode, title: string): HTMLElement {
	const heading = Array.from(root.querySelectorAll("h2, h3, h4")).find((candidate) =>
		(candidate.textContent ?? "").trim().startsWith(title)
	);
	if (heading === undefined) {
		throw new Error(`no heading starting with ${title}`);
	}
	return heading as HTMLElement;
}

/**
 * The header LINE a section's trailing glyphs hang off, beside the heading rather than inside it. Every SECTION
 * header spells that line `.section-head`, whether ui/section.tsx built it or a page rolled its own.
 */
function headOf(root: ParentNode, title: string): HTMLElement {
	const heading = headingByTitle(root, title);
	return (heading.closest(".section-head") as HTMLElement | null) ?? heading;
}

/**
 * The section's tabpanel. Every panel stays mounted (the hidden ones are display:none), so
 * title lookups scope to their panel - a document-wide first match would couple the test
 * to the panels' JSX order (the Settings page carries its own "Models" group heading).
 */
function panelOf(root: ParentNode, section: DashboardSectionId): HTMLElement {
	const panel = root.querySelector(`#panel-${section}`);
	if (panel === null) {
		throw new Error(`no panel for section ${section}`);
	}
	return panel as HTMLElement;
}

test("each section heading links its docs page", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));

	docsLinkIn(headOf(panelOf(root, "overview"), "Servers"), DOCS_LINK_SERVERS, "Open the servers guide");
	docsLinkIn(headOf(panelOf(root, "models"), "Models"), DOCS_LINK_MODELS, "Open the models guide");
	docsLinkIn(headOf(panelOf(root, "settings"), "Settings"), DOCS_LINK_SETTINGS, "Open the settings guide");
	docsLinkIn(
		headOf(panelOf(root, "settings"), "Model parameters"),
		DOCS_LINK_MODEL_PARAMETERS,
		"Open the model parameters guide"
	);
});

test("the server form links the entry-fields section of the servers guide", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));
	fireClick(buttonByText(root, "Edit"));

	// The id names the heading itself (the page's accessible name); the docs anchor is its sibling on the header line,
	// so neither name carries the anchor's label.
	const heading = document.getElementById("server-form-title");
	expect(heading?.tagName).toBe("H3");
	expect(heading?.querySelector("a.docs-link")).toBeNull();
	docsLinkIn(heading?.closest(".section-head") ?? null, DOCS_LINK_SERVER_FORM, "Open the server fields guide");

	// The form's two record sections carry the same docs anchors their
	// settings-page twins do, on the section header line.
	const page = document.getElementById("server-edit-page") as HTMLElement;
	docsLinkIn(headOf(page, "Model parameters"), DOCS_LINK_MODEL_PARAMETERS, "Open the model parameters guide");
	docsLinkIn(headOf(page, "Model capabilities"), DOCS_LINK_MODEL_CAPABILITIES, "Open the model capabilities guide");
});

test("the params-inactive line links the troubleshooting remedy", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod", notices: ["entry-params-inactive"] })] }))
	);

	const line = root.querySelector(".row-diagnostic");
	const anchor = docsLinkIn(line, DOCS_LINK_PARAMS_INACTIVE, "Learn more in the troubleshooting guide");
	// Visible text too: inside prose the icon alone would be too quiet.
	expect(anchor.textContent).toContain("Learn more");
});
