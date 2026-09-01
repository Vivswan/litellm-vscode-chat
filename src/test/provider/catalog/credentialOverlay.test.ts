import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { emptyErrorResponse, MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";
import { DEFAULT_DISCOVERY_PAYLOAD, makeLogger } from "../../pureHelpers";
import { makeProvider } from "../../testUtils";

/** The host passes the group configuration structurally; stable typings only declare `silent`. */
function groupOptions(configuration: unknown, silent = true): { silent: boolean } {
	return { silent, configuration } as { silent: boolean };
}

const cancellation = () => new vscode.CancellationTokenSource().token;

/** One discovery handler that records the Authorization header each fetch carried. */
function capturingDiscovery(): { headers: (string | null)[] } {
	const captured: { headers: (string | null)[] } = { headers: [] };
	mswServer.use(
		http.get(MODEL_INFO_URL, ({ request }) => {
			captured.headers.push(request.headers.get("authorization"));
			return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
		})
	);
	return captured;
}

suite("provider credential overlay", () => {
	useMsw();

	test("a labeled group's serve authenticates with the entry's current credentials, identity included", async () => {
		const resolved: [string, string][] = [];
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async (label, baseUrl) => {
				resolved.push([label, baseUrl]);
				return { apiKey: "sk-rotated" };
			},
		});
		const captured = capturingDiscovery();

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" }),
			cancellation()
		);

		assert.deepStrictEqual(captured.headers, ["Bearer sk-rotated"], "discovery must carry the overlaid key");
		assert.deepStrictEqual(resolved, [["Default", TEST_BASE_URL]], "the resolver gets the group's identity");
		const server = infos[0]?.litellm?.server;
		assert.strictEqual(server?.apiKey, "sk-rotated", "the attached connection carries the overlaid key");
		// The status identity follows the overlaid credentials too, so the cache,
		// prune keep-set, and dashboard join all describe what requests use.
		const snapshot = provider.getServerSnapshots()[0];
		assert.ok(snapshot !== undefined);
		assert.strictEqual(provider.getGroupServer(snapshot.status.serverId)?.apiKey, "sk-rotated");
	});

	test("a resolver answering undefined keeps the baked credentials in force", async () => {
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => undefined,
		});
		const captured = capturingDiscovery();

		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" }),
			cancellation()
		);

		assert.deepStrictEqual(captured.headers, ["Bearer sk-baked"]);
	});

	test("an unlabeled (external) group never consults the resolver", async () => {
		let calls = 0;
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => {
				calls += 1;
				return { apiKey: "sk-never" };
			},
		});
		const captured = capturingDiscovery();

		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "sk-baked" }),
			cancellation()
		);

		assert.strictEqual(calls, 0, "external groups keep host-owned credentials");
		assert.deepStrictEqual(captured.headers, ["Bearer sk-baked"]);
	});

	test("a throwing resolver falls back to the baked credentials with one facade log", async () => {
		const { logger, lines } = makeLogger();
		const provider = makeProvider(undefined, "unused", undefined, {
			logger,
			resolveEntryCredentials: async () => {
				throw new Error("secret storage exploded");
			},
		});
		const captured = capturingDiscovery();

		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" }),
			cancellation()
		);

		assert.deepStrictEqual(captured.headers, ["Bearer sk-baked"]);
		assert.strictEqual(
			lines.filter((line) => line.includes("Resolving a declared entry's credentials failed")).length,
			1,
			"the facade logs the failure exactly once"
		);
	});

	test("a rotation evicts the group's retired status identity instead of leaving a ghost twin", async () => {
		// A rotated credential mints a new client ID for the SAME logical group;
		// the old identity must leave the window at once, or it double-counts the
		// merged status and renders as a ghost external row whose Hide would
		// tombstone the label the real group serves under.
		let key = "sk-first";
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ apiKey: key }),
		});
		capturingDiscovery();
		const configuration = { baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" };
		await provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());
		const firstId = provider.getServerSnapshots()[0]?.status.serverId;
		assert.ok(firstId !== undefined);

		key = "sk-second";
		await provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());
		const snapshots = provider.getServerSnapshots();
		assert.strictEqual(snapshots.length, 1, "one logical group, one snapshot");
		assert.notStrictEqual(snapshots[0]?.status.serverId, firstId, "the rotation minted a new identity");
		assert.strictEqual(provider.getGroupServer(firstId), undefined, "the retired identity is gone");
	});

	test("a late pre-rotation discovery completion cannot clobber the rotated identity's record", async () => {
		// The old-key fetch is still in flight when the new-key serve completes;
		// its late completion must yield the record instead of restoring the
		// retired identity (arrival order is not credential freshness).
		let key = "sk-first";
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ apiKey: key }),
		});
		mswServer.use(
			http.get(MODEL_INFO_URL, async ({ request }) => {
				if (request.headers.get("authorization") === "Bearer sk-first") {
					await firstGate;
				}
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			})
		);
		const configuration = { baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" };
		const firstServe = provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());

		key = "sk-second";
		await provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());
		const rotatedId = provider.getServerSnapshots()[0]?.status.serverId;
		assert.ok(rotatedId !== undefined);

		releaseFirst();
		await firstServe;
		const snapshots = provider.getServerSnapshots();
		assert.strictEqual(snapshots.length, 1, "the late completion recorded nothing");
		assert.strictEqual(snapshots[0]?.status.serverId, rotatedId, "the rotated identity's record survives");
		assert.strictEqual(provider.getGroupServer(rotatedId)?.apiKey, "sk-second");
	});

	test("a serve stalled in the RESOLVER cannot stamp itself current after a newer serve recorded", async () => {
		// The generation is claimed before the overlay's secrets read: a first
		// call stalls in the resolver, a second call resolves and records the
		// rotated identity, then the first resumes - its record must yield even
		// though its fetch would start (and finish) after the second's.
		let call = 0;
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => {
				call += 1;
				if (call === 1) {
					await firstGate;
					return { apiKey: "sk-first" };
				}
				return { apiKey: "sk-second" };
			},
		});
		capturingDiscovery();
		const configuration = { baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" };
		const firstServe = provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());

		await provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());
		const rotatedId = provider.getServerSnapshots()[0]?.status.serverId;
		assert.ok(rotatedId !== undefined);

		releaseFirst();
		await firstServe;
		const snapshots = provider.getServerSnapshots();
		assert.strictEqual(snapshots.length, 1, "the stalled serve recorded nothing");
		assert.strictEqual(snapshots[0]?.status.serverId, rotatedId, "the rotated identity's record survives");
		assert.strictEqual(provider.getGroupServer(rotatedId)?.apiKey, "sk-second");
	});

	test("a rotation carries the stale-serve anchor: a failed silent refresh still serves last-known models", async () => {
		// The evicted twin's last success is the same logical group's; without
		// the carry, rotating right before an outage would vanish the models
		// instead of stale-serving them.
		let key = "sk-first";
		let fail = false;
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ apiKey: key }),
		});
		mswServer.use(
			http.get(MODEL_INFO_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))),
			http.get(MODELS_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)))
		);
		const configuration = { baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" };
		const healthy = await provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());
		assert.strictEqual(healthy.length, 1);

		key = "sk-second";
		fail = true;
		const stale = await provider.provideLanguageModelChatInformation(groupOptions(configuration, true), cancellation());
		assert.strictEqual(stale.length, 1, "the rotated identity inherits the twin's stale-serve anchor");
		assert.ok(stale[0]?.statusIcon !== undefined, "stale-served models carry the warning decoration");
	});

	test("the overlay replaces the credential set wholesale: a dropped OAuth unit strips the baked one", async () => {
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ apiKey: "sk-only" }),
		});
		const captured = capturingDiscovery();

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({
				baseUrl: TEST_BASE_URL,
				apiKey: "sk-baked",
				label: "Default",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "cid",
				oauthClientSecret: "shh",
			}),
			cancellation()
		);

		assert.deepStrictEqual(captured.headers, ["Bearer sk-only"], "no OAuth exchange rides a dropped unit");
		assert.strictEqual(infos[0]?.litellm?.server?.oauth, undefined, "the baked OAuth unit is gone");
	});
});
