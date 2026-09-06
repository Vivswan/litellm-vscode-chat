/**
 * readDashboardSettings: the settings page's rows, scopes, and diagnostics.
 */
import * as assert from "node:assert";
import { BOOLEAN_SETTING_IDS, NUMBER_SETTING_IDS } from "../../../dashboard/viewModels";
import { FEATURE_MODEL_IDS } from "../../../shared/config/settingSpec";
import { recordFromKeys } from "../../../shared/util/json";
import { makeReader, readSettings } from "./stateHelpers";

suite("extension/dashboard/state: settings", () => {
	suite("readDashboardSettings", () => {
		test("passes configured finite numbers through, even out of range", () => {
			const settings = readSettings(makeReader({ "chat.timeout": 5, "usage.pollInterval": 60000 }));

			assert.strictEqual(settings.numbers["chat.timeout"], 5);
			assert.strictEqual(settings.numbers["usage.pollInterval"], 60000);
		});

		test("falls back to the package.json default for unusable values", () => {
			const settings = readSettings(
				makeReader(
					{ "chat.timeout": "soon", "discovery.timeout": Number.NaN },
					{ "chat.timeout": 300000, "discovery.timeout": 30000 }
				)
			);

			assert.strictEqual(settings.numbers["chat.timeout"], 300000);
			assert.strictEqual(settings.numbers["discovery.timeout"], 30000);
		});

		test("without a usable default, numbers fall back to the minimum", () => {
			const settings = readSettings(makeReader({ "chat.timeout": "soon" }));

			assert.strictEqual(settings.numbers["chat.timeout"], 1000);
		});

		test("booleans pass through and fall back to the default for junk", () => {
			const settings = readSettings(
				makeReader({ "chat.promptCaching": false, "ui.maskSecretInputs": "yes" }, { "ui.maskSecretInputs": true })
			);

			assert.strictEqual(settings.booleans["chat.promptCaching"], false);
			assert.strictEqual(settings.booleans["ui.maskSecretInputs"], true);
		});

		test("the currency symbol pushes verbatim - empty included - with junk reading as the default", () => {
			const spaced = readSettings(makeReader({ "usage.currencySymbol": "EUR " }));
			assert.strictEqual(spaced.usage.currencySymbol, "EUR ");
			assert.strictEqual(spaced.usage.currencySymbolScope, "global");

			const empty = readSettings(makeReader({ "usage.currencySymbol": "" }));
			assert.strictEqual(empty.usage.currencySymbol, "");

			const junk = readSettings(makeReader({ "usage.currencySymbol": 7 }));
			assert.strictEqual(junk.usage.currencySymbol, "$");

			const unset = readSettings(makeReader({}));
			assert.strictEqual(unset.usage.currencySymbol, "$");
			assert.strictEqual(unset.usage.currencySymbolScope, null);
		});

		test("every catalog entry is present in the snapshot", () => {
			const settings = readSettings(makeReader({}));

			for (const id of NUMBER_SETTING_IDS) {
				assert.ok(id in settings.numbers, `missing number setting ${id}`);
				assert.ok(id in settings.configuredScopes.numbers, `missing number scope ${id}`);
			}
			for (const id of BOOLEAN_SETTING_IDS) {
				assert.ok(id in settings.booleans, `missing boolean setting ${id}`);
				assert.ok(id in settings.configuredScopes.booleans, `missing boolean scope ${id}`);
			}
		});

		test("configuredScopes carry the highest scope that sets the key, or null when only the default applies", () => {
			const settings = readSettings(
				makeReader(
					{ "chat.timeout": 60000, "ui.maskSecretInputs": true },
					{},
					{
						"discovery.timeout": { workspaceValue: 5000 },
						"discovery.cacheTtl": { globalValue: 1, workspaceValue: 2, workspaceFolderValue: 3 },
					}
				)
			);

			assert.strictEqual(settings.configuredScopes.numbers["chat.timeout"], "global");
			assert.strictEqual(settings.configuredScopes.numbers["discovery.timeout"], "workspace");
			assert.strictEqual(settings.configuredScopes.numbers["discovery.cacheTtl"], "workspaceFolder");
			assert.strictEqual(settings.configuredScopes.numbers["usage.pollInterval"], null);
			assert.strictEqual(settings.configuredScopes.booleans["ui.maskSecretInputs"], "global");
			assert.strictEqual(settings.configuredScopes.booleans["chat.promptCaching"], null);
		});

		test("a value pinned to exactly its default still counts as configured", () => {
			const settings = readSettings(makeReader({ "chat.timeout": 300000 }, { "chat.timeout": 300000 }));

			assert.strictEqual(settings.numbers["chat.timeout"], 300000);
			assert.strictEqual(settings.configuredScopes.numbers["chat.timeout"], "global");
		});

		test("records come from the edit scope's own value, never the merged one", () => {
			const settings = readSettings(
				makeReader(
					{ "models.parameters": { "gpt-4": { temperature: 0.1 }, "gpt-5": { temperature: 0.2 } } },
					{},
					{
						"models.parameters": {
							globalValue: { "gpt-4": { temperature: 0.1 } },
							workspaceValue: { "gpt-5": { temperature: 0.2 } },
						},
					}
				)
			);

			assert.strictEqual(settings.modelParameters.editScope, "workspace");
			assert.deepStrictEqual(
				settings.modelParameters.value,
				{ "gpt-5": { temperature: 0.2 } },
				"the user-scope value must not leak in"
			);
			assert.deepStrictEqual(settings.modelParameters.otherScopes, [
				{ scope: "global", value: { "gpt-4": { temperature: 0.1 } } },
			]);
		});

		test("records default to the user scope when only it holds a value", () => {
			const settings = readSettings(
				makeReader({}, {}, { "models.parameters": { globalValue: { "gpt-4": { temperature: 0.2 } } } })
			);

			assert.strictEqual(settings.modelParameters.editScope, "global");
			assert.deepStrictEqual(settings.modelParameters.value, { "gpt-4": { temperature: 0.2 } });
			assert.deepStrictEqual(settings.modelParameters.otherScopes, []);
		});

		test("a workspace-folder record shows up read-only and never becomes the edit scope", () => {
			const settings = readSettings(
				makeReader({}, {}, { "models.parameters": { workspaceFolderValue: { "gpt-4": { temperature: 0.2 } } } })
			);

			assert.strictEqual(settings.modelParameters.editScope, "global");
			assert.deepStrictEqual(settings.modelParameters.otherScopes, [
				{ scope: "workspaceFolder", value: { "gpt-4": { temperature: 0.2 } } },
			]);
		});

		test("modelParameters drops malformed and prototype-polluting entries but keeps the rest", () => {
			const settings = readSettings(
				makeReader(
					{},
					{},
					{
						"models.parameters": {
							globalValue: JSON.parse(
								'{"gpt-4": {"temperature": 0.2}, "broken": "not-an-object", "__proto__": {"polluted": true}}'
							) as unknown,
						},
					}
				)
			);

			assert.deepStrictEqual(settings.modelParameters.value, { "gpt-4": { temperature: 0.2 } });
		});

		test("a non-object modelParameters value reads as empty", () => {
			const settings = readSettings(makeReader({}, {}, { "models.parameters": { globalValue: [1, 2] } }));

			assert.deepStrictEqual(settings.modelParameters.value, {});
		});

		test("effective is the scope-merged read (reader.get), normalized like the request path", () => {
			// makeReader's get() stands in for VS Code's cross-scope merge while the
			// per-scope records come from inspect: the inspector must see the merged
			// record even when the edit scope holds only part of it.
			const settings = readSettings(
				makeReader(
					{ "models.parameters": { "gpt-4": { temperature: 0.2 }, bad: 7 } },
					{},
					{ "models.parameters": { workspaceValue: { "gpt-4": { temperature: 0.2 } } } }
				)
			);
			assert.deepStrictEqual(settings.modelParameters.effective, { "gpt-4": { temperature: 0.2 } });
			assert.strictEqual(settings.modelParameters.editScope, "workspace");
		});

		test("feature model refs snapshot per feature: normalized with scopes, malformed and unset as null", () => {
			const settings = readSettings(
				makeReader({
					"inlineCompletions.model": { server: " Prod ", model: " codestral " },
					"commitGeneration.model": { server: "Prod" },
				})
			);
			// One record entry per FEATURE_MODEL_IDS member, the unconfigured
			// features included: recordFromKeys totals the snapshot by construction.
			const unsetRefs = recordFromKeys(FEATURE_MODEL_IDS, () => null);
			assert.deepStrictEqual(settings.featureModels, {
				...unsetRefs,
				inlineCompletions: { server: "Prod", model: "codestral" },
			});
			assert.deepStrictEqual(settings.featureModelScopes, {
				...unsetRefs,
				inlineCompletions: "global",
				commitGeneration: "global",
			});

			const unset = readSettings(makeReader({}));
			assert.deepStrictEqual(unset.featureModels, unsetRefs);
			assert.deepStrictEqual(unset.featureModelScopes, unsetRefs);
		});

		test("the commit prompt snapshots verbatim; a junk value reads as the built-in marker", () => {
			const set = readSettings(makeReader({ "commitGeneration.prompt": "Subject only. " }));
			assert.strictEqual(set.commitPrompt, "Subject only. ");
			assert.strictEqual(set.commitPromptScope, "global");
			const junk = readSettings(makeReader({ "commitGeneration.prompt": 7 }));
			assert.strictEqual(junk.commitPrompt, "");
			assert.strictEqual(readSettings(makeReader({})).commitPromptScope, null);
		});

		test("the commit prompt CR-normalizes at the state boundary alone: the webview drafts in LF", () => {
			// A CRLF (or bare-CR) settings.json prompt would never compare equal to
			// the textarea's own LF round trip, reading as a permanently modified
			// draft on every push; the first dashboard edit rewrites the stored
			// value to LF. The REQUEST path stays verbatim (model-facing text) -
			// getCommitGenerationPrompt is pinned separately in settings.test.ts.
			const crlf = readSettings(makeReader({ "commitGeneration.prompt": "Subject.\r\nBody line.\rTail." }));
			assert.strictEqual(crlf.commitPrompt, "Subject.\nBody line.\nTail.");
		});

		test("the language filter snapshots normalized, and the lossy flag marks exactly the raw values an edit would rewrite", () => {
			// The flag is what stands between a hand-written settings.json filter
			// and a dashboard edit silently canonicalizing it: any drop, trim,
			// dedupe, unrecognized mode, or extra key marks the filter lossy and
			// its rows fall back to read-only.
			const clean = readSettings(
				makeReader({ "inlineCompletions.languageFilter": { mode: "allow", languages: ["typescript", "python"] } })
			);
			assert.deepStrictEqual(clean.languageFilter, {
				mode: "allow",
				languages: { values: ["typescript", "python"], lossy: false, scope: "global" },
			});
			assert.deepStrictEqual(readSettings(makeReader({})).languageFilter, {
				mode: "block",
				languages: { values: [], lossy: false, scope: null },
			});
			// A missing languages list reads as the clean empty list: writing
			// { mode, languages: [] } back is equivalent configuration.
			const bare = readSettings(makeReader({ "inlineCompletions.languageFilter": { mode: "allow" } }));
			assert.deepStrictEqual(bare.languageFilter, {
				mode: "allow",
				languages: { values: [], lossy: false, scope: "global" },
			});

			const lossyCases: readonly [string, unknown, string, readonly string[]][] = [
				["edge whitespace rewrites", { mode: "block", languages: [" typescript "] }, "block", ["typescript"]],
				["duplicates collapse", { mode: "block", languages: ["ts", "ts"] }, "block", ["ts"]],
				["non-strings drop", { mode: "allow", languages: ["ts", 3] }, "allow", ["ts"]],
				["a non-array list reads as empty", { mode: "block", languages: "markdown" }, "block", []],
				["an unrecognized mode reads as the default", { mode: "deny", languages: ["ts"] }, "block", []],
				["a non-object reads as the default", "markdown", "block", []],
				["extra keys a rewrite would drop", { mode: "block", languages: [], legacy: true }, "block", []],
			];
			for (const [name, raw, mode, values] of lossyCases) {
				const settings = readSettings(makeReader({ "inlineCompletions.languageFilter": raw }));
				assert.deepStrictEqual(
					settings.languageFilter,
					{ mode, languages: { values, lossy: true, scope: "global" } },
					name
				);
			}
		});

		test("the keywords lossy flag rides the same rule (the shared normalizedListLossy)", () => {
			const clean = readSettings(makeReader({ "chat.additionalToolSchemaKeywords": ["propertyNames"] }));
			assert.strictEqual(clean.chat.additionalToolSchemaKeywords.lossy, false);
			const lossy = readSettings(makeReader({ "chat.additionalToolSchemaKeywords": ["propertyNames", ""] }));
			assert.strictEqual(lossy.chat.additionalToolSchemaKeywords.lossy, true);
			assert.deepStrictEqual(lossy.chat.additionalToolSchemaKeywords.values, ["propertyNames"]);
		});
	});
});
