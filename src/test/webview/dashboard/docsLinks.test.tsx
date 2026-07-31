/**
 * The dashboard's "learn more" links into the docs. Three layers, mirroring
 * help.test.tsx: a source-level sweep over the docsLinks module (literal
 * ASCII strings only, no template syntax anywhere in the file, so a link can
 * never carry server data), a resolution check that every constant's path
 * and #anchor exist under docs/ (a renamed page or reworded heading fails
 * here instead of serving 404s), and render assertions that every section's
 * anchor points at its docs page, names its destination, and carries the
 * external-link glyph. Anchors need no message plumbing or CSP grant: the
 * webview host opens plain links externally.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { GITHUB_DOCS_URL, GITHUB_REPO_URL } from "../../../shared/util/links";
import { App } from "../../../webview/dashboard/app";
import * as docsLinks from "../../../webview/dashboard/docsLinks";
import {
	DOCS_LINK_MODEL_PARAMETERS,
	DOCS_LINK_MODELS,
	DOCS_LINK_PARAMS_INACTIVE,
	DOCS_LINK_SERVER_FORM,
	DOCS_LINK_SERVERS,
	DOCS_LINK_SETTINGS,
} from "../../../webview/dashboard/docsLinks";
import { declaredWithSecrets, makeDeclaredServer, makeModel, makeSettings, makeState, statePush } from "../fixtures";
import { buttonByText, cleanup, fireClick, mount, pushToWebview, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const DOCS_BASE = `${GITHUB_REPO_URL}/blob/main/docs/`;

/** Every docs URL the code ships: the webview constants plus the extension's Documentation action. */
function allDocsUrls(): [name: string, url: string][] {
	const entries = Object.entries(docsLinks).filter(([, value]) => typeof value === "string") as [string, string][];
	return [...entries, ["GITHUB_DOCS_URL", GITHUB_DOCS_URL]];
}

test("every docs URL is ASCII and rooted at the repository's docs folder", () => {
	const entries = allDocsUrls();
	expect(entries.length).toBeGreaterThan(1);
	for (const [name, value] of entries) {
		expect(value, name).toStartWith(DOCS_BASE);
		expect(value, name).toMatch(/^[\x20-\x7E]+$/);
	}
});

test("the docsLinks module is literal strings only, with no template syntax", () => {
	// The render sweep checks evaluated values, which computed expressions
	// could still produce; the source is the proof. Every export must be a
	// single double-quoted literal (no templates, no concatenation, no
	// identifiers), so DocsUrl can never silently widen to string.
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
			modelParameters: { editScope: "global", value: { "gpt-4": { temperature: 0.2 } }, otherScopes: [] },
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
	const heading = Array.from(root.querySelectorAll("h2, h3")).find((candidate) =>
		(candidate.textContent ?? "").trim().startsWith(title)
	);
	if (heading === undefined) {
		throw new Error(`no heading starting with ${title}`);
	}
	return heading as HTMLElement;
}

test("each section heading links its docs page", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));

	docsLinkIn(headingByTitle(root, "Servers"), DOCS_LINK_SERVERS, "Open the servers guide");
	docsLinkIn(headingByTitle(root, "Models"), DOCS_LINK_MODELS, "Open the models guide");
	docsLinkIn(headingByTitle(root, "Settings"), DOCS_LINK_SETTINGS, "Open the settings guide");
	docsLinkIn(headingByTitle(root, "Model parameters"), DOCS_LINK_MODEL_PARAMETERS, "Open the model parameters guide");
});

test("the server form links the entry-fields section of the servers guide", () => {
	const root = mount(<App />);
	pushToWebview(statePush(fullState()));
	fireClick(buttonByText(root, "Edit"));

	// The id names the title span (the dialog's accessible name); the docs
	// anchor sits beside it in the heading, outside the label.
	const heading = document.getElementById("server-form-title")?.closest("h3") ?? null;
	docsLinkIn(heading, DOCS_LINK_SERVER_FORM, "Open the server fields guide");
});

test("the params-inactive banner links the troubleshooting remedy", () => {
	const root = mount(<App />);
	pushToWebview(
		statePush(makeState({ servers: [makeDeclaredServer({ label: "Prod", notice: "entry-params-inactive" })] }))
	);

	const banner = root.querySelector(".banner-warn");
	const anchor = docsLinkIn(banner, DOCS_LINK_PARAMS_INACTIVE, "Learn more in the troubleshooting guide");
	// Visible text too: inside prose the icon alone would be too quiet.
	expect(anchor.textContent).toContain("Learn more");
});
