/**
 * The real draft probe (createDraftConnectionProbe): the connection's expected-failure flags must reach the production
 * fetchModels call, so an endpoint the draft declares expected probes with a single attempt instead of the
 * idempotent-GET retry budget - the same contract production discovery applies to declared entries.
 */
import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import { DashboardValidationError, executeDashboardIntent } from "../../../extension/dashboard/intents";
import { createDraftConnectionProbe } from "../../../extension/dashboard/testDraftConnection";
import { RequestError } from "../../../provider/transport/errorMapping";
import { KnownSecrets } from "../../../shared/util/knownSecrets";
import { emptyErrorResponse, MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";
import { KEEP_ALL, makeEnv, serverPayload } from "./recordedEnv";

const USER_AGENT = "litellm-vscode-chat/0.0.0-test VSCode/test";
const TOKEN_URL = "http://idp.test/tenants/draft-secret-Q7/token";

suite("extension/dashboard/testDraftConnection", () => {
	useMsw();

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
		const probe = createDraftConnectionProbe(USER_AGENT, new KnownSecrets());

		await assert.rejects(
			probe({
				baseUrl: TEST_BASE_URL,
				apiKey: "",
				expected: { modelInfo: true, modelListing: true },
			}),
			(error: unknown) => error instanceof RequestError
		);

		// A 500 is retryable, so anything above one attempt per endpoint means the expected flags were dropped on the
		// way to discovery.
		assert.strictEqual(infoAttempts, 1, "expected modelInfo must disable the retry budget");
		assert.strictEqual(modelsAttempts, 1, "expected modelListing must disable the retry budget");
	});

	test("the draft's credentials are known values for exactly the probe's lifetime", async () => {
		// A key typed into the form and not yet saved was unknown to the set, so a discovery 403 quoting it rendered in
		// the dashboard as "LiteLLM 403: key draft-key-Q7 is not allowed at https://host.test/v1".
		const known = new KnownSecrets();
		known.set(["configured-Q7"]);
		const seen: string[] = [];
		mswServer.use(
			http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
			http.get(MODELS_URL, () => {
				seen.push(known.redact("key draft-key-Q7, header hdr-token-Q7, token draft-tok-Q7, pw pw-Q7"));
				return HttpResponse.json({ error: "key draft-key-Q7 is not allowed" }, { status: 403 });
			}),
			http.post(TOKEN_URL, () => HttpResponse.json({ access_token: "draft-tok-Q7", expires_in: 3600 }))
		);
		const probe = createDraftConnectionProbe(USER_AGENT, known);

		await assert.rejects(
			probe({
				baseUrl: "http://litellm.test",
				apiKey: "draft-key-Q7",
				headers: { "X-Team-Token": "hdr-token-Q7" },
				oauth: { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "draft-secret-Q7" },
				expected: { modelInfo: true, modelListing: false },
			}),
			(error: unknown) => error instanceof RequestError && error.kind === "http" && error.status === 403
		);

		assert.deepStrictEqual(seen, ["key [redacted], header [redacted], token [redacted], pw pw-Q7"]);
		assert.deepStrictEqual(known.values(), ["configured-Q7"], "the probe's values and its token leave with it");
	});

	test("the failure the dashboard renders is redacted while the probe still holds the draft's key", async () => {
		// Reproduced: 'HTTP 403: "key draft-key-Q7 is not allowed"' reached the dashboard verbatim when the probe retired
		// its holds before the forwarded message was rendered.
		const known = new KnownSecrets();
		mswServer.use(
			http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
			http.get(MODELS_URL, () => HttpResponse.json({ error: "key draft-key-Q7 is not allowed" }, { status: 403 }))
		);
		const recorded = makeEnv([]);
		const env = { ...recorded.env, probeDraftConnection: createDraftConnectionProbe(USER_AGENT, known) };

		await assert.rejects(
			executeDashboardIntent(
				{
					method: "testServerDraft",
					payload: {
						server: serverPayload({ label: "Draft", baseUrl: TEST_BASE_URL, expectedFailures: ["modelInfo"] }),
						secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "settings", value: "draft-key-Q7" } },
					},
				},
				env
			),
			(error: unknown) => {
				assert.ok(error instanceof DashboardValidationError);
				assert.strictEqual(
					error.message,
					'The server refused the model-list request.\nHTTP 403: "key [redacted] is not allowed"'
				);
				assert.deepStrictEqual(error.classification, { kind: "http", status: 403 });
				return true;
			}
		);
		assert.deepStrictEqual(known.values(), []);
	});

	test("the OAuth detail of a draft probe cuts the draft's client secret from the token URL's path", async () => {
		// An unsaved draft's secret is in no configured set; the URL cut alone showed it in the path.
		const known = new KnownSecrets();
		mswServer.use(http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_client" }, { status: 401 })));
		const probe = createDraftConnectionProbe(USER_AGENT, known);

		await assert.rejects(
			probe({
				baseUrl: TEST_BASE_URL,
				apiKey: "",
				oauth: { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "draft-secret-Q7" },
			}),
			(error: unknown) =>
				error instanceof RequestError &&
				error.message.split("\n")[1] === "OAuth 401 at http://idp.test/tenants/[redacted]/token: invalid_client"
		);

		assert.deepStrictEqual(known.values(), []);
	});
});
