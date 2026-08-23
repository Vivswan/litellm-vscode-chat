/**
 * The shared log-safe error classifier: every log boundary that names a failed
 * action names it through this ONE export instead of carrying unpinnable
 * copies.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { errorLabel } from "../../../../shared/util/errorLabel";
import { REPO_ROOT } from "../../../util/repoRoot";

/** Every .ts file under a source tree, recursively. */
function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return sources(full);
		}
		return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
	});
}

/** The shipped source trees the drift pins sweep; src/test is the one tree allowed its own fixtures. */
function shippedSources(): string[] {
	return ["extension", "provider", "dashboard", "shared", "webview"].flatMap((tree) =>
		sources(path.join(REPO_ROOT, "src", tree))
	);
}

describe("shared/util errorLabel", () => {
	test("total and shape-gated: classifications and Error names pass, junk degrades to its type", () => {
		expect(errorLabel({ logClassification: "Timeout(15000ms)" })).toBe("Timeout(15000ms)");
		expect(errorLabel(new RangeError("boom"))).toBe("RangeError");
		expect(errorLabel({ logClassification: "multi\nline" })).toBe("object");
		expect(errorLabel("free text")).toBe("string");
		expect(
			errorLabel(
				new Proxy(
					{},
					{
						get() {
							throw new Error("hostile getter");
						},
					}
				)
			)
		).toBe("unreadable-error");
	});

	test("no tree declares its own copy: exactly one errorLabel exists in shipped source", () => {
		// The drift pin behind the shared home. Two features once each carried
		// their own classifier, and a copy is invisible to the suite above - it
		// can diverge on exactly the hostile input the shared one was hardened
		// against, and only the log (or a public issue report) would show it.
		const declarations = shippedSources().filter((file) =>
			/\bfunction\s+errorLabel\s*\(|\berrorLabel\s*=\s*(?:function\b|\()/.test(readFileSync(file, "utf8"))
		);
		expect(declarations.map((file) => path.relative(REPO_ROOT, file))).toEqual([
			path.join("src", "shared", "util", "errorLabel.ts"),
		]);
	});

	test("no shipped log line open-codes the name-or-typeof fallback beside the shared classifier", () => {
		// The idiom errorLabel replaced: `x instanceof Error ? x.name : typeof x`
		// skips the logClassification a MirroredError carries, so a site that
		// re-grows it logs a bare class name where the terse classification
		// exists. Variable-name independent (a backreference, not a literal
		// `error`), and fail-closed on any reappearance.
		const idiom = /instanceof\s+Error\s*\?\s*(\w+)\.name\s*:\s*typeof\s+\1\b/;
		const offenders = shippedSources().filter((file) => idiom.test(readFileSync(file, "utf8")));
		expect(offenders.map((file) => path.relative(REPO_ROOT, file))).toEqual([]);
	});
});
