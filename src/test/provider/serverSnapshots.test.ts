import * as assert from "node:assert";
import { http } from "msw";
import * as vscode from "vscode";
import {
	discoveryHandlers,
	emptyErrorResponse,
	MODEL_INFO_URL,
	MODELS_URL,
	mswServer,
	useMsw,
} from "../mocks/handlers";
import { DEFAULT_DISCOVERY_PAYLOAD, expectDefined, makeProvider } from "../testUtils";

/** The host passes the group configuration structurally; stable typings only declare `silent`. */
function groupOptions(configuration: unknown, silent = true): { silent: boolean } {
	return { silent, configuration } as { silent: boolean };
}

const cancellation = () => new vscode.CancellationTokenSource().token;

suite("provider server snapshots", () => {
	useMsw();

	test("a registry sweep records each server's status together with its built models", async () => {
		const provider = makeProvider("http://litellm.test");
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));

		await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());

		const snapshots = provider.getServerSnapshots();
		assert.strictEqual(snapshots.length, 1);
		const snapshot = expectDefined(snapshots[0]);
		assert.strictEqual(snapshot.status.state, "ok");
		assert.strictEqual(snapshot.status.modelCount, 1);
		assert.strictEqual(snapshot.models.length, 1);
		assert.strictEqual(expectDefined(snapshot.models[0]).id, "test-model");
	});

	test("a group refresh records the group's models without attaching the server credentials", async () => {
		const provider = makeProvider();
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));

		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: "http://litellm.test", apiKey: "group-secret" }),
			cancellation()
		);

		const snapshots = provider.getServerSnapshots();
		assert.strictEqual(snapshots.length, 1);
		const snapshot = expectDefined(snapshots[0]);
		assert.strictEqual(snapshot.status.state, "ok");
		const model = expectDefined(snapshot.models[0]);
		assert.strictEqual(model.id, "test-model");
		assert.strictEqual(model.litellm.server, undefined, "snapshot models must stay credential-free");
		assert.ok(!JSON.stringify(snapshots).includes("group-secret"), "no credential may leak into the snapshot");
	});

	test("a failing group refresh records an error status with no models", async () => {
		const provider = makeProvider();
		mswServer.use(
			http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
			http.get(MODELS_URL, () => emptyErrorResponse(404))
		);

		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: "http://litellm.test", apiKey: "k" }),
			cancellation()
		);

		const snapshots = provider.getServerSnapshots();
		const snapshot = expectDefined(snapshots[0]);
		assert.strictEqual(snapshot.status.state, "error");
		assert.deepStrictEqual(snapshot.models, []);
	});

	test("a cached group refresh still records the models", async () => {
		const provider = makeProvider();
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));
		const configuration = groupOptions({ baseUrl: "http://litellm.test", apiKey: "k" });

		await provider.provideLanguageModelChatInformation(configuration, cancellation());
		// Second refresh in the same cycle is served from the discovery cache.
		await provider.provideLanguageModelChatInformation(configuration, cancellation());

		const snapshot = expectDefined(provider.getServerSnapshots()[0]);
		assert.strictEqual(snapshot.models.length, 1);
	});
});
