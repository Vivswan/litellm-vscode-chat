import * as assert from "node:assert";
import {
	BOOLEAN_SETTING_IDS,
	formatHeaderValue,
	NUMBER_SETTING_IDS,
	parseHeaderValue,
	parseJsonValue,
} from "../../../extension/dashboard/protocol";
import type { DashboardIntent, SettingsInspection, SettingsReader } from "../../../extension/dashboard/state";
import {
	buildDashboardState,
	executeDashboardIntent,
	readDashboardSettings,
	resolveUpdateScope,
	validateHeadersRecord,
	validateModelParametersRecord,
	validateNumberSetting,
	webviewMessageSchema,
} from "../../../extension/dashboard/state";
import { REASONING_EFFORT_SCHEMA } from "../../../provider/modelConfiguration";
import { makeModelInfo, makeServerStatus } from "../../testUtils";

/**
 * A SettingsReader over fixture values: `values` back get() and double as the
 * global scope, `defaults` mirror package.json, and `scopes` sets per-scope
 * values explicitly for the scoped-record tests.
 */
function makeReader(
	values: Record<string, unknown>,
	defaults: Record<string, unknown> = {},
	scopes: Record<string, Omit<SettingsInspection, "defaultValue">> = {}
): SettingsReader {
	return {
		get: (key) => values[key],
		inspect: (key) => ({
			defaultValue: defaults[key],
			...(Object.hasOwn(values, key) ? { globalValue: values[key] } : {}),
			...scopes[key],
		}),
	};
}

interface RecordedEnv {
	updates: [string, unknown][];
	commands: [string, ...unknown[]][];
	env: {
		updateSetting(key: string, value: unknown): Promise<void>;
		executeCommand(command: string, ...args: readonly unknown[]): Thenable<unknown>;
	};
}

function makeEnv(): RecordedEnv {
	const updates: [string, unknown][] = [];
	const commands: [string, ...unknown[]][] = [];
	return {
		updates,
		commands,
		env: {
			updateSetting: async (key, value) => {
				updates.push([key, value]);
			},
			executeCommand: async (command, ...args) => {
				commands.push([command, ...args]);
			},
		},
	};
}

suite("extension/dashboard/state", () => {
	suite("buildDashboardState", () => {
		test("maps server statuses to dashboard servers, sorted by label", () => {
			const state = buildDashboardState(
				[
					{ status: makeServerStatus({ serverId: "b", label: "Zeta", hasApiKey: true }), models: [] },
					{
						status: makeServerStatus({
							serverId: "a",
							label: "Alpha",
							state: "error",
							error: "boom",
							modelCount: 0,
						}),
						models: [],
					},
				],
				makeReader({})
			);

			assert.deepStrictEqual(
				state.servers.map((s) => s.label),
				["Alpha", "Zeta"]
			);
			assert.strictEqual(state.servers[0]?.state, "error");
			assert.strictEqual(state.servers[0]?.error, "boom");
			assert.strictEqual(state.servers[0]?.hasApiKey, false, "absent hasApiKey narrows to false");
			assert.strictEqual(state.servers[1]?.hasApiKey, true);
			assert.strictEqual(state.servers[1]?.baseUrl, "http://prod.test");
			assert.strictEqual(state.servers[1]?.lastChecked, "2026-07-26T00:00:00.000Z");
		});

		test("colliding server labels get positional suffixes, on the servers and their models", () => {
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({ serverId: "s1", label: "litellm.test", baseUrl: "http://litellm.test" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						status: makeServerStatus({ serverId: "s2", label: "litellm.test", baseUrl: "http://litellm.test" }),
						models: [makeModelInfo({ id: "m2", name: "m2" })],
					},
					{ status: makeServerStatus({ serverId: "s3", label: "Other" }), models: [] },
				],
				makeReader({})
			);

			assert.deepStrictEqual(
				state.servers.map((s) => s.label),
				["litellm.test (1)", "litellm.test (2)", "Other"]
			);
			assert.deepStrictEqual(
				state.models.map((m) => m.serverLabel),
				["litellm.test (1)", "litellm.test (2)"]
			);
		});

		test("no serverId reaches the state", () => {
			const state = buildDashboardState(
				[{ status: makeServerStatus({ serverId: "group:secret-fingerprint:http://x" }), models: [makeModelInfo()] }],
				makeReader({})
			);

			assert.ok(!JSON.stringify(state).includes("secret-fingerprint"));
		});

		test("maps model infos to display facts including pricing and badges", () => {
			const info = makeModelInfo({
				id: "claude",
				name: "claude",
				family: "anthropic",
				inputCost: 3,
				outputCost: 15,
				cacheCost: 0.3,
				cacheWriteCost: 3.75,
				capabilities: { toolCalling: true, imageInput: true },
				configurationSchema: REASONING_EFFORT_SCHEMA,
				litellm: { supportsPromptCaching: true, outputLimitSource: "provider" },
			});
			const state = buildDashboardState([{ status: makeServerStatus(), models: [info] }], makeReader({}));

			assert.strictEqual(state.models.length, 1);
			const model = state.models[0];
			assert.deepStrictEqual(model, {
				id: "claude",
				name: "claude",
				family: "anthropic",
				serverLabel: "Prod",
				maxInputTokens: 100000,
				maxOutputTokens: 8000,
				inputCost: 3,
				outputCost: 15,
				cacheReadCost: 0.3,
				cacheWriteCost: 3.75,
				toolCalling: true,
				imageInput: true,
				promptCaching: true,
				reasoning: true,
			});
		});

		test("models without pricing or capabilities stay minimal", () => {
			const state = buildDashboardState([{ status: makeServerStatus(), models: [makeModelInfo()] }], makeReader({}));

			const model = state.models[0];
			assert.strictEqual(model?.inputCost, undefined);
			assert.strictEqual(model?.toolCalling, false);
			assert.strictEqual(model?.imageInput, false);
			assert.strictEqual(model?.promptCaching, false);
			assert.strictEqual(model?.reasoning, false);
		});

		test("models from several servers are flattened and sorted by server label then name", () => {
			const state = buildDashboardState(
				[
					{
						status: makeServerStatus({ serverId: "srv2", label: "Zeta" }),
						models: [makeModelInfo({ id: "m1", name: "m1" })],
					},
					{
						status: makeServerStatus({ serverId: "srv1", label: "Alpha" }),
						models: [makeModelInfo({ id: "b", name: "b" }), makeModelInfo({ id: "a", name: "a" })],
					},
				],
				makeReader({})
			);

			assert.deepStrictEqual(
				state.models.map((m) => `${m.serverLabel}/${m.name}`),
				["Alpha/a", "Alpha/b", "Zeta/m1"]
			);
		});
	});

	suite("readDashboardSettings", () => {
		test("passes configured finite numbers through, even out of range", () => {
			const settings = readDashboardSettings(makeReader({ requestTimeout: 5, defaultMaxOutputTokens: 32000 }));

			assert.strictEqual(settings.numbers.requestTimeout, 5);
			assert.strictEqual(settings.numbers.defaultMaxOutputTokens, 32000);
		});

		test("falls back to the package.json default for unusable values", () => {
			const settings = readDashboardSettings(
				makeReader(
					{ requestTimeout: "soon", discoveryTimeout: Number.NaN },
					{ requestTimeout: 300000, discoveryTimeout: 30000 }
				)
			);

			assert.strictEqual(settings.numbers.requestTimeout, 300000);
			assert.strictEqual(settings.numbers.discoveryTimeout, 30000);
		});

		test("without a usable default, non-nullable numbers fall back to the minimum and nullable ones to null", () => {
			const settings = readDashboardSettings(makeReader({ requestTimeout: "soon", defaultMaxInputTokens: "many" }));

			assert.strictEqual(settings.numbers.requestTimeout, 1000);
			assert.strictEqual(settings.numbers.defaultMaxInputTokens, null);
		});

		test("nullable numbers keep null and configured values", () => {
			assert.strictEqual(
				readDashboardSettings(makeReader({ defaultMaxInputTokens: null })).numbers.defaultMaxInputTokens,
				null
			);
			assert.strictEqual(
				readDashboardSettings(makeReader({ defaultMaxInputTokens: 90000 })).numbers.defaultMaxInputTokens,
				90000
			);
		});

		test("booleans pass through and fall back to the default for junk", () => {
			const settings = readDashboardSettings(
				makeReader({ "promptCaching.enabled": false, maskApiKeyInput: "yes" }, { maskApiKeyInput: true })
			);

			assert.strictEqual(settings.booleans["promptCaching.enabled"], false);
			assert.strictEqual(settings.booleans.maskApiKeyInput, true);
		});

		test("every catalog entry is present in the snapshot", () => {
			const settings = readDashboardSettings(makeReader({}));

			for (const id of NUMBER_SETTING_IDS) {
				assert.ok(id in settings.numbers, `missing number setting ${id}`);
			}
			for (const id of BOOLEAN_SETTING_IDS) {
				assert.ok(id in settings.booleans, `missing boolean setting ${id}`);
			}
		});

		test("records come from the edit scope's own value, never the merged one", () => {
			const settings = readDashboardSettings(
				makeReader(
					{ headers: { "x-user": "secret", "x-shared": "team" } },
					{},
					{
						headers: {
							globalValue: { "x-user": "secret" },
							workspaceValue: { "x-shared": "team" },
						},
					}
				)
			);

			assert.strictEqual(settings.headers.editScope, "workspace");
			assert.deepStrictEqual(settings.headers.value, { "x-shared": "team" }, "the user-scope secret must not leak in");
			assert.deepStrictEqual(settings.headers.otherScopes, [{ scope: "global", value: { "x-user": "secret" } }]);
		});

		test("records default to the user scope when only it holds a value", () => {
			const settings = readDashboardSettings(
				makeReader({}, {}, { modelParameters: { globalValue: { "gpt-4": { temperature: 0.2 } } } })
			);

			assert.strictEqual(settings.modelParameters.editScope, "global");
			assert.deepStrictEqual(settings.modelParameters.value, { "gpt-4": { temperature: 0.2 } });
			assert.deepStrictEqual(settings.modelParameters.otherScopes, []);
		});

		test("a workspace-folder record shows up read-only and never becomes the edit scope", () => {
			const settings = readDashboardSettings(
				makeReader({}, {}, { headers: { workspaceFolderValue: { "x-folder": "v" } } })
			);

			assert.strictEqual(settings.headers.editScope, "global");
			assert.deepStrictEqual(settings.headers.otherScopes, [{ scope: "workspaceFolder", value: { "x-folder": "v" } }]);
		});

		test("modelParameters drops malformed and prototype-polluting entries but keeps the rest", () => {
			const settings = readDashboardSettings(
				makeReader(
					{},
					{},
					{
						modelParameters: {
							globalValue: JSON.parse(
								'{"gpt-4": {"temperature": 0.2}, "broken": "not-an-object", "__proto__": {"polluted": true}}'
							) as unknown,
						},
					}
				)
			);

			assert.deepStrictEqual(settings.modelParameters.value, { "gpt-4": { temperature: 0.2 } });
		});

		test("headers keep configured scalar types and drop non-scalars and unsafe keys", () => {
			const settings = readDashboardSettings(
				makeReader(
					{},
					{},
					{
						headers: {
							globalValue: JSON.parse(
								'{"x-key": "abc", "x-count": 2, "x-flag": true, "x-bad": {"nested": 1}, "__proto__": {"polluted": true}}'
							) as unknown,
						},
					}
				)
			);

			assert.deepStrictEqual(settings.headers.value, { "x-key": "abc", "x-count": 2, "x-flag": true });
		});

		test("a non-object headers or modelParameters value reads as empty", () => {
			const settings = readDashboardSettings(
				makeReader({}, {}, { headers: { globalValue: 7 }, modelParameters: { globalValue: [1, 2] } })
			);

			assert.deepStrictEqual(settings.headers.value, {});
			assert.deepStrictEqual(settings.modelParameters.value, {});
		});
	});

	suite("resolveUpdateScope", () => {
		test("workspace when the workspace holds a value, user scope otherwise", () => {
			assert.strictEqual(resolveUpdateScope({ workspaceValue: 2 }), "workspace");
			assert.strictEqual(resolveUpdateScope({}), "global");
			assert.strictEqual(resolveUpdateScope(undefined), "global");
		});

		test("never returns workspaceFolder: resource-less folder updates would throw", () => {
			const inspection: SettingsInspection = { workspaceFolderValue: 1 };
			assert.strictEqual(resolveUpdateScope(inspection), "global");
		});
	});

	suite("webviewMessageSchema", () => {
		test("accepts every intent shape", () => {
			const intents: unknown[] = [
				{ type: "ready" },
				{ type: "setNumberSetting", setting: "requestTimeout", value: 60000 },
				{ type: "setNumberSetting", setting: "defaultMaxInputTokens", value: null },
				{ type: "setBooleanSetting", setting: "promptCaching.enabled", value: false },
				{ type: "setModelParameters", value: { "gpt-4": { temperature: 0.2, stop: ["\n"] } } },
				{ type: "setHeaders", value: { "x-key": "v", "x-n": 2, "x-b": true } },
				{ type: "executeCommand", command: "syncModels" },
			];
			for (const intent of intents) {
				assert.ok(webviewMessageSchema.safeParse(intent).success, `rejected ${JSON.stringify(intent)}`);
			}
		});

		test("rejects unknown types, unknown settings, unknown commands, and extra fields", () => {
			const rejected: unknown[] = [
				null,
				"ready",
				{ type: "detonate" },
				{ type: "setNumberSetting", setting: "notASetting", value: 1 },
				{ type: "setNumberSetting", setting: "requestTimeout", value: "1000" },
				{ type: "setNumberSetting", setting: "requestTimeout", value: Number.POSITIVE_INFINITY },
				{ type: "setBooleanSetting", setting: "promptCaching.enabled", value: "true" },
				{ type: "setHeaders", value: { "x-bad": { nested: true } } },
				{ type: "executeCommand", command: "workbench.action.terminal.sendSequence" },
				{ type: "ready", extra: 1 },
			];
			for (const message of rejected) {
				assert.strictEqual(
					webviewMessageSchema.safeParse(message).success,
					false,
					`accepted ${JSON.stringify(message)}`
				);
			}
		});
	});

	suite("intent value validation", () => {
		test("validateNumberSetting enforces the per-setting minimum", () => {
			assert.notStrictEqual(validateNumberSetting("requestTimeout", 999), undefined);
			assert.strictEqual(validateNumberSetting("requestTimeout", 1000), undefined);
			assert.strictEqual(validateNumberSetting("discoveryCacheTtl", 0), undefined);
		});

		test("null is legal only for nullable settings", () => {
			assert.strictEqual(validateNumberSetting("defaultMaxInputTokens", null), undefined);
			assert.notStrictEqual(validateNumberSetting("requestTimeout", null), undefined);
		});

		test("validateHeadersRecord enforces the request path's rules", () => {
			assert.strictEqual(validateHeadersRecord({ "x-litellm-api-key": "v", "x-n": 2 }), undefined);
			assert.notStrictEqual(validateHeadersRecord({ "bad name": "v" }), undefined, "spaces are not token chars");
			assert.notStrictEqual(validateHeadersRecord({ "x-key": "a\nb" }), undefined, "no line breaks in values");
			assert.notStrictEqual(
				validateHeadersRecord(JSON.parse('{"__proto__": "v"}') as Record<string, string>),
				undefined
			);
		});

		test("validateModelParametersRecord refuses prototype-polluting keys at both levels", () => {
			assert.strictEqual(validateModelParametersRecord({ "gpt-4": { temperature: 0.2 } }), undefined);
			assert.notStrictEqual(
				validateModelParametersRecord(JSON.parse('{"__proto__": {}}') as Record<string, Record<string, unknown>>),
				undefined
			);
			assert.notStrictEqual(
				validateModelParametersRecord(
					JSON.parse('{"gpt-4": {"constructor": 1}}') as Record<string, Record<string, unknown>>
				),
				undefined
			);
		});
	});

	suite("executeDashboardIntent", () => {
		test("setNumberSetting writes the setting key verbatim", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent(
				{ type: "setNumberSetting", setting: "requestTimeout", value: 120000 },
				recorded.env
			);

			assert.deepStrictEqual(recorded.updates, [["requestTimeout", 120000]]);
			assert.deepStrictEqual(recorded.commands, []);
		});

		test("setNumberSetting refuses values below the minimum without writing", async () => {
			const recorded = makeEnv();
			await assert.rejects(
				executeDashboardIntent({ type: "setNumberSetting", setting: "requestTimeout", value: 1 }, recorded.env)
			);

			assert.deepStrictEqual(recorded.updates, []);
		});

		test("setBooleanSetting writes the dotted key", async () => {
			const recorded = makeEnv();
			await executeDashboardIntent(
				{ type: "setBooleanSetting", setting: "promptCaching.enabled", value: false },
				recorded.env
			);

			assert.deepStrictEqual(recorded.updates, [["promptCaching.enabled", false]]);
		});

		test("setModelParameters and setHeaders write the whole record", async () => {
			const recorded = makeEnv();
			const params = { "gpt-4": { temperature: 0.2 } };
			const headers = { "x-key": "v" };
			await executeDashboardIntent({ type: "setModelParameters", value: params }, recorded.env);
			await executeDashboardIntent({ type: "setHeaders", value: headers }, recorded.env);

			assert.deepStrictEqual(recorded.updates, [
				["modelParameters", params],
				["headers", headers],
			]);
		});

		test("record intents that fail validation write nothing", async () => {
			const recorded = makeEnv();
			await assert.rejects(executeDashboardIntent({ type: "setHeaders", value: { "bad name": "v" } }, recorded.env));
			await assert.rejects(
				executeDashboardIntent(
					{
						type: "setModelParameters",
						value: JSON.parse('{"__proto__": {}}') as Record<string, Record<string, unknown>>,
					},
					recorded.env
				)
			);

			assert.deepStrictEqual(recorded.updates, []);
		});

		test("every command ID maps to an allow-listed command", async () => {
			const recorded = makeEnv();
			const intents: DashboardIntent[] = [
				{ type: "executeCommand", command: "manageServers" },
				{ type: "executeCommand", command: "syncModels" },
				{ type: "executeCommand", command: "testConnection" },
				{ type: "executeCommand", command: "showDiagnostics" },
				{ type: "executeCommand", command: "openSettings" },
			];
			for (const intent of intents) {
				await executeDashboardIntent(intent, recorded.env);
			}

			assert.deepStrictEqual(recorded.commands, [
				["litellm.manageServers"],
				["litellm.syncModels"],
				["litellm.testConnection"],
				["litellm.showDiagnostics"],
				["workbench.action.openSettings", "@ext:vivswan.litellm-vscode-chat"],
			]);
		});
	});

	suite("protocol value helpers", () => {
		test("parseJsonValue is strict JSON with an error for junk and empty input", () => {
			assert.deepStrictEqual(parseJsonValue("0.2"), { ok: true, value: 0.2 });
			assert.deepStrictEqual(parseJsonValue(' ["stop"] '), { ok: true, value: ["stop"] });
			assert.strictEqual(parseJsonValue("hello").ok, false);
			assert.strictEqual(parseJsonValue("").ok, false);
		});

		test("parseHeaderValue takes JSON scalars typed and everything else as the literal string", () => {
			assert.strictEqual(parseHeaderValue("true"), true);
			assert.strictEqual(parseHeaderValue("42"), 42);
			assert.strictEqual(parseHeaderValue('"42"'), "42");
			assert.strictEqual(parseHeaderValue("abc def"), "abc def");
			assert.strictEqual(parseHeaderValue("[1]"), "[1]", "non-scalar JSON stays a string");
		});

		test("formatHeaderValue round-trips through parseHeaderValue", () => {
			const values = [true, 42, "42", "true", "plain", "x y"] as const;
			for (const value of values) {
				assert.strictEqual(parseHeaderValue(formatHeaderValue(value)), value);
			}
		});
	});
});
