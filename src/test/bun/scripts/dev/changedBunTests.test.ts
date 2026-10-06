import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { selectBunTests } from "../../../../../scripts/dev/changedBunTests";
import { REPO_ROOT } from "../../../util/repoRoot";

/**
 * A wrong selection skips the suites that guard the staged change and the commit goes through green, so the mapping
 * is pinned on a hand-written tree (FILES): a direct importer, a transitive one, a type-only one, and an unrelated
 * suite, with a preload that reaches a file no suite imports. The preload also imports the repository-reader marker,
 * so the unreachable-doc case pins that the marker selects suites, never the preload (which would select everything).
 *
 * Red control: in changedBunTests.ts replace `graph.closureOf(entry)` with `graph.edgesOf(entry).imports`; the two
 * reach cases fail, each missing the suite that reaches its staged file through one more hop.
 */
let root: string;

const FILES: Record<string, string> = {
	"bunfig.toml": '[test]\nroot = "tests"\npreload = ["./tests/preload.ts"]\n',
	"src/thing.ts": "export const thing = 1;\n",
	"src/helper.ts": 'import { thing } from "./thing";\nexport const helper = thing + 1;\n',
	"src/other.ts": "export const other = 2;\n",
	"src/salt.ts": "export const salt = 3;\n",
	"src/test/util/repoRoot.ts": 'export const REPO_ROOT = "";\n',
	"tests/preload.ts": 'import "../src/salt";\nimport "../src/test/util/repoRoot";\n',
	"tests/direct.test.ts": 'import { thing } from "../src/thing";\nexport const d = thing;\n',
	"tests/transitive.test.ts": 'import { helper } from "../src/helper";\nexport const t = helper;\n',
	"tests/typeOnly.test.ts": 'import type { thing } from "../src/thing";\nexport type T = typeof thing;\n',
	"tests/unrelated.test.ts": 'import { other } from "../src/other";\nexport const u = other;\n',
	"tests/newBehavior.spec.ts": 'import { other } from "../src/other";\nexport const s = other;\n',
	"tests/odd.spec.mtsx": 'import { other } from "../src/other";\nexport const o = other;\n',
	"docs/guide.md": "# guide\n",
};
const ALL = [
	"./tests/direct.test.ts",
	"./tests/newBehavior.spec.ts",
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
		// bun test discovers .spec files and the other script extensions too, not only .test.ts; .mtsx is not one of them.
		{
			staged: ["src/other.ts"],
			files: ["./tests/newBehavior.spec.ts", "./tests/unrelated.test.ts"],
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

	test("a suite that imports the repository-reader marker runs on any staged change, and only then", () => {
		// A suite reading a doc or stylesheet as data has no import edge to it; the marker is the one thing that says so.
		const reader = path.join(root, "tests", "reader.test.ts");
		fs.writeFileSync(reader, 'import { REPO_ROOT } from "../src/test/util/repoRoot";\nexport const r = REPO_ROOT;\n');
		try {
			expect(selectBunTests(root, ["docs/guide.md"]).files).toEqual(["./tests/reader.test.ts"]);
			expect(selectBunTests(root, []).files).toEqual([]);
		} finally {
			fs.rmSync(reader);
		}
	});

	test("the repository's data-reading suites are selected for the files they read", () => {
		// Before the marker rule, staging any of these three selected nothing while each suite fails on the change.
		const { files } = selectBunTests(REPO_ROOT, [
			"src/webview/dashboard/styles/dashboard.css",
			"src/extension/features/gitAccess.ts",
			"src/test/bun/scripts/ci/userTextReadersFixture.ts",
		]);
		expect(files).toContain("./src/test/bun/docs/visualLanguageAnchors.test.ts");
		expect(files).toContain("./src/test/bun/extension/features/documentLabelGuard.test.ts");
		expect(files).toContain("./src/test/bun/scripts/ci/user-text-readers.test.ts");
	});
});
