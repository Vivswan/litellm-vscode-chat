/**
 * The l10n gate (pre-commit; the CI step lands with the checks.yml work):
 * fails when the committed English bundle is not byte-identical to a fresh
 * extraction, when a localized string is resolved at module scope, when a
 * translation file's key set drifts from its English reference, when a
 * translated value's {0}-style placeholders differ from the English value's,
 * when a translation file carries banned typography, when the bundle and
 * package.nls locale sets disagree, or when package.json's %key% references
 * and package.nls.json disagree. Every file is parsed through a zod schema;
 * nothing is cast.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
	BUNDLE_PATH,
	type BundleFile,
	bundleMessage,
	bundleSchema,
	extractBundle,
	moduleScopeL10nOffenses,
	nlsSchema,
	readSourceFiles,
	serializeBundle,
} from "./lib";

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

/** (a) The bundle is 100% generated, so drift is a byte comparison against a fresh extraction. */
async function checkExtractionDrift(): Promise<BundleFile | undefined> {
	if (!(await exists(BUNDLE_PATH))) {
		fail(`${rel(BUNDLE_PATH)} is missing; run \`bun run l10n:extract\` and commit the result.`);
		return undefined;
	}
	const committedText = await fs.readFile(BUNDLE_PATH, "utf8");
	const committed = bundleSchema.parse(JSON.parse(committedText));
	const extracted = await extractBundle();
	if (serializeBundle(extracted) !== committedText) {
		// Key-level hints before the verdict, so the failure reads without a manual diff.
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
		fail(
			`${rel(BUNDLE_PATH)} is not byte-identical to a fresh extraction; ` +
				"run `bun run l10n:extract`, then review and commit the result."
		);
	}
	return committed;
}

/** The lazy-catalog guard: no module-scope localization calls anywhere in the shipped source. */
async function checkModuleScopeLocalization(): Promise<void> {
	for (const { file, contents } of await readSourceFiles()) {
		for (const line of moduleScopeL10nOffenses(contents)) {
			fail(
				`${rel(file)}:${line}: localization call in a module-level initializer; ` +
					"it evaluates before l10n.config and freezes English. Resolve at call time (a zero-arg function)."
			);
		}
	}
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
 * (d) Banned typography, aligned with the repo-platform check: fullwidth
 * forms (variants, brackets, currency signs), no-break and ideographic
 * spaces, curly quotes, ellipsis, and hyphen-to-horizontal-bar dashes. CJK
 * ideographs and the sanctioned CJK punctuation pass because they are simply
 * not in the ranges.
 */
const BANNED_TYPOGRAPHY = /[\u00A0\u2010-\u2015\u2018-\u201F\u2026\u3000\uFF01-\uFF60\uFFE0-\uFFE6]/gu;

/** Scan decoded keys and values (raw-JSON scans miss \u-escaped offenders); report each offending key. */
function checkTypography(file: string, table: Record<string, string>): void {
	for (const [key, value] of Object.entries(table)) {
		const offenders = new Set<string>();
		for (const match of `${key}\n${value}`.matchAll(BANNED_TYPOGRAPHY)) {
			offenders.add(match[0]);
		}
		for (const offender of offenders) {
			const code = (offender.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
			fail(`${rel(file)}: key ${JSON.stringify(key)} carries banned typography U+${code}; use ASCII punctuation.`);
		}
	}
}

/** Message texts of a bundle file, for reference comparisons. */
function bundleMessages(bundle: BundleFile): Record<string, string> {
	return Object.fromEntries(Object.entries(bundle).map(([key, value]) => [key, bundleMessage(value)]));
}

/** The locale of a translation file name, per the family's pattern. */
function localesOf(names: readonly string[], pattern: RegExp): Set<string> {
	const locales = new Set<string>();
	for (const name of names) {
		const match = pattern.exec(name);
		if (match?.[1] !== undefined) {
			locales.add(match[1]);
		}
	}
	return locales;
}

async function checkTranslationFiles(englishBundle: BundleFile | undefined): Promise<void> {
	const root = process.cwd();
	const l10nDir = path.dirname(BUNDLE_PATH);
	const bundleFiles = (await exists(l10nDir))
		? (await fs.readdir(l10nDir)).filter((name) => /^bundle\.l10n\.[\w-]+\.json$/.test(name)).sort()
		: [];
	for (const name of bundleFiles) {
		const file = path.join(l10nDir, name);
		// Strings only: the webview bootstrap drops a bundle with any non-string
		// value, so a {message, comment} object here would silently revert the
		// dashboard to English while the host stays translated.
		const translated = nlsSchema.parse(await readJson(file));
		if (englishBundle !== undefined) {
			checkAgainstReference(file, translated, bundleMessages(englishBundle));
		}
		checkTypography(file, translated);
	}

	const rootNames = await fs.readdir(root);
	const nlsFiles = rootNames.filter((name) => /^package\.nls\.[\w-]+\.json$/.test(name)).sort();
	const nlsPath = path.join(root, "package.nls.json");
	if (await exists(nlsPath)) {
		const englishNls = nlsSchema.parse(await readJson(nlsPath));
		checkTypography(nlsPath, englishNls);
		for (const name of nlsFiles) {
			const file = path.join(root, name);
			const translated = nlsSchema.parse(await readJson(file));
			checkAgainstReference(file, translated, englishNls);
			checkTypography(file, translated);
		}
	}

	// Cross-family locale parity: a locale ships both files or neither.
	const bundleLocales = localesOf(bundleFiles, /^bundle\.l10n\.([\w-]+)\.json$/);
	const nlsLocales = localesOf(nlsFiles, /^package\.nls\.([\w-]+)\.json$/);
	for (const locale of bundleLocales) {
		if (!nlsLocales.has(locale)) {
			fail(`locale ${locale}: l10n/bundle.l10n.${locale}.json exists but package.nls.${locale}.json is missing.`);
		}
	}
	for (const locale of nlsLocales) {
		if (!bundleLocales.has(locale)) {
			fail(`locale ${locale}: package.nls.${locale}.json exists but l10n/bundle.l10n.${locale}.json is missing.`);
		}
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

/** How the manifest and package.nls.json relate; references are parsed first so a missing file cannot mask them. */
type ManifestNlsState =
	| { readonly kind: "not-externalized" }
	| { readonly kind: "missing-nls"; readonly references: ReadonlySet<string> }
	| {
			readonly kind: "externalized";
			readonly references: ReadonlySet<string>;
			readonly nls: Readonly<Record<string, string>>;
	  };

async function resolveManifestNlsState(): Promise<ManifestNlsState> {
	const root = process.cwd();
	const references = new Set<string>();
	collectNlsReferences(await readJson(path.join(root, "package.json")), references);
	const nlsPath = path.join(root, "package.nls.json");
	if (!(await exists(nlsPath))) {
		return references.size === 0 ? { kind: "not-externalized" } : { kind: "missing-nls", references };
	}
	return { kind: "externalized", references, nls: nlsSchema.parse(await readJson(nlsPath)) };
}

/** (e) package.json's %key% references and package.nls.json must name the same key set. */
async function checkManifestCoverage(): Promise<void> {
	const state = await resolveManifestNlsState();
	switch (state.kind) {
		case "not-externalized":
			return;
		case "missing-nls":
			fail(
				`package.json references ${state.references.size} %key% placeholder(s) but package.nls.json does not exist.`
			);
			return;
		case "externalized":
			for (const key of state.references) {
				if (!(key in state.nls)) {
					fail(`package.json references %${key}% but package.nls.json does not define it.`);
				}
			}
			for (const key of Object.keys(state.nls)) {
				if (!state.references.has(key)) {
					fail(`package.nls.json defines ${JSON.stringify(key)} but package.json never references %${key}%.`);
				}
			}
			return;
	}
}

async function main(): Promise<void> {
	const englishBundle = await checkExtractionDrift();
	await checkModuleScopeLocalization();
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
