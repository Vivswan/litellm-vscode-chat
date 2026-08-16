/**
 * Translated help-text guard: every translated bundle carrying an English help key must keep the contract - 10-160
 * chars (a lower band than the English 40-220, since CJK is denser), no template syntax or {0} placeholders (help
 * text never interpolates), no banned typography. Locales come from disk; missing keys are the parity suite's job.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerFormField } from "../../../../dashboard/serverForm";
import { EMPTY_SERVER_FORM } from "../../../../dashboard/serverForm";
import * as helpText from "../../../../webview/dashboard/helpText";
import { bannedTypography } from "../../../util/l10n";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..", "..");

function addIfString(value: unknown, into: Set<string>): void {
	if (typeof value === "string") {
		into.add(value);
	}
}

/**
 * Every English help string the module exports: the zero-arg helpX() functions swept generically, plus the two
 * arg-taking helpers fanned out over their whole domains, since those are invisible to the sweep.
 */
function collectEnglishHelp(): Set<string> {
	const english = new Set<string>();
	for (const value of Object.values({ ...helpText })) {
		if (typeof value === "function" && value.length === 0) {
			addIfString((value as () => unknown)(), english);
		}
	}
	for (const field of Object.keys(EMPTY_SERVER_FORM) as ServerFormField[]) {
		english.add(helpText.serverFieldHelp(field));
	}
	for (const id of helpText.SETTING_ROW_HELP_IDS) {
		const help = helpText.settingRowHelp(id);
		if (help !== undefined) {
			english.add(help);
		}
	}
	return english;
}

test("every translated help string keeps the help-text contract", () => {
	const english = collectEnglishHelp();
	// Floor: a helpX() given an arity would silently drop out of the sweep.
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
