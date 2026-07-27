import * as assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { DevSeed } from "../../extension/devSeed";
import { consumeDevSeed, DEV_SEED_FILENAME, parseDevSeed } from "../../extension/devSeed";
import { Logger } from "../../shared/logger";

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

	test("consumeDevSeed creates the provider group and deletes the file first", async () => {
		const dir = await makeSeedDir(
			JSON.stringify({ baseUrl: "http://localhost:4000", apiKey: "sk-test", openDashboard: true })
		);
		const added: DevSeed[] = [];

		const seed = await consumeDevSeed(
			dir,
			async (s) => {
				added.push(s);
				assert.ok(await seedFileGone(dir), "the file must be deleted before the group is created");
			},
			makeLogger()
		);

		assert.strictEqual(seed?.openDashboard, true);
		assert.strictEqual(added.length, 1);
		assert.strictEqual(added[0]?.baseUrl, "http://localhost:4000");
		assert.strictEqual(added[0]?.apiKey, "sk-test");
	});

	test("consumeDevSeed deletes a malformed file without creating a group", async () => {
		const dir = await makeSeedDir("not json");
		const added: DevSeed[] = [];

		const seed = await consumeDevSeed(
			dir,
			async (s) => {
				added.push(s);
			},
			makeLogger()
		);

		assert.strictEqual(seed, undefined);
		assert.deepStrictEqual(added, []);
		assert.ok(await seedFileGone(dir), "malformed seeds are consumed too");
	});

	test("consumeDevSeed still reports the seed when the group command fails", async () => {
		const dir = await makeSeedDir(JSON.stringify({ baseUrl: "http://localhost:4000", openDashboard: true }));

		const seed = await consumeDevSeed(
			dir,
			async () => {
				throw new Error("host refused");
			},
			makeLogger()
		);

		assert.strictEqual(seed?.openDashboard, true, "the dashboard still opens so the user sees the state");
	});

	test("consumeDevSeed is a no-op without a seed file", async () => {
		const dir = await makeSeedDir();
		const added: DevSeed[] = [];

		assert.strictEqual(
			await consumeDevSeed(
				dir,
				async (s) => {
					added.push(s);
				},
				makeLogger()
			),
			undefined
		);
		assert.deepStrictEqual(added, []);
	});
});
