/**
 * Floor sync: when a Dependabot bump makes the DECLARED @types/vscode pin
 * newer than engines.vscode, raise the engine floor to the pin's minor and
 * rewrite every doc that states the old floor. check-vscode-types.ts is the
 * gate this satisfies: it fails any PR whose typings outrun the floor, so
 * Dependabot's @types/vscode PRs land red until the floor moves with them -
 * the dependabot-vscode-floor workflow runs this script on those PRs and
 * pushes the result. In-sync is a successful no-op, so the workflow can run
 * on every Dependabot manifest bump. Fail-closed: an unreadable manifest,
 * a non-exact pin, a non-caret floor, or a doc missing its floor claim is
 * a failure, never a silent pass.
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

// Every doc stating the minimum VS Code version. stackDrift.test.ts pins
// this list against its own claim table, so the two cannot drift apart.
const FLOOR_DOCS = [
	"README.md",
	"README.zh-cn.md",
	"README.zh-tw.md",
	"docs/getting-started.md",
	"docs/zh-cn/getting-started.md",
	"docs/zh-tw/getting-started.md",
	"docs/troubleshooting.md",
	"docs/zh-cn/troubleshooting.md",
	"docs/zh-tw/troubleshooting.md",
];

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

const repoRoot = path.resolve(__dirname, "../..");
const manifestPath = path.join(repoRoot, "package.json");

let manifest: { engines?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
try {
	manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
	fail(`Cannot read package.json (${manifestPath}): ${error}`);
}

const declared = String(manifest.devDependencies?.["@types/vscode"] ?? "");
const pin = /^(\d+)\.(\d+)\.\d+$/.exec(declared);
if (!pin) {
	fail(`@types/vscode must be an exact version pin (got "${declared}")`);
}
const floorRange = String(manifest.engines?.vscode ?? "");
const floorMatch = /^\^((\d+)\.(\d+)\.\d+)$/.exec(floorRange);
if (!floorMatch?.[1]) {
	fail(`engines.vscode must be a caret range over an exact version (got "${floorRange}")`);
}
const floor = floorMatch[1];

// Same major.minor judgment as check-vscode-types.ts, which rejects EVERY
// major mismatch, either direction; a patch-level typings bump never moves
// the floor.
if (pin[1] !== floorMatch[2]) {
	fail(
		`@types/vscode ${declared} and engines.vscode ${floorRange} disagree on the major version: raise the floor by hand`
	);
}
if (Number(pin[2]) <= Number(floorMatch[3])) {
	console.log(`engines.vscode ${floorRange} already covers @types/vscode ${declared}`);
	process.exit(0);
}

// Validate every file before writing any, so a failure never leaves the
// tree half-raised.
const raised = `${pin[1]}.${pin[2]}.0`;
const manifestSource = readFileSync(manifestPath, "utf8");
const enginesLine = `"vscode": "^${floor}"`;
if (manifestSource.split(enginesLine).length !== 2) {
	fail(`package.json must contain exactly one occurrence of ${enginesLine}`);
}
const docSources = FLOOR_DOCS.map((doc) => {
	const source = readFileSync(path.join(repoRoot, doc), "utf8");
	if (source.split(floor).length !== 2) {
		fail(
			`${doc} must state the ${floor} floor exactly once: update FLOOR_DOCS and the stackDrift claim table together`
		);
	}
	return [doc, source] as const;
});

writeFileSync(manifestPath, manifestSource.replace(enginesLine, `"vscode": "^${raised}"`));
for (const [doc, source] of docSources) {
	writeFileSync(path.join(repoRoot, doc), source.replace(floor, raised));
}

console.log(
	`Raised engines.vscode ^${floor} -> ^${raised} (with ${FLOOR_DOCS.length} docs) for @types/vscode ${declared}`
);
