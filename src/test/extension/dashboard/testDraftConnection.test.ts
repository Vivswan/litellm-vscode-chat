/**
 * The real draft probe (createDraftConnectionProbe): the connection's
 * expected-failure flags must reach the production fetchModels call, so an
 * endpoint the draft declares expected probes with a single attempt instead
 * of the idempotent-GET retry budget - the same contract production
 * discovery applies to declared entries.
 */
import * as assert from "node:assert";
import { http } from "msw";
import type * as vscode from "vscode";
import { createDraftConnectionProbe } from "../../../extension/dashboard/testDraftConnection";
import { RequestError } from "../../../provider/transport/errorMapping";
import { emptyErrorResponse, MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";

suite("extension/dashboard/testDraftConnection", () => {
	useMsw();

	const fakeContext = { extension: { packageJSON: { version: "0.0.0-test" } } } as unknown as vscode.ExtensionContext;

	test("expected-failure flags reach fetchModels: expected endpoints probe with a single attempt", async () => {
		let infoAttempts = 0;
		let modelsAttempts = 0;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				infoAttempts += 1;
				return emptyErrorResponse(500);
			}),
			http.get(MODELS_URL, () => {
				modelsAttempts += 1;
				return emptyErrorResponse(500);
			})
		);
		const probe = createDraftConnectionProbe(fakeContext);

		await assert.rejects(
			probe({
				baseUrl: TEST_BASE_URL,
				apiKey: "",
				expected: { modelInfo: true, modelListing: true },
			}),
			(error: unknown) => error instanceof RequestError
		);

		// A 500 is retryable, so anything above one attempt per endpoint means
		// the expected flags were dropped on the way to discovery.
		assert.strictEqual(infoAttempts, 1, "expected modelInfo must disable the retry budget");
		assert.strictEqual(modelsAttempts, 1, "expected modelListing must disable the retry budget");
	});
});
