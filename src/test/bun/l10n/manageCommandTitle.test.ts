import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { CMD } from "../../../shared/config/commandIds";
import { resolveNls } from "../../util/nls";
import { REPO_ROOT } from "../../util/repoRoot";

/**
 * Per locale, the title the palette shows (package.nls.<locale>.json) must equal the title messages interpolate (the
 * bundle's translation). The l10n gate checks each family against its own English reference, never one against the
 * other, so a translator editing one leaves guidance naming a command the palette does not show, with nothing else
 * failing.
 *
 *   key names may change                           -> The manage command's nls keys are found by English VALUE
 *   a non-English host returns a translated value  -> Not manageCommandTitle()
 */

const englishBundlePath = path.join(REPO_ROOT, "l10n", "bundle.l10n.json");
const englishNlsPath = path.join(REPO_ROOT, "package.nls.json");

/** The English bundle's values may be strings or {message, comment} objects; every other file is flat strings. */
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

describe("l10n drift guard: manage-command title", () => {
	test("per locale, the package.nls manage-command title equals the bundle's translation", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
			contributes?: { commands?: { command?: string; title?: string }[] };
		};
		const manageTitle = (manifest.contributes?.commands ?? []).find((entry) => entry.command === CMD.manage)?.title;
		assert.ok(
			manageTitle !== undefined && manageTitle !== "",
			`package.json contributes a ${CMD.manage} command with a title`
		);
		const englishTitle = resolveNls(manageTitle);
		const englishNls = messagesOf(englishNlsPath);
		const titleKeys = Object.keys(englishNls).filter((key) => englishNls[key] === englishTitle);
		assert.ok(
			titleKeys.length > 0,
			`package.nls.json defines no key valued ${JSON.stringify(englishTitle)}; the manage-command title must be externalized`
		);
		const bundles = localeFiles(path.join(REPO_ROOT, "l10n"), /^bundle\.l10n\.([\w-]+)\.json$/);
		const nlsFiles = localeFiles(REPO_ROOT, /^package\.nls\.([\w-]+)\.json$/);
		assert.ok(
			nlsFiles.size > 0,
			"at least one translated package.nls file exists, so the loop below compares something"
		);
		for (const [locale, nlsFile] of nlsFiles) {
			const bundleFile = bundles.get(locale);
			assert.ok(bundleFile !== undefined, `bundle.l10n.${locale}.json exists beside package.nls.${locale}.json`);
			const translatedTitle = messagesOf(bundleFile)[englishTitle];
			assert.ok(translatedTitle !== undefined, `bundle.l10n.${locale}.json translates ${JSON.stringify(englishTitle)}`);
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
