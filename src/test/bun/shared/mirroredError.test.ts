import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { RequestError } from "../../../provider/transport/transportErrors";
import { Logger, publicErrorText } from "../../../shared/logger";
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

	test("carries the English mirror and renders it on the public surfaces", () => {
		const err = new MirroredError("mensaje localizado", { englishMessage: "english mirror" });
		assert.strictEqual(err.message, "mensaje localizado");
		assert.strictEqual(err.englishMessage, "english mirror");
		assert.strictEqual(err.logClassification, undefined);
		assert.strictEqual(err.name, "MirroredError");
		assert.strictEqual(publicErrorText(err), "english mirror");
	});

	test("a classification-only error keeps the classification on the public surfaces", () => {
		const err = new MirroredError("display with response body", { logClassification: "ValidationError(example)" });
		assert.strictEqual(err.englishMessage, undefined);
		assert.strictEqual(publicErrorText(err), "ValidationError(example)");
	});

	test("both channels together rank classification over mirror, and cause survives", () => {
		const cause = new Error("underlying");
		const err = new MirroredError("display", {
			englishMessage: "english",
			logClassification: "classified",
			cause,
		});
		assert.strictEqual(publicErrorText(err), "classified");
		assert.strictEqual(err.englishMessage, "english");
		assert.strictEqual(err.cause, cause);
	});

	test("the stack header reflects the assigned name, so the logger's prefix stripping keeps working", () => {
		const err = new MirroredError("display", { englishMessage: "english" });
		assert.ok(err.stack?.startsWith("MirroredError: display"), err.stack ?? "no stack captured");
	});

	test("localizedError is a thin factory over the class", () => {
		const plain = localizedError("display", "english");
		assert.ok(plain instanceof MirroredError);
		assert.strictEqual(plain.message, "display");
		assert.strictEqual(plain.englishMessage, "english");
		assert.strictEqual(plain.logClassification, undefined);

		const classified = localizedError("display", "english", "ValidationError(example)");
		assert.strictEqual(classified.logClassification, "ValidationError(example)");
	});

	test("RequestError extends the base, so transport errors inherit the guarantee", () => {
		const err = new RequestError("display", "http", { status: 503, englishMessage: "english" });
		assert.ok(err instanceof MirroredError);
		assert.strictEqual(err.name, "RequestError");
		assert.strictEqual(publicErrorText(err), "english");
	});
});
