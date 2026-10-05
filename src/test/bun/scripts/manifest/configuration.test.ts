import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	type ConfigurationInputs,
	renderConfiguration,
	renderProperty,
} from "../../../../../scripts/dev/manifest/configuration";
import {
	assertServersSchemaCoversEntryFields,
	type JsonObject,
} from "../../../../../scripts/dev/manifest/serversEntrySchema";
import { SETTING_PRESENTATION } from "../../../../shared/config/settingSpec";

/**
 * The renderer over an injected mini-spec: the key order the manifest carries, the omissions (window scope, absent
 * restricted), the integer and nullable type spellings, and the nls key convention are facts of the manifest format
 * that no type in the spec states.
 */
const MINI: ConfigurationInputs = {
	sections: [
		{ id: "alpha", settings: ["alpha.count", "alpha.enabled"] },
		{ id: "beta", settings: ["beta.mode", "beta.model", "beta.delay"] },
	],
	shapes: {
		"alpha.count": { kind: "number", spec: { default: 4, minimum: 1, maximum: 10, nullable: false, integer: true } },
		"alpha.enabled": { kind: "boolean", spec: { default: false } },
		"beta.mode": { kind: "enum", values: ["fast", "slow"], default: "fast" },
		"beta.model": { kind: "featureModel" },
		"beta.delay": { kind: "number", spec: { default: null, minimum: 0, maximum: 60000, nullable: true } },
	},
	presentation: {
		"alpha.count": { scope: "window", description: "plain" },
		"alpha.enabled": { scope: "machine-overridable", description: "markdown" },
		"beta.mode": { scope: "window", description: "plain", enumDescriptions: true },
		"beta.model": { scope: "machine-overridable", description: "markdown" },
		"beta.delay": { scope: "machine", restricted: true, description: "plain" },
	},
};

describe("manifest configuration renderer", () => {
	test("renders the mini-spec in manifest key order with the nls key convention", () => {
		const rendered = JSON.stringify(renderConfiguration(MINI));
		assert.strictEqual(
			rendered,
			JSON.stringify([
				{
					title: "%litellm.config.section.alpha%",
					properties: {
						"litellm-vscode-chat.alpha.count": {
							type: "integer",
							default: 4,
							minimum: 1,
							maximum: 10,
							description: "%litellm.config.alpha.count.description%",
						},
						"litellm-vscode-chat.alpha.enabled": {
							type: "boolean",
							scope: "machine-overridable",
							default: false,
							markdownDescription: "%litellm.config.alpha.enabled.description%",
						},
					},
				},
				{
					title: "%litellm.config.section.beta%",
					properties: {
						"litellm-vscode-chat.beta.mode": {
							type: "string",
							enum: ["fast", "slow"],
							default: "fast",
							enumDescriptions: ["%litellm.config.beta.mode.fast%", "%litellm.config.beta.mode.slow%"],
							description: "%litellm.config.beta.mode.description%",
						},
						"litellm-vscode-chat.beta.model": {
							type: ["object", "null"],
							scope: "machine-overridable",
							default: null,
							required: ["server", "model"],
							properties: {
								server: { type: "string", description: "%litellm.config.featureModel.server.description%" },
								model: { type: "string", description: "%litellm.config.featureModel.model.description%" },
							},
							additionalProperties: false,
							markdownDescription: "%litellm.config.beta.model.description%",
						},
						"litellm-vscode-chat.beta.delay": {
							type: ["number", "null"],
							scope: "machine",
							default: null,
							restricted: true,
							minimum: 0,
							maximum: 60000,
							description: "%litellm.config.beta.delay.description%",
						},
					},
				},
			])
		);
	});

	test("a setting listed in two sections is refused by name and nothing renders", () => {
		const doubled: ConfigurationInputs = {
			...MINI,
			sections: [...MINI.sections, { id: "gamma", settings: ["alpha.count"] }],
		};
		assert.throws(() => renderConfiguration(doubled), /alpha\.count is listed in two configuration sections/);
	});

	test("a setting with no shape or no presentation is refused by name", () => {
		const unshaped: ConfigurationInputs = { ...MINI, sections: [{ id: "delta", settings: ["delta.unknown"] }] };
		assert.throws(() => renderConfiguration(unshaped), /delta\.unknown has no shape/);
		const unpresented: ConfigurationInputs = {
			...unshaped,
			shapes: { ...MINI.shapes, "delta.unknown": { kind: "boolean", spec: { default: true } } },
		};
		assert.throws(() => renderConfiguration(unpresented), /delta\.unknown has no presentation/);
	});

	test("a servers items schema that lost a parser field is refused by field name", () => {
		const servers = renderProperty("servers", { kind: "servers" }, SETTING_PRESENTATION.servers);
		const items = servers.items as JsonObject;
		const { discovery: _dropped, ...rest } = items.properties as JsonObject;
		assert.throws(
			() => assertServersSchemaCoversEntryFields({ ...items, properties: rest }),
			/expectedFailures, declaredModels, includeModes/
		);
	});
});
