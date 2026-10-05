import { afterAll, describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderContributes } from "../../../../../scripts/dev/manifest/contributions";
import { serializeManifest } from "../../../../../scripts/dev/manifest/write";
import { REPO_ROOT } from "../../../util/repoRoot";
import { CHILD_PROCESS_TIMEOUT_MS } from "../../childProcessTimeout";

/**
 * The CLI against a canonical fixture manifest, never the shipped one: the negative controls prove --check fails on
 * each drift shape and names the block, and that no mode writes on a refused argument.
 */
const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-cli-"));
	tempDirs.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		serializeManifest({ name: "fixture", contributes: renderContributes() })
	);
	return root;
}

function readManifest(root: string): string {
	return fs.readFileSync(path.join(root, "package.json"), "utf8");
}

function runCli(root: string, ...flags: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({
		cmd: ["bun", path.join(REPO_ROOT, "scripts", "dev", "manifest", "generate-manifest.ts"), "--root", root, ...flags],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function stale(block: string): RegExp {
	return new RegExp(`manifest: contributes\\.${block} is stale; run: bun run manifest:generate`);
}

describe("generate-manifest CLI", () => {
	test(
		"--check passes on the canonical fixture and fails on each drift shape, naming the block",
		() => {
			const root = makeFixture();
			const canonical = readManifest(root);
			const clean = runCli(root, "--check");
			assert.strictEqual(clean.exitCode, 0, clean.stderr);
			assert.match(clean.stdout, /manifest check passed/);

			const perturbed = canonical.replace('"default": 300000,', '"default": 299,');
			const reordered = canonical.replace(
				'"type": "boolean",\n\t\t\t\t\t\t"scope": "machine-overridable",',
				'"scope": "machine-overridable",\n\t\t\t\t\t\t"type": "boolean",'
			);
			const stray = canonical.replace('"minimum": 1000,', '"minimum": 1000,\n\t\t\t\t\t\t"stray": true,');
			const retitled = canonical.replace('"title": "%litellm.command.manage.title%"', '"title": "Manage"');
			for (const [shape, mutant, block] of [
				["a perturbed default", perturbed, "configuration"],
				["two reordered keys", reordered, "configuration"],
				["a stray property", stray, "configuration"],
				["a hand-edited command title", retitled, "commands"],
			] as const) {
				assert.notStrictEqual(mutant, canonical, `${shape}: the mutation hit the fixture`);
				fs.writeFileSync(path.join(root, "package.json"), mutant);
				const drifted = runCli(root, "--check");
				assert.strictEqual(drifted.exitCode, 1, `${shape}: --check must fail`);
				assert.match(drifted.stderr, stale(block), shape);
				assert.strictEqual(readManifest(root), mutant, `${shape}: --check wrote nothing`);
			}

			const regenerate = runCli(root);
			assert.strictEqual(regenerate.exitCode, 0, regenerate.stderr);
			assert.strictEqual(readManifest(root), canonical, "regeneration restores the canonical text");
		},
		CHILD_PROCESS_TIMEOUT_MS
	);

	test(
		"an unknown argument aborts without writing",
		() => {
			// A typo'd --check must not fall through to generate mode and rewrite the manifest.
			const root = makeFixture();
			const mutant = readManifest(root).replace('"default": 300000,', '"default": 299,');
			fs.writeFileSync(path.join(root, "package.json"), mutant);
			const typo = runCli(root, "--chekc"); // typos: ignore
			assert.strictEqual(typo.exitCode, 1);
			assert.match(typo.stderr, /Unknown option/);
			assert.strictEqual(readManifest(root), mutant);
		},
		CHILD_PROCESS_TIMEOUT_MS
	);
});
