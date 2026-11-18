import * as assert from "node:assert";
import * as vscode from "vscode";
import { documentLabel } from "../../../extension/features/gitAccess";

suite("extension/features gitAccess documentLabel", () => {
	test("a file outside every workspace folder is labelled by name, never by its absolute path", () => {
		// The host hands an uncontained URI back untouched, and that string is the absolute path, home directory
		// included. The label rides into a model prompt, so only the file's own name may leave.
		const original = vscode.workspace.asRelativePath;
		(vscode.workspace as Record<string, unknown>).asRelativePath = (pathOrUri: vscode.Uri | string) =>
			typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath;
		try {
			const outside = vscode.Uri.file("/outside/project/source.ts");
			assert.strictEqual(documentLabel(outside), "source.ts");
		} finally {
			(vscode.workspace as Record<string, unknown>).asRelativePath = original;
		}
	});

	test("multi-root: same-named files in different roots keep distinct labels", () => {
		// A faithful stand-in for the host's multi-root asRelativePath: the workspace-folder name is prepended for
		// contained files unless the caller opts out. If the label pipeline opted out, both files below would collapse
		// into one "src/index.ts" and a model could not tell the user's two files apart.
		const original = vscode.workspace.asRelativePath;
		(vscode.workspace as Record<string, unknown>).asRelativePath = (
			pathOrUri: vscode.Uri | string,
			includeWorkspaceFolder?: boolean
		) => {
			const full = typeof pathOrUri === "string" ? pathOrUri : pathOrUri.path;
			const match = /^\/(root-[ab])\/(.*)$/.exec(full);
			if (match === null) {
				return typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath;
			}
			return includeWorkspaceFolder === false ? (match[2] ?? full) : `${match[1] ?? ""}/${match[2] ?? ""}`;
		};
		try {
			assert.strictEqual(documentLabel(vscode.Uri.file("/root-a/src/index.ts")), "root-a/src/index.ts");
			assert.strictEqual(documentLabel(vscode.Uri.file("/root-b/src/index.ts")), "root-b/src/index.ts");
		} finally {
			(vscode.workspace as Record<string, unknown>).asRelativePath = original;
		}
	});
});
