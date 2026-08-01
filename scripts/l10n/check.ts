/**
 * The l10n gate (pre-commit and CI): fails when the committed English bundle
 * drifts from the source, when a translation file's key set drifts from its
 * English reference, when a translated value's {0}-style placeholders differ
 * from the English value's, when a translation file carries banned
 * typography, or when package.json's %key% references and package.nls.json
 * disagree. Every file is parsed through a zod schema; nothing is cast.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { BUNDLE_PATH, type BundleFile, bundleMessage, bundleSchema, extractBundle, nlsSchema } from "./lib";

let failed = false;

function fail(message: string): void {
	failed = true;
	console.error(`l10n:check: ${message}`);
}

function rel(file: string): string {
	return path.relative(process.cwd(), file);
}

async function readJson(file: string): Promise<unknown> {
	return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

/** (a) The committed English bundle must equal a fresh extraction, key for key and value for value. */
async function checkExtractionDrift(): Promise<BundleFile | undefined> {
	if (!(await exists(BUNDLE_PATH))) {
		fail(`${rel(BUNDLE_PATH)} is missing; run \`bun run l10n:extract\` and commit the result.`);
		return undefined;
	}
	const committed = bundleSchema.parse(await readJson(BUNDLE_PATH));
	const extracted = bundleSchema.parse(await extractBundle());
	for (const key of Object.keys(extracted)) {
		if (!(key in committed)) {
			fail(`${rel(BUNDLE_PATH)} drift: key ${JSON.stringify(key)} is in the source but not in the bundle.`);
		} else if (bundleMessage(extracted[key]) !== bundleMessage(committed[key])) {
			fail(`${rel(BUNDLE_PATH)} drift: key ${JSON.stringify(key)} has a different message in the source.`);
		}
	}
	for (const key of Object.keys(committed)) {
		if (!(key in extracted)) {
			fail(`${rel(BUNDLE_PATH)} drift: key ${JSON.stringify(key)} is in the bundle but no longer in the source.`);
		}
	}
	if (failed) {
		console.error("l10n:check: run `bun run l10n:extract` to regenerate the bundle, then review and commit it.");
	}
	return committed;
}

/** The multiset of {0}/{1}-style placeholders in one message. */
function placeholderCounts(message: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const match of message.matchAll(/\{\d+\}/g)) {
		counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
	}
	return counts;
}

/** (b) + (c) One translation file against its English reference: equal key sets, matching placeholders. */
function checkAgainstReference(
	file: string,
	translated: Record<string, string>,
	english: Record<string, string>
): void {
	for (const key of Object.keys(translated)) {
		if (!(key in english)) {
			fail(`${rel(file)}: key ${JSON.stringify(key)} does not exist in the English file.`);
		}
	}
	for (const key of Object.keys(english)) {
		if (!(key in translated)) {
			fail(`${rel(file)}: key ${JSON.stringify(key)} is missing.`);
			continue;
		}
		const wanted = placeholderCounts(english[key]);
		const got = placeholderCounts(translated[key]);
		const sameCounts = wanted.size === got.size && [...wanted].every(([token, count]) => got.get(token) === count);
		if (!sameCounts) {
			fail(
				`${rel(file)}: key ${JSON.stringify(key)} must carry exactly the English value's placeholders ` +
					`(${[...wanted.keys()].join(" ") || "none"}).`
			);
		}
	}
}

/**
 * (d) Banned typography in translation files: fullwidth ASCII variants,
 * ideographic space, curly quotes, ellipsis, and hyphen-to-horizontal-bar
 * dashes. CJK ideographs and the sanctioned CJK punctuation pass because
 * they are simply not in the ranges.
 */
const BANNED_TYPOGRAPHY = /[\uFF01-\uFF5E\u3000\u2018-\u201F\u2026\u2010-\u2015]/u;

async function checkTypography(file: string): Promise<void> {
	const text = await fs.readFile(file, "utf8");
	const match = BANNED_TYPOGRAPHY.exec(text);
	if (match !== null) {
		const code = (match[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
		fail(`${rel(file)}: banned typography U+${code} (${JSON.stringify(match[0])}); use ASCII punctuation.`);
	}
}

/** Message texts of a bundle file, for reference comparisons. */
function bundleMessages(bundle: BundleFile): Record<string, string> {
	return Object.fromEntries(Object.entries(bundle).map(([key, value]) => [key, bundleMessage(value)]));
}

async function checkTranslationFiles(englishBundle: BundleFile | undefined): Promise<void> {
	const root = process.cwd();
	const l10nDir = path.dirname(BUNDLE_PATH);
	const bundleFiles = (await exists(l10nDir))
		? (await fs.readdir(l10nDir)).filter((name) => /^bundle\.l10n\.[\w-]+\.json$/.test(name)).sort()
		: [];
	for (const name of bundleFiles) {
		const file = path.join(l10nDir, name);
		const translated = bundleSchema.parse(await readJson(file));
		if (englishBundle !== undefined) {
			checkAgainstReference(file, bundleMessages(translated), bundleMessages(englishBundle));
		}
		await checkTypography(file);
	}

	const nlsPath = path.join(root, "package.nls.json");
	if (!(await exists(nlsPath))) {
		return;
	}
	const englishNls = nlsSchema.parse(await readJson(nlsPath));
	const nlsFiles = (await fs.readdir(root)).filter((name) => /^package\.nls\.[\w-]+\.json$/.test(name)).sort();
	for (const name of nlsFiles) {
		const file = path.join(root, name);
		checkAgainstReference(file, nlsSchema.parse(await readJson(file)), englishNls);
		await checkTypography(file);
	}
}

/** Every string value of the form %key% anywhere in the manifest. */
function collectNlsReferences(node: unknown, into: Set<string>): void {
	if (typeof node === "string") {
		const match = /^%(.+)%$/.exec(node);
		if (match !== null) {
			into.add(match[1]);
		}
	} else if (Array.isArray(node)) {
		for (const item of node) {
			collectNlsReferences(item, into);
		}
	} else if (typeof node === "object" && node !== null) {
		for (const value of Object.values(node)) {
			collectNlsReferences(value, into);
		}
	}
}

/** (e) package.json's %key% references and package.nls.json must name the same key set. */
async function checkManifestCoverage(): Promise<void> {
	const root = process.cwd();
	const nlsPath = path.join(root, "package.nls.json");
	if (!(await exists(nlsPath))) {
		// The manifest is not externalized yet; nothing to cross-check.
		return;
	}
	const nls = nlsSchema.parse(await readJson(nlsPath));
	const referenced = new Set<string>();
	collectNlsReferences(await readJson(path.join(root, "package.json")), referenced);
	for (const key of referenced) {
		if (!(key in nls)) {
			fail(`package.json references %${key}% but package.nls.json does not define it.`);
		}
	}
	for (const key of Object.keys(nls)) {
		if (!referenced.has(key)) {
			fail(`package.nls.json defines ${JSON.stringify(key)} but package.json never references %${key}%.`);
		}
	}
}

async function main(): Promise<void> {
	const englishBundle = await checkExtractionDrift();
	await checkTranslationFiles(englishBundle);
	await checkManifestCoverage();
	if (failed) {
		process.exitCode = 1;
		return;
	}
	console.log("l10n:check passed.");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
