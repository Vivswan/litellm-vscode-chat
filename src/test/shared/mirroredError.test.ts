import * as assert from "node:assert";
import { RequestError } from "../../provider/transport/errorMapping";
import { publicErrorText } from "../../shared/logger";
import { localizedError, MirroredError } from "../../shared/mirroredError";

suite("shared/mirroredError", () => {
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

	test("constructing a boundary error without an English channel does not typecheck", () => {
		// The compile-level pin for the localization invariant: at least one of
		// englishMessage/logClassification is required BY CONSTRUCTION.
		// @ts-expect-error - an empty options bag carries no English channel
		assert.ok(new MirroredError("display", {}) instanceof Error);
		// @ts-expect-error - a cause alone is not an English channel
		assert.ok(new MirroredError("display", { cause: new Error("x") }) instanceof Error);
		// @ts-expect-error - RequestError inherits the requirement: kind and status do not satisfy it
		assert.ok(new RequestError("display", "http", { status: 503 }) instanceof Error);
		// Never invoked: with types erased, calls without the bag would throw,
		// so the missing-argument forms are pinned without running them.
		const neverRun = () => [
			// @ts-expect-error - the options bag itself is required
			new MirroredError("display"),
			// @ts-expect-error - RequestError's options bag is required too
			new RequestError("display", "timeout"),
		];
		assert.strictEqual(typeof neverRun, "function");
	});
});
