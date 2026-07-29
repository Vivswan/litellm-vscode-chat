import * as assert from "node:assert";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import type { DevSeedEnv } from "../../extension/devSeed";
import { consumeDevSeed, parseDevSeed } from "../../extension/devSeed";
import { updateServerSecret } from "../../extension/serverSync";
import { DEV_SEED_FILENAME } from "../../shared/devSeed";
import { Logger } from "../../shared/logger";
import { serverSecretsKey } from "../../shared/storageKeys";
import { makeExtensionStorage } from "../testUtils";

function makeLogger(): Logger {
	return new Logger({
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		append: () => {},
		appendLine: () => {},
	} as unknown as vscode.LogOutputChannel);
}

/**
 * A DevSeedEnv over an in-memory setting plus the fake SecretStorage, with the
 * real secret-blob helper in the middle so the tests exercise the same secure
 * path the extension wires up.
 */
function makeEnv(initialSetting?: unknown) {
	const storage = makeExtensionStorage();
	let setting = initialSetting;
	const writes: unknown[][] = [];
	const env: DevSeedEnv = {
		readServersSetting: () => setting,
		writeServersSetting: async (value) => {
			writes.push([...value]);
			setting = value;
		},
		clearApiKey: (label) => updateServerSecret(storage.secrets, label, "apiKey", undefined),
	};
	return {
		env,
		writes,
		secretStore: storage.secretStore,
		secrets: storage.secrets,
		getSetting: () => setting,
	};
}

async function makeSeedDir(contents?: string): Promise<vscode.Uri> {
	const dir = vscode.Uri.file(join(tmpdir(), `dev-seed-${Date.now()}-${Math.random().toString(36).slice(2)}`));
	await vscode.workspace.fs.createDirectory(dir);
	if (contents !== undefined) {
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, DEV_SEED_FILENAME),
			new TextEncoder().encode(contents)
		);
	}
	return dir;
}

async function seedFileGone(dir: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, DEV_SEED_FILENAME));
		return false;
	} catch {
		return true;
	}
}

suite("extension/devSeed", () => {
	test("parseDevSeed accepts a full seed and defaults the optional fields", () => {
		const seed = parseDevSeed(JSON.stringify({ baseUrl: " http://localhost:4000 ", openDashboard: true }));
		assert.deepStrictEqual(seed, {
			label: "Fake LiteLLM",
			baseUrl: "http://localhost:4000",
			apiKey: "",
			openDashboard: true,
		});
	});

	test("parseDevSeed rejects malformed payloads", () => {
		for (const raw of ["not json", "42", "null", "{}", JSON.stringify({ baseUrl: "  " })]) {
			assert.strictEqual(parseDevSeed(raw), undefined, raw);
		}
	});

	test("parseDevSeed trims the label so the secret blob and the setting entry agree on the name", () => {
		const seed = parseDevSeed(JSON.stringify({ label: " Seeded ", baseUrl: "http://localhost:4000" }));
		assert.strictEqual(seed?.label, "Seeded");
	});

	test("consumeDevSeed writes the entry with its key inline, clears a stale blob, and deletes the file first", async () => {
		const dir = await makeSeedDir(
			JSON.stringify({ label: "Seeded", baseUrl: "http://localhost:4000", apiKey: "sk-test", openDashboard: true })
		);
		const fake = makeEnv();
		// A previous run's secure-side key: the seed must clear it so the inline
		// key is unambiguously the one in effect (and the dashboard's edit form
		// prefill sees a purely inline-stored key).
		await updateServerSecret(fake.secrets, "Seeded", "apiKey", "sk-previous-run");
		const originalWrite = fake.env.writeServersSetting;
		fake.env.writeServersSetting = async (value) => {
			assert.ok(await seedFileGone(dir), "the file must be deleted before anything acts on the seed");
			await originalWrite(value);
		};

		const seed = await consumeDevSeed(dir, fake.env, makeLogger());

		assert.strictEqual(seed?.openDashboard, true);
		assert.deepStrictEqual(
			fake.getSetting(),
			[{ label: "Seeded", baseUrl: "http://localhost:4000", apiKey: "sk-test" }],
			"the key sits inline in the entry, visible in settings like the rest of the seed"
		);
		assert.strictEqual(
			fake.secretStore.get(serverSecretsKey("Seeded")),
			undefined,
			"no secure-side copy remains; inline is the single storage"
		);
	});

	test("consumeDevSeed replaces its own entry wholesale and keeps siblings verbatim", async () => {
		const dir = await makeSeedDir(
			JSON.stringify({ label: "Seeded", baseUrl: "http://localhost:5000", apiKey: "sk-2" })
		);
		const fake = makeEnv([
			{ label: "Other", baseUrl: "http://other.test" },
			{ label: " Seeded ", baseUrl: "http://localhost:4000", apiKey: "stale-inline" },
			"junk entry",
		]);

		await consumeDevSeed(dir, fake.env, makeLogger());

		assert.deepStrictEqual(fake.getSetting(), [
			{ label: "Other", baseUrl: "http://other.test" },
			{ label: "Seeded", baseUrl: "http://localhost:5000", apiKey: "sk-2" },
			"junk entry",
		]);
	});

	test("an empty seed key clears the previous run's stored one", async () => {
		const dir = await makeSeedDir(JSON.stringify({ label: "Seeded", baseUrl: "http://localhost:4000" }));
		const fake = makeEnv();
		await updateServerSecret(fake.secrets, "Seeded", "apiKey", "sk-stale");

		await consumeDevSeed(dir, fake.env, makeLogger());

		assert.strictEqual(fake.secretStore.get(serverSecretsKey("Seeded")), undefined);
		assert.deepStrictEqual(fake.getSetting(), [{ label: "Seeded", baseUrl: "http://localhost:4000" }]);
	});

	test("consumeDevSeed deletes a malformed file without writing anything", async () => {
		const dir = await makeSeedDir("not json");
		const fake = makeEnv();

		const seed = await consumeDevSeed(dir, fake.env, makeLogger());

		assert.strictEqual(seed, undefined);
		assert.deepStrictEqual(fake.writes, []);
		assert.strictEqual(fake.secretStore.size, 0);
		assert.ok(await seedFileGone(dir), "malformed seeds are consumed too");
	});

	test("consumeDevSeed still reports the seed when the settings write fails", async () => {
		const dir = await makeSeedDir(JSON.stringify({ baseUrl: "http://localhost:4000", openDashboard: true }));
		const fake = makeEnv();
		fake.env.writeServersSetting = async () => {
			throw new Error("configuration write refused");
		};

		const seed = await consumeDevSeed(dir, fake.env, makeLogger());

		assert.strictEqual(seed?.openDashboard, true, "the dashboard still opens so the user sees the state");
	});

	test("the entry lands before the blob clear: a failed clear leaves a dormant leftover, never a missing key", async () => {
		const dir = await makeSeedDir(
			JSON.stringify({ label: "Seeded", baseUrl: "http://localhost:4000", apiKey: "sk-test" })
		);
		const fake = makeEnv();
		await updateServerSecret(fake.secrets, "Seeded", "apiKey", "sk-previous-run");
		fake.env.clearApiKey = async () => {
			throw new Error("secret store refused");
		};

		const seed = await consumeDevSeed(dir, fake.env, makeLogger());

		assert.strictEqual(seed?.baseUrl, "http://localhost:4000");
		assert.deepStrictEqual(
			fake.writes,
			[[{ label: "Seeded", baseUrl: "http://localhost:4000", apiKey: "sk-test" }]],
			"the entry landed with its inline key, which outranks the surviving stale blob"
		);
	});

	test("consumeDevSeed is a no-op without a seed file", async () => {
		const dir = await makeSeedDir();
		const fake = makeEnv();

		assert.strictEqual(await consumeDevSeed(dir, fake.env, makeLogger()), undefined);
		assert.deepStrictEqual(fake.writes, []);
	});

	test("the ignore files keep the seed file out of commits and the VSIX", () => {
		// The seed carries the local stack's master key inline, so renaming
		// DEV_SEED_FILENAME must not silently un-ignore a secret-bearing file.
		// Tests run from out/test/extension, so the repo root is three levels up.
		const repoRoot = resolve(__dirname, "..", "..", "..");
		for (const ignoreFile of [".gitignore", ".vscodeignore"]) {
			const lines = fs.readFileSync(join(repoRoot, ignoreFile), "utf8").split(/\r?\n/);
			assert.ok(lines.includes(DEV_SEED_FILENAME), `${ignoreFile} ignores ${DEV_SEED_FILENAME}`);
		}
	});
});
