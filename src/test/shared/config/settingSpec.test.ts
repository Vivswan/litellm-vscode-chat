import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_MAX_TOKENS_CAP } from "../../../provider/transport/request";
import {
	AGENT_TOOLS_SETTING_KEYS,
	ALL_SETTING_KEYS,
	BOOLEAN_SETTING_SPECS,
	type BooleanSettingId,
	CONFIG_SECTION,
	CURRENCY_SYMBOL_SETTING_KEY,
	DEFAULT_CURRENCY_SYMBOL,
	DEFAULT_INLINE_LANGUAGE_FILTER,
	DEFAULT_TOKEN_ESTIMATION_MODE,
	FEATURE_ENABLE_SETTING_KEYS,
	FEATURE_MODEL_SETTING_KEY_LIST,
	INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY,
	isIntegerSetting,
	LANGUAGE_FILTER_MODES,
	MIN_TIMEOUT_MS,
	NUMBER_SETTING_SPECS,
	type NumberSettingId,
	STRUCTURED_SETTING_KEYS,
	TOKEN_ESTIMATION_MODES,
	TOKEN_ESTIMATION_SETTING_KEY,
	USAGE_STATUS_BAR_MODES,
} from "../../../shared/config/settingSpec";
import {
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	SERVERS_SETTING_KEY,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_SETTING_KEY,
} from "../../../shared/config/settings";
import { EXPECTED_FAILURE_CATEGORIES, NON_CHAT_MODES } from "../../../shared/serverEntry";
import { HEADER_SCALAR_TYPES } from "../../../shared/util/headers";
import { resolveNls } from "../../util/nls";

/**
 * Drift guards between the shared setting spec and its prose mirrors: package.json's
 * contributed configuration and the settings numbers in docs/. The spec is
 * the code-side truth. Tests run from out/test/shared/config, so the root is four up.
 */
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");

interface SettingSchema {
	readonly type?: string | readonly string[];
	readonly default?: unknown;
	readonly minimum?: number;
	readonly scope?: string;
	readonly restricted?: boolean;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean | { readonly type?: string | readonly string[] };
	readonly description?: string;
	readonly markdownDescription?: string;
	readonly enum?: readonly string[];
	readonly properties?: Record<string, SettingSchema>;
	readonly items?: SettingSchema & { readonly properties?: Record<string, SettingSchema> };
}

/** One contributed configuration section: a titled group of properties (the manifest declares an array of these). */
interface ConfigurationSection {
	readonly title: string;
	readonly properties: Record<string, SettingSchema>;
}

interface PackageJson {
	readonly contributes: {
		readonly configuration: readonly ConfigurationSection[];
	};
}

function readPackageJson(): PackageJson {
	return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
}

/** Every contributed property across the titled sections, flattened; duplicate keys would be a manifest bug. */
function allProperties(): Record<string, SettingSchema> {
	const sections = readPackageJson().contributes.configuration;
	const merged: Record<string, SettingSchema> = {};
	for (const section of sections) {
		for (const [key, schema] of Object.entries(section.properties)) {
			assert.ok(!(key in merged), `setting ${key} is contributed twice`);
			merged[key] = schema;
		}
	}
	return merged;
}

function readSettingsDoc(): string {
	return fs.readFileSync(path.join(repoRoot, "docs", "settings.md"), "utf8");
}

function readModelsDoc(): string {
	return fs.readFileSync(path.join(repoRoot, "docs", "models.md"), "utf8");
}

function settingSchema(properties: Record<string, SettingSchema>, id: string): SettingSchema {
	const schema = properties[`${CONFIG_SECTION}.${id}`];
	assert.ok(schema, `package.json contributes no ${CONFIG_SECTION}.${id} setting`);
	return schema;
}

function schemaTypes(schema: SettingSchema): readonly string[] {
	const { type } = schema;
	if (type === undefined) {
		return [];
	}
	return typeof type === "string" ? [type] : type;
}

suite("shared/config/settingSpec: package.json drift guard", () => {
	test("every contributed scalar setting has a spec entry", () => {
		// The reverse direction: a number or boolean setting added only to package.json
		// must land in the spec too. Object, array, and enum-string settings have no
		// scalar spec by design.
		for (const [key, schema] of Object.entries(allProperties())) {
			const id = key.slice(`${CONFIG_SECTION}.`.length);
			const types = schemaTypes(schema);
			if (types.includes("number") || types.includes("integer")) {
				assert.ok(
					Object.hasOwn(NUMBER_SETTING_SPECS, id),
					`${id} is a number setting without a NUMBER_SETTING_SPECS entry`
				);
			} else if (types.includes("boolean")) {
				assert.ok(
					Object.hasOwn(BOOLEAN_SETTING_SPECS, id),
					`${id} is a boolean setting without a BOOLEAN_SETTING_SPECS entry`
				);
			}
		}
	});

	test("number settings carry the spec's default, minimum, and integer-ness", () => {
		const properties = allProperties();
		for (const [id, spec] of Object.entries(NUMBER_SETTING_SPECS)) {
			const schema = settingSchema(properties, id);
			assert.strictEqual(schema.default, spec.default, `${id} default`);
			assert.strictEqual(schema.minimum, spec.minimum, `${id} minimum`);
			assert.strictEqual(schemaTypes(schema).includes("null"), spec.nullable, `${id} nullability`);
			// The spec's `integer` flag is the one source of the integer-only fact; the
			// manifest's scalar type must mirror it exactly, and an integer-flagged
			// spec's own numbers must satisfy the rule they declare.
			const integer = isIntegerSetting(id as NumberSettingId);
			const scalarTypes = schemaTypes(schema).filter((type) => type !== "null");
			assert.deepStrictEqual(scalarTypes, [integer ? "integer" : "number"], `${id} type`);
			if (integer) {
				assert.ok(spec.default === null || Number.isInteger(spec.default), `${id} default must be an integer`);
				assert.ok(Number.isInteger(spec.minimum), `${id} minimum must be an integer`);
			}
		}
	});

	test("every non-null spec default respects its own minimum", () => {
		// The readers clamp to the minimum, so a below-minimum default could
		// never take effect as written.
		for (const [id, spec] of Object.entries(NUMBER_SETTING_SPECS)) {
			if (spec.default !== null) {
				assert.ok(spec.default >= spec.minimum, `${id} default ${spec.default} is below its minimum ${spec.minimum}`);
			}
		}
	});

	test("boolean settings carry the spec's default", () => {
		const properties = allProperties();
		for (const [id, spec] of Object.entries(BOOLEAN_SETTING_SPECS)) {
			const schema = settingSchema(properties, id);
			assert.strictEqual(schema.type, "boolean", `${id} type`);
			assert.strictEqual(schema.default, spec.default, `${id} default`);
		}
	});

	test("descriptions that state a default state the spec's number", () => {
		// "Default is 300000ms (5 minutes)" and friends: the sentence may be rephrased,
		// but the number it quotes must be the live default. Quoted digits compare whole,
		// so a spec default that is a prefix of a stale prose number cannot pass.
		const properties = allProperties();
		let checked = 0;
		for (const [id, spec] of Object.entries(NUMBER_SETTING_SPECS)) {
			const schema = settingSchema(properties, id);
			const description = resolveNls(schema.description ?? schema.markdownDescription ?? "");
			const quoted = /Default is (\d+)/.exec(description)?.[1];
			if (quoted === undefined) {
				continue;
			}
			checked += 1;
			assert.strictEqual(quoted, String(spec.default), `${id} description quotes a stale default: "${description}"`);
		}
		assert.ok(checked >= 3, "the timeout and cache TTL descriptions all state their defaults");
	});

	test("ALL_SETTING_KEYS names exactly the contributed configuration properties", () => {
		// The export/import surface walks ALL_SETTING_KEYS, so a setting
		// contributed without joining the vocabulary (or vice versa) would
		// silently escape export coverage; this pin makes the drift a CI failure.
		const contributed = Object.keys(allProperties()).map((key) => key.slice(`${CONFIG_SECTION}.`.length));
		assert.deepStrictEqual([...ALL_SETTING_KEYS].sort(), contributed.sort());
	});

	test("the structured keys and the scalar specs partition the vocabulary", () => {
		// A structured key gaining a scalar spec (or a key listed twice) would
		// double-count in ALL_SETTING_KEYS and double-write on import.
		assert.strictEqual(new Set(ALL_SETTING_KEYS).size, ALL_SETTING_KEYS.length, "ALL_SETTING_KEYS holds duplicates");
		for (const key of STRUCTURED_SETTING_KEYS) {
			assert.ok(!Object.hasOwn(NUMBER_SETTING_SPECS, key), `${key} is structured and number-spec'd`);
			assert.ok(!Object.hasOwn(BOOLEAN_SETTING_SPECS, key), `${key} is structured and boolean-spec'd`);
		}
	});

	test("the usage settings are contributed as a threshold array and the readers' status-bar enum", () => {
		const properties = allProperties();
		const thresholds = settingSchema(properties, USAGE_ALERT_THRESHOLDS_SETTING_KEY);
		assert.strictEqual(thresholds.type, "array");
		const statusBar = settingSchema(properties, USAGE_STATUS_BAR_SETTING_KEY);
		assert.strictEqual(statusBar.type, "string");
		assert.deepStrictEqual(statusBar.enum, [...USAGE_STATUS_BAR_MODES]);
	});

	test("the token-estimation setting is contributed with the spec's vocabulary and default", () => {
		const schema = settingSchema(allProperties(), TOKEN_ESTIMATION_SETTING_KEY);
		assert.strictEqual(schema.type, "string");
		assert.deepStrictEqual(schema.enum, [...TOKEN_ESTIMATION_MODES]);
		assert.strictEqual(schema.default, DEFAULT_TOKEN_ESTIMATION_MODE);
	});

	test("the currency-symbol setting is contributed as a free string defaulting to the spec's symbol", () => {
		const schema = settingSchema(allProperties(), CURRENCY_SYMBOL_SETTING_KEY);
		assert.strictEqual(schema.type, "string");
		// Free text by design (any currency reads as its owner wrote it): no
		// enum, no pattern - a vocabulary here would refuse real currencies.
		assert.strictEqual(schema.enum, undefined);
		assert.strictEqual(schema.default, DEFAULT_CURRENCY_SYMBOL);
	});
});

suite("shared/config/settingSpec: docs drift guard", () => {
	test("the minimum-timeout prose quotes MIN_TIMEOUT_MS", () => {
		const quoted = /Minimum (\d+); lower values are clamped/.exec(readSettingsDoc())?.[1];
		assert.ok(quoted, "docs/settings.md states the minimum timeout");
		assert.strictEqual(quoted, String(MIN_TIMEOUT_MS));
	});

	test("the max_tokens fallback sentence quotes DEFAULT_MAX_TOKENS_CAP", () => {
		const quoted = /capped at (\d+)\*\* when it is a guess/.exec(readModelsDoc())?.[1];
		assert.ok(quoted, "docs/models.md states the max_tokens fallback cap");
		assert.strictEqual(quoted, String(DEFAULT_MAX_TOKENS_CAP));
	});
});

suite("shared/config/settings: object-setting contributions drift guard", () => {
	// The scalar suites above skip object settings by design (no scalar spec);
	// these pin the object settings' keys and value shapes instead, against
	// the constants their readers use.
	test("every setting carries exactly its ruled scope tier", () => {
		// Load-bearing: enable booleans and model refs decide whether requests
		// happen and where they go, and the catalog toggle causes OpenRouter
		// fetches, so they are machine-overridable (per-machine, skipped by Settings
		// Sync, overridden by a workspace only through its own explicit entry). The
		// servers setting and the agentTools family are machine scope, user settings
		// only: an agent's write access to servers and keys is granted by the user
		// alone, never by a checked-in workspace file. Everything else stays window
		// scope. Total over ALL_SETTING_KEYS, and both feature key maps are total
		// over FeatureId, so the next feature or setting cannot ship an unruled scope.
		const catalogKey: BooleanSettingId = "models.openRouterCatalog";
		const machineOnly = new Set<string>([SERVERS_SETTING_KEY, ...AGENT_TOOLS_SETTING_KEYS]);
		const machineOverridable = new Set<string>(
			[...Object.values(FEATURE_ENABLE_SETTING_KEYS), ...FEATURE_MODEL_SETTING_KEY_LIST, catalogKey].filter(
				(key) => !machineOnly.has(key)
			)
		);
		const properties = allProperties();
		for (const key of ALL_SETTING_KEYS) {
			const expected = machineOverridable.has(key)
				? "machine-overridable"
				: machineOnly.has(key)
					? "machine"
					: undefined;
			assert.strictEqual(settingSchema(properties, key).scope, expected, `${key} scope`);
		}
	});

	test("only the two model record settings are restricted in untrusted workspaces", () => {
		// Restricted Mode still applies a workspace's window-scoped settings unless the schema marks them.
		// The record settings shape what goes to the user's server and compile user regex matchers.
		// So an untrusted workspace may not supply them.
		// Total over ALL_SETTING_KEYS, so a new setting cannot ship with an unruled trust flag.
		const restricted = new Set<string>([MODEL_PARAMETERS_SETTING_KEY, MODEL_CAPABILITIES_SETTING_KEY]);
		const properties = allProperties();
		for (const key of ALL_SETTING_KEYS) {
			const expected = restricted.has(key) ? true : undefined;
			assert.strictEqual(settingSchema(properties, key).restricted, expected, `${key} restricted`);
		}
	});

	test("a servers entry declares discovery.expectedFailures as an array over exactly the shared categories", () => {
		const entryProperties = settingSchema(allProperties(), SERVERS_SETTING_KEY).items?.properties;
		assert.ok(entryProperties);
		const discovery = entryProperties.discovery;
		assert.ok(discovery, "the servers items schema declares no discovery property");
		const schema = discovery.properties?.expectedFailures;
		assert.ok(schema, "the servers discovery schema declares no expectedFailures property");
		assert.strictEqual(schema.type, "array");
		// The enum mirrors EXPECTED_FAILURE_CATEGORIES, order included: the
		// parser, the provider's demotion, and the dashboard's checkbox set all
		// derive from that one list.
		assert.deepStrictEqual(schema.items?.enum, [...EXPECTED_FAILURE_CATEGORIES]);
	});

	test("a servers entry declares discovery.includeModes as an array over exactly the shared non-chat modes", () => {
		const entryProperties = settingSchema(allProperties(), SERVERS_SETTING_KEY).items?.properties;
		assert.ok(entryProperties);
		const schema = entryProperties.discovery?.properties?.includeModes;
		assert.ok(schema, "the servers discovery schema declares no includeModes property");
		assert.strictEqual(schema.type, "array");
		// The enum mirrors NON_CHAT_MODES, order included: discovery's filter,
		// the parser, the intent schema, and the dashboard's checkbox set all
		// derive from that one list, so the manifest cannot offer a mode the
		// extension never skips.
		assert.deepStrictEqual(schema.items?.enum, [...NON_CHAT_MODES]);
	});

	test("a servers entry declares headers over exactly the HeaderScalar wire types", () => {
		const entryProperties = settingSchema(allProperties(), SERVERS_SETTING_KEY).items?.properties;
		assert.ok(entryProperties);
		const headers = entryProperties.headers;
		assert.ok(headers, "the servers items schema declares no headers property");
		assert.strictEqual(headers.type, "object");
		// The contribution admits every HeaderScalar wire type. The code is
		// deliberately stricter than this schema: isHeaderScalar refuses
		// non-finite numbers, which JSON cannot carry anyway.
		assert.ok(typeof headers.additionalProperties === "object", "headers declares typed additionalProperties");
		assert.deepStrictEqual(headers.additionalProperties.type, [...HEADER_SCALAR_TYPES]);
	});

	test("the inline-completions language filter is contributed as the closed { mode, languages } object", () => {
		const schema = settingSchema(allProperties(), INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY);
		assert.strictEqual(schema.type, "object");
		// Closed shape: a typo'd key must flag in the editor, not silently ride
		// along until a rewrite drops it.
		assert.strictEqual(schema.additionalProperties, false);
		// A filter without a mode is not a filter; the languages list may be
		// omitted (the reader treats it as empty).
		assert.deepStrictEqual(schema.required, ["mode"]);
		assert.deepStrictEqual(Object.keys(schema.properties ?? {}).sort(), ["languages", "mode"]);
		assert.deepStrictEqual(schema.properties?.mode?.enum, [...LANGUAGE_FILTER_MODES]);
		assert.strictEqual(schema.properties?.languages?.type, "array");
		assert.strictEqual(schema.properties?.languages?.items?.type, "string");
		// Identical semantics to the readers' default: block nothing.
		assert.deepStrictEqual(schema.default, DEFAULT_INLINE_LANGUAGE_FILTER);
	});
});
