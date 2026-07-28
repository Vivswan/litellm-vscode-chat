import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	BOOLEAN_SETTING_SPECS,
	CONFIG_SECTION,
	MIN_TIMEOUT_MS,
	NUMBER_SETTING_SPECS,
	type NumberSettingId,
} from "../../shared/settingSpec";

/**
 * Drift guards between the shared setting spec and its two prose mirrors:
 * package.json's contributed configuration and the README's settings
 * numbers. The spec is the code-side truth; these tests make the mirrors
 * CI-enforced. Tests run from out/test/shared, so the repo root is three
 * levels up.
 */
const repoRoot = path.resolve(__dirname, "..", "..", "..");

interface SettingSchema {
	readonly type?: string | readonly string[];
	readonly default?: unknown;
	readonly minimum?: number;
	readonly description?: string;
	readonly markdownDescription?: string;
}

interface PackageJson {
	readonly contributes: {
		readonly configuration: { readonly properties: Record<string, SettingSchema> };
	};
}

function readPackageJson(): PackageJson {
	return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
}

function readReadme(): string {
	return fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
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

suite("shared/settingSpec: package.json drift guard", () => {
	test("every contributed configuration property lives under the config section", () => {
		const { properties } = readPackageJson().contributes.configuration;
		for (const key of Object.keys(properties)) {
			assert.ok(key.startsWith(`${CONFIG_SECTION}.`), `setting ${key} is outside the ${CONFIG_SECTION} section`);
		}
	});

	test("every contributed scalar setting has a spec entry", () => {
		// The reverse direction: a number or boolean setting added only to
		// package.json must land in the spec too. Object and array settings
		// (servers, headers, modelParameters) have no scalar spec by design.
		const { properties } = readPackageJson().contributes.configuration;
		for (const [key, schema] of Object.entries(properties)) {
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
		const { properties } = readPackageJson().contributes.configuration;
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
		const { properties } = readPackageJson().contributes.configuration;
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
		// prefix of a stale prose number cannot pass.
		const { properties } = readPackageJson().contributes.configuration;
		let checked = 0;
		for (const [id, spec] of Object.entries(NUMBER_SETTING_SPECS)) {
			const schema = settingSchema(properties, id);
			const description = schema.description ?? schema.markdownDescription ?? "";
			const quoted = /Default is (\d+)/.exec(description)?.[1];
			if (quoted === undefined) {
				continue;
			}
			checked += 1;
			assert.strictEqual(quoted, String(spec.default), `${id} description quotes a stale default: "${description}"`);
		}
		assert.ok(checked >= 3, "the timeout and cache TTL descriptions all state their defaults");
	});
});

suite("shared/settingSpec: README drift guard", () => {
	test("settings-table rows show the spec's default", () => {
		// Rows look like: | `litellm-vscode-chat.requestTimeout` | `300000` (5 minutes) | ... |
		// Any row naming a spec'd setting must show its default in the second column.
		const row = new RegExp(`^\\|\\s*\`${CONFIG_SECTION}\\.([\\w.]+)\`\\s*\\|\\s*\`([^\`]*)\``);
		let checked = 0;
		for (const line of readReadme().split("\n")) {
			const match = row.exec(line);
			const id = match?.[1];
			const shown = match?.[2];
			if (id === undefined || shown === undefined || !Object.hasOwn(NUMBER_SETTING_SPECS, id)) {
				continue;
			}
			checked += 1;
			const spec = NUMBER_SETTING_SPECS[id as NumberSettingId];
			assert.strictEqual(shown, String(spec.default), `README default column for ${id}`);
		}
		assert.ok(checked >= 5, `the README settings tables cover the number settings (found ${checked} rows)`);
	});

	test("the discoveryCacheTtl JSON example uses the spec default", () => {
		const example = new RegExp(`"${CONFIG_SECTION}\\.discoveryCacheTtl":\\s*(\\d+)`).exec(readReadme())?.[1];
		assert.ok(example, "the README shows a discoveryCacheTtl JSON example");
		assert.strictEqual(example, String(NUMBER_SETTING_SPECS.discoveryCacheTtl.default));
	});

	test("the minimum-timeout prose quotes MIN_TIMEOUT_MS", () => {
		const quoted = /Minimum timeout is (\d+)ms/.exec(readReadme())?.[1];
		assert.ok(quoted, "the README states the minimum timeout");
		assert.strictEqual(quoted, String(MIN_TIMEOUT_MS));
	});
});
