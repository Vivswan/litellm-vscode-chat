import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { classifyOverall } from "../../../dashboard/presenters";
import { entryGroupCredentialsFor } from "../../../extension/servers/serverSync/entryCredentials";
import { readServerSecretsRecord, updateServerSecret } from "../../../extension/servers/serverSync/secrets";
import type { GroupCredentialsResolution, LiteLLMModelInfo } from "../../../provider/catalog/groupModels";
import { failureTexts } from "../../../shared/failureCause";
import { publicErrorText } from "../../../shared/logger";
import { MirroredError } from "../../../shared/mirroredError";
import type { RejectedCredentialField } from "../../../shared/serverEntry";
import { fixedHeaderValue } from "../../../shared/util/headers";
import { makeSecretStore } from "../../extension/servers/serverSyncHelpers";
import {
	CHAT_COMPLETIONS_URL,
	emptyErrorResponse,
	MODEL_INFO_URL,
	MODELS_URL,
	mswServer,
	sseTextResponse,
	TEST_BASE_URL,
	useMsw,
} from "../../mocks/handlers";
import { DEFAULT_DISCOVERY_PAYLOAD, expectDefined, makeLogger } from "../../pureHelpers";
import { makeProvider, userMessage } from "../../testUtils";

/** The unresolved-credentials failure's log rendering, in the status window and the issue report's latest error. */
const EXPECTED_CLASSIFICATION = "EntryCredentialsUnavailable(secretsUnreadable)";

/** The host passes the group configuration structurally; stable typings only declare `silent`. */
function groupOptions(configuration: unknown, silent = true): { silent: boolean } {
	return { silent, configuration } as { silent: boolean };
}

const cancellation = () => new vscode.CancellationTokenSource().token;

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
				return { kind: "resolved", credentials: { apiKey: fixedHeaderValue("sk-rotated") } };
			},
		});
		const captured = capturingDiscovery();

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" }),
			cancellation()
		);

		assert.deepStrictEqual(captured.headers, ["Bearer sk-rotated"], "discovery must carry the overlaid key");
		assert.deepStrictEqual(resolved, [["Default", TEST_BASE_URL]], "the resolver gets the group's identity");
		// The status identity follows the overlaid credentials too, so the cache, prune keep-set, and dashboard join
		// all describe what requests use.
		const snapshot = provider.getServerSnapshots()[0];
		assert.ok(snapshot !== undefined);
		assert.strictEqual(provider.getGroupServer(snapshot.status.serverId)?.apiKey, "sk-rotated");
		// What the host receives names the group and holds no credential: neither the key the host baked nor the one
		// the entry resolved to.
		const handedToHost = JSON.stringify(infos);
		assert.ok(!handedToHost.includes("sk-baked") && !handedToHost.includes("sk-rotated"), handedToHost);
		assert.strictEqual(typeof infos[0]?.litellm.group, "string", "the model names its group");
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
				return { kind: "resolved", credentials: { apiKey: fixedHeaderValue("sk-never") } };
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
			assert.deepStrictEqual(
				statuses[0]?.state === "error" ? statuses[0].cause : undefined,
				{ kind: "credentials", reason: "secretsUnreadable" },
				`${name}: the status carries the cause the overlay records`
			);
			assert.strictEqual(statuses[0]?.servedModelCount, 0);
			assert.strictEqual(classifyOverall(statuses), "error", `${name}: the window is not connected`);
			// The silent serve, then the throwing one: each logs the whole failure line once, at error level, with no
			// transport kind to name.
			assert.deepStrictEqual(
				lines.filter((line) => line.startsWith("ERROR: ")),
				[true, false].map(
					(silent) =>
						`ERROR: Model discovery failed for provider group: ${JSON.stringify(
							{ expected: false, silent, kind: "unclassified" },
							null,
							2
						)}`
				),
				`${name}: the facade's failure lines`
			);
		}
	});

	test("an expected model-listing failure does not soften an unresolved-credentials failure", async () => {
		// The declaration speaks about the listing endpoint. A credential failure hands the declared set out like any
		// failure, but under an UNEXPECTED error, or the window reads connected while every request fails before
		// transport.
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ kind: "unavailable", reason: "secretsUnreadable" }),
			getExpectedFailures: () => ["modelListing"],
			getEntryDeclaredModels: () => ["declared-model"],
		});
		const captured = capturingDiscovery();

		const served = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" }, false),
			cancellation()
		);
		assert.deepStrictEqual(
			served.map((info) => info.id),
			["declared-model"],
			"the declared model registers under the credential failure"
		);
		assert.deepStrictEqual(captured.headers, [], "no discovery request carries the baked key");
		const status = provider.getServerSnapshots()[0]?.status;
		assert.strictEqual(status?.state, "error");
		assert.strictEqual(status.logSafeError, EXPECTED_CLASSIFICATION, "the failure keeps its classification");
		assert.strictEqual(status.expected, undefined, "the failure stays unexpected");
		assert.strictEqual(status.servedModelCount, 1, "the declared model stays listed under the error");
		assert.strictEqual(classifyOverall([status]), "degraded", "serving under an unexpected error, never connected");
	});

	test("a rotation replaces the client ID in the group's one status entry: the retired ID leaves the window at once", async () => {
		// A rotated credential mints a new client ID for the SAME logical group; a
		// second entry beside the retired one double-counted the merged status and
		// rendered as a ghost external row whose Hide tombstoned the label the real
		// group serves under.
		let key = fixedHeaderValue("sk-first");
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ kind: "resolved", credentials: { apiKey: key } }),
		});
		capturingDiscovery();
		const configuration = { baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" };
		await provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());
		const firstId = provider.getServerSnapshots()[0]?.status.serverId;
		assert.ok(firstId !== undefined);

		key = fixedHeaderValue("sk-second");
		await provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());
		const snapshots = provider.getServerSnapshots();
		assert.strictEqual(snapshots.length, 1, "one logical group, one snapshot");
		assert.notStrictEqual(snapshots[0]?.status.serverId, firstId, "the rotation minted a new identity");
		assert.strictEqual(provider.getGroupServer(firstId), undefined, "the retired identity is gone");
	});

	test("a late pre-rotation discovery completion cannot clobber the rotated identity's record", async () => {
		// The old-key fetch is still in flight when the new-key serve completes; its late completion must yield the
		// record instead of restoring the retired identity (arrival order is not credential freshness).
		let key = fixedHeaderValue("sk-first");
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

		key = fixedHeaderValue("sk-second");
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
		// The generation is claimed before the overlay's secrets read: a first call stalls in the resolver, a second
		// call resolves and records the rotated identity, then the first resumes - its record must yield even though
		// its fetch would start (and finish) after the second's.
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
					return { kind: "resolved", credentials: { apiKey: fixedHeaderValue("sk-first") } };
				}
				return { kind: "resolved", credentials: { apiKey: fixedHeaderValue("sk-second") } };
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
		let key = fixedHeaderValue("sk-first");
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

		key = fixedHeaderValue("sk-second");
		fail = true;
		const stale = await provider.provideLanguageModelChatInformation(groupOptions(configuration, true), cancellation());
		assert.strictEqual(stale.length, 1, "the rotated group keeps its stale-serve anchor");
		assert.ok(stale[0]?.statusIcon !== undefined, "stale-served models carry the warning decoration");
	});

	test("the overlay replaces the credential set wholesale: a dropped OAuth unit strips the baked one", async () => {
		const provider = makeProvider(undefined, "unused", undefined, {
			resolveEntryCredentials: async () => ({ kind: "resolved", credentials: { apiKey: fixedHeaderValue("sk-only") } }),
		});
		const captured = capturingDiscovery();

		await provider.provideLanguageModelChatInformation(
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
		const served = expectDefined(provider.getServerSnapshots()[0]).status.serverId;
		assert.strictEqual(provider.getGroupServer(served)?.oauth, undefined, "the baked OAuth unit is gone");
	});

	suite("request path", () => {
		/** The Authorization header of the one chat request, or null for a request that carried none. */
		function capturingChat(): { headers: (string | null)[] } {
			const captured: { headers: (string | null)[] } = { headers: [] };
			mswServer.use(
				http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
					captured.headers.push(request.headers.get("authorization"));
					return sseTextResponse("ok");
				})
			);
			return captured;
		}

		function sendChat(provider: ReturnType<typeof makeProvider>, model: LiteLLMModelInfo): Promise<void> {
			return provider.provideLanguageModelChatResponse(
				model,
				[userMessage("hi")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				cancellation()
			);
		}

		/**
		 * The real resolver over an in-memory secret store, so the refusal is the owner's (entryCredentials.ts) and not a
		 * fixture's answer. The stored value's interior newline survives the edge trim; a keyless resolution here sent
		 * discovery and chat headerless, and the server's 401 was the first sign of it.
		 */
		const refusedCases: { field: RejectedCredentialField; kind: string; setting: unknown; value: string }[] = [
			{ field: "apiKey", kind: "API key", setting: [{ label: "Default", baseUrl: TEST_BASE_URL }], value: "sk-a\nb" },
			{
				field: "virtualKeyValue",
				kind: "virtual key",
				setting: [{ label: "Default", baseUrl: TEST_BASE_URL, auth: { virtualKey: { header: "x-vk" } } }],
				value: "vk-a\nb",
			},
		];
		for (const { field, kind, setting, value } of refusedCases) {
			test(`a stored ${field} the header rule refuses fails the serve and the request before any transport`, async () => {
				const secrets = makeSecretStore();
				await updateServerSecret(secrets, "Default", field, value, TEST_BASE_URL);
				const provider = makeProvider(undefined, "unused", undefined, {
					resolveEntryCredentials: (label, baseUrl) =>
						entryGroupCredentialsFor(
							() => setting,
							(entryLabel) => readServerSecretsRecord(secrets, entryLabel),
							label,
							baseUrl
						),
					getEntryDeclaredModels: () => ["declared-model"],
				});
				const discovery = capturingDiscovery();
				const chat = capturingChat();
				const classification = "EntryCredentialsUnavailable(credentialsRefused)";

				const served = await provider.provideLanguageModelChatInformation(
					groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" }),
					cancellation()
				);
				assert.deepStrictEqual(discovery.headers, [], "the serve sends nothing");
				assert.deepStrictEqual(
					served.map((info) => info.id),
					["declared-model"],
					"only the declared model is served, under the preflight failure"
				);
				const status = expectDefined(provider.getServerSnapshots()[0]).status;
				assert.strictEqual(status.state, "error");
				assert.strictEqual(status.logSafeError, classification, "the row and the status window carry the refusal");
				assert.deepStrictEqual(status.cause, { kind: "credentialsRefused", fields: [field] });
				const text = failureTexts(status.cause, status.baseUrl).display;
				assert.ok(text.includes(kind) && !text.includes("sk-a") && !text.includes("vk-a"), text);

				await assert.rejects(
					sendChat(provider, expectDefined(served[0])),
					(error: unknown) => error instanceof MirroredError && publicErrorText(error) === classification
				);
				assert.deepStrictEqual(chat.headers, [], "the request is refused before transport");
			});
		}

		test("a request authenticates with the entry's credentials at request time, not at serve time", async () => {
			// The model object dates from the serve; a rotation since then must reach the very next request, not wait
			// out a host re-resolve.
			let key = fixedHeaderValue("sk-first");
			const resolved: [string, string][] = [];
			const provider = makeProvider(undefined, "unused", undefined, {
				resolveEntryCredentials: async (label, baseUrl) => {
					resolved.push([label, baseUrl]);
					return { kind: "resolved", credentials: { apiKey: key } };
				},
			});
			capturingDiscovery();
			const chat = capturingChat();
			const infos = await provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" }),
				cancellation()
			);

			key = fixedHeaderValue("sk-rotated");
			await sendChat(provider, expectDefined(infos[0]));

			assert.deepStrictEqual(chat.headers, ["Bearer sk-rotated"], "the request authenticates with the current key");
			assert.deepStrictEqual(resolved, [
				["Default", TEST_BASE_URL],
				["Default", TEST_BASE_URL],
			]);
		});

		test("a serve that finishes before a newer claim records still routes the models it handed out", async () => {
			// Serve A stalls in discovery, serve B claims the next generation and stalls in the resolver, then A
			// completes first. A's models reach the host; a request with one of them must route until B's record
			// replaces A's, so A yields only to a newer RECORD, never to a newer claim.
			// Calls 1 and 2 are the serves; every request-time call answers external, so the recorded set shows which
			// record the request routed through.
			let call = 0;
			let releaseDiscovery!: () => void;
			const discoveryGate = new Promise<void>((resolve) => {
				releaseDiscovery = resolve;
			});
			let releaseResolver!: () => void;
			const resolverGate = new Promise<void>((resolve) => {
				releaseResolver = resolve;
			});
			const provider = makeProvider(undefined, "unused", undefined, {
				resolveEntryCredentials: async () => {
					const serve = ++call;
					if (serve > 2) {
						return { kind: "external" };
					}
					if (serve === 2) {
						await resolverGate;
					}
					return { kind: "resolved", credentials: { apiKey: fixedHeaderValue(`sk-${serve}`) } };
				},
			});
			mswServer.use(
				http.get(MODEL_INFO_URL, async ({ request }) => {
					if (request.headers.get("authorization") === "Bearer sk-1") {
						await discoveryGate;
					}
					return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
				})
			);
			const chat = capturingChat();
			const configuration = { baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" };
			const serveA = provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());
			const serveB = provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());

			releaseDiscovery();
			const fromA = await serveA;
			await sendChat(provider, expectDefined(fromA[0]));
			assert.deepStrictEqual(chat.headers, ["Bearer sk-1"], "A's model routes through A's record");

			releaseResolver();
			await serveB;
			assert.strictEqual(provider.getServerSnapshots().length, 1, "B's record replaced A's");
			await sendChat(provider, expectDefined(fromA[0]));
			assert.strictEqual(chat.headers.at(-1), "Bearer sk-2", "the same model now routes through B's record");
		});

		test("two labeled external groups at one URL keep their own keys: no declared owner, no shared identity", async () => {
			// Hand-labeled native groups can share a label and a URL with different keys. Nothing declarative says one
			// stands in for the other, so each model must route through its own group's recorded connection.
			const provider = makeProvider(undefined, "unused", undefined, {
				resolveEntryCredentials: async () => ({ kind: "external" }),
			});
			capturingDiscovery();
			const chat = capturingChat();
			const serveTwin = (apiKey: string) =>
				provider.provideLanguageModelChatInformation(
					groupOptions({ baseUrl: TEST_BASE_URL, apiKey, label: "Twin" }),
					cancellation()
				);
			const fromA = await serveTwin("key-a");
			const fromB = await serveTwin("key-b");
			assert.strictEqual(provider.getServerSnapshots().length, 2, "two groups, two window entries");

			await sendChat(provider, expectDefined(fromA[0]));
			await sendChat(provider, expectDefined(fromB[0]));
			assert.deepStrictEqual(chat.headers, ["Bearer key-a", "Bearer key-b"]);
		});

		test("a base URL with userinfo never hands its password to the host, labeled or not", async () => {
			// The identity rides the model object and the status identity rides the dashboard; both are built on the
			// credential-free URL. Discovery at such a URL may fail; the declared model is served either way.
			const cases = [
				{
					name: "entry-owned",
					configuration: { baseUrl: "https://user:pass@vault.test/v1", apiKey: "k", label: "Vault" },
				},
				{ name: "unlabeled", configuration: { baseUrl: "https://user:pass@vault.test/v1", apiKey: "k" } },
			];
			for (const { name, configuration } of cases) {
				const provider = makeProvider(undefined, "unused", undefined, {
					resolveEntryCredentials: async () => ({ kind: "resolved", credentials: { apiKey: fixedHeaderValue("k") } }),
					getEntryDeclaredModels: () => ["declared-model"],
				});
				mswServer.use(
					http.get("https://vault.test/v1/model/info", () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)),
					http.get("https://vault.test/v1/models", () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
				);
				const infos = await provider.provideLanguageModelChatInformation(groupOptions(configuration), cancellation());
				assert.ok(infos.length > 0, `${name}: the declared model is served`);
				const handedToHost = JSON.stringify(infos);
				assert.ok(!handedToHost.includes("pass"), `${name}: ${handedToHost}`);
				const serverId = expectDefined(provider.getServerSnapshots()[0]).status.serverId;
				assert.ok(!serverId.includes("pass"), `${name}: the status identity ${serverId}`);
			}
		});

		test("an external answer sends the recorded credentials; an unresolved entry fails before any request", async () => {
			// The recorded set is the serve-time copy a rotation may have retired, so a declared entry whose credentials
			// cannot be resolved (or a resolver that throws) must fail the request instead of sending it (#398).
			const cases: { name: string; answer: () => Promise<GroupCredentialsResolution>; sent: boolean }[] = [
				{ name: "external", answer: async () => ({ kind: "external" }), sent: true },
				{
					name: "unavailable",
					answer: async () => ({ kind: "unavailable", reason: "secretsMismatched" }),
					sent: false,
				},
				{
					name: "throwing",
					answer: async () => {
						throw new Error("secret storage exploded");
					},
					sent: false,
				},
			];
			for (const { name, answer, sent } of cases) {
				// The serve resolves, so the group records and the model exists; the request then gets `answer`.
				let answerRequests = false;
				const provider = makeProvider(undefined, "unused", undefined, {
					resolveEntryCredentials: () =>
						answerRequests
							? answer()
							: Promise.resolve({ kind: "resolved", credentials: { apiKey: fixedHeaderValue("sk-served") } }),
				});
				capturingDiscovery();
				const chat = capturingChat();
				const infos = await provider.provideLanguageModelChatInformation(
					groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "sk-baked", label: "Default" }),
					cancellation()
				);
				answerRequests = true;

				const send = sendChat(provider, expectDefined(infos[0]));
				if (sent) {
					await send;
					assert.deepStrictEqual(chat.headers, ["Bearer sk-served"], `${name}: the recorded key is the request's`);
					continue;
				}
				await assert.rejects(
					send,
					(error: unknown) =>
						error instanceof MirroredError &&
						publicErrorText(error) ===
							`EntryCredentialsUnavailable(${name === "throwing" ? "secretsUnreadable" : "secretsMismatched"})`,
					`${name}: the classified failure`
				);
				assert.deepStrictEqual(chat.headers, [], `${name}: no request left with the recorded key`);
			}
		});
	});
});
