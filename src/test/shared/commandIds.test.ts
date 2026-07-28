import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { CMD, INTERNAL_CMD, VENDOR_ID } from "../../shared/commandIds";

/**
 * Drift guards between the shared command-ID map and package.json: the
 * palette contributions, the vendor, and the walkthrough deep-links must all
 * use exactly the IDs the code registers. Tests run from out/test/shared, so
 * the repo root is three levels up.
 */
const repoRoot = path.resolve(__dirname, "..", "..", "..");

interface PackageJson {
	readonly contributes: {
		readonly commands: readonly { readonly command: string }[];
		readonly languageModelChatProviders: readonly [{ readonly vendor: string }];
		readonly walkthroughs?: unknown;
	};
}

function readPackageJson(): PackageJson {
	return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
}

suite("shared/commandIds: package.json drift guard", () => {
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

	test("VENDOR_ID is the contributed language-model vendor", () => {
		const [provider] = readPackageJson().contributes.languageModelChatProviders;
		assert.strictEqual(VENDOR_ID, provider.vendor);
	});

	test("walkthrough command: and onCommand: deep-links use registered command IDs", () => {
		const registered = new Set<string>([...Object.values(CMD), ...Object.values(INTERNAL_CMD)]);
		const walkthroughs = JSON.stringify(readPackageJson().contributes.walkthroughs ?? "");
		const references = [...walkthroughs.matchAll(/(?:onCommand|command):(litellm\.[\w.]+)/g)].map(
			(match) => match[1] as string
		);
		assert.ok(references.length > 0, "the walkthrough deep-links at least one extension command");
		for (const id of references) {
			assert.ok(registered.has(id), `walkthrough references unregistered command ${id}`);
		}
	});
});
