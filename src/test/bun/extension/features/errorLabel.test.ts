/**
 * The features' shared log-safe error classifier: every feature's log boundary
 * names failures through this ONE export instead of carrying unpinnable copies.
 */
import { describe, expect, test } from "bun:test";
import { errorLabel } from "../../../../extension/features/errorLabel";

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
});
