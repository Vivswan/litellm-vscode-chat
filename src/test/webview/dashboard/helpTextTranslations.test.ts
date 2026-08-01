/**
 * Translated help-text guard, the localized counterpart of help.test.tsx's
 * English sweep: for every English help string the helpText module exports,
 * each translated bundle that carries the key must keep the help-text
 * contract. That is: 1-2 short sentences (10-160 chars, a lower band than
 * the English 40-220 because CJK is denser), no template syntax and no {0}
 * placeholders (help text never interpolates, so it can never carry server
 * data), and no banned typography. Locales are discovered from disk, so the
 * guard passes with zero translated bundles and tightens as they land;
 * missing or untranslated keys are the parity suite's job
 * (src/test/l10n/bundleParity.test.ts), not this one's.
 *
 * The collector tolerates both helpText shapes so this suite is green on
 * either side of the lazy-catalog refactor: the pre-refactor module (HELP_X
 * string constants plus the SERVER_FIELD_HELP / SETTING_ROW_HELP records)
 * and the post-refactor one (zero-arg helpX() functions plus
 * serverFieldHelp(field) and settingRowHelp(id), fanned out explicitly over
 * their domains, since arity-taking helpers are invisible to generic
 * collection). SETTING_ROW_HELP_IDS is an ID list, not help text; arrays
 * are never collected from.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPTY_SERVER_FORM } from "../../../extension/dashboard/serverForm";
import * as helpText from "../../../webview/dashboard/helpText";
import { bannedTypography } from "../../util/l10n";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");

function addIfString(value: unknown, into: Set<string>): void {
	if (typeof value === "string") {
		into.add(value);
	}
}

/** Every English help string the module exports, whichever shape it currently has. */
function collectEnglishHelp(): Set<string> {
	const mod: Record<string, unknown> = { ...helpText };
	const english = new Set<string>();
	for (const value of Object.values(mod)) {
		if (typeof value === "string") {
			english.add(value); // Pre-refactor HELP_X constants.
			continue;
		}
		if (typeof value === "function" && value.length === 0) {
			addIfString((value as () => unknown)(), english); // Post-refactor helpX().
			continue;
		}
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			// Pre-refactor SERVER_FIELD_HELP / SETTING_ROW_HELP records.
			for (const nested of Object.values(value)) {
				addIfString(nested, english);
			}
		}
	}
	// Post-refactor arg-taking helpers, fanned out over their whole domains.
	const serverFieldHelp = mod.serverFieldHelp;
	if (typeof serverFieldHelp === "function") {
		for (const field of Object.keys(EMPTY_SERVER_FORM)) {
			addIfString((serverFieldHelp as (field: string) => unknown)(field), english);
		}
	}
	const settingRowHelp = mod.settingRowHelp;
	const rowIds = mod.SETTING_ROW_HELP_IDS;
	if (typeof settingRowHelp === "function" && Array.isArray(rowIds)) {
		for (const id of rowIds) {
			addIfString((settingRowHelp as (id: unknown) => unknown)(id), english);
		}
	}
	return english;
}

test("every translated help string keeps the help-text contract", () => {
	const english = collectEnglishHelp();
	// 11 section/field-editor strings + one per server-form field + one per
	// SETTING_ROW_HELP id, on both sides of the refactor. A drop below the
	// floor means the export shape changed and the collector above went
	// partially blind; teach it the new shape instead of lowering the floor.
	expect(english.size).toBeGreaterThanOrEqual(25);

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
