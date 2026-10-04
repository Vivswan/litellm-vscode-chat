/**
 * The dashboard's "learn more" links into the docs: every page and #anchor the webview, the host, or a text carrier
 * ships exists under docs/ as the published site serves it, and each section renders its link. Plain anchors need
 * no plumbing or CSP grant.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { slug } from "github-slugger";
import type { DashboardSectionId } from "../../../../dashboard/viewModels";
import * as links from "../../../../shared/util/links";
import { App } from "../../../../webview/dashboard/app";
import * as docsLinks from "../../../../webview/dashboard/docsLinks";
import {
	DOCS_LINK_MODEL_CAPABILITIES,
	DOCS_LINK_MODEL_PARAMETERS,
	DOCS_LINK_MODELS,
	DOCS_LINK_PARAMS_INACTIVE,
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
const DOCS_BASE = `${links.DOCS_SITE_URL}/`;

/**
 * Every host-side link the links module exports: flat string constants plus the values of record exports. Swept
 * from a namespace import, so a future host link cannot escape the checks by not being hand-listed.
 */
function hostLinkUrls(): [name: string, url: string][] {
	return Object.entries(links).flatMap(([name, value]): [string, string][] =>
		typeof value === "string"
			? [[name, value]]
			: typeof value === "object"
				? Object.entries(value).map(([key, url]): [string, string] => [`${name}.${key}`, url])
				: []
	);
}

/**
 * The prose carriers that may spell a docs-site URL outright: the manifest's string bundles (walkthrough titles,
 * markdownDescriptions) in every locale, read as JSON so an escaped solidus still counts, and the walkthrough pages,
 * read as text. A link pasted into any of them is resolved like the code's.
 */
function carrierDocsUrls(): [name: string, url: string][] {
	const walkthroughDir = path.join(repoRoot, "assets", "walkthrough");
	const texts: [name: string, text: string][] = [
		...fs
			.readdirSync(repoRoot)
			.filter((name) => /^package\.nls(\.[\w-]+)?\.json$/.test(name))
			.map((name): [string, string] => [
				name,
				Object.values(JSON.parse(fs.readFileSync(path.join(repoRoot, name), "utf8")) as Record<string, string>).join(
					"\n"
				),
			]),
		...fs
			.readdirSync(walkthroughDir)
			.map((name): [string, string] => [
				path.join("assets", "walkthrough", name),
				fs.readFileSync(path.join(walkthroughDir, name), "utf8"),
			]),
	];
	// Each occurrence of the origin plus its slash, extended to the end of its URL: whitespace, a quote, a markdown
	// link's `)`, or an autolink's `>`.
	return texts.flatMap(([name, text]) =>
		text
			.split(DOCS_BASE)
			.slice(1)
			.map((rest): [string, string] => [name, `${DOCS_BASE}${/^[^\s"'<>)]*/.exec(rest)?.[0] ?? ""}`])
	);
}

/** Every docs URL the extension ships: the webview constants, the host-side links on the site, and the carriers'. */
function allDocsUrls(): [name: string, url: string][] {
	const entries = Object.entries(docsLinks).filter(([, value]) => typeof value === "string") as [string, string][];
	return [...entries, ...hostLinkUrls().filter(([, url]) => url.startsWith(DOCS_BASE)), ...carrierDocsUrls()];
}

test("every docs URL resolves to a page under docs/, and its #anchor to a heading the site serves", () => {
	const urls = allDocsUrls();
	expect(urls.length).toBeGreaterThan(0);
	for (const [name, url] of urls) {
		const [route, fragment] = url.slice(DOCS_BASE.length).split("#");
		// The site serves docs/<path>.md at /<path>.html, the zh-cn and zh-tw twins at their directory's prefix.
		expect(route, `${name}: ${url} names a rendered page`).toMatch(/^[\w-]+(\/[\w-]+)*\.html$/);
		const file = `${(route ?? "").slice(0, -".html".length)}.md`;
		const target = path.join(repoRoot, "docs", file);
		expect(fs.existsSync(target), `${name}: docs/${file} exists`).toBe(true);
		if (fragment !== undefined) {
			// Heading ids on the site are github-slugger's (the same package the site build slugs with), so the
			// markdown heading text slugs straight to the id the page serves.
			const headings = fs
				.readFileSync(target, "utf8")
				.split("\n")
				.flatMap((line) => {
					const match = /^#+\s+(.*)$/.exec(line);
					return match?.[1] === undefined ? [] : [slug(match[1])];
				});
			expect(headings, `${name}: docs/${file}#${fragment}`).toContain(decodeURIComponent(fragment));
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
