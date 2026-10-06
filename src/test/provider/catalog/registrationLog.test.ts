import * as assert from "node:assert";
import * as vscode from "vscode";
import { discoveryHandlers, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";
import { assertOmits, makeLogger } from "../../pureHelpers";
import { makeProvider } from "../../testUtils";

const MARKER = "sk-live-MARKER";
const COUNT_LINE = "Registered models";

suite("provider/catalog/registration log", () => {
	useMsw();

	test("a listing's model ids register and reach no log line; the one registration line carries counts", async () => {
		// One bare listing entry and one deployment listed twice: the duplicate merges before registration, so the
		// counts read the merged listing.
		mswServer.use(
			...discoveryHandlers({
				data: [
					{ id: `${MARKER}-model`, object: "model" },
					{ model_name: `${MARKER}-deployment`, model_info: { max_input_tokens: 1000, max_output_tokens: 100 } },
					{ model_name: `${MARKER}-deployment`, model_info: { max_input_tokens: 1000, max_output_tokens: 100 } },
				],
			})
		);
		const { logger, lines } = makeLogger();
		const provider = makeProvider(undefined, "test-key", undefined, { logger });

		const models = await provider.provideLanguageModelChatInformation(
			{ silent: true, configuration: { baseUrl: TEST_BASE_URL, apiKey: "test-key", label: "Default" } } as {
				silent: boolean;
			},
			new vscode.CancellationTokenSource().token
		);

		assert.deepStrictEqual(
			models.map((model) => model.id).sort(),
			[`${MARKER}-deployment`, `${MARKER}-model`],
			"the marked ids register"
		);
		for (const logged of lines) {
			assertOmits(logged, MARKER, `a log line carried a listing id: ${logged}`);
		}
		assert.deepStrictEqual(
			lines.filter((logged) => logged.includes(COUNT_LINE)),
			[
				`${COUNT_LINE}: ${JSON.stringify(
					{ modelCount: 2, entryCount: 2, deploymentModels: 1, bareModels: 1, groupModels: 0 },
					null,
					2
				)}`,
			]
		);
	});
});
