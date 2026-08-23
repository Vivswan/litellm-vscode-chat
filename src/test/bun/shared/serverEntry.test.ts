import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import type { ExpectedFailureCategory } from "../../../shared/serverEntry";
import {
	EXPECTED_FAILURE_CATEGORIES,
	isExpectedFailureCategory,
	OPTIONAL_ENTRY_FIELDS,
} from "../../../shared/serverEntry";
import { REPO_ROOT } from "../../util/repoRoot";

/**
 * Drift guards between the server-entry field descriptor and its two
 * package.json copies: the servers setting's items schema and the
 * languageModelChatProviders configuration.
 */
interface ItemsSchema {
	readonly additionalProperties: boolean;
	readonly required: readonly string[];
	readonly properties: Record<string, unknown>;
}

interface FieldSchema {
	readonly secret?: boolean;
}

interface PackageJson {
	readonly contributes: {
		readonly configuration: readonly {
			readonly properties: Record<string, { readonly items?: ItemsSchema }>;
		}[];
		readonly languageModelChatProviders: readonly [
			{
				readonly configuration: {
					readonly properties: Record<string, FieldSchema>;
					readonly required: readonly string[];
				};
			},
		];
	};
}

function readPackageJson(): PackageJson {
	return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as PackageJson;
}

describe("shared/serverEntry: package.json drift guard", () => {
	const optionalIds = OPTIONAL_ENTRY_FIELDS.map((field) => field.id);

	test("the servers setting's items schema declares exactly the nested entry shape", () => {
		// The SETTINGS shape is nested; the flat descriptor fields live on in the
		// provider-group configuration and in the parsed internal shape.
		const sections = readPackageJson().contributes.configuration;
		const properties = Object.assign({}, ...sections.map((section) => section.properties)) as Record<
			string,
			{ readonly items?: ItemsSchema }
		>;
		const items = properties[`${CONFIG_SECTION}.servers`]?.items;
		assert.ok(items, "the servers setting declares an items schema");
		assert.strictEqual(items.additionalProperties, false, "unknown entry fields must be rejected");
		assert.deepStrictEqual([...items.required], ["label", "baseUrl"]);
		assert.deepStrictEqual(Object.keys(items.properties), [
			"label",
			"baseUrl",
			"apiVersion",
			"auth",
			"headers",
			"models",
			"discovery",
			"budget",
			"mcp",
		]);
	});

	test("the provider-group configuration declares the descriptor's fields with its secret flags", () => {
		const [provider] = readPackageJson().contributes.languageModelChatProviders;
		// `label` is the one non-descriptor property: it mirrors the group NAME into
		// the configuration, giving same-URL same-credential entries distinct
		// identities.
		assert.deepStrictEqual(Object.keys(provider.configuration.properties), ["baseUrl", "label", ...optionalIds]);
		assert.deepStrictEqual([...provider.configuration.required], ["baseUrl"]);
		assert.notStrictEqual(provider.configuration.properties.baseUrl?.secret, true, "baseUrl is not a secret");
		assert.notStrictEqual(provider.configuration.properties.label?.secret, true, "label is not a secret");
		for (const field of OPTIONAL_ENTRY_FIELDS) {
			const schema = provider.configuration.properties[field.id];
			assert.ok(schema, `provider configuration declares ${field.id}`);
			assert.strictEqual(
				schema.secret === true,
				field.secret,
				`provider configuration secret flag for ${field.id} matches the descriptor`
			);
		}
	});
});

describe("shared/serverEntry: expected failure categories", () => {
	test("the category tokens are pinned: they are wire-adjacent config values users type", () => {
		const categories: readonly ExpectedFailureCategory[] = EXPECTED_FAILURE_CATEGORIES;
		assert.deepStrictEqual([...categories], ["modelListing", "modelInfo"]);
	});

	test("the categories stay out of the entry descriptor, like an entry's modelParameters", () => {
		// expectedFailures must never reach the provider-group args or their
		// fingerprint, so it can never join OPTIONAL_ENTRY_FIELDS.
		const optionalIds: readonly string[] = OPTIONAL_ENTRY_FIELDS.map((field) => field.id);
		assert.ok(!optionalIds.includes("expectedFailures"));
	});

	test("isExpectedFailureCategory accepts exactly the pinned tokens", () => {
		for (const category of EXPECTED_FAILURE_CATEGORIES) {
			assert.ok(isExpectedFailureCategory(category));
		}
		assert.strictEqual(isExpectedFailureCategory("models"), false);
		assert.strictEqual(isExpectedFailureCategory("MODELLISTING"), false);
		assert.strictEqual(isExpectedFailureCategory(1), false);
		assert.strictEqual(isExpectedFailureCategory(undefined), false);
	});
});
