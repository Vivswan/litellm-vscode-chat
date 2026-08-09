import * as assert from "node:assert";
import type { AdoptableGroupCredentials } from "../../../extension/dashboard/adopt";
import type { DashboardIntent } from "../../../extension/dashboard/intentSchema";
import {
	DashboardOperationError,
	executeDashboardIntent,
	readInlineSecretValues,
} from "../../../extension/dashboard/intents";
import type { ServerFormDraft } from "../../../extension/dashboard/serverForm";
import { applyInlinePrefill, EMPTY_SERVER_FORM, parseServerForm } from "../../../extension/dashboard/serverForm";
import { KEEP_ALL, makeEnv, type RecordedEnv, serverPayload } from "./recordedEnv";

/** The intent body a clean draft parses to; fails the test if the draft has problems. */
function parseClean(draft: ServerFormDraft, originalLabel: string) {
	const parse = parseServerForm(draft, { originalLabel });
	assert.ok(parse.ok, "the draft must parse clean");
	return parse.intent;
}

suite("extension/dashboard/intents", () => {
	suite("executeDashboardIntent", () => {
		test("setNumberSetting writes the setting key verbatim", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent({ type: "setNumberSetting", setting: "chat.timeout", value: 120000 }, recorded.env);

			assert.deepStrictEqual(recorded.updates, [["chat.timeout", 120000]]);
			assert.deepStrictEqual(recorded.commands, []);
		});

		test("setNumberSetting refuses values below the minimum without writing", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent({ type: "setNumberSetting", setting: "chat.timeout", value: 1 }, recorded.env)
			);

			assert.deepStrictEqual(recorded.updates, []);
		});

		test("setBooleanSetting writes the dotted key", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent(
				{ type: "setBooleanSetting", setting: "chat.promptCaching", value: false },
				recorded.env
			);

			assert.deepStrictEqual(recorded.updates, [["chat.promptCaching", false]]);
		});

		test("resetSetting removes the key through removeSetting, never a value write", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent({ type: "resetSetting", setting: "chat.timeout" }, recorded.env);
			await executeDashboardIntent({ type: "resetSetting", setting: "ui.maskSecretInputs" }, recorded.env);

			assert.deepStrictEqual(recorded.removals, ["chat.timeout", "ui.maskSecretInputs"]);
			assert.deepStrictEqual(recorded.updates, []);
			assert.deepStrictEqual(recorded.commands, []);
		});

		test("revealSetting executes the internal open-setting command with the bare key as its argument", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent({ type: "revealSetting", setting: "chat.timeout" }, recorded.env);
			await executeDashboardIntent({ type: "revealSetting", setting: "models.parameters" }, recorded.env);

			assert.deepStrictEqual(recorded.commands, [
				["litellm.openSettingKey", "chat.timeout"],
				["litellm.openSettingKey", "models.parameters"],
			]);
			// A jump reads; it must never write or sync anything.
			assert.deepStrictEqual(recorded.updates, []);
			assert.deepStrictEqual(recorded.removals, []);
			assert.strictEqual(recorded.syncRequests, 0);
		});

		test("setModelParameters writes the whole record", async () => {
			const recorded = makeEnv();
			const params = { "gpt-4": { temperature: 0.2 } };
			await executeDashboardIntent({ type: "setModelParameters", value: params, requestId: "r-params" }, recorded.env);

			assert.deepStrictEqual(recorded.updates, [["models.parameters", params]]);
		});

		test("record intents that fail validation write nothing", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent(
					{
						type: "setModelParameters",
						value: JSON.parse('{"__proto__": {}}') as Record<string, Record<string, unknown>>,
						requestId: "r-params-bad",
					},
					recorded.env
				)
			);

			assert.deepStrictEqual(recorded.updates, []);
		});

		test("setModelCapabilities refuses a reserved key and writes nothing", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent(
					{
						type: "setModelCapabilities",
						value: JSON.parse('{"__proto__": {}}') as Record<string, Record<string, unknown>>,
						requestId: "r-caps-bad",
					},
					recorded.env
				)
			);

			assert.deepStrictEqual(recorded.updates, []);
		});

		test("setUsageAlertThresholds refuses out-of-range values and writes the rest sorted and deduplicated", async () => {
			const recorded = makeEnv();
			for (const values of [[0], [1.5], [0.8, -1]]) {
				await assert.rejects(
					executeDashboardIntent({ type: "setUsageAlertThresholds", values }, recorded.env),
					/allowed range 0 < value <= 1/
				);
			}
			assert.deepStrictEqual(recorded.updates, []);

			await executeDashboardIntent({ type: "setUsageAlertThresholds", values: [0.95, 0.8, 0.95] }, recorded.env);
			assert.deepStrictEqual(recorded.updates, [["usage.alertThresholds", [0.8, 0.95]]]);
		});

		test("every command ID maps to an allow-listed command", async () => {
			const recorded = makeEnv();
			const intents: DashboardIntent[] = [
				{ type: "executeCommand", command: "openGroupsFile" },
				{ type: "executeCommand", command: "syncModels" },
				{ type: "executeCommand", command: "testConnection" },
				{ type: "executeCommand", command: "openSettings" },
				{ type: "executeCommand", command: "reportIssue" },
				{ type: "executeCommand", command: "openOutput" },
			];
			for (const intent of intents) {
				await executeDashboardIntent(intent, recorded.env);
			}

			assert.deepStrictEqual(recorded.commands, [
				["litellm.openGroupsFile"],
				["litellm.syncModels"],
				["litellm.testConnection"],
				["workbench.action.openSettings", "@ext:vivswan.litellm-vscode-chat"],
				["litellm.reportIssue"],
				["litellm.openOutput"],
			]);
		});
	});

	suite("executeDashboardIntent: the servers setting", () => {
		const save = (
			recorded: RecordedEnv,
			partial: Partial<Extract<DashboardIntent, { type: "saveServerSetting" }>>
		): Promise<string | undefined> =>
			executeDashboardIntent(
				{
					type: "saveServerSetting",
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: KEEP_ALL,
					requestId: "req-1",
					...partial,
				},
				recorded.env
			);

		test("a new entry appends to the array and requests a sync; empty optionals stay omitted", async () => {
			const recorded = makeEnv([{ label: "Existing", baseUrl: "http://old.test" }]);
			await save(recorded, {
				server: serverPayload({ label: "Prod", baseUrl: " http://prod.test ", oauthTokenUrl: "", oauthScopes: "  " }),
			});

			assert.deepStrictEqual(recorded.serverWrites, [
				[
					{ label: "Existing", baseUrl: "http://old.test" },
					{ label: "Prod", baseUrl: "http://prod.test" },
				],
			]);
			assert.strictEqual(recorded.syncRequests, 1);
			assert.deepStrictEqual(recorded.secretOps, []);
		});

		test("an edit replaces the entry in place and keep-directives carry its inline secrets over", async () => {
			const recorded = makeEnv([
				{ label: "A", baseUrl: "http://a.test" },
				{
					label: "Prod",
					baseUrl: "http://old.test",
					auth: { apiKey: "sk-inline", virtualKey: { header: "x-old" } },
				},
				{ label: "Z", baseUrl: "http://z.test" },
			]);
			await save(recorded, {
				server: serverPayload({ label: "Prod", baseUrl: "http://new.test" }),
				replaceLabel: "Prod",
			});

			assert.deepStrictEqual(recorded.serverWrites, [
				[
					{ label: "A", baseUrl: "http://a.test" },
					{ label: "Prod", baseUrl: "http://new.test", auth: { apiKey: "sk-inline" } },
					{ label: "Z", baseUrl: "http://z.test" },
				],
			]);
			assert.deepStrictEqual(recorded.secretCopies, [], "no rename, no copy");
			assert.deepStrictEqual(recorded.secretDeletes, []);
		});

		test("an edit's empty always-sent fields deliberately clear the stored configuration", async () => {
			// The save rebuilds the whole entry from the payload, and the payload
			// always carries every editable field (the schema requires them), so
			// empty means clear - a payload that could omit one is rejected at the
			// schema instead of silently deleting hand-written configuration.
			const recorded = makeEnv([
				{
					label: "Prod",
					baseUrl: "http://old.test",
					headers: { "x-env": "prod" },
					discovery: { declared: ["deepseek-r1"] },
					budget: 50,
				},
			]);
			await save(recorded, {
				server: serverPayload({ label: "Prod", baseUrl: "http://new.test" }),
				replaceLabel: "Prod",
			});

			assert.deepStrictEqual(recorded.serverWrites, [[{ label: "Prod", baseUrl: "http://new.test" }]]);
		});

		test("an edit's populated always-sent fields land in the rebuilt entry verbatim", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://old.test" }]);
			await save(recorded, {
				server: serverPayload({
					label: "Prod",
					baseUrl: "http://new.test",
					headers: { "x-env": "prod" },
					declaredModels: ["deepseek-r1"],
					budget: 50,
				}),
				replaceLabel: "Prod",
			});

			assert.deepStrictEqual(recorded.serverWrites, [
				[
					{
						label: "Prod",
						baseUrl: "http://new.test",
						headers: { "x-env": "prod" },
						discovery: { declared: ["deepseek-r1"] },
						budget: 50,
					},
				],
			]);
		});

		test("header and budget rules refuse a save before any effect", async () => {
			// The acceptance matrix for the payload's new fields: names may be
			// echoed in the message (structural configuration), values never are.
			const cases: readonly [
				Record<string, string | number | boolean> | undefined,
				number | null | undefined,
				RegExp,
			][] = [
				// JSON.parse mints a real own "__proto__" key (a literal would set the prototype instead).
				[JSON.parse('{"__proto__": "x"}') as Record<string, string>, undefined, /reserved name/],
				[{ "bad name": "x" }, undefined, /not a valid HTTP header name/],
				[{ "x-env": "a", "X-Env": "b" }, undefined, /repeats an earlier header name/],
				[{ "x-env": "a\nb" }, undefined, /cannot be sent as an HTTP header/],
				[undefined, 0, /budget: must be a number greater than 0/],
				[undefined, -5, /budget: must be a number greater than 0/],
			];
			for (const [headers, budget, expected] of cases) {
				const recorded = makeEnv();
				await assert.rejects(
					save(recorded, {
						server: serverPayload({
							label: "Prod",
							baseUrl: "http://prod.test",
							...(headers !== undefined ? { headers } : {}),
							...(budget !== undefined ? { budget } : {}),
						}),
					}),
					expected
				);
				assert.deepStrictEqual(recorded.serverWrites, []);
			}
		});

		test("junk sibling entries survive a save verbatim", async () => {
			const junk = ["not an object", 42, { baseUrl: "http://no-label.test" }];
			const recorded = makeEnv([junk[0], { label: "Prod", baseUrl: "http://old.test" }, junk[1], junk[2]]);
			await save(recorded, { replaceLabel: "Prod" });

			assert.deepStrictEqual(recorded.serverWrites, [
				[junk[0], { label: "Prod", baseUrl: "http://prod.test" }, junk[1], junk[2]],
			]);
		});

		test("the save target is the parser-accepted entry: a rejected same-label sibling is not edited", async () => {
			// The first raw carrier of the label is rejected by parseServersSetting
			// (no usable baseUrl), so the dashboard row - and therefore this edit -
			// describes the second entry. The save must replace THAT one; the
			// invalid sibling survives verbatim like any junk entry, and the
			// keep-directive carries the accepted entry's inline key.
			const invalidSibling = { label: "Prod", auth: { apiKey: "sk-shadow" } };
			const recorded = makeEnv([
				invalidSibling,
				{ label: "Prod", baseUrl: "http://old.test", auth: { apiKey: "sk-real" } },
			]);
			await save(recorded, {
				server: serverPayload({ label: "Prod", baseUrl: "http://new.test" }),
				replaceLabel: "Prod",
			});

			assert.deepStrictEqual(recorded.serverWrites, [
				[invalidSibling, { label: "Prod", baseUrl: "http://new.test", auth: { apiKey: "sk-real" } }],
			]);
		});

		test("set-secure stores the value and keeps it out of the setting; set-settings inlines it and drops the secure copy after the write", async () => {
			const recorded = makeEnv([]);
			await save(recorded, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" }),
				secrets: {
					apiKey: { action: "set", location: "secure", value: "sk-secret" },
					oauthClientSecret: { action: "keep" },
					virtualKeyValue: { action: "set", location: "settings", value: "vk-visible" },
				},
			});

			assert.deepStrictEqual(recorded.secretOps, [
				["Prod", "apiKey", "sk-secret"],
				["Prod", "virtualKeyValue", undefined],
			]);
			assert.deepStrictEqual(recorded.serverWrites, [
				[{ label: "Prod", baseUrl: "http://prod.test", auth: { virtualKey: { header: "x-vk", value: "vk-visible" } } }],
			]);
			const written = JSON.stringify(recorded.serverWrites);
			assert.ok(!written.includes("sk-secret"), "secure values never land in the setting");
			assert.deepStrictEqual(
				recorded.ops,
				["store:Prod.apiKey", "write", "unstore:Prod.virtualKeyValue"],
				"additive ops precede the write; destructive cleanup follows it"
			);
		});

		test("clear removes the secure copy only after the write lands", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", auth: { apiKey: "sk-old" } }]);
			await save(recorded, {
				secrets: { ...KEEP_ALL, apiKey: { action: "clear" } },
				replaceLabel: "Prod",
			});

			assert.deepStrictEqual(recorded.secretOps, [["Prod", "apiKey", undefined]]);
			assert.deepStrictEqual(recorded.serverWrites, [[{ label: "Prod", baseUrl: "http://prod.test" }]]);
			assert.deepStrictEqual(recorded.ops, ["write", "unstore:Prod.apiKey"]);
		});

		test("prefill round trip: an untouched inline value survives a save unchanged, still inline", async () => {
			const entry = { label: "Prod", baseUrl: "http://prod.test", auth: { apiKey: "sk-inline" } };
			const recorded = makeEnv([entry]);
			// The webview's edit flow end to end: prefill the draft from the
			// entry's inline values, leave everything untouched, assemble, save.
			const prefilled = applyInlinePrefill(
				{
					...EMPTY_SERVER_FORM,
					authForm: "apiKey" as const,
					label: "Prod",
					baseUrl: "http://prod.test",
					apiKey: { value: "", location: "settings", clear: false, existing: "settings" },
				},
				readInlineSecretValues([entry], "Prod")
			);
			assert.strictEqual(prefilled.apiKey.value, "sk-inline", "the form shows the inline value");
			const assembled = parseClean(prefilled, "Prod");
			assert.deepStrictEqual(assembled.secrets.apiKey, { action: "keep" }, "untouched prefill assembles as keep");
			await executeDashboardIntent({ type: "saveServerSetting", ...assembled, requestId: "req-rt" }, recorded.env);

			assert.deepStrictEqual(recorded.serverWrites, [[entry]], "the value survives unchanged, storage stays inline");
			assert.deepStrictEqual(recorded.secretOps, [], "no secure-side traffic for an untouched prefill");
		});

		test("prefill round trip: an edited prefill lands the new value inline", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test", auth: { apiKey: "sk-old" } }]);
			const prefilled = applyInlinePrefill(
				{
					...EMPTY_SERVER_FORM,
					authForm: "apiKey" as const,
					label: "Prod",
					baseUrl: "http://prod.test",
					apiKey: { value: "", location: "settings", clear: false, existing: "settings" },
				},
				readInlineSecretValues(recorded.env.readServersSetting(), "Prod")
			);
			const edited = { ...prefilled, apiKey: { ...prefilled.apiKey, value: "sk-rotated" } };
			const assembled = parseClean(edited, "Prod");
			assert.deepStrictEqual(assembled.secrets.apiKey, { action: "set", location: "settings", value: "sk-rotated" });
			await executeDashboardIntent({ type: "saveServerSetting", ...assembled, requestId: "req-rt2" }, recorded.env);

			assert.deepStrictEqual(recorded.serverWrites, [
				[{ label: "Prod", baseUrl: "http://prod.test", auth: { apiKey: "sk-rotated" } }],
			]);
		});

		test("overwriting a live secure value whose settings write then fails restores the old value", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-old" });
			recorded.failWrites = new Error("disk full");
			await assert.rejects(
				save(recorded, {
					secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-new" } },
					replaceLabel: "Prod",
				}),
				/disk full/
			);

			assert.strictEqual(
				recorded.storedSecrets.get("Prod")?.apiKey,
				"sk-old",
				"the entry still in the setting must resolve its old secret"
			);
			assert.deepStrictEqual(recorded.ops, ["store:Prod.apiKey", "store:Prod.apiKey"], "overwrite, then restore");
			assert.strictEqual(recorded.syncRequests, 0, "a clean rollback changes nothing durable, so no sync");
		});

		test("a failed settings write also removes a secure value that had no predecessor", async () => {
			// The unchanged entry resolves the label's blob, so a freshly stored
			// value must not survive the failed write as its new secret.
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.failWrites = new Error("disk full");
			await assert.rejects(
				save(recorded, {
					secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-new" } },
					replaceLabel: "Prod",
				}),
				/disk full/
			);

			assert.strictEqual(recorded.storedSecrets.get("Prod")?.apiKey, undefined);
		});

		test("a second secure write failing rolls back the first and never writes the setting", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-old" });
			recorded.failStoreField = "oauthClientSecret";
			await assert.rejects(
				save(recorded, {
					server: serverPayload({
						label: "Prod",
						baseUrl: "http://prod.test",
						oauthTokenUrl: "https://idp.test/token",
						oauthClientId: "client",
					}),
					secrets: {
						apiKey: { action: "set", location: "secure", value: "sk-new" },
						oauthClientSecret: { action: "set", location: "secure", value: "cs-new" },
						virtualKeyValue: { action: "keep" },
					},
					replaceLabel: "Prod",
				})
			);

			assert.strictEqual(recorded.storedSecrets.get("Prod")?.apiKey, "sk-old", "the first write is rolled back");
			assert.strictEqual(recorded.storedSecrets.get("Prod")?.oauthClientSecret, undefined);
			assert.deepStrictEqual(recorded.serverWrites, [], "the settings write never runs");
			assert.strictEqual(recorded.syncRequests, 0);
		});

		test("a rename over an orphan blob whose settings write fails restores the orphan wholesale", async () => {
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Old", { apiKey: "sk-old" });
			recorded.storedSecrets.set("New", { virtualKeyValue: "vk-orphan" });
			recorded.failWrites = new Error("disk full");
			await assert.rejects(
				save(recorded, { server: serverPayload({ label: "New", baseUrl: "http://prod.test" }), replaceLabel: "Old" })
			);

			assert.deepStrictEqual(
				recorded.storedSecrets.get("New"),
				{ virtualKeyValue: "vk-orphan" },
				"the pre-copy blob is restored wholesale, copied-over fields removed"
			);
			assert.deepStrictEqual(recorded.storedSecrets.get("Old"), { apiKey: "sk-old" }, "the source blob is untouched");
		});

		test("a failed write whose rollback also fails reports an operation failure, not a clean validation one", async () => {
			// The freshly stored secret survived the rollback and now resolves for
			// the unchanged entry: durable state changed, so "nothing landed"
			// (rethrowing the write error as validation-kind) would be a lie.
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.failWrites = new Error("disk full");
			recorded.failUnstore = new Error("keychain locked");
			await assert.rejects(
				save(recorded, {
					secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-new" } },
					replaceLabel: "Prod",
				}),
				(error: unknown) =>
					error instanceof DashboardOperationError &&
					error.message.includes("a stored secret may have been left changed") &&
					error.message.includes("Set Server Secret") &&
					error.message.includes("could not restore apiKey")
			);

			assert.strictEqual(recorded.storedSecrets.get("Prod")?.apiKey, "sk-new", "the unrestored secret is live");
			assert.strictEqual(recorded.syncRequests, 1, "the changed secure value must reach the provider group");
			const logged = JSON.stringify(recorded.logs);
			assert.ok(logged.includes("left a secure value unrestored"), "the conversion is logged as a classification");
			assert.ok(!logged.includes("disk full") && !logged.includes("sk-new"), "names only, never messages or values");
		});

		test("a rename rollback that fails likewise fails the intent as an operation error", async () => {
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Old", { apiKey: "sk-old" });
			recorded.failWrites = new Error("disk full");
			recorded.failUnstore = new Error("keychain locked");
			await assert.rejects(
				save(recorded, { server: serverPayload({ label: "New", baseUrl: "http://prod.test" }), replaceLabel: "Old" }),
				(error: unknown) =>
					error instanceof DashboardOperationError &&
					// Only the fields a side actually held are reported: the
					// wholesale restore's no-op deletes must not name secrets that
					// never existed.
					error.message.includes("could not restore apiKey") &&
					!error.message.includes("oauthClientSecret") &&
					!error.message.includes("virtualKeyValue")
			);

			assert.strictEqual(recorded.syncRequests, 1, "the unrestored blob must reach the provider group");
		});

		test("a clear whose deletion keeps failing fails the intent after the write landed, with an actionable message", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-old" });
			recorded.failUnstore = new Error("keychain locked");
			await assert.rejects(
				save(recorded, { secrets: { ...KEEP_ALL, apiKey: { action: "clear" } }, replaceLabel: "Prod" }),
				(error: unknown) =>
					error instanceof DashboardOperationError &&
					error.message.includes("Edit the server and retry") &&
					error.message.includes("Set Server Secret")
			);

			assert.strictEqual(recorded.serverWrites.length, 1, "the settings write landed");
			assert.strictEqual(recorded.syncRequests, 1, "the landed write still gets its sync");
			const logged = JSON.stringify(recorded.logs);
			assert.ok(logged.includes("still in effect"), "the failure is logged as a classification");
			assert.ok(!logged.includes("sk-old"), "no value reaches the log");
		});

		test("a clear deletion that fails once succeeds on the retry", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-old" });
			recorded.failUnstoreTimes = 1;
			await save(recorded, { secrets: { ...KEEP_ALL, apiKey: { action: "clear" } }, replaceLabel: "Prod" });

			assert.strictEqual(recorded.storedSecrets.get("Prod")?.apiKey, undefined, "the retry removed the secret");
		});

		test("dormant-leftover cleanup failures after the settings write landed do not fail the intent", async () => {
			// The stale secure copy behind a fresh inline value is outranked and
			// the old rename blob is orphaned, so both failures are log-only.
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Old", { apiKey: "sk-old" });
			recorded.failUnstore = new Error("keychain locked");
			recorded.failBlobDeletes = new Error("keychain locked");
			await save(recorded, {
				server: serverPayload({ label: "New", baseUrl: "http://prod.test" }),
				secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "settings", value: "sk-inline" } },
				replaceLabel: "Old",
			});

			assert.strictEqual(recorded.serverWrites.length, 1);
			assert.strictEqual(recorded.syncRequests, 1);
			const logged = JSON.stringify(recorded.logs);
			assert.ok(logged.includes("dormant secure copy remains"), "the stale-copy failure is a classification");
			assert.ok(logged.includes("old label's blob remains"), "the rename-blob failure is a classification");
		});

		test("edits and removals find hand-written entries whose labels carry whitespace", async () => {
			const edited = makeEnv([{ label: " Prod ", baseUrl: "http://old.test" }]);
			await save(edited, { replaceLabel: "Prod" });
			assert.deepStrictEqual(edited.serverWrites, [[{ label: "Prod", baseUrl: "http://prod.test" }]]);

			const removed = makeEnv([{ label: " Prod ", baseUrl: "http://old.test" }]);
			await executeDashboardIntent({ type: "removeServerSetting", label: "Prod", requestId: "req-9" }, removed.env);
			assert.deepStrictEqual(removed.serverWrites, [[]]);
		});

		test("a rename with keep directives resolves pairing against the old label's secure value", async () => {
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Old", { virtualKeyValue: "vk-1" });
			await save(recorded, {
				server: serverPayload({ label: "New", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" }),
				replaceLabel: "Old",
			});

			assert.strictEqual(recorded.serverWrites.length, 1, "the old label's secure value satisfies the pair");
			assert.deepStrictEqual(recorded.storedSecrets.get("New"), { virtualKeyValue: "vk-1" });
		});

		test("a rename with keep directives also resolves against an orphan blob under the new label", async () => {
			// copyServerSecrets is a no-op on an empty source, so the orphan
			// survives the save and the sync engine adopts it; the pairing check
			// must agree instead of refusing a save the engine would satisfy.
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("New", { virtualKeyValue: "vk-orphan" });
			await save(recorded, {
				server: serverPayload({ label: "New", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" }),
				replaceLabel: "Old",
			});

			assert.strictEqual(recorded.serverWrites.length, 1);
		});

		test("a non-empty old blob replaces the orphan wholesale on rename, and pairing tracks that", async () => {
			// The copy overwrites the whole new-label blob, so a field only the
			// orphan held does not survive; the pairing check must refuse like the
			// engine would degrade.
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Old", { apiKey: "sk-1" });
			recorded.storedSecrets.set("New", { virtualKeyValue: "vk-orphan" });
			await assert.rejects(
				save(recorded, {
					server: serverPayload({ label: "New", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" }),
					replaceLabel: "Old",
				}),
				/virtualKeyValue/
			);
		});

		test("a rename copies the blob before the write and deletes the old one after it", async () => {
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			await save(recorded, {
				server: serverPayload({ label: "New", baseUrl: "http://prod.test" }),
				replaceLabel: "Old",
			});

			assert.deepStrictEqual(recorded.secretCopies, [["Old", "New"]]);
			assert.deepStrictEqual(recorded.secretDeletes, ["Old"]);
			assert.deepStrictEqual(recorded.serverWrites, [[{ label: "New", baseUrl: "http://prod.test" }]]);
			assert.deepStrictEqual(recorded.ops, ["copy:Old->New", "write", "deleteBlob:Old"]);
		});

		test("a rename whose settings write rejects leaves the old label's secrets intact", async () => {
			const recorded = makeEnv([{ label: "Old", baseUrl: "http://prod.test" }]);
			recorded.failWrites = new Error("disk full");
			await assert.rejects(
				save(recorded, { server: serverPayload({ label: "New", baseUrl: "http://prod.test" }), replaceLabel: "Old" }),
				/disk full/
			);

			assert.deepStrictEqual(recorded.secretCopies, [["Old", "New"]], "the additive copy may have happened");
			assert.deepStrictEqual(recorded.secretDeletes, [], "the old blob must survive the failed write");
			assert.deepStrictEqual(recorded.secretOps, [], "no clears before or after a failed write");
			assert.strictEqual(recorded.syncRequests, 0);
		});

		test("renaming onto an existing sibling label is refused before any effect", async () => {
			const recorded = makeEnv([
				{ label: "A", baseUrl: "http://a.test" },
				{ label: "B", baseUrl: "http://b.test" },
			]);
			await assert.rejects(
				save(recorded, { server: serverPayload({ label: "B", baseUrl: "http://a.test" }), replaceLabel: "A" }),
				/already exists/
			);

			assert.deepStrictEqual(recorded.serverWrites, []);
			assert.deepStrictEqual(recorded.secretCopies, []);
			assert.deepStrictEqual(recorded.secretOps, []);
		});

		test("an edit whose entry vanished from the setting is refused instead of appending a duplicate", async () => {
			const recorded = makeEnv([{ label: "Other", baseUrl: "http://other.test" }]);
			await assert.rejects(save(recorded, { replaceLabel: "Gone" }), /no longer exists/);

			assert.deepStrictEqual(recorded.serverWrites, []);
		});

		test("OAuth pairing is enforced at the boundary: a token URL without a client ID never saves", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(
				save(recorded, {
					server: serverPayload({
						label: "Prod",
						baseUrl: "http://prod.test",
						oauthTokenUrl: "https://idp.test/token",
					}),
				}),
				/oauthClientId/
			);
			await assert.rejects(
				save(recorded, {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", oauthClientId: "client" }),
				}),
				/oauthTokenUrl/
			);

			assert.deepStrictEqual(recorded.serverWrites, []);
		});

		test("OAuth semantics mirror the form: scopes or a resolving client secret require the full pair", async () => {
			const scopesOnly = makeEnv([]);
			await assert.rejects(
				save(scopesOnly, {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", oauthScopes: "read" }),
				}),
				/oauthTokenUrl/
			);
			assert.deepStrictEqual(scopesOnly.serverWrites, []);

			const storedSecretOnly = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			storedSecretOnly.storedSecrets.set("Prod", { oauthClientSecret: "cs-stored" });
			await assert.rejects(save(storedSecretOnly, { replaceLabel: "Prod" }), /oauthTokenUrl/);

			const cleared = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			cleared.storedSecrets.set("Prod", { oauthClientSecret: "cs-stored" });
			await save(cleared, {
				secrets: { ...KEEP_ALL, oauthClientSecret: { action: "clear" } },
				replaceLabel: "Prod",
			});
			assert.strictEqual(cleared.serverWrites.length, 1, "clearing the dangling secret makes the entry savable");
		});

		test("a padded replaceLabel targets the trimmed label's secret blob, not a padded key", async () => {
			const recorded = makeEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			recorded.storedSecrets.set("Prod", { apiKey: "sk-old" });
			await save(recorded, {
				server: serverPayload({ label: "Renamed", baseUrl: "http://prod.test" }),
				replaceLabel: " Prod ",
			});

			assert.deepStrictEqual(recorded.secretCopies, [["Prod", "Renamed"]], "the copy reads the trimmed label");
			assert.deepStrictEqual(recorded.secretDeletes, ["Prod"], "the cleanup deletes the trimmed label");
			assert.deepStrictEqual(recorded.storedSecrets.get("Renamed"), { apiKey: "sk-old" });
		});

		test("virtual key pairing is enforced against the resolved secrets", async () => {
			const noValue = makeEnv([]);
			await assert.rejects(
				save(noValue, {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" }),
				}),
				/virtualKeyValue/
			);

			const secureValue = makeEnv([]);
			secureValue.storedSecrets.set("Prod", { virtualKeyValue: "vk-stored" });
			await save(secureValue, {
				server: serverPayload({ label: "Prod", baseUrl: "http://prod.test", virtualKeyHeader: "x-vk" }),
			});
			assert.strictEqual(secureValue.serverWrites.length, 1, "a kept secure value satisfies the pair");

			const valueWithoutHeader = makeEnv([]);
			await assert.rejects(
				save(valueWithoutHeader, {
					secrets: { ...KEEP_ALL, virtualKeyValue: { action: "set", location: "secure", value: "vk-1" } },
				}),
				/virtualKeyHeader/
			);
			assert.deepStrictEqual(valueWithoutHeader.secretOps, [], "pairing is checked before any secret write");
		});

		test("an invalid save writes nothing anywhere", async () => {
			const recorded = makeEnv([]);
			await assert.rejects(save(recorded, { server: serverPayload({ label: "__proto__", baseUrl: "http://x" }) }));
			await assert.rejects(save(recorded, { server: serverPayload({ label: "P", baseUrl: "not-a-url" }) }));
			await assert.rejects(save(recorded, { server: serverPayload({ label: "P", baseUrl: "" }) }));

			assert.deepStrictEqual(recorded.serverWrites, []);
			assert.deepStrictEqual(recorded.secretOps, []);
			assert.strictEqual(recorded.syncRequests, 0);
		});

		test("removeServerSetting deletes the entry, keeps its secure-side secrets, and preserves junk siblings", async () => {
			const recorded = makeEnv([
				{ label: "A", baseUrl: "http://a.test" },
				"junk",
				{ label: "B", baseUrl: "http://b.test" },
			]);
			await executeDashboardIntent({ type: "removeServerSetting", label: "A", requestId: "req-2" }, recorded.env);

			assert.deepStrictEqual(recorded.serverWrites, [["junk", { label: "B", baseUrl: "http://b.test" }]]);
			assert.deepStrictEqual(recorded.secretOps, []);
			assert.deepStrictEqual(recorded.secretDeletes, []);
			assert.strictEqual(recorded.syncRequests, 1);
		});

		test("removing a label the setting does not hold refuses without writing", async () => {
			const recorded = makeEnv([{ label: "A", baseUrl: "http://a.test" }]);
			await assert.rejects(
				executeDashboardIntent({ type: "removeServerSetting", label: "External", requestId: "req-3" }, recorded.env)
			);

			assert.deepStrictEqual(recorded.serverWrites, []);
		});
	});

	suite("executeDashboardIntent: adoptServer", () => {
		const FULL_CREDENTIALS: AdoptableGroupCredentials = {
			apiKey: "sk-live",
			oauthTokenUrl: "https://idp.test/token",
			oauthClientId: "client-1",
			oauthClientSecret: "oauth-secret",
			oauthScopes: "read write",
			virtualKeyHeader: "x-litellm-api-key",
			virtualKeyValue: "vk-live",
		};

		const adopt = (
			recorded: RecordedEnv,
			partial: Partial<Extract<DashboardIntent, { type: "adoptServer" }>> = {}
		): Promise<string | undefined> =>
			executeDashboardIntent(
				{
					type: "adoptServer",
					label: "Adopted",
					baseUrl: "http://ext.test",
					sourceHandle: "handle-ext",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
					requestId: "req-a",
					...partial,
				},
				recorded.env
			);

		test("writes the entry with non-secret fields and stores secure-side secrets, never logging a value", async () => {
			const recorded = makeEnv([{ label: "Existing", baseUrl: "http://other.test" }]);
			recorded.adoptionCredentials = FULL_CREDENTIALS;

			const notice = await adopt(recorded);

			assert.strictEqual(notice, undefined, "a full adoption carries no caveat");
			assert.deepStrictEqual(recorded.adoptionLookups, [["http://ext.test", "handle-ext"]]);
			assert.deepStrictEqual(recorded.serverWrites, [
				[
					{ label: "Existing", baseUrl: "http://other.test" },
					{
						label: "Adopted",
						baseUrl: "http://ext.test",
						oauthTokenUrl: "https://idp.test/token",
						oauthClientId: "client-1",
						oauthScopes: "read write",
						virtualKeyHeader: "x-litellm-api-key",
					},
				],
			]);
			assert.deepStrictEqual(recorded.storedSecrets.get("Adopted"), {
				apiKey: "sk-live",
				oauthClientSecret: "oauth-secret",
				virtualKeyValue: "vk-live",
			});
			assert.strictEqual(recorded.syncRequests, 1);
			const everything = JSON.stringify(recorded.logs);
			for (const secret of ["sk-live", "oauth-secret", "vk-live"]) {
				assert.ok(!everything.includes(secret), `logs must never carry ${secret}`);
			}
		});

		test("a settings-side storage choice inlines the value into the entry instead", async () => {
			const recorded = makeEnv([]);
			recorded.adoptionCredentials = { apiKey: "sk-live" };

			await adopt(recorded, {
				secrets: { apiKey: "settings", oauthClientSecret: "secure", virtualKeyValue: "secure" },
			});

			assert.deepStrictEqual(recorded.serverWrites, [
				[{ label: "Adopted", baseUrl: "http://ext.test", apiKey: "sk-live" }],
			]);
			assert.deepStrictEqual(recorded.secretOps, [], "nothing goes secure-side when settings was chosen");
		});

		test("refuses a label collision with an existing declared entry", async () => {
			const recorded = makeEnv([{ label: "Adopted", baseUrl: "http://other.test" }]);
			recorded.adoptionCredentials = FULL_CREDENTIALS;

			await assert.rejects(
				() => adopt(recorded),
				(error: unknown) =>
					error instanceof Error && error.name === "DashboardValidationError" && /already exists/.test(error.message)
			);
			assert.deepStrictEqual(recorded.serverWrites, []);
			assert.deepStrictEqual(recorded.secretOps, []);
		});

		test("refuses label and URL rule violations", async () => {
			const recorded = makeEnv([]);
			recorded.adoptionCredentials = FULL_CREDENTIALS;
			for (const partial of [
				{ label: "  " },
				{ label: "__proto__" },
				{ baseUrl: "not a url" },
				{ baseUrl: "ftp://x.test" },
			]) {
				await assert.rejects(
					() => adopt(recorded, partial),
					(error: unknown) => error instanceof Error && error.name === "DashboardValidationError",
					JSON.stringify(partial)
				);
			}
			assert.deepStrictEqual(recorded.serverWrites, []);
		});

		test("a missing credential lookup still adopts the plain entry and reports the caveat", async () => {
			const recorded = makeEnv([]);
			// adoptionCredentials stays unset: the group refreshed away.

			const notice = await adopt(recorded);

			assert.ok(notice !== undefined && /could not be read/.test(notice), notice ?? "expected a caveat notice");
			assert.deepStrictEqual(recorded.serverWrites, [[{ label: "Adopted", baseUrl: "http://ext.test" }]]);
			assert.deepStrictEqual(recorded.secretOps, [], "no secrets to copy");
			assert.strictEqual(recorded.syncRequests, 1);
		});

		test("a failed settings write rolls the copied secure secrets back", async () => {
			const recorded = makeEnv([]);
			recorded.adoptionCredentials = FULL_CREDENTIALS;
			recorded.failWrites = new Error("settings store unavailable");

			await assert.rejects(() => adopt(recorded));

			assert.deepStrictEqual(
				recorded.storedSecrets.get("Adopted"),
				{},
				"the copied secrets are removed again when the entry never landed"
			);
		});

		test("a stale secure blob under the new label is cleared, never inherited", async () => {
			// serverSync keeps a removed entry's blob on purpose (re-adding the
			// label picks it up), but an adoption under that label asked for the
			// GROUP's secrets, so leftovers from neither the group nor the user
			// must not resolve for the new entry.
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Adopted", { apiKey: "sk-stale", virtualKeyValue: "vk-stale" });
			recorded.adoptionCredentials = { apiKey: "sk-live" };

			await adopt(recorded);

			assert.deepStrictEqual(
				recorded.storedSecrets.get("Adopted"),
				{ apiKey: "sk-live" },
				"copied fields land; stale fields are removed"
			);
		});

		test("a stale blob field behind a settings-side copy is cleared too, like the save path's dormant copies", async () => {
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Adopted", { apiKey: "sk-stale" });
			recorded.adoptionCredentials = { apiKey: "sk-live" };

			await adopt(recorded, {
				secrets: { apiKey: "settings", oauthClientSecret: "secure", virtualKeyValue: "secure" },
			});

			assert.deepStrictEqual(recorded.serverWrites, [
				[{ label: "Adopted", baseUrl: "http://ext.test", apiKey: "sk-live" }],
			]);
			assert.deepStrictEqual(
				recorded.storedSecrets.get("Adopted"),
				{},
				"the stale secure copy behind the inline value is removed"
			);
		});

		test("a failed settings write also restores a stale blob the adoption had cleared", async () => {
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Adopted", { virtualKeyValue: "vk-stale" });
			recorded.adoptionCredentials = { apiKey: "sk-live" };
			recorded.failWrites = new Error("settings store unavailable");

			await assert.rejects(() => adopt(recorded));

			assert.deepStrictEqual(
				recorded.storedSecrets.get("Adopted"),
				{ virtualKeyValue: "vk-stale" },
				"the cleared stale blob comes back when the entry never landed"
			);
		});

		test("a failed stale-blob clear aborts the adoption and rolls the copied secrets back", async () => {
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Adopted", { virtualKeyValue: "vk-stale" });
			recorded.adoptionCredentials = { apiKey: "sk-live" };
			// The stale clear (an unstore) fails once; the rollback's own
			// unstore of the copied apiKey then succeeds.
			recorded.failUnstoreTimes = 1;

			await assert.rejects(
				() => adopt(recorded),
				(error: unknown) => error instanceof Error && error.name === "Error" && /keychain locked/.test(error.message),
				"the storage failure surfaces as-is, not re-wrapped"
			);

			assert.deepStrictEqual(recorded.serverWrites, [], "the entry never lands when a stale clear fails");
			assert.deepStrictEqual(
				recorded.storedSecrets.get("Adopted"),
				{ virtualKeyValue: "vk-stale" },
				"the copied secret is rolled back and the pre-existing blob is intact, so retrying converges"
			);
		});

		test("a failed stale clear aborts the caveat-path adoption too, restoring the blob", async () => {
			const recorded = makeEnv([]);
			recorded.storedSecrets.set("Adopted", { apiKey: "sk-stale" });
			recorded.failUnstoreTimes = 1;
			// adoptionCredentials stays unset: nothing to copy, but the stale
			// blob still must not resolve for the would-be entry.

			await assert.rejects(
				() => adopt(recorded),
				(error: unknown) => error instanceof Error && /keychain locked/.test(error.message)
			);

			assert.deepStrictEqual(recorded.serverWrites, []);
			assert.deepStrictEqual(recorded.storedSecrets.get("Adopted"), { apiKey: "sk-stale" });
		});

		test("a failed write whose rollback also fails reports the reachable recovery path", async () => {
			const recorded = makeEnv([]);
			recorded.adoptionCredentials = { apiKey: "sk-live" };
			recorded.failWrites = new Error("settings store unavailable");
			// The rollback deletes the copied secret (a store of undefined),
			// which this knob rejects.
			recorded.failUnstore = new Error("keychain locked");

			await assert.rejects(
				() => adopt(recorded),
				(error: unknown) =>
					error instanceof Error &&
					error.name === "DashboardOperationError" &&
					/Re-add a server under this label/.test(error.message)
			);
			assert.strictEqual(recorded.syncRequests, 1, "the unrestored secret must still reach the sync engine");
		});
	});

	suite("executeDashboardIntent: hidden groups", () => {
		test("hideExternalServer tombstones exactly the identity the handle resolves to", async () => {
			const recorded = makeEnv();
			// The resolved identity is the group's own status label and URL, not
			// what the intent claimed: the handle is the authority.
			recorded.externalGroup = { label: "Prod", baseUrl: "http://prod.test/" };
			await executeDashboardIntent(
				{ type: "hideExternalServer", baseUrl: "http://prod.test", sourceHandle: "handle-1", requestId: "req-1" },
				recorded.env
			);

			assert.deepStrictEqual(recorded.externalLookups, [["http://prod.test", "handle-1"]]);
			assert.deepStrictEqual(recorded.hidden, [{ label: "Prod", baseUrl: "http://prod.test/" }]);
		});

		test("hideExternalServer refuses an unusable base URL before any lookup", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent(
					{ type: "hideExternalServer", baseUrl: "not a url", sourceHandle: "h", requestId: "r" },
					recorded.env
				),
				/baseUrl/
			);
			assert.deepStrictEqual(recorded.externalLookups, []);
			assert.deepStrictEqual(recorded.hidden, []);
		});

		test("a handle that resolves to no still-external group hides nothing", async () => {
			const recorded = makeEnv();
			// recorded.externalGroup stays unset: the resolver answers undefined.
			await assert.rejects(
				executeDashboardIntent(
					{ type: "hideExternalServer", baseUrl: "http://prod.test", sourceHandle: "stale", requestId: "r" },
					recorded.env
				),
				/no longer matches a hideable server/
			);
			assert.deepStrictEqual(recorded.hidden, []);
		});

		test("unhideServer echoes the identity verbatim and fails when no tombstone matched", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent(
				{ type: "unhideServer", label: "Prod", baseUrl: "http://prod.test", requestId: "r1" },
				recorded.env
			);
			assert.deepStrictEqual(recorded.unhidden, [{ label: "Prod", baseUrl: "http://prod.test" }]);

			recorded.unhideResult = false;
			await assert.rejects(
				executeDashboardIntent(
					{ type: "unhideServer", label: "Ghost", baseUrl: "http://gone.test", requestId: "r2" },
					recorded.env
				),
				/No hidden group/
			);
		});

		test("unhideServer refuses a blank label", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent(
					{ type: "unhideServer", label: "  ", baseUrl: "http://prod.test", requestId: "r" },
					recorded.env
				),
				/label/
			);
			assert.deepStrictEqual(recorded.unhidden, []);
		});
	});
});
