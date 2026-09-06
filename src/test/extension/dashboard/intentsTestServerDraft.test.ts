/**
 * executeDashboardIntent's testServerDraft: the draft probe's inputs, outcomes, and secret handling.
 */
import * as assert from "node:assert";
import type { RequestPayload } from "../../../dashboard/endpoints";
import type { IntentAckNotice } from "../../../extension/dashboard/intents";
import {
	DashboardValidationError,
	executeDashboardIntent,
	validateTestServerDraft,
} from "../../../extension/dashboard/intents";
import { RequestError } from "../../../provider/transport/errorMapping";
import { displayedReplace, KEEP_ALL, makeEnv, type RecordedEnv, replaceIdentity, serverPayload } from "./recordedEnv";

suite("extension/dashboard/intents: testServerDraft", () => {
	suite("executeDashboardIntent: testServerDraft", () => {
		// Every probe carries the draft's expectedFailures in discovery's
		// per-endpoint shape, so expected endpoints probe with a single
		// attempt like production; a draft without any declares both false.
		const NO_EXPECTED = { modelInfo: false, modelListing: false };
		const draftTest = (
			recorded: RecordedEnv,
			partial: Partial<RequestPayload<"testServerDraft">> = {}
		): Promise<IntentAckNotice | undefined> =>
			executeDashboardIntent(
				{
					method: "testServerDraft",
					payload: {
						server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
						secrets: KEEP_ALL,
						...partial,
					},
				},
				recorded.env
			);

		test("validateTestServerDraft: connection rules apply, label rules do not", () => {
			// The probe cares about the connection only: an empty or reserved
			// label must not block it (the button gates on the base URL alone).
			assert.strictEqual(
				validateTestServerDraft(serverPayload({ label: "", baseUrl: "http://x" }), KEEP_ALL),
				undefined
			);
			assert.strictEqual(
				validateTestServerDraft(serverPayload({ label: "__proto__", baseUrl: "http://x" }), KEEP_ALL),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft(serverPayload({ label: "Prod", baseUrl: "" }), KEEP_ALL),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft(serverPayload({ label: "Prod", baseUrl: "not a url" }), KEEP_ALL),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft(
					serverPayload({ label: "Prod", baseUrl: "http://x", oauthTokenUrl: "idp.test/token" }),
					KEEP_ALL
				),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft(
					serverPayload({ label: "Prod", baseUrl: "http://x", virtualKeyHeader: "bad header" }),
					KEEP_ALL
				),
				undefined
			);
			assert.notStrictEqual(
				validateTestServerDraft(serverPayload({ label: "Prod", baseUrl: "http://x" }), {
					...KEEP_ALL,
					apiKey: { action: "set", location: "secure", value: "" },
				}),
				undefined,
				"an empty set-value must be a clear, not a set"
			);
			const problem = validateTestServerDraft(serverPayload({ label: "Prod", baseUrl: "http://x" }), {
				...KEEP_ALL,
				virtualKeyValue: { action: "set", location: "secure", value: "vk-secret\n" },
			});
			assert.ok(problem !== undefined);
			assert.ok(!problem.includes("vk-secret"), problem);
		});

		test("a set directive probes the typed value; nothing is written, stored, or synced", async () => {
			const recorded = makeEnv([]);
			const notice = await draftTest(recorded, {
				secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-draft" } },
			});

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiKey: "sk-draft", expected: NO_EXPECTED },
			]);
			// Zero models is the shared zero-model warning, never a green success.
			assert.deepStrictEqual(notice, {
				message: "Connected - 0 models. The server answered but listed no models.",
				tone: "warning",
			});
			// The no-mutation contract: a probe leaves every store untouched.
			assert.deepStrictEqual(recorded.serverWrites, []);
			assert.deepStrictEqual(recorded.secretOps, []);
			assert.deepStrictEqual(recorded.updates, []);
			assert.strictEqual(recorded.syncRequests, 0);
		});

		test("the draft's apiVersion override rides the probe connection trimmed; auto stays absent", async () => {
			const custom = makeEnv([]);
			await draftTest(custom, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", apiVersion: " v2 " }),
			});
			assert.deepStrictEqual(custom.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiVersion: "v2", apiKey: "", expected: NO_EXPECTED },
			]);

			// "" is a real override (append nothing) and must reach the probe.
			const none = makeEnv([]);
			await draftTest(none, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", apiVersion: "" }),
			});
			assert.strictEqual(none.probes[0]?.apiVersion, "");
			assert.ok(none.probes[0] !== undefined && "apiVersion" in none.probes[0]);

			const auto = makeEnv([]);
			await draftTest(auto);
			assert.ok(auto.probes[0] !== undefined && !("apiVersion" in auto.probes[0]), "auto probes the auto rule");
		});

		test("the success notice is static classification plus count, singular and plural", async () => {
			const recorded = makeEnv([]);
			recorded.probeResult = ["m1"];
			assert.strictEqual(await draftTest(recorded), "Connected - 1 model");
			recorded.probeResult = Array.from({ length: 12 }, (_, index) => `m${index}`);
			assert.strictEqual(await draftTest(recorded), "Connected - 12 models");
		});

		test("the draft's declared models join the count when not discovered; discovered ones stay inert", async () => {
			// The probe reports what a save would produce: the payload's declared
			// list. The stored entry's conflicting list pins payload-wins - it must
			// not leak into the count.
			const recorded = makeEnv([
				{ label: "Prod", baseUrl: "http://prod.test", discovery: { declared: ["stored-only"] } },
			]);
			recorded.probeResult = ["gpt-4"];
			const notice = await draftTest(recorded, {
				server: serverPayload({
					label: "Prod",
					baseUrl: "http://prod.test",
					declaredModels: ["my-model", "gpt-4"],
				}),
				replace: await displayedReplace(recorded, "Prod"),
			});
			// gpt-4 is discovered, so its declaration is inert; my-model adds one.
			assert.strictEqual(notice, "Connected - 2 models (1 declared)");
		});

		test("a lone declared model on an empty discovery keeps the singular reading", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.probeResult = [];
			const notice = await draftTest(recorded, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", declaredModels: ["my-model"] }),
				replace: await displayedReplace(recorded, "Prod"),
			});
			assert.strictEqual(notice, "Connected - 1 model (declared)");
		});

		test("the probe carries the draft's custom headers, exactly what a save would write", async () => {
			// A gateway requiring a header must not report a false probe failure for
			// a configuration that works once saved. The stored entry's conflicting
			// record pins payload-wins: the probe sends the draft's value.
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", headers: { "x-cf-access": "stale" } }]);
			recorded.probeResult = ["m1"];
			await draftTest(recorded, {
				server: serverPayload({
					label: "Prod",
					baseUrl: "http://prod.test",
					headers: { "x-cf-access": "token-1" },
				}),
				replace: await displayedReplace(recorded, "Prod"),
			});
			assert.deepStrictEqual(recorded.probes[0]?.headers, { "x-cf-access": "token-1" });
		});

		test("an expected modelListing failure reports the declared models instead of failing", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.probeError = new RequestError("404 page not found", "http", {
				status: 404,
				englishMessage: "404 page not found",
			});
			const notice = await draftTest(recorded, {
				server: serverPayload({
					label: "Prod",
					baseUrl: "http://prod.test",
					declaredModels: ["my-model"],
					expectedFailures: ["modelListing"],
				}),
				replace: await displayedReplace(recorded, "Prod"),
			});
			assert.strictEqual(notice, "Discovery failed (expected) - serving 1 declared model");
			// The draft's expectedFailures reach the probe in discovery's
			// per-endpoint shape, so an expected endpoint gets a single attempt.
			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiKey: "", expected: { modelInfo: false, modelListing: true } },
			]);
		});

		test("an expected modelListing failure with nothing declared warns: the needs-declare state, not a pass", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new RequestError("404 page not found", "http", {
				status: 404,
				englishMessage: "404 page not found",
			});
			const notice = await draftTest(recorded, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", expectedFailures: ["modelListing"] }),
			});
			assert.deepStrictEqual(notice, {
				message: "Discovery failed (expected) and no models are declared. Add model IDs to Declared models.",
				tone: "warning",
			});
		});

		test("a failure outside the expected categories still fails the intent", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new RequestError("404 page not found", "http", {
				status: 404,
				englishMessage: "404 page not found",
			});
			await assert.rejects(
				() =>
					draftTest(recorded, {
						server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", expectedFailures: ["modelInfo"] }),
					}),
				(error: unknown) => error instanceof DashboardValidationError
			);
		});

		test("keep while editing resolves inline from the accepted entry and secure from the stored blob", async () => {
			// Inline wins over a secure copy for apiKey (the sync engine's rule);
			// the OAuth client secret has no inline value and comes from storage.
			const recorded = makeEnv([
				{ label: "Shadow", auth: { apiKey: "sk-shadow" } },
				{
					label: "Prod",
					baseUrl: "http://old.test",
					auth: { oauth: { tokenUrl: "http://idp.test/token", clientId: "client-1", apiKey: "sk-inline" } },
				},
			]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-stale-secure", oauthClientSecret: "oa-secret" });
			await draftTest(recorded, {
				server: serverPayload({
					label: "Prod",
					baseUrl: "http://new.test",
					oauthTokenUrl: "http://idp.test/token",
					oauthClientId: "client-1",
					oauthScopes: "read write",
				}),
				replace: await displayedReplace(recorded, "Prod"),
			});

			assert.deepStrictEqual(recorded.probes, [
				{
					baseUrl: "http://new.test",
					label: "Prod",
					apiKey: "sk-inline",
					oauth: {
						tokenUrl: "http://idp.test/token",
						clientId: "client-1",
						clientSecret: "oa-secret",
						scopes: "read write",
					},
					expected: NO_EXPECTED,
				},
			]);
		});

		test("a fresh label ignores an orphan secure blob: keep on a create resolves nothing, exactly as a save would", async () => {
			// The form showed no stored credential (a create's fields all read
			// "none"), so the probe must not authenticate with a removed label's
			// leftover blob.
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-orphan" });
			await draftTest(recorded);

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiKey: "", expected: NO_EXPECTED },
			]);
		});

		test("an orphan OAuth or virtual-key blob does not block a create's test-connection", async () => {
			// An orphan resolving into the pairing check would refuse the probe on
			// fields the create form does not render.
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Prod", { oauthClientSecret: "cs-orphan", virtualKeyValue: "vk-orphan" });
			await draftTest(recorded);

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiKey: "", expected: NO_EXPECTED },
			]);
		});

		test("the add form over a taken label probes credential-less: no replace identity, nothing resolves", async () => {
			// The add form never names an entry to replace, so neither the entry's
			// inline key nor the label's stored blob may be probed against the newly
			// typed base URL - the save writes the same credential-less entry.
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://old.test", auth: { apiKey: "sk-inline-old" } }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-stored-old" });
			await draftTest(recorded, { server: serverPayload({ label: "Prod", baseUrl: "http://new.test" }) });

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://new.test", label: "Prod", apiKey: "", expected: NO_EXPECTED },
			]);
		});

		test("a rename draft's keep resolves the source entry alone, never the new label's orphan blob", async () => {
			// The edit form showed "Old", which holds nothing, so the retired
			// label's leftover under the typed new label must not ride the probe -
			// the same rule the save applies when it wipes that blob.
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("New", { apiKey: "sk-orphan" });
			await draftTest(recorded, {
				server: serverPayload({ label: "New", baseUrl: "http://prod.test" }),
				replace: await displayedReplace(recorded, "Old"),
			});

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "New", apiKey: "", expected: NO_EXPECTED },
			]);
		});

		test("clear probes without the credential even when one is stored", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-inline" }]);
			await draftTest(recorded, {
				secrets: { ...KEEP_ALL, apiKey: { action: "clear" } },
				replace: await displayedReplace(recorded, "Prod"),
			});

			assert.deepStrictEqual(recorded.probes, [
				{ baseUrl: "http://prod.test", label: "Prod", apiKey: "", expected: NO_EXPECTED },
			]);
			assert.deepStrictEqual(recorded.secretOps, [], "clear on a test deletes nothing");
		});

		test("the virtual key pair rides the probe; partial pairs are refused before it", async () => {
			const recorded = makeEnv([]);
			await draftTest(recorded, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" }),
				secrets: { ...KEEP_ALL, virtualKeyValue: { action: "set", location: "secure", value: "vk-1" } },
			});
			assert.deepStrictEqual(recorded.probes, [
				{
					baseUrl: "http://prod.test",
					label: "Prod",
					apiKey: "",
					virtualKey: { header: "x-vk", value: "vk-1" },
					expected: NO_EXPECTED,
				},
			]);

			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" }),
				}),
				/virtualKeyValue/
			);
			await assert.rejects(
				draftTest(recorded, {
					secrets: { ...KEEP_ALL, virtualKeyValue: { action: "set", location: "secure", value: "vk-1" } },
				}),
				/virtualKeyHeader/
			);
			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", oauthClientId: "client-1" }),
				}),
				/oauthTokenUrl/
			);
			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", oauthTokenUrl: "http://idp.test/token" }),
				}),
				/oauthClientId/
			);
			assert.strictEqual(recorded.probes.length, 1, "refused pairings never reach the probe");
		});

		test("an unusable base URL is refused before the probe runs", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(
				draftTest(recorded, { server: serverPayload({ label: "Prod", baseUrl: "not a url" }) }),
				/baseUrl/
			);
			assert.deepStrictEqual(recorded.probes, []);
		});

		test("editing an entry that vanished is refused like the save path", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(
				draftTest(recorded, { replace: replaceIdentity("Gone", "http://gone.test") }),
				/no longer exists/
			);
			assert.deepStrictEqual(recorded.probes, []);
		});

		test("a probe for an entry swapped underneath the form is refused before any network call", async () => {
			// The form displayed Prod at old.test with no credentials; another
			// window replaced the entry with one at old.test carrying an inline
			// key. A label-only lookup would resolve THAT key for "keep" and send
			// it wherever the draft's base URL points; the identity refuses first.
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://old.test", auth: { apiKey: "sk-swapped-in" } }]);
			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({ label: "Prod", baseUrl: "http://old.test" }),
					replace: replaceIdentity("Prod", "http://old.test"),
				}),
				/changed in the servers setting/
			);
			assert.deepStrictEqual(recorded.probes, [], "the swapped entry's credential never rides a probe");
		});

		test("a probe whose entry's OAuth destination changed is refused before the token exchange", async () => {
			// Same label, base URL, and locations, but the stored client secret
			// now belongs to another token URL; probing would exchange it at the
			// endpoint the stale form displays.
			const recorded = makeEnv([
				{
					label: "Prod",
					baseUrl: "http://prod.test",
					auth: { oauth: { tokenUrl: "https://idp-b.test/token", clientId: "c1" } },
				},
			]);
			recorded.storedSecrets.set("Prod", { oauthClientSecret: "cs-for-idp-b" });
			const displayed = {
				...(await displayedReplace(recorded, "Prod")),
				oauthTokenUrl: "https://idp-a.test/token",
			};
			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({
						label: "Prod",
						baseUrl: "http://prod.test",
						oauthTokenUrl: "https://idp-a.test/token",
						oauthClientId: "c1",
					}),
					replace: displayed,
				}),
				/changed in the servers setting/
			);
			assert.deepStrictEqual(recorded.probes, [], "the rotated secret never rides toward the stale endpoint");
		});

		test("a probe for a re-pointed label is refused: the displayed host is not the entry's host anymore", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://moved.test" }]);
			await assert.rejects(
				draftTest(recorded, {
					server: serverPayload({ label: "Prod", baseUrl: "http://old.test" }),
					replace: replaceIdentity("Prod", "http://old.test"),
				}),
				/changed in the servers setting/
			);
			assert.deepStrictEqual(recorded.probes, []);
		});

		test("a transport RequestError surfaces its user-facing message as a validation failure, unlogged", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new RequestError("Network Error: Unable to reach the LiteLLM server", "network", {
				englishMessage: "Network Error: Unable to reach the LiteLLM server",
			});
			await assert.rejects(draftTest(recorded), (error: unknown) => {
				assert.ok(error instanceof Error);
				assert.strictEqual(error.name, "DashboardValidationError");
				assert.strictEqual(error.message, "Network Error: Unable to reach the LiteLLM server");
				return true;
			});
			// Error ownership: the intent layer maps, the panel boundary logs.
			assert.deepStrictEqual(recorded.logs, []);
		});

		test("a probe RequestError's classification rides the validation error: kind, status, and setup hint", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new RequestError("the server answered 404", "http", {
				englishMessage: "the server answered 404",
				status: 404,
				setupHint: "check-base-url",
			});
			await assert.rejects(draftTest(recorded), (error: unknown) => {
				assert.ok(error instanceof DashboardValidationError);
				assert.deepStrictEqual(error.classification, { kind: "http", status: 404, setupHint: "check-base-url" });
				return true;
			});
		});

		test("a non-transport validation refusal carries no classification", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(
				draftTest(recorded, { server: serverPayload({ label: "Prod", baseUrl: "not a url" }) }),
				(error: unknown) => {
					assert.ok(error instanceof DashboardValidationError);
					assert.strictEqual(error.classification, undefined);
					return true;
				}
			);
		});

		test("an unexpected non-transport error is rethrown as-is for the boundary's generic handling", async () => {
			const recorded = makeEnv([]);
			recorded.probeError = new TypeError("boom");
			await assert.rejects(draftTest(recorded), (error: unknown) => error instanceof TypeError);
		});
	});
});
