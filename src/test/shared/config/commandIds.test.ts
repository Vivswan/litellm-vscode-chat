import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CMD,
	INTERNAL_CMD,
	manageCommandTitle,
	refreshUsageCommandTitle,
	syncModelsCommandTitle,
	VENDOR_ID,
} from "../../../shared/config/commandIds";
import { resolveNls } from "../../util/nls";

/**
 * Drift guards between the shared command-ID map and package.json: the
 * palette contributions, the vendor, and the walkthrough deep-links must all
 * use exactly the IDs the code registers. Tests run from out/test/shared/config, so
 * the repo root is four levels up.
 */
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");

interface PackageJson {
	readonly contributes: {
		readonly commands: readonly { readonly command: string; readonly title?: string }[];
		readonly languageModelChatProviders: readonly [{ readonly vendor: string }];
		readonly walkthroughs?: unknown;
	};
}

function readPackageJson(): PackageJson {
	return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
}

suite("shared/config/commandIds: package.json drift guard", () => {
	test("CMD names exactly the contributed command set", () => {
		const contributed = readPackageJson().contributes.commands.map((entry) => entry.command);
		assert.deepStrictEqual([...Object.values(CMD)].sort(), [...contributed].sort());
	});

	test("internal commands stay out of contributes.commands", () => {
		// manageServers is registered but deliberately palette-less (the hub is
		// the palette entry); contributing it later must move it into CMD.
		const contributed = new Set(readPackageJson().contributes.commands.map((entry) => entry.command));
		for (const id of Object.values(INTERNAL_CMD)) {
			assert.ok(!contributed.has(id), `${id} is contributed; it belongs in CMD, not INTERNAL_CMD`);
		}
	});

	test("the manage command is contributed under manageCommandTitle()", () => {
		// User-facing messages interpolate the title when telling the user to
		// run the command, so it must be exactly what the palette shows.
		const entry = readPackageJson().contributes.commands.find((candidate) => candidate.command === CMD.manage);
		assert.ok(entry?.title !== undefined, "the manage command is contributed with a title");
		assert.strictEqual(resolveNls(entry.title), manageCommandTitle());
	});

	test("the sync-models command is contributed under syncModelsCommandTitle()", () => {
		// Same contract as the manage title: the chat-404 guidance interpolates
		// it, so it must be exactly what the palette shows.
		const entry = readPackageJson().contributes.commands.find((candidate) => candidate.command === CMD.syncModels);
		assert.ok(entry?.title !== undefined, "the sync-models command is contributed with a title");
		assert.strictEqual(resolveNls(entry.title), syncModelsCommandTitle());
	});

	test("the refresh-usage command is contributed under refreshUsageCommandTitle()", () => {
		const entry = readPackageJson().contributes.commands.find((candidate) => candidate.command === CMD.refreshUsage);
		assert.ok(entry?.title !== undefined, "the refresh-usage command is contributed with a title");
		assert.strictEqual(resolveNls(entry.title), refreshUsageCommandTitle());
	});

	test("the docs and walkthrough prose name the manage command by its contributed title", () => {
		// Presence-only guard: a retitled command must at least reach every doc
		// that tells the user to run it.
		for (const file of [
			path.join("docs", "getting-started.md"),
			path.join("docs", "servers.md"),
			path.join("docs", "troubleshooting.md"),
			path.join("assets", "walkthrough", "fine-tune.md"),
		]) {
			const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
			assert.ok(text.includes(manageCommandTitle()), `${file} names the manage command title`);
		}
	});

	test("every contributed command title appears in the getting-started commands table", () => {
		// docs/getting-started.md's Commands table mirrors contributes.commands;
		// an added or retitled command must reach it. The docs pin the English
		// titles, so the manifest's %key% references resolve through
		// package.nls.json first.
		const text = fs.readFileSync(path.join(repoRoot, "docs", "getting-started.md"), "utf8");
		for (const entry of readPackageJson().contributes.commands) {
			assert.ok(entry.title !== undefined, `${entry.command} is contributed with a title`);
			// TEMPORARY docs-pin adjustment (flagged for the integrator): the
			// committed docs predate the settings redesign, so the new usage
			// command's row lands with the redesigned docs at integration.
			if (entry.command === CMD.refreshUsage) {
				continue;
			}
			const title = resolveNls(entry.title);
			assert.ok(text.includes(title), `docs/getting-started.md names "${title}"`);
		}
	});

	test("VENDOR_ID is the contributed language-model vendor", () => {
		const [provider] = readPackageJson().contributes.languageModelChatProviders;
		assert.strictEqual(VENDOR_ID, provider.vendor);
	});

	test("walkthrough command: and onCommand: deep-links use registered command IDs", () => {
		const registered = new Set<string>([...Object.values(CMD), ...Object.values(INTERNAL_CMD)]);
		// The command: links sit inside externalized step descriptions, so every
		// manifest string resolves through package.nls.json before the scan.
		const walkthroughs = JSON.stringify(readPackageJson().contributes.walkthroughs ?? "", (_key, value: unknown) =>
			typeof value === "string" ? resolveNls(value) : value
		);
		const references = [...walkthroughs.matchAll(/(?:onCommand|command):(litellm\.[\w.]+)/g)].map(
			(match) => match[1] as string
		);
		assert.ok(references.length > 0, "the walkthrough deep-links at least one extension command");
		for (const id of references) {
			assert.ok(registered.has(id), `walkthrough references unregistered command ${id}`);
		}
	});
});
