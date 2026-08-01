/**
 * Translated help-text guard, the localized counterpart of help.test.tsx's
 * English sweep: for every English help string the helpText module exports
 * (plain string constants today; the lazy-catalog refactor turns them into
 * zero-arg functions and both shapes are collected, including record
 * values), each translated bundle that carries the key must keep the
 * help-text contract. That is: 1-2 short sentences (10-160 chars, a lower
 * band than the English 40-220 because CJK is denser), no template syntax
 * and no {0} placeholders (help text never interpolates, so it can never
 * carry server data), and no banned typography. Locales are discovered from
 * disk, so the guard passes with zero translated bundles and tightens as
 * they land; missing or untranslated keys are the parity suite's job
 * (src/test/l10n/bundleParity.test.ts), not this one's.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as helpText from "../../../webview/dashboard/helpText";
import { bannedTypography } from "../../util/l10n";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");

/** Every English help string reachable from one exported value, whatever its shape. */
function collectEnglishHelp(value: unknown, into: Set<string>): void {
	if (typeof value === "string") {
		into.add(value);
		return;
	}
	if (typeof value === "function") {
		if (value.length === 0) {
			const result = (value as () => unknown)();
			if (typeof result === "string") {
				into.add(result);
			}
		}
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const nested of Object.values(value)) {
			collectEnglishHelp(nested, into);
		}
	}
}

test("every translated help string keeps the help-text contract", () => {
	const english = new Set<string>();
	for (const value of Object.values(helpText)) {
		collectEnglishHelp(value, english);
	}
	// The module exports dozens of help strings; a collapse here means the
	// export shape changed and the collector above needs to learn it.
	expect(english.size).toBeGreaterThan(10);

	const l10nDir = path.join(repoRoot, "l10n");
	const bundleNames = fs
		.readdirSync(l10nDir)
		.filter((name) => /^bundle\.l10n\.[\w-]+\.json$/.test(name))
		.sort();
	const offenses: string[] = [];
	for (const name of bundleNames) {
		const raw: unknown = JSON.parse(fs.readFileSync(path.join(l10nDir, name), "utf8"));
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			offenses.push(`${name}: not a JSON object`);
			continue;
		}
		const table = raw as Record<string, unknown>;
		for (const key of english) {
			const value = table[key];
			if (typeof value !== "string") {
				continue; // Absent or malformed: the parity suite owns that failure.
			}
			const where = `${name}: ${JSON.stringify(key)}`;
			if (value.length < 10 || value.length > 160) {
				offenses.push(`${where} is ${value.length} chars; help text stays 10-160`);
			}
			if (value.includes("${")) {
				offenses.push(`${where} carries template syntax; help text never interpolates`);
			}
			if (/\{\d+\}/.test(value)) {
				offenses.push(`${where} carries a {0}-style placeholder; help text takes no arguments`);
			}
			for (const match of value.matchAll(bannedTypography())) {
				const code = (match[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
				offenses.push(`${where} carries banned typography U+${code}`);
			}
		}
	}
	expect(offenses).toEqual([]);
});
