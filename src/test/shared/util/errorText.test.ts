import * as assert from "node:assert";
import { statusErrorDetail, statusErrorHeadline } from "../../../shared/util/errorText";

suite("shared/util/errorText", () => {
	test("statusErrorHeadline takes the first content line and passes junk through", () => {
		assert.strictEqual(statusErrorHeadline("headline\ndetail line"), "headline");
		assert.strictEqual(statusErrorHeadline("\ndetail only"), "detail only");
		assert.strictEqual(statusErrorHeadline("one line"), "one line");
		assert.strictEqual(statusErrorHeadline(""), "");
	});

	test("statusErrorDetail is everything after the headline, or undefined for a single-part message", () => {
		assert.strictEqual(statusErrorDetail("headline\ndetail line"), "detail line");
		assert.strictEqual(statusErrorDetail("headline\nfirst\nsecond"), "first\nsecond");
		assert.strictEqual(statusErrorDetail("\nheadline after a blank\ndetail"), "detail");
		assert.strictEqual(statusErrorDetail("one line"), undefined);
		assert.strictEqual(statusErrorDetail("headline\n  \n"), undefined, "whitespace-only remainders are no detail");
		assert.strictEqual(statusErrorDetail(""), undefined);
	});

	test("the two parts partition a two-part message: nothing is dropped or duplicated", () => {
		const message = "The server could not be reached.\nGET http://litellm.test/v1/models: ETIMEDOUT";
		assert.strictEqual(statusErrorHeadline(message), "The server could not be reached.");
		assert.strictEqual(statusErrorDetail(message), "GET http://litellm.test/v1/models: ETIMEDOUT");
	});
});
