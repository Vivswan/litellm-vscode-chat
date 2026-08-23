/**
 * Typings-floor gate: the INSTALLED @types/vscode must not be newer than
 * engines.vscode, because newer typings would allow APIs the minimum
 * supported host lacks. Two callers run this one script - .husky/pre-commit
 * and the format-check workflow - so a local green predicts the gate: the
 * hook once compared the DECLARED range while CI compared the installed
 * version, and a range like ^1.129.0 resolving to 1.134.0 passed locally
 * and failed only in CI. Fail-closed: an unreadable manifest or an
 * unparseable version is a failure, never a pass.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function readManifest(filePath: string, label: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		fail(`Cannot read ${label} (${filePath}): ${error}`);
	}
}

function parseVersion(value: unknown, label: string): readonly [number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value).replace(/^[~^>=\s]+/, ""));
	if (!match) {
		fail(`Cannot parse ${label}: ${String(value)}`);
	}
	return [Number(match[1]), Number(match[2])];
}

// Anchored on this script's own location, not the CWD, and resolved like an
// import, so the check reads the manifest the compiler actually sees.
const rootManifestPath = path.resolve(__dirname, "../../package.json");
function resolveTypesManifest(): string {
	let resolved: string;
	try {
		resolved = createRequire(rootManifestPath).resolve("@types/vscode/package.json");
	} catch (error) {
		fail(`Cannot resolve the installed @types/vscode: ${error}`);
	}
	// bun's resolver falls back to its global install cache when node_modules
	// is missing, which would judge a manifest the compiler never sees; only
	// an install inside this repository counts.
	if (!resolved.startsWith(path.dirname(rootManifestPath) + path.sep)) {
		fail(`Resolved @types/vscode outside this repository (${resolved}): run bun install first`);
	}
	return resolved;
}

const enginesRange = (readManifest(rootManifestPath, "package.json").engines as Record<string, unknown> | undefined)
	?.vscode;
const engines = parseVersion(enginesRange, "engines.vscode");
const installed = readManifest(resolveTypesManifest(), "installed @types/vscode").version;
const types = parseVersion(installed, "installed @types/vscode");
if (types[0] !== engines[0] || types[1] > engines[1]) {
	fail(
		`Installed @types/vscode (${installed}) must not be newer than engines.vscode (${enginesRange}): ` +
			"newer typings would allow APIs the minimum supported host lacks"
	);
}
console.log(`Installed @types/vscode ${installed} is within engines.vscode ${enginesRange}`);
