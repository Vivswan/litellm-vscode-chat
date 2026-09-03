/**
 * The extension's one compact token-count rendering, shared by the dashboard's
 * model rows and the chat participant's /models table. Pinned at the unit
 * boundaries, which is where a formatter of this shape goes wrong: rounding
 * before choosing the magnitude turns 999,999 into "1000k".
 */
import { describe, expect, test } from "bun:test";
import { compactTokenCount } from "../../../../shared/util/tokenCount";

describe("shared/util tokenCount", () => {
	test("under a thousand is the number itself", () => {
		expect(compactTokenCount(0)).toBe("0");
		expect(compactTokenCount(1)).toBe("1");
		expect(compactTokenCount(999)).toBe("999");
	});

	test("thousands read as k, at the boundary and at the common sizes", () => {
		expect(compactTokenCount(1000)).toBe("1k");
		expect(compactTokenCount(8192)).toBe("8k");
		expect(compactTokenCount(128_000)).toBe("128k");
		expect(compactTokenCount(200_000)).toBe("200k");
	});

	test("the unit is promoted AFTER rounding, so no count ever renders as 1000k", () => {
		expect(compactTokenCount(999_499)).toBe("999k");
		expect(compactTokenCount(999_500)).toBe("1M");
		expect(compactTokenCount(999_999)).toBe("1M");
	});

	test("millions keep three significant figures, so a 1M-ish window is not flattened to 1M", () => {
		expect(compactTokenCount(1_000_000)).toBe("1M");
		expect(compactTokenCount(1_048_576)).toBe("1.05M");
		expect(compactTokenCount(2_000_000)).toBe("2M");
		expect(compactTokenCount(5_000_000)).toBe("5M");
		expect(compactTokenCount(10_000_000)).toBe("10M");
	});
});
