import * as assert from "node:assert";
import { COMMAND_SIGIL } from "./commands";
import type { FakeModel } from "./models";
import { FAKE_MODELS } from "./models";
import {
	assertUniqueNames,
	consolidatedModelEntry,
	costLiteral,
	generateConfig,
	parseCopilotCatalog,
} from "./proxyConfig";

/**
 * Pins the generated proxy config's load-bearing emission properties on
 * every CI OS without docker: the explicit tools-negatives (discovery
 * defaults a missing flag to true), byte-identical pricing across the
 * load-balanced pair (discovery's agreedCost silently nulls disagreement),
 * and plain-decimal cost literals (YAML floats do not guarantee scientific
 * notation).
 */

suite("fakeStack proxyConfig emission", () => {
	const config = generateConfig({ realProviders: false });

	/** The model_info block emitted for one model_name, one per deployment. */
	function infoBlocks(alias: string): string[] {
		const blocks: string[] = [];
		const entries = config.split(/\n(?= {2}- model_name: )/);
		for (const entry of entries) {
			if (entry.startsWith(`  - model_name: ${alias}\n`) || entry.includes(`\n  - model_name: ${alias}\n`)) {
				const info = entry.split("    model_info:\n")[1];
				if (info !== undefined) {
					blocks.push(info.split("\n\n")[0] ?? info);
				}
			}
		}
		return blocks;
	}

	test("both tools-negatives emit explicit false flags", () => {
		for (const alias of ["deepseek-r2", "llama-4-scout"]) {
			const [block] = infoBlocks(alias);
			assert.ok(block, `${alias} emitted`);
			assert.ok(block.includes("supports_function_calling: false"), `${alias} function_calling false`);
			assert.ok(block.includes("supports_tool_choice: false"), `${alias} tool_choice false`);
		}
	});

	test("the load-balanced pair's pricing lines are byte-identical", () => {
		const blocks = infoBlocks("gpt-5.2");
		assert.strictEqual(blocks.length, 2, "two deployments");
		const pricingLines = (block: string): string[] => block.split("\n").filter((line) => line.includes("cost"));
		assert.ok(pricingLines(blocks[0] as string).length > 0, "pricing present");
		assert.deepStrictEqual(pricingLines(blocks[0] as string), pricingLines(blocks[1] as string));
	});

	test("no cost literal uses scientific notation", () => {
		const costLines = config.split("\n").filter((line) => line.includes("cost"));
		assert.ok(costLines.length >= 10, "costs emitted");
		for (const line of costLines) {
			assert.doesNotMatch(line, /[0-9][eE][+-]?[0-9]/, `plain decimal expected: ${line}`);
		}
	});

	test("every non-blocked alias is emitted and the blocked one carries blocked: true", () => {
		for (const model of FAKE_MODELS) {
			const blocks = infoBlocks(model.alias);
			assert.strictEqual(blocks.length, model.deployments.length, `${model.alias} deployment count`);
			if (model.blocked) {
				assert.ok(blocks[0]?.includes("blocked: true"), `${model.alias} blocked flag`);
			}
		}
	});

	test("test mode emits no wildcard routes regardless of the env lookup", () => {
		const withKeys = generateConfig({ realProviders: false }, () => "sk-anything");
		assert.ok(!withKeys.includes("model_name: openai/*"));
		assert.ok(!withKeys.includes('model_name: "*"'));
		assert.ok(!withKeys.includes("litellm_settings:"), "no expansion flag without wildcard routes");
	});

	test("a set key emits its wildcard route plus the expansion flag", () => {
		const real = generateConfig({ realProviders: true, copilotModels: [] }, (name) =>
			name === "OPENAI_API_KEY" ? "sk-real" : ""
		);
		assert.ok(real.includes("  - model_name: openai/*"), "wildcard route emitted");
		assert.ok(!real.includes("model_name: anthropic/*"), "keyless providers stay out");
		assert.ok(
			real.includes("litellm_settings:\n  check_provider_endpoint: true"),
			"wildcards come with live-catalog expansion"
		);
	});

	test("the bare * passthrough alone does not enable the expansion flag", () => {
		const real = generateConfig({ realProviders: true, copilotModels: [] }, (name) =>
			name === "LITELLM_WILDCARD_ALL" ? "1" : ""
		);
		assert.ok(real.includes('  - model_name: "*"'), "bare passthrough emitted");
		assert.ok(!real.includes("litellm_settings:"), "no provider endpoint to expand");
	});

	test("real mode without keys emits neither wildcards nor the expansion flag", () => {
		const real = generateConfig({ realProviders: true, copilotModels: [] });
		assert.ok(!real.includes("model_name: openai/*"));
		assert.ok(!real.includes("litellm_settings:"));
	});

	test("copilot models emit explicit routes with modes from the catalog", () => {
		const real = generateConfig({
			realProviders: true,
			copilotModels: [
				{ id: "claude-opus-5", type: "chat", supportedEndpoints: ["/chat/completions", "/v1/messages"] },
				{ id: "text-embedding-3-small", type: "embeddings", supportedEndpoints: [] },
				{ id: "gpt-5.4-mini", type: "chat", supportedEndpoints: ["/responses", "ws:/responses"] },
				{ id: "gpt-5.3-codex", type: "chat", supportedEndpoints: ["/chat/completions", "/responses"] },
				{ id: "legacy-default", type: "chat", supportedEndpoints: [] },
			],
		});
		assert.ok(
			real.includes(
				"  - model_name: github_copilot/claude-opus-5\n    litellm_params:\n      model: github_copilot/claude-opus-5\n"
			),
			"chat model emitted"
		);
		for (const chatOnly of ["claude-opus-5", "gpt-5.3-codex", "legacy-default"]) {
			assert.ok(
				!new RegExp(`model: github_copilot/${chatOnly.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n {4}model_info:`).test(
					real
				),
				`${chatOnly} carries no mode (chat endpoint available)`
			);
		}
		assert.ok(
			real.includes("      model: github_copilot/text-embedding-3-small\n    model_info:\n      mode: embedding"),
			"embeddings type maps to litellm's embedding mode"
		);
		assert.ok(
			real.includes("      model: github_copilot/gpt-5.4-mini\n    model_info:\n      mode: responses"),
			"a responses-only endpoint set maps to mode responses despite type chat"
		);
	});

	test("a copilot id outside the safe alphabet is rejected by the emission", () => {
		assert.throws(
			() =>
				generateConfig({
					realProviders: true,
					copilotModels: [{ id: "bad id\nmodel_name: pwned", type: "chat", supportedEndpoints: [] }],
				}),
			/must match/
		);
	});

	test("parseCopilotCatalog drops malformed entries instead of throwing", () => {
		for (const hostile of [null, 42, "nope", {}, { data: "not-a-list" }, { data: null }]) {
			assert.deepStrictEqual(parseCopilotCatalog(hostile), { models: [], rejected: [] });
		}
		const parsed = parseCopilotCatalog({
			data: [
				{ id: "claude-opus-5", capabilities: { type: "chat" }, supported_endpoints: ["/chat/completions", 7] },
				{ id: "bad id\nmodel_name: pwned" },
				{ id: 42 },
				{ id: "bare-entry" },
				{ id: "typed-oddly", capabilities: { type: 9 }, supported_endpoints: "not-a-list" },
			],
		});
		assert.deepStrictEqual(parsed.rejected, ["bad id\nmodel_name: pwned", "<non-string id>"]);
		assert.deepStrictEqual(parsed.models, [
			{ id: "claude-opus-5", type: "chat", supportedEndpoints: ["/chat/completions"] },
			{ id: "bare-entry", type: "chat", supportedEndpoints: [] },
			{ id: "typed-oddly", type: "chat", supportedEndpoints: [] },
		]);
	});

	test("the catalog shape is pinned: exactly 8 entries across 7 aliases", () => {
		const names = config.split("\n").filter((line) => line.startsWith("  - model_name: "));
		assert.strictEqual(names.length, 8, "one entry per deployment");
		assert.strictEqual(new Set(names).size, 7, "seven distinct aliases (the pair repeats)");
	});

	test("costLiteral throws outside its plain-decimal window", () => {
		assert.throws(() => costLiteral(4e-13), /plain-decimal window/);
		assert.throws(() => costLiteral(1e21), /plain-decimal window/);
		assert.throws(() => costLiteral(0), /plain-decimal window/);
		assert.strictEqual(costLiteral(5e-7), "0.0000005");
	});

	const validModel = (overrides: Partial<FakeModel>): FakeModel => ({
		alias: "probe-model",
		capabilities: { tools: true },
		deployments: [{ upstreamModel: "fake-probe" }],
		...overrides,
	});

	test("an alias outside the safe alphabet is rejected", () => {
		assert.throws(() => consolidatedModelEntry(validModel({ alias: "Bad Name" })), /must match/);
	});

	test("an upstream without the fake- prefix is rejected", () => {
		assert.throws(
			() => consolidatedModelEntry(validModel({ deployments: [{ upstreamModel: "gpt-5.2-mini" }] })),
			/must match/
		);
	});

	test("duplicate aliases and duplicate upstreams both throw", () => {
		assert.throws(() => assertUniqueNames([validModel({}), validModel({})]), /Duplicate FAKE_MODELS alias/);
		assert.throws(
			() => assertUniqueNames([validModel({}), validModel({ alias: "probe-two" })]),
			/Duplicate FAKE_MODELS upstream/
		);
	});

	test(`router cooldowns are disabled: deliberate ${COMMAND_SIGIL}error responses must not sideline deployments`, () => {
		assert.ok(config.includes("allowed_fails: 1000000"), "allowed_fails is the load-bearing knob");
		assert.ok(config.includes("cooldown_time: 0"), "cooldown_time backs it up where the router honors 0");
	});
});
