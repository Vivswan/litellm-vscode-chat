import * as assert from "node:assert";
import * as vscode from "vscode";
import { STACK_DEFAULTS } from "./envFile";
import { FALLBACK_TEXT } from "./fakeStack/commands";
import { PLAYBACK_MODEL } from "./fakeStack/models";
import { assertIdsUnserved, uniqueName } from "./groupApiHelpers";
import { catalogOff, collectStream, ensureActivated, extractText, waitForHostModels } from "./hostApiHelpers";
import { expectDefined } from "./pureHelpers";

const BASE_URL = process.env.LITELLM_DOCKER_BASE_URL || "";
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || STACK_DEFAULTS.LITELLM_MASTER_KEY;

/**
 * Provider-group chat path, in its own extension host (the docker-group-path
 * label): the host's provider-group command is add-only, so the group created
 * here serves models until the host exits, and no other docker suite could
 * share this host. This suite pins the VS Code-managed provider-group path
 * end to end against a proxy that REQUIRES the master key: group creation
 * through the host command IN THE NATIVE-EDITOR SHAPE (no `label` in the
 * configuration - every other suite goes through the declarative sync chain,
 * whose engine stamps one), model resolution through the per-group provider
 * call, and a chat whose credentials ride the model's litellm metadata across
 * the host round trip. A chat that loses the group credentials anywhere along
 * that path fails here (as a 401 if the key is dropped from the request, or
 * as a routing error if the metadata is stripped).
 */
suite("Docker provider-group chat path", () => {
	if (!BASE_URL) {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL not set; run via `bun run test:docker`", () => {});
		return;
	}

	suiteSetup(async function () {
		this.timeout(90000);
		await ensureActivated();
		await catalogOff();
		// The playback alias is a fixed stack id; a leftover group in a recycled
		// user-data directory would be indistinguishable from this one, so fail
		// fast before adding the group.
		await assertIdsUnserved([PLAYBACK_MODEL.alias]);
		await vscode.commands.executeCommand("lm.addLanguageModelsProviderGroup", {
			name: uniqueName("Docker Group Path"),
			vendor: "litellm",
			baseUrl: BASE_URL,
			apiKey: API_KEY,
		});
	});

	test("a group model chats with the group's own credentials", async function () {
		this.timeout(60000);
		const models = await waitForHostModels(
			60000,
			(candidates) => candidates.some((m) => m.id === PLAYBACK_MODEL.alias),
			`the provider group to expose ${PLAYBACK_MODEL.alias}`
		);
		const model = expectDefined(models.find((m) => m.id === PLAYBACK_MODEL.alias));
		const response = await model.sendRequest(
			[vscode.LanguageModelChatMessage.User("hi")],
			{},
			new vscode.CancellationTokenSource().token
		);
		assert.strictEqual(extractText(await collectStream(response)), FALLBACK_TEXT);
	});
});
