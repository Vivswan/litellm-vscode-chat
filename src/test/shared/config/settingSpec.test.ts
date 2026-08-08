import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_MAX_TOKENS_CAP } from "../../../provider/transport/request";
import {
	BOOLEAN_SETTING_SPECS,
	CONFIG_SECTION,
	MIN_TIMEOUT_MS,
	NUMBER_SETTING_SPECS,
} from "../../../shared/config/settingSpec";
import {
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	SERVERS_SETTING_KEY,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_MODES,
	USAGE_STATUS_BAR_SETTING_KEY,
} from "../../../shared/config/settings";
import { EXPECTED_FAILURE_CATEGORIES } from "../../../shared/serverEntry";
import type { HeaderScalar } from "../../../shared/util/headers";
import { HEADER_SCALAR_TYPES } from "../../../shared/util/headers";
import { resolveNls } from "../../util/nls";

/**
 * Drift guards between the shared setting spec and its prose mirrors:
 * package.json's contributed configuration and the settings numbers in
 * docs/ and AGENTS.md. The spec is the code-side truth; these tests make the
 * mirrors CI-enforced. Tests run from out/test/shared/config, so the repo
 * root is four levels up.
 */
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");

interface SettingSchema {
	readonly type?: string | readonly string[];
	readonly default?: unknown;
	readonly minimum?: number;
	readonly scope?: string;
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

function readModelParametersDoc(): string {
	return fs.readFileSync(path.join(repoRoot, "docs", "model-parameters.md"), "utf8");
}

// AGENTS.md is the real file (CLAUDE.md is a symlink to it, which a Windows
// checkout may materialize as a plain link-target stub), so read it directly.
function readAgentsDoc(): string {
	return fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
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
	test("the configuration contributes exactly the six titled sections, in order", () => {
		const titles = readPackageJson().contributes.configuration.map((section) => resolveNls(section.title));
		assert.deepStrictEqual(titles, ["Servers", "Models", "Chat", "Discovery", "Usage", "UI"]);
	});

	test("every contributed configuration property lives under the config section", () => {
		for (const key of Object.keys(allProperties())) {
			assert.ok(key.startsWith(`${CONFIG_SECTION}.`), `setting ${key} is outside the ${CONFIG_SECTION} section`);
		}
	});

	test("every contributed scalar setting has a spec entry", () => {
		// The reverse direction: a number or boolean setting added only to
		// package.json must land in the spec too. Object, array, and enum-string
		// settings (servers, models.parameters, usage.alertThresholds,
		// usage.statusBar) have no scalar spec by design.
		for (const [key, schema] of Object.entries(allProperties())) {
			const id = key.slice(`${CONFIG_SECTION}.`.length);
			const types = schemaTypes(schema);
			if (types.includes("number")) {
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

	test("number settings carry the spec's default and minimum", () => {
		const properties = allProperties();
		for (const [id, spec] of Object.entries(NUMBER_SETTING_SPECS)) {
			const schema = settingSchema(properties, id);
			assert.strictEqual(schema.default, spec.default, `${id} default`);
			assert.strictEqual(schema.minimum, spec.minimum, `${id} minimum`);
			assert.strictEqual(schemaTypes(schema).includes("null"), spec.nullable, `${id} nullability`);
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
		// "Default is 300000ms (5 minutes)" and friends: the sentence may be
		// rephrased freely, but the number it quotes must be the live default.
		// The quoted digits are compared whole, so a spec default that is a
		// prefix of a stale prose number cannot pass. The manifest holds %key%
		// references, so the prose is the resolved package.nls.json value.
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

	test("the usage settings are contributed with the readers' defaults and vocabulary", () => {
		const properties = allProperties();
		const thresholds = settingSchema(properties, USAGE_ALERT_THRESHOLDS_SETTING_KEY);
		assert.strictEqual(thresholds.type, "array");
		assert.deepStrictEqual(thresholds.default, [0.8, 0.95]);
		const statusBar = settingSchema(properties, USAGE_STATUS_BAR_SETTING_KEY);
		assert.strictEqual(statusBar.type, "string");
		assert.deepStrictEqual(statusBar.enum, [...USAGE_STATUS_BAR_MODES]);
		assert.strictEqual(statusBar.default, "always");
	});
});

/**
 * TEMPORARY docs-pin adjustment for the settings redesign (flagged for the
 * integrator): the committed docs still carry the PRE-redesign setting names,
 * and the redesigned docs land with the integration commit. Until then the
 * reference-table pin checks each renamed setting under its OLD doc name
 * (same default), and skips ids with no pre-redesign row (the usage.*
 * settings). The integration pass must drop this map so the ids pin directly.
 */
const OLD_DOC_IDS: Readonly<Record<string, string | undefined>> = {
	"chat.timeout": "requestTimeout",
	"discovery.timeout": "discoveryTimeout",
	"discovery.cacheTtl": "discoveryCacheTtl",
	"usage.pollInterval": undefined,
	"chat.promptCaching": "promptCaching.enabled",
	"models.openRouterCatalog": "openRouterCatalog.enabled",
	"ui.maskSecretInputs": "maskApiKeyInput",
};

suite("shared/config/settingSpec: docs drift guard", () => {
	test("the settings-reference table covers every scalar setting and shows the spec's default", () => {
		// Rows look like: | `litellm-vscode-chat.requestTimeout` | `300000` | ... |
		// Every spec'd number and boolean setting must have a row under its
		// (temporarily pre-redesign; see OLD_DOC_IDS) doc name, and the row must
		// show its default in the second column; a dropped row fails the set
		// compare.
		const defaults = new Map<string, string>();
		for (const [id, spec] of [...Object.entries(NUMBER_SETTING_SPECS), ...Object.entries(BOOLEAN_SETTING_SPECS)]) {
			const docId = Object.hasOwn(OLD_DOC_IDS, id) ? OLD_DOC_IDS[id] : id;
			if (docId !== undefined) {
				defaults.set(docId, String(spec.default));
			}
		}
		const row = new RegExp(`^\\|\\s*\`${CONFIG_SECTION}\\.([\\w.]+)\`\\s*\\|\\s*\`([^\`]*)\``);
		const covered: string[] = [];
		for (const line of readSettingsDoc().split("\n")) {
			const match = row.exec(line);
			const id = match?.[1];
			const shown = match?.[2];
			if (id === undefined || shown === undefined || !defaults.has(id)) {
				continue;
			}
			covered.push(id);
			assert.strictEqual(shown, defaults.get(id), `docs/settings.md default column for ${id}`);
		}
		assert.deepStrictEqual(
			covered.sort(),
			[...defaults.keys()].sort(),
			"the docs/settings.md reference table names every scalar setting exactly once"
		);
	});

	test("the discoveryCacheTtl JSON example uses the spec default", () => {
		const example = new RegExp(`"${CONFIG_SECTION}\\.discoveryCacheTtl":\\s*(\\d+)`).exec(readSettingsDoc())?.[1];
		assert.ok(example, "docs/settings.md shows a discoveryCacheTtl JSON example");
		assert.strictEqual(example, String(NUMBER_SETTING_SPECS["discovery.cacheTtl"].default));
	});

	test("the minimum-timeout prose quotes MIN_TIMEOUT_MS", () => {
		const quoted = /Minimum timeout is (\d+)ms/.exec(readSettingsDoc())?.[1];
		assert.ok(quoted, "docs/settings.md states the minimum timeout");
		assert.strictEqual(quoted, String(MIN_TIMEOUT_MS));
	});

	test("the max_tokens fallback sentence quotes DEFAULT_MAX_TOKENS_CAP", () => {
		const quoted = /or at most (\d+) when the server declares none/.exec(readModelParametersDoc())?.[1];
		assert.ok(quoted, "docs/model-parameters.md states the max_tokens fallback cap");
		assert.strictEqual(quoted, String(DEFAULT_MAX_TOKENS_CAP));
	});
});

suite("shared/config/settingSpec: AGENTS.md drift guard", () => {
	test("the request pass-through invariant quotes DEFAULT_MAX_TOKENS_CAP", () => {
		const quoted = /min\((\d+), model max output tokens\)/.exec(readAgentsDoc())?.[1];
		assert.ok(quoted, "AGENTS.md states the max_tokens fallback cap");
		assert.strictEqual(quoted, String(DEFAULT_MAX_TOKENS_CAP));
	});
});

suite("shared/config/settings: object-setting contributions drift guard", () => {
	// The scalar suites above skip object settings by design (no scalar spec);
	// these pin the object settings' keys and value shapes instead, against
	// the constants their readers use.
	test("the models.parameters setting is contributed under MODEL_PARAMETERS_SETTING_KEY as a record of objects", () => {
		const schema = settingSchema(allProperties(), MODEL_PARAMETERS_SETTING_KEY);
		assert.strictEqual(schema.type, "object");
		assert.deepStrictEqual(schema.additionalProperties, { type: "object" });
	});

	test("the servers setting is machine-scoped", () => {
		// Load-bearing (see AGENTS.md, Storage): user settings only, so a
		// workspace cannot re-point a label at another host to harvest its
		// stored secrets. The dashboard panel's readServersSetting reads
		// inspect(...).globalValue and writes ConfigurationTarget.Global, and
		// the dev seed writes the Global scope too; both are correct only
		// while this scope keeps workspace values out of the merge.
		const schema = settingSchema(allProperties(), SERVERS_SETTING_KEY);
		assert.strictEqual(schema.scope, "machine");
	});

	test("a servers entry declares the nested auth object with exactly the three forms", () => {
		const entryProperties = settingSchema(allProperties(), SERVERS_SETTING_KEY).items?.properties;
		assert.ok(entryProperties);
		const auth = entryProperties.auth;
		assert.ok(auth, "the servers items schema declares no auth property");
		assert.strictEqual(auth.type, "object");
		assert.strictEqual(auth.additionalProperties, false);
		assert.deepStrictEqual(Object.keys(auth.properties ?? {}).sort(), ["apiKey", "oauth", "virtualKey"]);
		const oauth = auth.properties?.oauth;
		assert.ok(oauth);
		assert.deepStrictEqual(Object.keys(oauth.properties ?? {}).sort(), [
			"apiKey",
			"clientId",
			"clientSecret",
			"scopes",
			"tokenUrl",
			"virtualKey",
		]);
		const virtualKey = auth.properties?.virtualKey;
		assert.ok(virtualKey);
		assert.deepStrictEqual(Object.keys(virtualKey.properties ?? {}).sort(), ["header", "value"]);
	});

	test("a servers entry declares per-entry models.parameters and models.capabilities shaped like the global settings", () => {
		// The servers items schema is additionalProperties:false, so without
		// these properties VS Code's settings validation would flag every entry
		// that uses per-entry configuration.
		const entryProperties = settingSchema(allProperties(), SERVERS_SETTING_KEY).items?.properties;
		assert.ok(entryProperties);
		const models = entryProperties.models;
		assert.ok(models, "the servers items schema declares no models property");
		assert.strictEqual(models.type, "object");
		for (const field of ["parameters", "capabilities"] as const) {
			const fieldSchema: SettingSchema | undefined = models.properties?.[field];
			assert.ok(fieldSchema, `the servers models schema declares no ${field} property`);
			assert.strictEqual(fieldSchema.type, "object");
			assert.deepStrictEqual(fieldSchema.additionalProperties, { type: "object" });
		}
	});

	test("the models.capabilities setting is contributed under MODEL_CAPABILITIES_SETTING_KEY as a record of objects", () => {
		const schema = settingSchema(allProperties(), MODEL_CAPABILITIES_SETTING_KEY);
		assert.strictEqual(schema.type, "object");
		assert.deepStrictEqual(schema.additionalProperties, { type: "object" });
		const description = resolveNls(schema.markdownDescription ?? "");
		assert.ok(description.length > 0, "the setting carries a markdownDescription (it renders code examples)");
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

	test("HEADER_SCALAR_TYPES names exactly the HeaderScalar member types", () => {
		// Both directions hold at compile time: a listed name without a
		// matching HeaderScalar member fails the first assignment, and a
		// HeaderScalar member the list does not name maps to "unlisted" and
		// fails the second.
		type TypeNameOf<T> = T extends string
			? "string"
			: T extends number
				? "number"
				: T extends boolean
					? "boolean"
					: "unlisted";
		const listed: readonly TypeNameOf<HeaderScalar>[] = HEADER_SCALAR_TYPES;
		const covered: readonly (typeof HEADER_SCALAR_TYPES)[number][] = listed;
		assert.deepStrictEqual([...covered], [...HEADER_SCALAR_TYPES]);
	});

	test("a servers entry declares discovery.declared, headers, and budget", () => {
		const entryProperties = settingSchema(allProperties(), SERVERS_SETTING_KEY).items?.properties;
		assert.ok(entryProperties);
		const declared = entryProperties.discovery?.properties?.declared;
		assert.ok(declared, "the servers discovery schema declares no declared property");
		assert.strictEqual(declared.type, "array");
		const headers = entryProperties.headers;
		assert.ok(headers, "the servers items schema declares no headers property");
		assert.strictEqual(headers.type, "object");
		// The contribution admits every HeaderScalar wire type. The code is
		// deliberately stricter than this schema: isHeaderScalar refuses
		// non-finite numbers, which JSON cannot carry anyway.
		assert.ok(typeof headers.additionalProperties === "object", "headers declares typed additionalProperties");
		assert.deepStrictEqual(headers.additionalProperties.type, [...HEADER_SCALAR_TYPES]);
		const budget = entryProperties.budget;
		assert.ok(budget, "the servers items schema declares no budget property");
		assert.strictEqual(budget.type, "number");
	});
});
