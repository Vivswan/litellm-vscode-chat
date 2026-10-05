import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { classifyOverall } from "../../../dashboard/presenters";
import type { GroupCredentialsResolution } from "../../../provider/catalog/groupModels";
import { publicErrorText } from "../../../shared/logger";
import { MirroredError } from "../../../shared/mirroredError";
import { emptyErrorResponse, MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";
import { DEFAULT_DISCOVERY_PAYLOAD, makeLogger } from "../../pureHelpers";
import { makeProvider } from "../../testUtils";

/** The unresolved-credentials failure's two log renderings: the classification (status window, issue-report buffer) and the English mirror (output channel). */
const EXPECTED_CLASSIFICATION = "EntryCredentialsUnavailable(secretsUnreadable)";
const EXPECTED_ENGLISH = "entry credentials unavailable";

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
				return { kind: "resolved", credentials: { apiKey: "sk-rotated" } };
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

	test("an external answer (no declared entry) keeps the baked credentials in force", async () => {
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ kind: "external" }),
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
				return { kind: "resolved", credentials: { apiKey: "sk-never" } };
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

	test("a declared entry whose credentials do not resolve is a classified failure, never the baked key", async () => {
		// The baked key is the copy the host stored at group creation; after a rotation it is the retired key. A
		// surviving group confirmed by the sync engine (#398) must not read connected on that key when the entry's
		// own secrets cannot be read, so the serve records the failure and sends nothing.
		const resolvers: { name: string; resolve: () => Promise<GroupCredentialsResolution> }[] = [
			{ name: "unavailable", resolve: async () => ({ kind: "unavailable", reason: "secretsUnreadable" }) },
			{
				name: "throwing",
				resolve: async () => {
					throw new Error("secret storage exploded");
				},
			},
		];
		for (const { name, resolve } of resolvers) {
			const { logger, lines } = makeLogger();
			const provider = makeProvider(undefined, "unused", undefined, { logger, resolveEntryCredentials: resolve });
			const captured = capturingDiscovery();
			const configuration = { baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" };

			const silent = await provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());
			assert.deepStrictEqual(silent, [], `${name}: a silent serve hands out nothing`);
			await assert.rejects(
				provider.provideLanguageModelChatInformation(groupOptions(configuration, false), cancellation()),
				(error: unknown) => error instanceof MirroredError && publicErrorText(error) === EXPECTED_CLASSIFICATION,
				`${name}: a non-silent serve throws the classified failure`
			);

			assert.deepStrictEqual(captured.headers, [], `${name}: no discovery request carries the baked key`);
			const statuses = provider.getServerSnapshots().map((snapshot) => snapshot.status);
			assert.strictEqual(statuses.length, 1, `${name}: the failure is recorded under the group's identity`);
			assert.strictEqual(statuses[0]?.state, "error");
			assert.strictEqual(statuses[0]?.logSafeError, EXPECTED_CLASSIFICATION, `${name}: the log rendering`);
			assert.strictEqual(statuses[0]?.servedModelCount, 0);
			assert.strictEqual(classifyOverall(statuses), "error", `${name}: the window is not connected`);
			assert.strictEqual(
				lines.filter(
					(line) => line.includes("Failed to fetch models for provider group") && line.includes(EXPECTED_ENGLISH)
				).length,
				2,
				`${name}: the facade logs each failed serve once, with the English mirror on the channel`
			);
		}
	});

	test("an expected model-listing failure does not soften an unresolved-credentials failure", async () => {
		// The declaration speaks about the listing endpoint. A non-silent serve of an entry declaring it with declared
		// models normally hands the declared set out under an expected error; a credential failure must not take
		// that route, or the window reads connected while every request fails before transport.
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ kind: "unavailable", reason: "secretsUnreadable" }),
			getExpectedFailures: () => ["modelListing"],
			getEntryDeclaredModels: () => ["declared-model"],
		});
		capturingDiscovery();

		await assert.rejects(
			provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" }, false),
				cancellation()
			),
			(error: unknown) => error instanceof MirroredError && publicErrorText(error) === EXPECTED_CLASSIFICATION
		);
		const status = provider.getServerSnapshots()[0]?.status;
		assert.strictEqual(status?.state, "error");
		assert.strictEqual(status.expected, undefined, "the failure stays unexpected");
		assert.strictEqual(status.servedModelCount, 1, "the declared model stays listed under the error");
		assert.strictEqual(classifyOverall([status]), "degraded", "serving under an unexpected error, never connected");
	});

	test("a rotation replaces the client ID in the group's one status entry: the retired ID leaves the window at once", async () => {
		// A rotated credential mints a new client ID for the SAME logical group; a
		// second entry beside the retired one double-counted the merged status and
		// rendered as a ghost external row whose Hide tombstoned the label the real
		// group serves under.
		let key = "sk-first";
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ kind: "resolved", credentials: { apiKey: key } }),
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
			resolveEntryCredentials: async () => ({ kind: "resolved", credentials: { apiKey: key } }),
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
					return { kind: "resolved", credentials: { apiKey: "sk-first" } };
				}
				return { kind: "resolved", credentials: { apiKey: "sk-second" } };
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
		// The stale anchor belongs to the group, not to the client ID: rotating
		// right before an outage must not vanish the models it was serving.
		let key = "sk-first";
		let fail = false;
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ kind: "resolved", credentials: { apiKey: key } }),
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
		assert.strictEqual(stale.length, 1, "the rotated group keeps its stale-serve anchor");
		assert.ok(stale[0]?.statusIcon !== undefined, "stale-served models carry the warning decoration");
	});

	test("the overlay replaces the credential set wholesale: a dropped OAuth unit strips the baked one", async () => {
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ kind: "resolved", credentials: { apiKey: "sk-only" } }),
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
