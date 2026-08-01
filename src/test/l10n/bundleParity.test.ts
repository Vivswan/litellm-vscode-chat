import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { manageCommandTitle } from "../../shared/config/commandIds";
import { bannedTypography, placeholderCounts } from "../util/l10n";

/**
 * Layer two of the l10n parity scheme (scripts/l10n/check.ts is layer one,
 * in pre-commit and CI's format-check job): every translated bundle and
 * package.nls file must mirror its English reference, so a plain
 * `bun run test` catches translation drift even when the script never runs.
 * Locale files are discovered from disk, so the suite passes before any
 * translation lands and tightens automatically as locales arrive; what it
 * refuses to tolerate is a locale shipping in one file family but not the
 * other, or a file whose keys, {0} placeholders, or typography drift from
 * the English reference.
 */

// Tests run from out/test/l10n, so the repo root is three levels up.
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const englishBundlePath = path.join(repoRoot, "l10n", "bundle.l10n.json");
const englishNlsPath = path.join(repoRoot, "package.nls.json");

/**
 * Flat key-to-message view of one translation file. The English bundle's
 * values may be strings or {message, comment} objects (l10n.t with
 * translator comments mints the wrapped shape); every other file must be
 * flat strings, which this shape check enforces as a side effect.
 */
function messagesOf(file: string): Record<string, string> {
	const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.ok(raw !== null && typeof raw === "object" && !Array.isArray(raw), `${path.basename(file)} is a JSON object`);
	const table: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string") {
			table[key] = value;
			continue;
		}
		const allowWrapped = file === englishBundlePath;
		const message =
			allowWrapped && value !== null && typeof value === "object"
				? (value as { message?: unknown }).message
				: undefined;
		assert.strictEqual(
			typeof message,
			"string",
			`${path.basename(file)}: value of ${JSON.stringify(key)} must be a string${allowWrapped ? " or a {message, comment} object" : ""}`
		);
		table[key] = message as string;
	}
	return table;
}

/** Locale -> absolute file path for one translation-file family. */
function localeFiles(dir: string, pattern: RegExp): Map<string, string> {
	const files = new Map<string, string>();
	for (const name of fs.readdirSync(dir).sort()) {
		const locale = pattern.exec(name)?.[1];
		if (locale !== undefined) {
			files.set(locale, path.join(dir, name));
		}
	}
	return files;
}

function bundleLocales(): Map<string, string> {
	return localeFiles(path.join(repoRoot, "l10n"), /^bundle\.l10n\.([\w-]+)\.json$/);
}

function nlsLocales(): Map<string, string> {
	return localeFiles(repoRoot, /^package\.nls\.([\w-]+)\.json$/);
}

/** Every typography offense in one table, as printable findings (empty means clean). */
function typographyOffenses(name: string, table: Record<string, string>): string[] {
	const offenses: string[] = [];
	for (const [key, value] of Object.entries(table)) {
		for (const match of `${key}\n${value}`.matchAll(bannedTypography())) {
			const code = (match[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
			offenses.push(`${name}: key ${JSON.stringify(key)} carries banned typography U+${code}`);
		}
	}
	return offenses;
}

/** Key-set and per-key placeholder-multiset parity of one translated table against its English reference. */
function assertMirrorsReference(
	name: string,
	translated: Record<string, string>,
	english: Record<string, string>
): void {
	assert.deepStrictEqual(
		Object.keys(translated).sort(),
		Object.keys(english).sort(),
		`${name} must carry exactly the English reference's keys`
	);
	for (const [key, value] of Object.entries(translated)) {
		const wanted = [...placeholderCounts(english[key] ?? "")].sort();
		const got = [...placeholderCounts(value)].sort();
		assert.deepStrictEqual(got, wanted, `${name}: placeholders of ${JSON.stringify(key)} must match the English value`);
	}
}

suite("l10n drift guard: translation-file parity", () => {
	test("the English bundle exists and is clean of banned typography", () => {
		assert.ok(fs.existsSync(englishBundlePath), "l10n/bundle.l10n.json exists (run `bun run l10n:extract`)");
		const english = messagesOf(englishBundlePath);
		assert.ok(Object.keys(english).length > 0, "the English bundle is not empty");
		assert.deepStrictEqual(typographyOffenses("bundle.l10n.json", english), []);
	});

	test("every translated bundle mirrors the English bundle's keys and placeholders, with clean typography", () => {
		const english = messagesOf(englishBundlePath);
		for (const [locale, file] of bundleLocales()) {
			const name = `bundle.l10n.${locale}.json`;
			const translated = messagesOf(file);
			assertMirrorsReference(name, translated, english);
			assert.deepStrictEqual(typographyOffenses(name, translated), []);
		}
	});

	test("every package.nls locale file mirrors package.nls.json's keys, with clean typography", () => {
		const locales = nlsLocales();
		if (!fs.existsSync(englishNlsPath)) {
			// Pre-externalization: no English reference is fine, but a stray
			// locale file without one is not.
			assert.deepStrictEqual([...locales.keys()], [], "package.nls.<locale>.json files exist without package.nls.json");
			return;
		}
		const english = messagesOf(englishNlsPath);
		assert.deepStrictEqual(typographyOffenses("package.nls.json", english), []);
		for (const [locale, file] of locales) {
			const name = `package.nls.${locale}.json`;
			const translated = messagesOf(file);
			assertMirrorsReference(name, translated, english);
			assert.deepStrictEqual(typographyOffenses(name, translated), []);
		}
	});

	test("a locale ships the bundle and the package.nls file together or not at all", () => {
		assert.deepStrictEqual(
			[...bundleLocales().keys()].sort(),
			[...nlsLocales().keys()].sort(),
			"the bundle.l10n.<locale>.json and package.nls.<locale>.json locale sets must be identical"
		);
	});
});

suite("l10n drift guard: manage-command title", () => {
	/**
	 * The dashboard, toasts, and docs all tell the user to run the manage
	 * command by its palette title, so per locale the title the palette shows
	 * (package.nls.<locale>.json, native %key% substitution) must equal the
	 * title messages interpolate (the bundle's translation). The manifest key
	 * names belong to the externalization work and may change, so this guard
	 * finds the manage command's nls key(s) by English VALUE, not by name;
	 * the one coupling constant is the English title itself, obtained from
	 * manageCommandTitle() (unconfigured hosts return the l10n.t literal,
	 * which is also the bundle key on both sides).
	 */
	test("per locale, the package.nls manage-command title equals the bundle's translation", () => {
		if (!fs.existsSync(englishNlsPath)) {
			return; // Manifest not externalized yet; nothing to compare.
		}
		const englishTitle = manageCommandTitle();
		const englishNls = messagesOf(englishNlsPath);
		const titleKeys = Object.keys(englishNls).filter((key) => englishNls[key] === englishTitle);
		assert.ok(
			titleKeys.length > 0,
			`package.nls.json defines no key valued ${JSON.stringify(englishTitle)}; the manage-command title must be externalized (or manageCommandTitle() drifted from the manifest)`
		);
		const bundles = bundleLocales();
		for (const [locale, nlsFile] of nlsLocales()) {
			const bundleFile = bundles.get(locale);
			if (bundleFile === undefined) {
				continue; // The locale-pairing test reports this.
			}
			const translatedTitle = messagesOf(bundleFile)[englishTitle];
			if (translatedTitle === undefined) {
				continue; // The key-parity test reports this.
			}
			const nls = messagesOf(nlsFile);
			for (const key of titleKeys) {
				assert.strictEqual(
					nls[key],
					translatedTitle,
					`package.nls.${locale}.json ${JSON.stringify(key)} must equal bundle.l10n.${locale}.json's translation of ${JSON.stringify(englishTitle)}`
				);
			}
		}
	});
});
