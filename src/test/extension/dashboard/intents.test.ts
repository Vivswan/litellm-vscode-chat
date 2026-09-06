/**
 * executeDashboardIntent: the setting and command intents, adoptServer, and hidden
 * groups. The servers-setting intents have their own suite file.
 */
import * as assert from "node:assert";
import type { DashboardIntent, RequestPayload } from "../../../dashboard/endpoints";
import { DASHBOARD_COMMAND_IDS } from "../../../dashboard/endpoints";
import type { AdoptableGroupCredentials } from "../../../extension/dashboard/adopt";
import type { IntentAckNotice } from "../../../extension/dashboard/intents";
import { executeDashboardIntent } from "../../../extension/dashboard/intents";
import { buildGroupArgs } from "../../../extension/servers/serverSync/engine";
import { acceptedEntry, parseServersSetting } from "../../../extension/servers/serverSync/setting";
import { stripEntrySecrets } from "../../../extension/settingsTransfer/secretSurgery";
import { isRecord } from "../../../shared/util/json";
import { makeEnv, type RecordedEnv } from "./recordedEnv";

suite("extension/dashboard/intents", () => {
	suite("executeDashboardIntent", () => {
		test("setNumberSetting writes the setting key verbatim", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent(
				{ method: "setNumberSetting", payload: { setting: "chat.timeout", value: 120000 } },
				recorded.env
			);

			assert.deepStrictEqual(recorded.updates, [["chat.timeout", 120000]]);
			assert.deepStrictEqual(recorded.commands, []);
		});

		test("setNumberSetting refuses values below the minimum without writing", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent(
					{ method: "setNumberSetting", payload: { setting: "chat.timeout", value: 1 } },
					recorded.env
				)
			);

			assert.deepStrictEqual(recorded.updates, []);
		});

		test("setBooleanSetting writes the dotted key", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent(
				{ method: "setBooleanSetting", payload: { setting: "chat.promptCaching", value: false } },
				recorded.env
			);

			assert.deepStrictEqual(recorded.updates, [["chat.promptCaching", false]]);
		});

		test("resetSetting removes the key through removeSetting, never a value write", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent({ method: "resetSetting", payload: { setting: "chat.timeout" } }, recorded.env);
			await executeDashboardIntent(
				{ method: "resetSetting", payload: { setting: "ui.maskSecretInputs" } },
				recorded.env
			);

			assert.deepStrictEqual(recorded.removals, ["chat.timeout", "ui.maskSecretInputs"]);
			assert.deepStrictEqual(recorded.updates, []);
			assert.deepStrictEqual(recorded.commands, []);
		});

		test("revealSetting executes the internal open-setting command with the bare key as its argument", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent({ method: "revealSetting", payload: { setting: "chat.timeout" } }, recorded.env);
			await executeDashboardIntent(
				{ method: "revealSetting", payload: { setting: "models.parameters" } },
				recorded.env
			);

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
			await executeDashboardIntent({ method: "setModelParameters", payload: { value: params } }, recorded.env);

			assert.deepStrictEqual(recorded.updates, [["models.parameters", params]]);
		});

		test("record intents that fail validation write nothing", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent(
					{
						method: "setModelParameters",
						payload: { value: JSON.parse('{"__proto__": {}}') as Record<string, Record<string, unknown>> },
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
						method: "setModelCapabilities",
						payload: { value: JSON.parse('{"__proto__": {}}') as Record<string, Record<string, unknown>> },
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
					executeDashboardIntent({ method: "setUsageAlertThresholds", payload: { values } }, recorded.env),
					/allowed range 0 < value <= 1/
				);
			}
			assert.deepStrictEqual(recorded.updates, []);

			await executeDashboardIntent(
				{ method: "setUsageAlertThresholds", payload: { values: [0.95, 0.8, 0.95] } },
				recorded.env
			);
			assert.deepStrictEqual(recorded.updates, [["usage.alertThresholds", [0.8, 0.95]]]);
		});

		test("setCurrencySymbol writes the string verbatim, the empty string included", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent({ method: "setCurrencySymbol", payload: { value: "EUR " } }, recorded.env);
			await executeDashboardIntent({ method: "setCurrencySymbol", payload: { value: "" } }, recorded.env);
			assert.deepStrictEqual(recorded.updates, [
				["usage.currencySymbol", "EUR "],
				["usage.currencySymbol", ""],
			]);
		});

		test("setAdditionalToolSchemaKeywords refuses empty or unsafe names and writes the rest deduplicated in order", async () => {
			const recorded = makeEnv();
			for (const values of [["propertyNames", ""], ["__proto__"], ["constructor"]]) {
				await assert.rejects(
					executeDashboardIntent({ method: "setAdditionalToolSchemaKeywords", payload: { values } }, recorded.env),
					/allowed range plain non-empty strings/
				);
			}
			assert.deepStrictEqual(recorded.updates, []);

			await executeDashboardIntent(
				{
					method: "setAdditionalToolSchemaKeywords",
					payload: { values: ["propertyNames", "patternProperties", "propertyNames"] },
				},
				recorded.env
			);
			assert.deepStrictEqual(recorded.updates, [
				["chat.additionalToolSchemaKeywords", ["propertyNames", "patternProperties"]],
			]);
		});

		test("setFeatureModel writes the trimmed ref to the feature's own key; null resets instead of writing", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent(
				{
					method: "setFeatureModel",
					payload: { feature: "inlineCompletions", value: { server: " Prod ", model: " codestral " } },
				},
				recorded.env
			);
			await executeDashboardIntent(
				{
					method: "setFeatureModel",
					payload: { feature: "commitGeneration", value: { server: "Gateway", model: "gpt-4o-mini" } },
				},
				recorded.env
			);
			await executeDashboardIntent(
				{ method: "setFeatureModel", payload: { feature: "inlineCompletions", value: null } },
				recorded.env
			);

			assert.deepStrictEqual(recorded.updates, [
				["inlineCompletions.model", { server: "Prod", model: "codestral" }],
				["commitGeneration.model", { server: "Gateway", model: "gpt-4o-mini" }],
			]);
			assert.deepStrictEqual(recorded.removals, ["inlineCompletions.model"]);
		});

		test("setFeatureModel refuses refs whose halves trim away, and writes nothing", async () => {
			const recorded = makeEnv();
			for (const value of [
				{ server: " ", model: "m" },
				{ server: "s", model: "  " },
			]) {
				await assert.rejects(
					executeDashboardIntent(
						{ method: "setFeatureModel", payload: { feature: "commitGeneration", value } },
						recorded.env
					),
					/allowed range non-empty server label and model ID/
				);
			}
			assert.deepStrictEqual(recorded.updates, []);
			assert.deepStrictEqual(recorded.removals, []);
		});

		test("setCommitPrompt writes the text verbatim; the empty string resets the setting", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent({ method: "setCommitPrompt", payload: { value: "Subject only. " } }, recorded.env);
			await executeDashboardIntent({ method: "setCommitPrompt", payload: { value: "" } }, recorded.env);

			assert.deepStrictEqual(recorded.updates, [["commitGeneration.prompt", "Subject only. "]]);
			assert.deepStrictEqual(recorded.removals, ["commitGeneration.prompt"]);
		});

		test("setLanguageFilter merges partial patches onto the stored filter, refuses blanks and empty patches, and resets on block-nothing", async () => {
			const recorded = makeEnv();
			for (const languages of [[""], ["typescript", "  "]]) {
				await assert.rejects(
					executeDashboardIntent({ method: "setLanguageFilter", payload: { languages } }, recorded.env),
					/allowed range plain non-empty strings/
				);
			}
			// A patch must name something; the rows always name their own field.
			await assert.rejects(
				executeDashboardIntent({ method: "setLanguageFilter", payload: {} }, recorded.env),
				/allowed range mode and\/or languages/
			);
			assert.deepStrictEqual(recorded.updates, []);

			// A languages patch writes trimmed and deduplicated, keeping the
			// stored (here: default) block mode.
			await executeDashboardIntent(
				{ method: "setLanguageFilter", payload: { languages: [" typescript ", "python", "typescript"] } },
				recorded.env
			);
			// A mode patch keeps the JUST-WRITTEN languages: the merge reads
			// landed writes, never a caller's stale snapshot.
			await executeDashboardIntent({ method: "setLanguageFilter", payload: { mode: "allow" } }, recorded.env);
			// Allow mode with the empty list is a real configuration (completions
			// run nowhere), so it writes rather than resets.
			await executeDashboardIntent({ method: "setLanguageFilter", payload: { languages: [] } }, recorded.env);
			// Block mode with the empty list IS the default, so patching the mode
			// back resets the setting.
			await executeDashboardIntent({ method: "setLanguageFilter", payload: { mode: "block" } }, recorded.env);

			assert.deepStrictEqual(recorded.updates, [
				["inlineCompletions.languageFilter", { mode: "block", languages: ["typescript", "python"] }],
				["inlineCompletions.languageFilter", { mode: "allow", languages: ["typescript", "python"] }],
				["inlineCompletions.languageFilter", { mode: "allow", languages: [] }],
			]);
			assert.deepStrictEqual(recorded.removals, ["inlineCompletions.languageFilter"]);
		});

		test("every command ID maps to an allow-listed command", async () => {
			const recorded = makeEnv();
			const intents: DashboardIntent[] = [
				{ method: "executeCommand", payload: { command: "openGroupsFile" } },
				{ method: "executeCommand", payload: { command: "testConnection" } },
				{ method: "executeCommand", payload: { command: "openSettings" } },
				{ method: "executeCommand", payload: { command: "reportIssue" } },
				{ method: "executeCommand", payload: { command: "openOutput" } },
				{ method: "executeCommand", payload: { command: "exportSettings" } },
				{ method: "executeCommand", payload: { command: "importSettings" } },
			];
			// Completeness guard: a new dashboard command id must join this table.
			assert.deepStrictEqual(
				intents.map((intent) => (intent.method === "executeCommand" ? intent.payload.command : undefined)),
				[...DASHBOARD_COMMAND_IDS]
			);
			for (const intent of intents) {
				await executeDashboardIntent(intent, recorded.env);
			}

			assert.deepStrictEqual(recorded.commands, [
				["litellm.openGroupsFile"],
				["litellm.testConnection"],
				["workbench.action.openSettings", "@ext:vivswan.litellm-vscode-chat"],
				["litellm.reportIssue"],
				["litellm.openOutput"],
				["litellm.exportSettings"],
				["litellm.importSettings"],
			]);
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
			partial: Partial<RequestPayload<"adoptServer">> = {}
		): Promise<IntentAckNotice | undefined> =>
			executeDashboardIntent(
				{
					method: "adoptServer",
					payload: {
						label: "Adopted",
						baseUrl: "http://ext.test",
						sourceHandle: "handle-ext",
						secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
						...partial,
					},
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
						// The NESTED auth shape the sync engine parses, secure-routed
						// values omitted: a flat credential field would sync
						// credential-less and escape the no-secrets export's strip.
						auth: {
							oauth: {
								tokenUrl: "https://idp.test/token",
								clientId: "client-1",
								scopes: "read write",
								virtualKey: { header: "x-litellm-api-key" },
							},
						},
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
				[{ label: "Adopted", baseUrl: "http://ext.test", auth: { apiKey: "sk-live" } }],
			]);
			assert.deepStrictEqual(recorded.secretOps, [], "nothing goes secure-side when settings was chosen");
		});

		test("the adopted entry is parser-accepted and its group args carry every copied credential", async () => {
			// The healing guarantee by construction: what adopt writes is already
			// the shape the sync engine parses, so the entry serves its
			// credentials immediately, no activation-time restructure needed.
			const recorded = makeEnv([]);
			recorded.adoptionCredentials = FULL_CREDENTIALS;

			await adopt(recorded);

			const written = recorded.serverWrites.at(-1);
			assert.ok(written !== undefined);
			assert.deepStrictEqual(parseServersSetting(written).problems, [], "the adopted entry parses clean");
			const accepted = acceptedEntry(written, "Adopted");
			assert.ok(accepted !== undefined, "the adopted entry is accepted, not just carried");
			const args = buildGroupArgs(accepted.entry, recorded.storedSecrets.get("Adopted") ?? {});
			assert.strictEqual(args.apiKey, "sk-live");
			assert.strictEqual(args.oauthTokenUrl, "https://idp.test/token");
			assert.strictEqual(args.oauthClientId, "client-1");
			assert.strictEqual(args.oauthClientSecret, "oauth-secret");
			assert.strictEqual(args.oauthScopes, "read write");
			assert.strictEqual(args.virtualKeyHeader, "x-litellm-api-key");
			assert.strictEqual(args.virtualKeyValue, "vk-live");
		});

		test("a no-secrets strip of a fully inlined adopted entry certifies and removes every credential", async () => {
			// The export-hole closure: with every secret routed to settings, the
			// adopted entry holds them all inline - and the no-secrets export's
			// strip must reach every one, which only the nested auth shape allows.
			const recorded = makeEnv([]);
			recorded.adoptionCredentials = FULL_CREDENTIALS;

			await adopt(recorded, {
				secrets: { apiKey: "settings", oauthClientSecret: "settings", virtualKeyValue: "settings" },
			});

			const entry = recorded.serverWrites.at(-1)?.[0];
			assert.ok(isRecord(entry));
			const stripped = stripEntrySecrets(entry);
			assert.strictEqual(stripped.unsanitizable, false, "an adopted entry must be exportable without secrets");
			const rendered = JSON.stringify(stripped.entry);
			for (const secret of ["sk-live", "oauth-secret", "vk-live"]) {
				assert.ok(!rendered.includes(secret), `the no-secrets export must not carry ${secret}`);
			}
			assert.deepStrictEqual(stripped.secrets, {
				apiKey: "sk-live",
				oauthClientSecret: "oauth-secret",
				virtualKeyValue: "vk-live",
			});
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

		test("refuses a label collision with a parser-rejected raw entry too", async () => {
			// Adoption always appends; a rejected entry still occupies its label,
			// so appending beside it would land two entries under one label.
			const recorded = makeEnv([{ label: "Adopted", baseUrl: "http://other.test", auth: {} }]);
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

			assert.ok(
				typeof notice === "string" && /could not be read/.test(notice),
				JSON.stringify(notice) ?? "expected a caveat notice"
			);
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
			// serverSync keeps a removed entry's blob on purpose, but an adoption
			// under that label asked for the GROUP's secrets, so leftovers from
			// neither the group nor the user must not resolve for the new entry.
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
				[{ label: "Adopted", baseUrl: "http://ext.test", auth: { apiKey: "sk-live" } }],
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
				{ method: "hideExternalServer", payload: { baseUrl: "http://prod.test", sourceHandle: "handle-1" } },
				recorded.env
			);

			assert.deepStrictEqual(recorded.externalLookups, [["http://prod.test", "handle-1"]]);
			assert.deepStrictEqual(recorded.hidden, [{ label: "Prod", baseUrl: "http://prod.test/" }]);
		});

		test("hideExternalServer refuses an unusable base URL before any lookup", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent(
					{ method: "hideExternalServer", payload: { baseUrl: "not a url", sourceHandle: "h" } },
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
					{ method: "hideExternalServer", payload: { baseUrl: "http://prod.test", sourceHandle: "stale" } },
					recorded.env
				),
				/no longer matches a hideable server/
			);
			assert.deepStrictEqual(recorded.hidden, []);
		});

		test("unhideServer echoes the identity verbatim and fails when no tombstone matched", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent(
				{ method: "unhideServer", payload: { label: "Prod", baseUrl: "http://prod.test" } },
				recorded.env
			);
			assert.deepStrictEqual(recorded.unhidden, [{ label: "Prod", baseUrl: "http://prod.test" }]);

			recorded.unhideResult = false;
			await assert.rejects(
				executeDashboardIntent(
					{ method: "unhideServer", payload: { label: "Ghost", baseUrl: "http://gone.test" } },
					recorded.env
				),
				/No hidden group/
			);
		});

		test("unhideServer refuses a blank label", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent(
					{ method: "unhideServer", payload: { label: "  ", baseUrl: "http://prod.test" } },
					recorded.env
				),
				/label/
			);
			assert.deepStrictEqual(recorded.unhidden, []);
		});
	});
});
