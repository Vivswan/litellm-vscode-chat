import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { selectBunTests } from "../../../../../scripts/dev/changedBunTests";

/**
 * A wrong selection skips the suites that guard the staged change and the commit goes through green, so the mapping
 * is pinned on a hand-written tree (FILES): a direct importer, a transitive one, a type-only one, and an unrelated
 * suite, with a preload that reaches a file no suite imports.
 */
let root: string;

const FILES: Record<string, string> = {
	"bunfig.toml": '[test]\nroot = "tests"\npreload = ["./tests/preload.ts"]\n',
	"src/thing.ts": "export const thing = 1;\n",
	"src/helper.ts": 'import { thing } from "./thing";\nexport const helper = thing + 1;\n',
	"src/other.ts": "export const other = 2;\n",
	"src/salt.ts": "export const salt = 3;\n",
	"tests/preload.ts": 'import "../src/salt";\n',
	"tests/direct.test.ts": 'import { thing } from "../src/thing";\nexport const d = thing;\n',
	"tests/transitive.test.ts": 'import { helper } from "../src/helper";\nexport const t = helper;\n',
	"tests/typeOnly.test.ts": 'import type { thing } from "../src/thing";\nexport type T = typeof thing;\n',
	"tests/unrelated.test.ts": 'import { other } from "../src/other";\nexport const u = other;\n',
	"docs/guide.md": "# guide\n",
};
const ALL = [
	"./tests/direct.test.ts",
	"./tests/transitive.test.ts",
	"./tests/typeOnly.test.ts",
	"./tests/unrelated.test.ts",
];

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "lvt-changed-bun-tests-"));
	for (const [file, text] of Object.entries(FILES)) {
		fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), text);
	}
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("pre-commit bun test selection", () => {
	const cases: { staged: string[]; files: string[] }[] = [
		{
			staged: ["src/thing.ts"],
			files: ["./tests/direct.test.ts", "./tests/transitive.test.ts"],
		},
		{
			staged: ["tests/unrelated.test.ts", "src/helper.ts"],
			files: ["./tests/transitive.test.ts", "./tests/unrelated.test.ts"],
		},
		{
			staged: ["docs/guide.md", "src/unused.ts"],
			files: [],
		},
		{
			staged: ["src/salt.ts"],
			files: ALL,
		},
		{ staged: ["bunfig.toml"], files: ALL },
		{ staged: [], files: [] },
	];

	test.each(cases)("staged $staged selects exactly $files", ({ staged, files }) => {
		expect(selectBunTests(root, staged).files).toEqual(files);
	});

	test("an import the graph cannot resolve fails the selection instead of pruning it", () => {
		// A suite whose edge is dropped would be left out of every selection its subtree should have produced.
		const broken = path.join(root, "tests", "broken.test.ts");
		fs.writeFileSync(broken, 'import "../src/missing";\n');
		try {
			expect(() => selectBunTests(root, ["src/thing.ts"])).toThrow(/broken\.test\.ts imports "\.\.\/src\/missing"/);
		} finally {
			fs.rmSync(broken);
		}
	});
	test("a computed import specifier fails the selection instead of counting as no edge", () => {
		// bun keeps `import(target)` as written, so the suite loads a file the scanner cannot name.
		const opaque = path.join(root, "tests", "opaque.test.ts");
		fs.writeFileSync(opaque, `const target = "../src/thing";\nexport const loaded = import(target);\n`);
		try {
			for (const staged of [["docs/guide.md"], ["bunfig.toml"], ["src/salt.ts"]]) {
				expect(() => selectBunTests(root, staged)).toThrow(/opaque\.test\.ts loads a module by a computed specifier/);
			}
		} finally {
			fs.rmSync(opaque);
		}
	});
});
