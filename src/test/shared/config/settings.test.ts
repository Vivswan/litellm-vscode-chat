import * as assert from "node:assert";
import * as vscode from "vscode";
import { WIRE_LIMITS } from "../../../dashboard/endpoints";
import { parseHeaderValue, parseJsonValue, parseNumberDraft, parseThresholdBox } from "../../../dashboard/presenters";
import { parseCatalogIdText, parseHeaderRows, parseInheritKeysText } from "../../../dashboard/recordDraft";
import { parseBudgetText, parseDeclaredModelsText } from "../../../dashboard/serverForm";
import { assembleEntryAuth } from "../../../extension/dashboard/entryAuth";
import { parseAgentToolInput } from "../../../extension/features/agentTools/inputSchema";
import { buildCommitPrompt } from "../../../extension/features/commitGen/commitMessage";
import { transformEntryRecord } from "../../../extension/migrations/settingsRedesign/records";
import { parseServersSetting } from "../../../extension/servers/serverSync/setting";
import { planSettingsImport, resolveImportPlan } from "../../../extension/settingsTransfer/importPlan";
import { parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import { parseCapabilityRecord } from "../../../shared/config/capabilityResolution";
import {
	ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY,
	BOOLEAN_SETTING_SPECS,
	CONFIG_SECTION,
	CURRENCY_SYMBOL_SETTING_KEY,
	DEFAULT_CURRENCY_SYMBOL,
	DEFAULT_INLINE_LANGUAGE_FILTER,
	DEFAULT_TOKEN_ESTIMATION_MODE,
	DEFAULT_UI_ACCENT,
	DEFAULT_UI_THEME,
	FEATURE_ENABLE_SETTING_KEYS,
	FEATURE_IDS,
	MAX_TIMER_MS,
	MIN_USAGE_POLL_INTERVAL_MS,
	TOKEN_ESTIMATION_MODES,
	TOKEN_ESTIMATION_SETTING_KEY,
	UI_ACCENT_SETTING_KEY,
	UI_ACCENTS,
	UI_THEME_SETTING_KEY,
	UI_THEMES,
} from "../../../shared/config/settingSpec";
import {
	DEFAULT_DISCOVERY_CACHE_TTL_MS,
	DEFAULT_DISCOVERY_TIMEOUT_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	getAdditionalToolSchemaKeywords,
	getCommitGenerationPrompt,
	getCurrencySymbol,
	getDiscoveryCacheTtl,
	getDiscoveryTimeout,
	getFeatureModelRef,
	getInlineLanguageFilter,
	getMaxToolsPerRequest,
	getModelCapabilitiesConfig,
	getModelParametersConfig,
	getRequestTimeout,
	getTokenEstimationMode,
	getUiAccent,
	getUiTheme,
	getUsageInitialRefreshDelayMs,
	getUsagePollIntervalMs,
	getUsagePollingOffFreshnessWindowMs,
	getUsageServersChangeRefreshDelayMs,
	isFeatureEnabled,
	logRecordShapeProblems,
	MIN_TIMEOUT_MS,
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	normalizeAdditionalToolSchemaKeywords,
	normalizeCommitGenerationPrompt,
	normalizeCurrencySymbol,
	normalizeCustomHeaders,
	normalizeFeatureModelRef,
	normalizeInlineLanguageFilter,
	normalizeModelCapabilities,
	normalizeTokenEstimationMode,
	normalizeUiAccent,
	normalizeUiTheme,
	resetRecordShapeReports,
} from "../../../shared/config/settings";
import { usableHttpText } from "../../../shared/util/headers";
import { normalizePositiveNumber } from "../../../shared/util/numbers";
import { withConfig } from "../../testUtils";

suite("shared/config/settings timeout getters", () => {
	test("pass valid timeouts through without logging", async () => {
		const logged: unknown[] = [];
		await withConfig({ "discovery.timeout": 5000 }, () => {
			assert.strictEqual(
				getDiscoveryTimeout(() => logged.push(true)),
				5000
			);
		});
		assert.strictEqual(logged.length, 0);
	});

	test("use the default when nothing is configured", async () => {
		await withConfig({}, () => {
			assert.strictEqual(getDiscoveryTimeout(), DEFAULT_DISCOVERY_TIMEOUT_MS);
			assert.strictEqual(getRequestTimeout(), DEFAULT_REQUEST_TIMEOUT_MS);
		});
	});

	test("a value outside the contract reads as the default, logged with the key and the bound, never clamped", async () => {
		// 2^31 made setTimeout and AbortSignal.timeout fire after 1 ms (every request timed out at once); 2^32 and a
		// fraction made AbortSignal.timeout throw a RangeError.
		for (const configured of [500, 2 ** 31, 2 ** 32, 1000.5]) {
			const logged: { msg: string; data?: unknown }[] = [];
			await withConfig({ "chat.timeout": configured }, () => {
				assert.strictEqual(
					getRequestTimeout((msg, data) => logged.push({ msg, data })),
					DEFAULT_REQUEST_TIMEOUT_MS
				);
			});
			assert.deepStrictEqual(logged, [
				{
					msg: `chat.timeout must be a whole number between ${MIN_TIMEOUT_MS} and ${MAX_TIMER_MS}; using the default`,
					data: { configured },
				},
			]);
		}
	});

	test("fall back to the default for NaN", async () => {
		const logged: unknown[] = [];
		await withConfig({ "discovery.timeout": Number.NaN }, () => {
			assert.strictEqual(
				getDiscoveryTimeout(() => logged.push(true)),
				DEFAULT_DISCOVERY_TIMEOUT_MS
			);
		});
		assert.strictEqual(logged.length, 1);
	});

	test("fall back to the default for non-finite and non-number values", async () => {
		for (const raw of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "5000", undefined]) {
			const logged: unknown[] = [];
			await withConfig({ "discovery.timeout": raw }, () => {
				assert.strictEqual(
					getDiscoveryTimeout(() => logged.push(true)),
					DEFAULT_DISCOVERY_TIMEOUT_MS,
					`configured value ${String(raw)} must fall back to the default`
				);
			});
			assert.strictEqual(logged.length, 1, `configured value ${String(raw)} must be logged`);
		}
	});
});

suite("shared/config/settings getDiscoveryCacheTtl", () => {
	test("passes valid values through without logging, including 0", async () => {
		const logged: unknown[] = [];
		await withConfig({ "discovery.cacheTtl": 60000 }, () => {
			assert.strictEqual(
				getDiscoveryCacheTtl(() => logged.push(true)),
				60000
			);
		});
		await withConfig({ "discovery.cacheTtl": 0 }, () => {
			assert.strictEqual(
				getDiscoveryCacheTtl(() => logged.push(true)),
				0
			);
		});
		assert.strictEqual(logged.length, 0);
	});

	test("uses the default when nothing is configured", async () => {
		await withConfig({}, () => {
			assert.strictEqual(getDiscoveryCacheTtl(), DEFAULT_DISCOVERY_CACHE_TTL_MS);
		});
	});

	test("a negative TTL reads as the default and is logged with the key and the bound", async () => {
		const logged: { msg: string; data?: unknown }[] = [];
		await withConfig({ "discovery.cacheTtl": -5 }, () => {
			assert.strictEqual(
				getDiscoveryCacheTtl((msg, data) => logged.push({ msg, data })),
				DEFAULT_DISCOVERY_CACHE_TTL_MS
			);
		});
		assert.deepStrictEqual(logged, [
			{
				msg: `discovery.cacheTtl must be a whole number between 0 and ${Number.MAX_SAFE_INTEGER}; using the default`,
				data: { configured: -5 },
			},
		]);
	});

	test("falls back to the default for non-finite and non-number values", async () => {
		for (const raw of [Number.NaN, Number.POSITIVE_INFINITY, "60000", null, true]) {
			const logged: unknown[] = [];
			await withConfig({ "discovery.cacheTtl": raw }, () => {
				assert.strictEqual(
					getDiscoveryCacheTtl(() => logged.push(true)),
					DEFAULT_DISCOVERY_CACHE_TTL_MS,
					`configured value ${String(raw)} must fall back to the default`
				);
			});
			assert.strictEqual(logged.length, 1, `configured value ${String(raw)} must be logged`);
		}
	});
});

suite("shared/config/settings normalizeCustomHeaders", () => {
	test("values with CR, LF, or CRLF are dropped by the shared header-value predicate", () => {
		const logged: { msg: string; data: unknown }[] = [];
		const headers = normalizeCustomHeaders(
			{
				"x-cr": "start\rend",
				"x-lf": "start\nend",
				"x-crlf": "start\r\nend",
				"x-ok": "value",
			},
			(msg, data) => logged.push({ msg, data })
		);

		assert.deepStrictEqual(headers, { "x-ok": "value" });
		assert.strictEqual(logged.length, 3, "each rejected header logs exactly once");
		for (const entry of logged) {
			assert.ok(entry.msg.includes("cannot be sent as an HTTP header"), entry.msg);
			// The classification names the header, never the value: these values can be secrets and the log buffer
			// feeds public issue reports.
			assert.ok(!JSON.stringify(entry).includes("start"), "the rejected value must not reach the log");
		}
	});

	test("other control octets fail the same predicate the platform Headers enforces; empty stays legal", () => {
		const headers = normalizeCustomHeaders({ "x-nul": "a\u0000b", "x-del": "a\u007fb", "x-empty": "" });
		assert.deepStrictEqual(headers, { "x-empty": "" }, "an empty field value is legal HTTP and must keep flowing");
	});

	test("scalar values stringify and travel; tab and obs-text stay legal", () => {
		const headers = normalizeCustomHeaders({ "x-num": 42, "x-bool": true, "x-tab": "a\tb", "x-hi": "caf\u00e9" });
		assert.deepStrictEqual(headers, { "x-num": "42", "x-bool": "true", "x-tab": "a\tb", "x-hi": "caf\u00e9" });
	});

	test("invalid names, non-scalar values, and non-record inputs drop without throwing", () => {
		assert.deepStrictEqual(normalizeCustomHeaders({ "bad name": "v", "x-obj": { nested: 1 }, "x-ok": "v" }), {
			"x-ok": "v",
		});
		assert.deepStrictEqual(normalizeCustomHeaders("not a record"), {});
		assert.deepStrictEqual(normalizeCustomHeaders(undefined), {});
	});

	test("a headers slot that is not an object is reported once and reads as empty; an object passes unchanged", () => {
		// A string where the map belongs used to read as {} with nothing logged; only an absent slot is silent.
		const cases: { raw: unknown; reported: boolean }[] = [
			{ raw: "oops", reported: true },
			{ raw: ["x-team: ops"], reported: true },
			{ raw: null, reported: true },
			{ raw: undefined, reported: false },
		];
		for (const { raw, reported } of cases) {
			const logged: { message: string; data?: unknown }[] = [];
			const headers = normalizeCustomHeaders(raw, (message, data) => logged.push({ message, data }));
			assert.deepStrictEqual(headers, {}, `${JSON.stringify(raw)}: the slot reads as empty`);
			assert.deepStrictEqual(
				logged,
				reported
					? [{ message: "Ignoring custom headers that are not an object", data: { configured: typeof raw } }]
					: [],
				`${JSON.stringify(raw)}: reported exactly when the slot is present and wrong-shaped`
			);
		}
		assert.deepStrictEqual(
			normalizeCustomHeaders({ "x-team": "ops" }, () => assert.fail("a well-shaped map reports nothing")),
			{ "x-team": "ops" }
		);
	});
});

suite("shared/config/settings normalizeModelCapabilities", () => {
	// The getters report a setting value once per session; each test here starts the session over.
	setup(() => resetRecordShapeReports());

	test("keeps the record-of-records shape and stays vocabulary-blind", () => {
		// Shape only, deliberately: unknown keys and invalid values survive here so parseCapabilityRecord (the one
		// vocabulary boundary) can diagnose them instead of them silently vanishing.
		const raw = {
			"gpt-4": { context_length: 128000, supports_pdf_input: true, context_window: "128k" },
			"http://a.test/claude": { _declare: true },
		};
		assert.deepStrictEqual(normalizeModelCapabilities(raw), raw);
	});

	test("a records entry read from the host survives serialization under a dotted model id", async () => {
		// The host's clone-on-write proxy re-finds a nested value by its dotted path, which "gpt-5.2-mini" splits, so
		// the request fingerprint's JSON.stringify used to drop response_format and the chat path then threw. A schema
		// property named toJSON trips the same proxy on a plain read.
		const configured = {
			"gpt-5.2-mini": {
				response_format: {
					type: "json_schema",
					json_schema: { schema: { properties: { toJSON: { type: "string" }, value: { type: "number" } } } },
				},
				temperature: 0.25,
			},
		};
		const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);
		await config().update(MODEL_PARAMETERS_SETTING_KEY, configured, vscode.ConfigurationTarget.Global);
		try {
			assert.deepStrictEqual(JSON.parse(JSON.stringify(getModelParametersConfig())), configured);
		} finally {
			await config().update(MODEL_PARAMETERS_SETTING_KEY, undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test("one malformed entry drops only itself, named; unsafe and non-record inputs drop entirely, reported", () => {
		// A string-valued top-level setting used to read as {} with no trace, so the dashboard showed no overrides and
		// nothing said why.
		const logged: { msg: string; data?: unknown }[] = [];
		const log = logRecordShapeProblems("models.capabilities", (msg, data) => logged.push({ msg, data }));
		assert.deepStrictEqual(
			normalizeModelCapabilities({ "gpt-4": { supports_vision: true }, bad: "not a record" }, log),
			{ "gpt-4": { supports_vision: true } }
		);
		const polluted = JSON.parse('{"__proto__": {"x": 1}, "constructor": {"y": 2}, "gpt-4": {}}');
		assert.deepStrictEqual(normalizeModelCapabilities(polluted, log), { "gpt-4": {} });
		assert.deepStrictEqual(normalizeModelCapabilities("not a record", log), {});
		assert.deepStrictEqual(normalizeModelCapabilities(undefined, log), {});
		assert.deepStrictEqual(logged, [
			{ msg: "Ignoring models.capabilities entry whose value is not an object", data: { model: "bad" } },
			{ msg: "Ignoring models.capabilities entry under a reserved name", data: { model: "__proto__" } },
			{ msg: "Ignoring models.capabilities entry under a reserved name", data: { model: "constructor" } },
			{ msg: "Invalid models.capabilities configuration, reading it as empty", data: undefined },
		]);
	});

	test("getModelCapabilitiesConfig reads the modelCapabilities setting through the normalizer", async () => {
		await withConfig({ [MODEL_CAPABILITIES_SETTING_KEY]: { "gpt-4": { supports_vision: true }, bad: 1 } }, () => {
			assert.deepStrictEqual(getModelCapabilitiesConfig(), { "gpt-4": { supports_vision: true } });
		});
		await withConfig({}, () => {
			assert.deepStrictEqual(getModelCapabilitiesConfig(), {});
		});
		const logged: { msg: string; data?: unknown }[] = [];
		await withConfig({ [MODEL_CAPABILITIES_SETTING_KEY]: "oops" }, () => {
			assert.deepStrictEqual(
				getModelCapabilitiesConfig((msg, data) => logged.push({ msg, data })),
				{}
			);
		});
		assert.deepStrictEqual(logged, [
			{ msg: "Invalid models.capabilities configuration, reading it as empty", data: undefined },
		]);
	});

	test("a wrong-shaped records slot is reported once per distinct setting value, not once per read", async () => {
		// The getter runs per chat request, per inline completion, and per serve, so one misconfigured entry used to
		// put a line naming it in the channel on every request. A read with no sink leaves the gate alone: the first
		// read that can report still does.
		const logged: { msg: string; data?: unknown }[] = [];
		const log = (msg: string, data?: unknown) => logged.push({ msg, data });
		const entryLine = {
			msg: "Ignoring models.parameters entry whose value is not an object",
			data: { model: "gpt-4" },
		};
		await withConfig({ [MODEL_PARAMETERS_SETTING_KEY]: { "gpt-4": "fast" } }, () => {
			assert.deepStrictEqual(getModelParametersConfig(), {});
			for (let read = 0; read < 3; read++) {
				assert.deepStrictEqual(getModelParametersConfig(log), {});
			}
		});
		assert.deepStrictEqual(logged, [entryLine]);
		await withConfig({ [MODEL_PARAMETERS_SETTING_KEY]: { "gpt-4": "fast", o3: { temperature: 1 } } }, () => {
			for (let read = 0; read < 3; read++) {
				assert.deepStrictEqual(getModelParametersConfig(log), { o3: { temperature: 1 } });
			}
		});
		assert.deepStrictEqual(logged, [entryLine, entryLine]);
	});
});

suite("shared/config/settings getUsagePollIntervalMs", () => {
	test("zero stays the off switch; a nonzero value below the floor reads as the default, named with the floor", async () => {
		await withConfig({ "usage.pollInterval": 0 }, () => {
			assert.strictEqual(getUsagePollIntervalMs(), 0);
		});
		// A 1 ms interval would be a permanent request loop; it used to clamp up to the floor.
		const logged: { msg: string; data?: unknown }[] = [];
		await withConfig({ "usage.pollInterval": 1 }, () => {
			assert.strictEqual(
				getUsagePollIntervalMs((msg, data) => logged.push({ msg, data })),
				300000
			);
		});
		assert.deepStrictEqual(logged, [
			{
				msg: `usage.pollInterval must be a whole number between ${MIN_USAGE_POLL_INTERVAL_MS} and ${MAX_TIMER_MS}, or 0 to turn it off; using the default`,
				data: { configured: 1 },
			},
		]);
		await withConfig({ "usage.pollInterval": -5 }, () => {
			assert.strictEqual(getUsagePollIntervalMs(), 300000, "a negative is outside the contract: the default applies");
		});
		await withConfig({ "usage.pollInterval": 600000 }, () => {
			assert.strictEqual(getUsagePollIntervalMs(), 600000);
		});
	});
});

suite("shared/config/settings usage cadence getters", () => {
	test("the delays and the polling-off window default from the spec; negatives read as the default", async () => {
		await withConfig({}, () => {
			assert.strictEqual(getUsageInitialRefreshDelayMs(), 5000);
			assert.strictEqual(getUsageServersChangeRefreshDelayMs(), 2000);
			assert.strictEqual(getUsagePollingOffFreshnessWindowMs(), 600000);
		});
		await withConfig(
			{
				"usage.initialRefreshDelay": 100,
				"usage.serversChangeRefreshDelay": 0,
				"usage.pollingOffFreshnessWindow": 1_200_000,
			},
			() => {
				assert.strictEqual(getUsageInitialRefreshDelayMs(), 100);
				assert.strictEqual(getUsageServersChangeRefreshDelayMs(), 0);
				assert.strictEqual(getUsagePollingOffFreshnessWindowMs(), 1_200_000);
			}
		);
		await withConfig({ "usage.initialRefreshDelay": -1, "usage.pollingOffFreshnessWindow": -5 }, () => {
			assert.strictEqual(getUsageInitialRefreshDelayMs(), 5000);
			assert.strictEqual(getUsagePollingOffFreshnessWindowMs(), 600000);
		});
	});
});

suite("shared/config/settings max tools per request", () => {
	test("defaults to 128, passes configured values through, and reads a zero or fractional cap as the default", async () => {
		await withConfig({}, () => {
			assert.strictEqual(getMaxToolsPerRequest(), 128);
		});
		await withConfig({ "chat.maxToolsPerRequest": 256 }, () => {
			assert.strictEqual(getMaxToolsPerRequest(), 256);
		});
		const logged: unknown[] = [];
		await withConfig({ "chat.maxToolsPerRequest": 0 }, () => {
			assert.strictEqual(
				getMaxToolsPerRequest(() => logged.push(true)),
				128,
				"a zero cap would refuse every tool-carrying request"
			);
		});
		assert.strictEqual(logged.length, 1);
		await withConfig({ "chat.maxToolsPerRequest": 2.5 }, () => {
			assert.strictEqual(
				getMaxToolsPerRequest(() => logged.push(true)),
				128,
				"a fractional cap is not guessed at, so the refusal detail never reports a fraction"
			);
		});
		assert.strictEqual(logged.length, 2);
	});
});

suite("shared/config/settings normalizeAdditionalToolSchemaKeywords", () => {
	test("a non-array reads as no additions; only a configured non-array logs", () => {
		const logged: string[] = [];
		assert.deepStrictEqual(
			normalizeAdditionalToolSchemaKeywords(undefined, (msg) => logged.push(msg)),
			[]
		);
		assert.strictEqual(logged.length, 0, "unset must not warn");
		assert.deepStrictEqual(
			normalizeAdditionalToolSchemaKeywords("propertyNames", (msg) => logged.push(msg)),
			[]
		);
		assert.strictEqual(logged.length, 1);
	});

	test("keeps non-empty strings in order, deduplicated; drops the rest with one line", () => {
		const logged: string[] = [];
		assert.deepStrictEqual(
			normalizeAdditionalToolSchemaKeywords(["propertyNames", "", 42, "patternProperties", "propertyNames"], (msg) =>
				logged.push(msg)
			),
			["propertyNames", "patternProperties"]
		);
		assert.strictEqual(logged.length, 1);
	});

	test("drops prototype-polluting keyword names", () => {
		const logged: string[] = [];
		assert.deepStrictEqual(
			normalizeAdditionalToolSchemaKeywords(["__proto__", "constructor", "propertyNames"], (msg) => logged.push(msg)),
			["propertyNames"]
		);
		assert.strictEqual(logged.length, 1);
	});

	test("the getter reads the setting through the normalizer", async () => {
		await withConfig({ [ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY]: ["propertyNames"] }, () => {
			assert.deepStrictEqual(getAdditionalToolSchemaKeywords(), ["propertyNames"]);
		});
		await withConfig({ [ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY]: { propertyNames: true } }, () => {
			assert.deepStrictEqual(getAdditionalToolSchemaKeywords(), []);
		});
	});
});

suite("shared/config/settings appearance getters", () => {
	test("a junk settings.json appearance value reads as the default, whatever kind it is", () => {
		// The dashboard restamps the root element from these two on every state push, so a hand-edited settings.json
		// holding a typo, a number, or null must not reach the webview as a data-theme nobody styles.
		for (const junk of ["Dark", "", "system", 3, null, undefined, {}, ["dark"]]) {
			assert.strictEqual(normalizeUiTheme(junk), DEFAULT_UI_THEME, JSON.stringify(junk) ?? "undefined");
			assert.strictEqual(normalizeUiAccent(junk), DEFAULT_UI_ACCENT, JSON.stringify(junk) ?? "undefined");
		}
		for (const theme of UI_THEMES) {
			assert.strictEqual(normalizeUiTheme(theme), theme);
		}
		for (const accent of UI_ACCENTS) {
			assert.strictEqual(normalizeUiAccent(accent), accent);
		}
	});

	test("the getters read their settings through the normalizer", async () => {
		await withConfig({ [UI_THEME_SETTING_KEY]: "light", [UI_ACCENT_SETTING_KEY]: "teal" }, () => {
			assert.strictEqual(getUiTheme(), "light");
			assert.strictEqual(getUiAccent(), "teal");
		});
		await withConfig({ [UI_THEME_SETTING_KEY]: "solarized", [UI_ACCENT_SETTING_KEY]: 7 }, () => {
			assert.strictEqual(getUiTheme(), DEFAULT_UI_THEME);
			assert.strictEqual(getUiAccent(), DEFAULT_UI_ACCENT);
		});
	});
});

suite("shared/config/settings token estimation getter", () => {
	test("a junk chat.tokenEstimation value reads as the default, whatever kind it is", () => {
		// The settings import path can write an arbitrary value into the key, and this normalizer is the only thing
		// between that and the counter.
		for (const junk of ["Auto", "", "gpt2", "o200k", 3, null, undefined, {}, ["auto"]]) {
			assert.strictEqual(
				normalizeTokenEstimationMode(junk),
				DEFAULT_TOKEN_ESTIMATION_MODE,
				JSON.stringify(junk) ?? "undefined"
			);
		}
		for (const mode of TOKEN_ESTIMATION_MODES) {
			assert.strictEqual(normalizeTokenEstimationMode(mode), mode);
		}
	});

	test("the getter reads the setting through the normalizer", async () => {
		await withConfig({ [TOKEN_ESTIMATION_SETTING_KEY]: "cl100k_base" }, () => {
			assert.strictEqual(getTokenEstimationMode(), "cl100k_base");
		});
		await withConfig({ [TOKEN_ESTIMATION_SETTING_KEY]: "tiktoken" }, () => {
			assert.strictEqual(getTokenEstimationMode(), DEFAULT_TOKEN_ESTIMATION_MODE);
		});
	});
});

suite("shared/config/settings currency symbol getter", () => {
	test("any string passes verbatim - multi-character, spaced, and empty included", () => {
		// The symbol is display-only, so the whole string space is legal: no trimming (the trailing space in "EUR " is
		// load-bearing) and the empty string is a real choice (bare numbers), never coerced to the default.
		for (const symbol of ["$", "EUR ", "kr", "", " ", "USD "]) {
			assert.strictEqual(normalizeCurrencySymbol(symbol), symbol);
		}
	});

	test("a non-string settings.json value reads as the default", () => {
		for (const junk of [3, null, undefined, {}, ["$"], true]) {
			assert.strictEqual(normalizeCurrencySymbol(junk), DEFAULT_CURRENCY_SYMBOL, JSON.stringify(junk) ?? "undefined");
		}
	});

	test("the getter reads the setting through the normalizer", async () => {
		await withConfig({ [CURRENCY_SYMBOL_SETTING_KEY]: "EUR " }, () => {
			assert.strictEqual(getCurrencySymbol(), "EUR ");
		});
		await withConfig({ [CURRENCY_SYMBOL_SETTING_KEY]: "" }, () => {
			assert.strictEqual(getCurrencySymbol(), "");
		});
		await withConfig({ [CURRENCY_SYMBOL_SETTING_KEY]: 42 }, () => {
			assert.strictEqual(getCurrencySymbol(), DEFAULT_CURRENCY_SYMBOL);
		});
	});
});

suite("shared/config/settings feature model refs", () => {
	test("a well-formed ref passes with both halves edge-trimmed", () => {
		const logged: unknown[] = [];
		assert.deepStrictEqual(
			normalizeFeatureModelRef({ server: " Prod ", model: " gpt-4o-mini " }, "inlineCompletions", () =>
				logged.push(true)
			),
			{ server: "Prod", model: "gpt-4o-mini" }
		);
		assert.strictEqual(logged.length, 0);
	});

	test("unset and null read as unset without logging", () => {
		const logged: unknown[] = [];
		assert.strictEqual(
			normalizeFeatureModelRef(undefined, "inlineCompletions", () => logged.push(true)),
			undefined
		);
		assert.strictEqual(
			normalizeFeatureModelRef(null, "commitGeneration", () => logged.push(true)),
			undefined
		);
		assert.strictEqual(logged.length, 0);
	});

	test("malformed values advisory-log and read as unset (the feature stays fail-closed)", () => {
		const junkValues: unknown[] = [
			"Prod/gpt",
			3,
			true,
			[],
			{},
			{ server: "Prod" },
			{ model: "gpt" },
			{ server: "", model: "m" },
			{ server: " ", model: "m" },
			{ server: "s", model: 4 },
		];
		for (const junk of junkValues) {
			const logged: string[] = [];
			assert.strictEqual(
				normalizeFeatureModelRef(junk, "commitGeneration", (message) => logged.push(message)),
				undefined,
				JSON.stringify(junk) ?? "undefined"
			);
			assert.strictEqual(logged.length, 1, JSON.stringify(junk) ?? "undefined");
			assert.ok(logged[0]?.includes("commitGeneration.model"), "the advisory names the setting");
		}
	});

	test("extra keys are ignored, not refused: the schema flags them, the reader stays lenient", () => {
		assert.deepStrictEqual(normalizeFeatureModelRef({ server: "Prod", model: "m", junk: 1 }, "inlineCompletions"), {
			server: "Prod",
			model: "m",
		});
	});

	test("the getter reads each feature's own setting key", async () => {
		await withConfig(
			{
				"inlineCompletions.model": { server: "Prod", model: "codestral" },
				"commitGeneration.model": { server: "Gateway", model: "gpt-4o-mini" },
			},
			() => {
				assert.deepStrictEqual(getFeatureModelRef("inlineCompletions"), { server: "Prod", model: "codestral" });
				assert.deepStrictEqual(getFeatureModelRef("commitGeneration"), { server: "Gateway", model: "gpt-4o-mini" });
			}
		);
		await withConfig({}, () => {
			assert.strictEqual(getFeatureModelRef("inlineCompletions"), undefined);
			assert.strictEqual(getFeatureModelRef("commitGeneration"), undefined);
		});
	});
});

suite("shared/config/settings commit prompt getter", () => {
	test("any string passes verbatim - whitespace and the empty built-in marker included", () => {
		// Model-facing text: no trimming, and "" is the real "use the built-in instruction" value rather than a
		// fallback.
		for (const prompt of ["", " ", "One line.", "line\nline"]) {
			assert.strictEqual(normalizeCommitGenerationPrompt(prompt), prompt);
		}
	});

	test("a non-string settings.json value reads as the built-in marker", () => {
		for (const junk of [3, null, undefined, {}, ["p"], true]) {
			assert.strictEqual(normalizeCommitGenerationPrompt(junk), "", JSON.stringify(junk) ?? "undefined");
		}
	});

	test("the getter reads the setting through the normalizer", async () => {
		await withConfig({ "commitGeneration.prompt": "Subject only." }, () => {
			assert.strictEqual(getCommitGenerationPrompt(), "Subject only.");
		});
		await withConfig({ "commitGeneration.prompt": 42 }, () => {
			assert.strictEqual(getCommitGenerationPrompt(), "");
		});
	});
});

suite("shared/config/settings language filter", () => {
	test("trims, drops non-strings and empties, and deduplicates languages in order", () => {
		const logged: string[] = [];
		assert.deepStrictEqual(
			normalizeInlineLanguageFilter(
				{ mode: "allow", languages: [" typescript ", "python", 3, "", "   ", "typescript", null] },
				(message) => logged.push(message)
			),
			{ mode: "allow", languages: ["typescript", "python"] }
		);
		assert.strictEqual(logged.length, 1);
	});

	test("a value without a recognized mode reads as the default; everything configured logs, unset stays silent", () => {
		const logged: string[] = [];
		assert.deepStrictEqual(
			normalizeInlineLanguageFilter(undefined, (message) => logged.push(message)),
			DEFAULT_INLINE_LANGUAGE_FILTER
		);
		assert.strictEqual(logged.length, 0);
		for (const junk of [null, "block", 3, {}, [], { mode: "deny" }, { mode: 3, languages: ["ts"] }]) {
			assert.deepStrictEqual(
				normalizeInlineLanguageFilter(junk, (message) => logged.push(message)),
				DEFAULT_INLINE_LANGUAGE_FILTER
			);
		}
		assert.strictEqual(logged.length, 7);
	});

	test("a valid mode with a missing or malformed languages list keeps the mode and reads the empty list", () => {
		const logged: string[] = [];
		assert.deepStrictEqual(
			normalizeInlineLanguageFilter({ mode: "allow" }, (message) => logged.push(message)),
			{
				mode: "allow",
				languages: [],
			}
		);
		assert.strictEqual(logged.length, 0);
		assert.deepStrictEqual(
			normalizeInlineLanguageFilter({ mode: "block", languages: "markdown" }, (message) => logged.push(message)),
			{ mode: "block", languages: [] }
		);
		assert.strictEqual(logged.length, 1);
	});

	test("the getter reads the setting through the normalizer", async () => {
		await withConfig(
			{ "inlineCompletions.languageFilter": { mode: "allow", languages: ["typescript", " python "] } },
			() => {
				assert.deepStrictEqual(getInlineLanguageFilter(), { mode: "allow", languages: ["typescript", "python"] });
			}
		);
		await withConfig({ "inlineCompletions.languageFilter": "markdown" }, () => {
			assert.deepStrictEqual(getInlineLanguageFilter(), DEFAULT_INLINE_LANGUAGE_FILTER);
		});
	});
});

suite("shared/config/settings feature opt-in getters", () => {
	test("every feature reads its spec default and a configured true through the one enable map", async () => {
		await withConfig({}, () => {
			for (const feature of FEATURE_IDS) {
				assert.strictEqual(
					isFeatureEnabled(feature),
					BOOLEAN_SETTING_SPECS[FEATURE_ENABLE_SETTING_KEYS[feature]].default,
					`${feature} default`
				);
			}
		});
		await withConfig({ "inlineCompletions.enabled": true, "commitGeneration.enabled": true }, () => {
			assert.strictEqual(isFeatureEnabled("inlineCompletions"), true);
			assert.strictEqual(isFeatureEnabled("commitGeneration"), true);
		});
	});
});

suite("one trim rule: padded user values are kept verbatim or refused, never repaired", () => {
	// Edge HTTP whitespace (tab, space, CR, LF) goes; a U+00A0 or U+2003 beside or inside a value is the user's spelling,
	// kept where the reader can use it and refused where it cannot. Number text passes the one decimal grammar, so
	// Number()'s own whitespace and "0x10" readings never happen. One row per reader the sweep touched.
	const NBSP = String.fromCharCode(0xa0);
	const EM_SPACE = String.fromCharCode(0x2003);
	const padded = (text: string): string => `${NBSP}${text}${EM_SPACE}`;
	const BASE_URL = "http://localhost:4000";

	function renamedImportLabel(newLabel: string): unknown[] {
		// Two entries under one label with different connections collide; the rename decision names the landing label.
		const current = [{ label: "Prod", baseUrl: BASE_URL }];
		const incoming = [{ label: "Prod", baseUrl: "http://other.example.com" }];
		const plan = planSettingsImport({ servers: incoming }, current);
		const application = resolveImportPlan(plan, { Prod: { action: "rename", newLabel } });
		return (application.serversValue ?? []).map((entry) => (entry as { label?: string }).label);
	}

	test("one case table across the readers of a user-authored string", () => {
		const logged: string[] = [];
		const cases: readonly (readonly [string, () => unknown, unknown])[] = [
			["usableHttpText", () => usableHttpText(` \t${padded("sk-abc")}\r\n`), padded("sk-abc")],
			[
				"normalizeCustomHeaders: padded name dropped, U+2003 value dropped, U+00A0 value kept",
				() =>
					normalizeCustomHeaders({ [padded("x-vk")]: "v", "X-Em": padded("v"), "X-Nbsp": `${NBSP}v` }, (line) => {
						logged.push(line);
					}),
				{ "X-Nbsp": `${NBSP}v` },
			],
			[
				"normalizeFeatureModelRef",
				() => normalizeFeatureModelRef({ server: ` ${padded("Prod")} `, model: padded("gpt") }, "quickFix"),
				{ server: padded("Prod"), model: padded("gpt") },
			],
			[
				"normalizeInlineLanguageFilter",
				() => normalizeInlineLanguageFilter({ mode: "block", languages: [padded("ts"), " js "] }),
				{ mode: "block", languages: [padded("ts"), "js"] },
			],
			[
				"parseCapabilityRecord keys",
				() => Object.keys(parseCapabilityRecord({ [` ${padded("vision")} `]: true }).fields),
				[padded("vision")],
			],
			[
				"parseServersSetting labels",
				() =>
					parseServersSetting([{ label: ` ${padded("Prod")} `, baseUrl: BASE_URL }]).entries.map(
						(entry) => entry.label
					),
				[padded("Prod")],
			],
			[
				"parseGroupConfiguration label and key",
				() => {
					const group = parseGroupConfiguration({
						baseUrl: BASE_URL,
						label: ` ${padded("Prod")} `,
						apiKey: ` ${NBSP}sk `,
					})?.server;
					return { label: group?.label, apiKey: group?.apiKey };
				},
				{ label: padded("Prod"), apiKey: `${NBSP}sk` },
			],
			["assembleEntryAuth", () => assembleEntryAuth({ apiKey: ` ${NBSP}sk ` }).auth, { apiKey: `${NBSP}sk` }],
			["parseDeclaredModelsText", () => parseDeclaredModelsText(`a\n ${padded("b")} \n`), ["a", padded("b")]],
			["parseCatalogIdText", () => parseCatalogIdText(` ${padded("openai/gpt")} `), padded("openai/gpt")],
			["parseInheritKeysText", () => parseInheritKeysText(` ${padded("a")} , b `), [padded("a"), "b"]],
			[
				"parseHeaderRows: U+00A0 value kept",
				() => parseHeaderRows([{ name: " X-Nbsp ", valueText: ` ${NBSP}v ` }]),
				{ ok: true, value: { "X-Nbsp": `${NBSP}v` } },
			],
			[
				"parseHeaderRows: padded name refused",
				() => parseHeaderRows([{ name: padded("x-vk"), valueText: "v" }]).ok,
				false,
			],
			[
				"import rename lands the HTTP-trimmed label",
				() => renamedImportLabel(` ${padded("Prod2")} `),
				["Prod", padded("Prod2")],
			],
			[
				"transformEntryRecord declared IDs",
				() => transformEntryRecord({ [` ${padded("gpt")} `]: { _declare: true } }, "capabilities").declared,
				[padded("gpt")],
			],
			["parseBudgetText: HTTP edges", () => parseBudgetText(" 100 "), { ok: true, value: 100 }],
			["parseBudgetText: U+00A0 refused", () => parseBudgetText(`${NBSP}100`), { ok: false, text: `${NBSP}100` }],
			["parseBudgetText: hex refused", () => parseBudgetText("0x10"), { ok: false, text: "0x10" }],
			["parseThresholdBox: HTTP edges", () => parseThresholdBox(" 80% "), { kind: "value", value: 0.8 }],
			["parseThresholdBox: U+00A0 refused", () => parseThresholdBox(`${NBSP}0.8`), { kind: "invalid" }],
			["normalizePositiveNumber: HTTP edges", () => normalizePositiveNumber(" 9000 "), 9000],
			["normalizePositiveNumber: U+00A0 refused", () => normalizePositiveNumber(`${NBSP}9000`), undefined],
			["normalizePositiveNumber: hex refused", () => normalizePositiveNumber("0x10"), undefined],
			[
				"agent tool label at the length limit, padded",
				() => {
					const atLimit = "a".repeat(WIRE_LIMITS.label);
					const parsed = parseAgentToolInput("inspectModel", { server: ` ${atLimit} `, model: "m" });
					return parsed.ok ? parsed.input.server : parsed;
				},
				"a".repeat(WIRE_LIMITS.label),
			],
			[
				"agent tool label",
				() => {
					const parsed = parseAgentToolInput("inspectModel", { server: ` ${padded("Prod")} `, model: "m" });
					return parsed.ok ? parsed.input.server : parsed;
				},
				padded("Prod"),
			],
			[
				"commitGeneration.prompt: U+00A0 is an instruction",
				() =>
					buildCommitPrompt({ customPrompt: NBSP, diff: "", recentSubjects: [], untrackedPaths: [] }).startsWith(NBSP),
				true,
			],
			[
				"commitGeneration.prompt: HTTP whitespace is empty",
				() =>
					buildCommitPrompt({ customPrompt: " \n", diff: "", recentSubjects: [], untrackedPaths: [] }).startsWith(" "),
				false,
			],
			[
				"parseNumberDraft: HTTP edges",
				() => parseNumberDraft("chat.timeout", " 1000 "),
				{ kind: "value", value: 1000 },
			],
			[
				"parseNumberDraft: U+2003 is a grammar error",
				() => parseNumberDraft("chat.timeout", `${EM_SPACE}1000${EM_SPACE}`),
				{ kind: "invalid", problem: "Not a duration - use ms, s, m, or h" },
			],
			["parseJsonValue: HTTP edges", () => parseJsonValue(" 1 "), { ok: true, value: 1 }],
			["parseJsonValue: U+2003 refused", () => parseJsonValue(`${EM_SPACE}1${EM_SPACE}`).ok, false],
			[
				"parseHeaderValue keeps the padded literal",
				() => parseHeaderValue(`${EM_SPACE}Bearer sk-abc${EM_SPACE}`),
				`${EM_SPACE}Bearer sk-abc${EM_SPACE}`,
			],
		];
		for (const [name, actual, expected] of cases) {
			assert.deepStrictEqual(actual(), expected, name);
		}
		assert.deepStrictEqual(logged, [
			"Ignoring invalid custom header name",
			"Ignoring custom header whose value cannot be sent as an HTTP header",
		]);
	});
});
