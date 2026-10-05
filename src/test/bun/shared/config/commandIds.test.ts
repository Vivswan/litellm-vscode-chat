import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CMD,
	generateCommitMessageCommandTitle,
	generatePrDescriptionCommandTitle,
	INTERNAL_CMD,
	manageCommandTitle,
	prGenerationProviderTitle,
	refreshUsageCommandTitle,
	reviewChangesCommandTitle,
	reviewFileCommandTitle,
	syncModelsCommandTitle,
} from "../../../../shared/config/commandIds";
import { resolveNls } from "../../../util/nls";
import { REPO_ROOT } from "../../../util/repoRoot";

/**
 * The prose around the command ids: the palette titles package.nls.json carries against the shared title functions
 * and the docs, and the command: deep-links inside the nls prose against the registered ids. The manifest itself is
 * generated from CMD, so nothing here reads it.
 */
/** The nls title of one CMD member, by the key convention the generator emits. */
function contributedTitle(key: keyof typeof CMD): string {
	return resolveNls(`%litellm.command.${key}.title%`);
}

describe("shared/config/commandIds: titles and deep-links", () => {
	test("the GitHub Pull Requests provider title never claims the Copilot slot, in any locale", () => {
		// That extension picks a provider by case-insensitive substring, and "Copilot" is the search term of its own
		// slot: a title carrying that word would hijack a request this extension has no business answering. Every
		// translation is checked, because the registered title is the localized one.
		assert.ok(!/copilot/i.test(prGenerationProviderTitle()));
		const key = prGenerationProviderTitle();
		for (const file of ["bundle.l10n.json", "bundle.l10n.zh-cn.json", "bundle.l10n.zh-tw.json"]) {
			const bundle = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "l10n", file), "utf8")) as Record<
				string,
				string | { message: string }
			>;
			const entry = bundle[key];
			assert.ok(entry !== undefined, `${file} carries the provider title key`);
			const text = typeof entry === "string" ? entry : entry.message;
			assert.ok(!/copilot/i.test(text), `${file} translates the provider title with a Copilot substring: ${text}`);
		}
	});

	test("every command with a shared title function is contributed under exactly that title", () => {
		// User-facing messages interpolate these titles when telling the user to run the command (the chat-404 guidance
		// names the manage and sync-models commands), so each must be exactly what the palette shows.
		const pins: readonly [keyof typeof CMD, string][] = [
			["manage", manageCommandTitle()],
			["syncModels", syncModelsCommandTitle()],
			["refreshUsage", refreshUsageCommandTitle()],
			["generateCommitMessage", generateCommitMessageCommandTitle()],
			["generatePrDescription", generatePrDescriptionCommandTitle()],
			["reviewChanges", reviewChangesCommandTitle()],
			["reviewFile", reviewFileCommandTitle()],
		];
		for (const [key, title] of pins) {
			assert.strictEqual(contributedTitle(key), title, `${CMD[key]} is contributed under its shared title`);
		}
	});

	test("the docs and walkthrough prose name the manage command by its contributed title", () => {
		// Presence-only guard: a retitled command must at least reach every doc that tells the user to run it.
		for (const file of [
			path.join("docs", "getting-started.md"),
			path.join("docs", "servers.md"),
			path.join("docs", "troubleshooting.md"),
			path.join("assets", "walkthrough", "fine-tune.md"),
		]) {
			const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
			assert.ok(text.includes(manageCommandTitle()), `${file} names the manage command title`);
		}
	});

	test("every contributed command title appears in the getting-started commands table", () => {
		// The docs pin the English titles, so each key resolves through package.nls.json first.
		const text = fs.readFileSync(path.join(REPO_ROOT, "docs", "getting-started.md"), "utf8");
		for (const key of Object.keys(CMD) as (keyof typeof CMD)[]) {
			const title = contributedTitle(key);
			assert.ok(text.includes(title), `docs/getting-started.md names "${title}"`);
		}
	});

	test("every command: deep-link in the nls prose names a registered command", () => {
		// The walkthrough steps' buttons are command: links inside package.nls.json values; the host routes a click
		// to whatever id the link names, so an id nothing registers is a button that does nothing.
		const registered = new Set<string>([...Object.values(CMD), ...Object.values(INTERNAL_CMD)]);
		const nls = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.nls.json"), "utf8")) as Record<string, string>;
		const references = Object.values(nls).flatMap((value) =>
			[...value.matchAll(/command:(litellm\.[\w.]+)/g)].map((match) => match[1] as string)
		);
		assert.ok(references.length > 0, "the nls prose deep-links at least one extension command");
		for (const id of references) {
			assert.ok(registered.has(id), `package.nls.json deep-links unregistered command ${id}`);
		}
	});
});
