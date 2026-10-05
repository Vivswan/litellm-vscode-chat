import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import type { LiteLLMChatModelProviderOptions } from "../../../provider";
import { emptyErrorResponse, MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";
import { assertOmits, makeLogger } from "../../pureHelpers";
import { makeProvider } from "../../testUtils";

const SECRET = "sk-live-abc";
const FAILURE_LINE = "Model discovery failed for provider group";

suite("provider/catalog/groupDiscovery failure log", () => {
	useMsw();

	/**
	 * Each way a group serve fails, the level the boundary logs it at, and the whole line it logs; every response that
	 * has a body carries the token.
	 */
	const cases: {
		name: string;
		respond: () => Response;
		overrides?: Partial<LiteLLMChatModelProviderOptions>;
		level: "error" | "info";
		line: Record<string, unknown>;
	}[] = [
		{
			name: "an HTTP 500 whose body carries the token",
			// The SDK obeys x-should-retry, so it reads this body instead of cancelling it for a retry; see
			// emptyErrorResponse for why a retried msw body deadlocks.
			respond: () =>
				HttpResponse.json({ error: { message: SECRET } }, { status: 500, headers: { "x-should-retry": "false" } }),
			level: "error",
			line: { expected: false, silent: true, kind: "http", status: 500 },
		},
		{
			name: "an HTTP 401 whose body echoes the token",
			respond: () => HttpResponse.json({ error: { message: `Invalid proxy server token ${SECRET}` } }, { status: 401 }),
			level: "error",
			line: { expected: false, silent: true, kind: "auth", status: 401 },
		},
		{
			name: "a socket failure",
			respond: () => HttpResponse.error(),
			level: "error",
			line: { expected: false, silent: true, kind: "network" },
		},
		{
			name: "a non-JSON body that starts with the token",
			respond: () => HttpResponse.text(`${SECRET} upstream capacity exhausted`, { status: 200 }),
			level: "error",
			line: { expected: false, silent: true, kind: "http" },
		},
		{
			name: "a 404 the entry declares expected",
			respond: () => emptyErrorResponse(404),
			overrides: { getExpectedFailures: () => ["modelListing"] },
			level: "info",
			line: { expected: true, silent: true, kind: "http", status: 404 },
		},
	];
	for (const { name, respond, overrides, level, line } of cases) {
		test(`${name} logs its transport kind and nothing from the response`, async () => {
			mswServer.use(http.get(MODEL_INFO_URL, respond), http.get(MODELS_URL, respond));
			const { logger, lines } = makeLogger();
			const provider = makeProvider(undefined, "test-key", undefined, { logger, ...overrides });

			const models = await provider.provideLanguageModelChatInformation(
				{ silent: true, configuration: { baseUrl: TEST_BASE_URL, apiKey: "test-key", label: "Default" } } as {
					silent: boolean;
				},
				new vscode.CancellationTokenSource().token
			);

			assert.deepStrictEqual(models, [], "a silent failed serve hands out nothing");
			for (const logged of lines) {
				assertOmits(logged, SECRET, `a log line carried the response: ${logged}`);
			}
			// Every error-level line and every failure line together: one failure line per serve, at its level, and no
			// other error-level line beside it.
			assert.deepStrictEqual(
				lines.filter((logged) => logged.startsWith("ERROR: ") || logged.includes(FAILURE_LINE)),
				[`${level === "error" ? "ERROR: " : ""}${FAILURE_LINE}: ${JSON.stringify(line, null, 2)}`]
			);
		});
	}
});
