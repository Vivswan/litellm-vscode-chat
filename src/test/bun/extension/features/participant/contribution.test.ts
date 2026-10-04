/**
 * The participant's prose: package.nls.json carries the "/" picker's copy of each command description, because the
 * host reads the manifest long before this process exists, while the registry resolves its own through the runtime
 * l10n bundle. The two cannot share a string, so they are pinned equal here. The manifest's structure (command set and
 * order, gates, categories) is generated from the tables and no longer read.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { builtinSlashCommands } from "../../../../../extension/features/participant/slashCommands";
import { quickFixSlashCommands } from "../../../../../extension/features/quickFixChatCommands";
import { REPO_ROOT } from "../../../../util/repoRoot";

/** Every nls table, so a key can be resolved in each locale that ships. English comes first. */
function nlsTables(): { locale: string; table: Record<string, string> }[] {
	return ["", "zh-cn", "zh-tw"].map((locale) => ({
		locale: locale === "" ? "en" : locale,
		table: JSON.parse(
			readFileSync(path.join(REPO_ROOT, locale === "" ? "package.nls.json" : `package.nls.${locale}.json`), "utf8")
		) as Record<string, string>,
	}));
}

describe("extension/features/participant contribution prose", () => {
	test("the manifest and the registry tell the user the same thing about each command", () => {
		// Two runtimes, two string tables, so the prose cannot be shared by construction - but it can be pinned
		// equal, which is what keeps the "/" picker and the in-chat listing from describing a command two ways.
		const [english] = nlsTables();
		for (const command of [...builtinSlashCommands(), ...quickFixSlashCommands()]) {
			expect(
				english?.table[`litellm.participant.command.${command.name}.description`],
				`/${command.name}: manifest and registry descriptions differ`
			).toBe(command.description);
		}
	});

	test("every participant string is non-blank in every locale", () => {
		// A blank description or example ships silently green and gives the host's classifier nothing to route on.
		for (const { locale, table } of nlsTables()) {
			const keys = Object.keys(table).filter((key) => key.startsWith("litellm.participant."));
			expect(keys.length, `${locale} carries participant strings`).toBeGreaterThan(0);
			for (const key of keys) {
				expect(table[key]?.trim(), `${key} is blank in ${locale}`).not.toBe("");
			}
		}
	});
});
