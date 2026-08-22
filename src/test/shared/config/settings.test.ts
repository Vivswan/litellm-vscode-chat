import * as assert from "node:assert";
import {
	ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY,
	CURRENCY_SYMBOL_SETTING_KEY,
	DEFAULT_CURRENCY_SYMBOL,
	DEFAULT_INLINE_LANGUAGE_FILTER,
	DEFAULT_TOKEN_ESTIMATION_MODE,
	DEFAULT_UI_ACCENT,
	DEFAULT_UI_THEME,
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
	getRequestTimeout,
	getTokenEstimationMode,
	getUiAccent,
	getUiTheme,
	getUsageInitialRefreshDelayMs,
	getUsagePollIntervalMs,
	getUsagePollingOffFreshnessWindowMs,
	getUsageServersChangeRefreshDelayMs,
	isCommitGenerationEnabled,
	isInlineCompletionsEnabled,
	MIN_TIMEOUT_MS,
	MIN_USAGE_POLL_INTERVAL_MS,
	MODEL_CAPABILITIES_SETTING_KEY,
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
} from "../../../shared/config/settings";
import { expectDefined } from "../../pureHelpers";
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

	test("clamp sub-minimum values to the minimum and log", async () => {
		const logged: { msg: string; data?: unknown }[] = [];
		await withConfig({ "chat.timeout": 500 }, () => {
			assert.strictEqual(
				getRequestTimeout((msg, data) => logged.push({ msg, data })),
				MIN_TIMEOUT_MS
			);
		});
		assert.strictEqual(logged.length, 1);
		const entry = expectDefined(logged[0]);
		assert.ok(entry.msg.includes("chat.timeout"));
		assert.deepStrictEqual(entry.data, { configured: 500, clamped: MIN_TIMEOUT_MS });
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

	test("clamps negative values to 0 and logs", async () => {
		const logged: { msg: string; data?: unknown }[] = [];
		await withConfig({ "discovery.cacheTtl": -5 }, () => {
			assert.strictEqual(
				getDiscoveryCacheTtl((msg, data) => logged.push({ msg, data })),
				0
			);
		});
		const entry = expectDefined(logged[0]);
		assert.ok(entry.msg.includes("discovery.cacheTtl"));
		assert.deepStrictEqual(entry.data, { configured: -5, clamped: 0 });
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
			// The classification names the header, never the value: these values
			// can be secrets and the log buffer feeds public issue reports.
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
});

suite("shared/config/settings normalizeModelCapabilities", () => {
	test("keeps the record-of-records shape and stays vocabulary-blind", () => {
		// Shape only, deliberately: unknown keys and invalid values survive here
		// so parseCapabilityRecord (the one vocabulary boundary) can diagnose
		// them instead of them silently vanishing.
		const raw = {
			"gpt-4": { context_length: 128000, supports_pdf_input: true, context_window: "128k" },
			"http://a.test/claude": { _declare: true },
		};
		assert.deepStrictEqual(normalizeModelCapabilities(raw), raw);
	});

	test("one malformed entry drops only itself; unsafe and non-record inputs drop entirely", () => {
		assert.deepStrictEqual(normalizeModelCapabilities({ "gpt-4": { supports_vision: true }, bad: "not a record" }), {
			"gpt-4": { supports_vision: true },
		});
		const polluted = JSON.parse('{"__proto__": {"x": 1}, "constructor": {"y": 2}, "gpt-4": {}}');
		assert.deepStrictEqual(normalizeModelCapabilities(polluted), { "gpt-4": {} });
		assert.deepStrictEqual(normalizeModelCapabilities("not a record"), {});
		assert.deepStrictEqual(normalizeModelCapabilities(undefined), {});
	});

	test("getModelCapabilitiesConfig reads the modelCapabilities setting through the normalizer", async () => {
		await withConfig({ [MODEL_CAPABILITIES_SETTING_KEY]: { "gpt-4": { supports_vision: true }, bad: 1 } }, () => {
			assert.deepStrictEqual(getModelCapabilitiesConfig(), { "gpt-4": { supports_vision: true } });
		});
		await withConfig({}, () => {
			assert.deepStrictEqual(getModelCapabilitiesConfig(), {});
		});
	});
});

suite("shared/config/settings getUsagePollIntervalMs", () => {
	test("zero stays the off switch; tiny positive values clamp up; negatives clamp to zero", async () => {
		await withConfig({ "usage.pollInterval": 0 }, () => {
			assert.strictEqual(getUsagePollIntervalMs(), 0);
		});
		await withConfig({ "usage.pollInterval": 1 }, () => {
			assert.strictEqual(getUsagePollIntervalMs(), MIN_USAGE_POLL_INTERVAL_MS, "a 1ms loop must not ship");
		});
		await withConfig({ "usage.pollInterval": -5 }, () => {
			assert.strictEqual(getUsagePollIntervalMs(), 0, "negatives read as the off switch");
		});
		await withConfig({ "usage.pollInterval": 600000 }, () => {
			assert.strictEqual(getUsagePollIntervalMs(), 600000);
		});
	});
});

suite("shared/config/settings usage cadence getters", () => {
	test("the delays and the polling-off window default from the spec and clamp negatives to zero", async () => {
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
			assert.strictEqual(getUsageInitialRefreshDelayMs(), 0);
			assert.strictEqual(getUsagePollingOffFreshnessWindowMs(), 0);
		});
	});
});

suite("shared/config/settings max tools per request", () => {
	test("defaults to 128, clamps below 1, and passes configured values through", async () => {
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
				1,
				"a zero cap would refuse every tool-carrying request"
			);
		});
		assert.strictEqual(logged.length, 1);
		await withConfig({ "chat.maxToolsPerRequest": 128.5 }, () => {
			assert.strictEqual(
				getMaxToolsPerRequest(() => logged.push(true)),
				128,
				"fractional caps floor, so the refusal detail never reports a fraction"
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
		// The dashboard restamps the root element from these two on every state
		// push, so a hand-edited settings.json holding a typo, a number, or null
		// must not reach the webview as a data-theme nobody styles.
		for (const junk of ["Dark", "", "system", 3, null, undefined, {}, ["dark"]]) {
			assert.strictEqual(normalizeUiTheme(junk), DEFAULT_UI_THEME, JSON.stringify(junk) ?? "undefined");
			assert.strictEqual(normalizeUiAccent(junk), DEFAULT_UI_ACCENT, JSON.stringify(junk) ?? "undefined");
		}
		// Every member of the vocabulary passes through untouched.
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
		// The settings import path can write an arbitrary value into the key,
		// and this normalizer is the only thing between that and the counter.
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
		// The symbol is display-only, so the whole string space is legal: no
		// trimming (the trailing space in "EUR " is load-bearing) and the empty
		// string is a real choice (bare numbers), never coerced to the default.
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
		// Model-facing text: no trimming, and "" is the real "use the built-in
		// instruction" value rather than a fallback.
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
	test("both default to false and read a configured true", async () => {
		await withConfig({}, () => {
			assert.strictEqual(isInlineCompletionsEnabled(), false);
			assert.strictEqual(isCommitGenerationEnabled(), false);
		});
		await withConfig({ "inlineCompletions.enabled": true, "commitGeneration.enabled": true }, () => {
			assert.strictEqual(isInlineCompletionsEnabled(), true);
			assert.strictEqual(isCommitGenerationEnabled(), true);
		});
	});
});
