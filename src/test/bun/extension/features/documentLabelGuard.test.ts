/**
 * The fail-closed guard on the model-facing file-label pipeline: for a file
 * outside the workspace, vscode.workspace.asRelativePath returns the ABSOLUTE
 * filesystem path - home directory and user name included - so a feature that
 * calls it raw ships that path inside a prompt. gitAccess.documentLabel is the
 * one owner (it detects the outside-workspace case and answers the bare file
 * name), and this guard keeps it that way: Biome cannot ban a member call on
 * an allowed import, so the sweep walks every features/ source file itself.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../util/repoRoot";

describe("extension/features asRelativePath ownership", () => {
	test("gitAccess.documentLabel is the only asRelativePath call under features/", () => {
		const featuresDir = path.join(REPO_ROOT, "src", "extension", "features");
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const full = path.join(dir, entry.name);
				return entry.isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
			});
		const files = walk(featuresDir);
		expect(files.length).toBeGreaterThan(1);
		const offenders = files
			.filter((file) => readFileSync(file, "utf8").includes("asRelativePath"))
			.map((file) => path.relative(featuresDir, file))
			.sort();
		// The positive control rides in the same assertion: gitAccess.ts MUST
		// appear, so renaming or emptying the owner fails here instead of leaving
		// a guard that matches nothing.
		expect(offenders).toEqual(["gitAccess.ts"]);
		// And the owner must still CALL the API - a doc comment alone satisfies
		// the substring sweep above, so the control pins the call shape too.
		expect(readFileSync(path.join(featuresDir, "gitAccess.ts"), "utf8")).toContain("vscode.workspace.asRelativePath(");
	});
});
