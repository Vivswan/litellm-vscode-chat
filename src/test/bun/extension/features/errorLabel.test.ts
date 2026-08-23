/**
 * The features' shared log-safe error classifier: every feature's log boundary
 * names failures through this ONE export instead of carrying unpinnable copies.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { errorLabel } from "../../../../extension/features/errorLabel";
import { REPO_ROOT } from "../../../util/repoRoot";

/** Every .ts file under src/extension/features, recursively. */
function featureSources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return featureSources(full);
		}
		return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
	});
}

describe("extension/features errorLabel", () => {
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

	test("no feature declares its own copy: exactly one errorLabel exists in the tree", () => {
		// The drift pin behind the shared home. Two features once each carried
		// their own classifier, and a copy is invisible to the suite above - it
		// can diverge on exactly the hostile input the shared one was hardened
		// against, and only the log (or a public issue report) would show it.
		const featuresDir = path.join(REPO_ROOT, "src", "extension", "features");
		const declarations = featureSources(featuresDir).filter((file) =>
			/\bfunction\s+errorLabel\s*\(|\berrorLabel\s*=\s*(?:function\b|\()/.test(readFileSync(file, "utf8"))
		);
		expect(declarations.map((file) => path.relative(REPO_ROOT, file))).toEqual([
			path.join("src", "extension", "features", "errorLabel.ts"),
		]);
	});
});
