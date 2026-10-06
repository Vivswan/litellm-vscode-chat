import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { Logger } from "../../../shared/logger";
import { localizedError, MirroredError } from "../../../shared/mirroredError";

describe("shared/mirroredError", () => {
	test("the display message and the English mirror pass the output door exactly once, and again to no effect", () => {
		const key = `sk-live-${"A".repeat(32)}`;
		Logger.registerSecrets([key]);
		const text = `key ${key} refused at http://bob:pw@hub.test/v1`;
		const shown = "key sk-liv... refused at http://[redacted]@hub.test/v1";
		const error = new MirroredError(text, { englishMessage: text });
		const localized = localizedError(text, text, "Feature(x)");
		assert.deepStrictEqual(
			{
				message: error.message,
				english: error.englishMessage,
				localizedMessage: localized.message,
				localizedEnglish: localized.englishMessage,
				again: Logger.redact(error.message),
			},
			{ message: shown, english: shown, localizedMessage: shown, localizedEnglish: shown, again: shown }
		);
	});
});
