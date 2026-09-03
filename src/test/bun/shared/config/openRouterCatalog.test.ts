import { describe, test } from "bun:test";
import * as assert from "node:assert";
import type {
	CatalogModel,
	OpenRouterFetchFailure,
	SlimOpenRouterModel,
} from "../../../../shared/config/openRouterCatalog";
import {
	createCatalogLookup,
	isRetryableOpenRouterFailure,
	mapOpenRouterEntry,
	parseCatalogSnapshot,
	slimCatalogPayload,
} from "../../../../shared/config/openRouterCatalog";
import { catalogFixtureJson } from "../../../catalogFixture";

const fixture = catalogFixtureJson();

function modelById(id: string): CatalogModel {
	const model = parseCatalogSnapshot(fixture).models.find((entry) => entry.id === id);
	assert.ok(model !== undefined, `fixture model ${id} missing`);
	return model;
}

describe("shared/config openRouterCatalog mapping", () => {
	test("maps every OpenRouter source field to its capability wire key", () => {
		assert.deepStrictEqual(modelById("anthropic/claude-sonnet-4.5"), {
			id: "anthropic/claude-sonnet-4.5",
			name: "Anthropic: Claude Sonnet 4.5",
			fields: {
				context_length: 1000000,
				max_output_tokens: 64000,
				supports_vision: true,
				supports_function_calling: true,
				supports_reasoning: true,
			},
		});
	});

	test("a present modality or parameter list is authoritative both ways", () => {
		// Text-only with a supported_parameters list lacking tools and reasoning:
		// the booleans are known false, not unknown.
		assert.deepStrictEqual(modelById("meta-llama/llama-3-8b-instruct").fields, {
			context_length: 8192,
			max_output_tokens: 4096,
			supports_vision: false,
			supports_function_calling: false,
			supports_reasoning: false,
		});
	});

	test("absent lists and absent numbers leave their fields unset", () => {
		// Every boolean stays unset so lower precedence levels keep those fields.
		// The numeric string context_length parses leniently.
		assert.deepStrictEqual(modelById("mistralai/mistral-tiny"), {
			id: "mistralai/mistral-tiny",
			name: "Mistral Tiny",
			fields: { context_length: 32000 },
		});
	});

	test("entries without a usable id are dropped; a snapshot is never an error", () => {
		const { models } = parseCatalogSnapshot(fixture);
		assert.deepStrictEqual(
			models.map((model) => model.id),
			[
				"anthropic/claude-sonnet-4.5",
				"openai/gpt-4o-mini",
				"meta-llama/llama-3-8b-instruct",
				"fireworks/llama-3-8b-instruct",
				"mistralai/mistral-tiny",
				"gemma-7b",
			]
		);
	});

	test("mapping rejects malformed values instead of throwing", () => {
		assert.strictEqual(mapOpenRouterEntry(null), undefined);
		assert.strictEqual(mapOpenRouterEntry("claude"), undefined);
		assert.strictEqual(mapOpenRouterEntry({ name: "no id" }), undefined);
		assert.deepStrictEqual(
			mapOpenRouterEntry({
				id: "vendor/odd",
				context_length: -5,
				architecture: { input_modalities: "image" },
				top_provider: { max_completion_tokens: 1.5 },
				// A malformed legacy pricing block is just unmapped-key noise.
				pricing: { prompt: "-0.001", completion: [] },
				supported_parameters: [{ tools: true }, "tools"],
			}),
			{ id: "vendor/odd", fields: { supports_function_calling: true, supports_reasoning: false } }
		);
	});

	test("non-catalog payloads degrade to the empty snapshot", () => {
		assert.deepStrictEqual(parseCatalogSnapshot(undefined).models, []);
		assert.deepStrictEqual(parseCatalogSnapshot("[]").models, []);
		assert.deepStrictEqual(parseCatalogSnapshot({ data: "nope" }).models, []);
		assert.deepStrictEqual(parseCatalogSnapshot({ models: [{ id: "a" }] }).models, []);
	});

	test("duplicate ids keep their first occurrence", () => {
		const { models } = parseCatalogSnapshot([
			{ id: "vendor/twin", context_length: 100 },
			{ id: "vendor/twin", context_length: 200 },
		]);
		assert.deepStrictEqual(models, [{ id: "vendor/twin", fields: { context_length: 100 } }]);
	});
});

describe("shared/config openRouterCatalog lookup", () => {
	const snapshot = parseCatalogSnapshot(fixture);
	const lookup = createCatalogLookup(snapshot, { implicitLookup: true });

	test("byExactId answers exact catalog ids only", () => {
		const found = lookup.byExactId("openai/gpt-4o-mini");
		assert.strictEqual(found.kind, "found");
		assert.ok(found.kind === "found");
		assert.strictEqual(found.id, "openai/gpt-4o-mini");
		assert.strictEqual(found.fields.max_output_tokens, 16384);
		assert.deepStrictEqual(lookup.byExactId("gpt-4o-mini"), { kind: "not-found" });
		assert.deepStrictEqual(lookup.byExactId("nope"), { kind: "not-found" });
	});

	test("byRawModelId prefers an exact id, then an unambiguous post-vendor suffix", () => {
		assert.strictEqual(lookup.byRawModelId("gemma-7b").kind, "found");
		const suffix = lookup.byRawModelId("gpt-4o-mini");
		assert.ok(suffix.kind === "found");
		assert.strictEqual(suffix.id, "openai/gpt-4o-mini");
		assert.deepStrictEqual(lookup.byRawModelId("unknown-model"), { kind: "not-found" });
	});

	test("a suffix carried by two vendors answers ambiguous, never a guess", () => {
		assert.deepStrictEqual(lookup.byRawModelId("llama-3-8b-instruct"), { kind: "ambiguous" });
		// Naming the vendor disambiguates.
		const fireworks = lookup.byRawModelId("fireworks/llama-3-8b-instruct");
		assert.ok(fireworks.kind === "found");
		assert.strictEqual(fireworks.fields.context_length, 16384);
	});

	test("implicitLookup false turns off byRawModelId while byExactId keeps serving", () => {
		const optedOut = createCatalogLookup(snapshot, { implicitLookup: false });
		assert.deepStrictEqual(optedOut.byRawModelId("gemma-7b"), { kind: "not-found" });
		assert.deepStrictEqual(optedOut.byRawModelId("gpt-4o-mini"), { kind: "not-found" });
		assert.strictEqual(optedOut.byExactId("anthropic/claude-sonnet-4.5").kind, "found");
	});
});

describe("shared/config openRouterCatalog slimming", () => {
	test("slims to the mapped subset with deterministic key order and id-sorted entries", () => {
		const slim = slimCatalogPayload({
			data: [
				{
					id: "z-vendor/model",
					extra_field: { huge: "payload" },
					supported_parameters: ["temperature", "tools"],
					name: "Z",
					description: "dropped",
					context_length: 4096,
				},
				{
					id: "a-vendor/model",
					pricing: { prompt: "0.000001", completion: "0.000002", image: "0.01" },
					architecture: { input_modalities: ["image", "text"], tokenizer: "dropped" },
					top_provider: { max_completion_tokens: 2048, is_moderated: true },
				},
			],
		});
		const expected: readonly SlimOpenRouterModel[] = [
			{
				id: "a-vendor/model",
				architecture: { input_modalities: ["image"] },
				top_provider: { max_completion_tokens: 2048 },
			},
			{
				id: "z-vendor/model",
				name: "Z",
				context_length: 4096,
				supported_parameters: ["tools"],
			},
		];
		assert.deepStrictEqual(slim, { data: expected });
		// Key order inside each entry is fixed, so the artifact is diffable.
		assert.deepStrictEqual(Object.keys(slim.data[1] ?? {}), ["id", "name", "context_length", "supported_parameters"]);
	});

	test("slimming is idempotent and mapping-equivalent on the fixture", () => {
		const once = slimCatalogPayload(fixture);
		const twice = slimCatalogPayload(once);
		assert.strictEqual(JSON.stringify(twice), JSON.stringify(once));

		const fromRaw = new Map(parseCatalogSnapshot(fixture).models.map((model) => [model.id, model]));
		const fromSlim = parseCatalogSnapshot(once).models;
		assert.strictEqual(fromSlim.length, fromRaw.size);
		for (const model of fromSlim) {
			assert.deepStrictEqual(model, fromRaw.get(model.id));
		}
	});

	test("legacy slim artifacts that still carry pricing blocks parse fine and re-slim without them", () => {
		// Older cached and packaged artifacts were slimmed while pricing still rode
		// the catalog: the decoder must keep reading them, and nothing
		// pricing-derived may reach a snapshot, lookup, or re-encode.
		const legacySlimFile = {
			data: [
				{
					id: "anthropic/claude-3.5-sonnet",
					name: "Anthropic: Claude 3.5 Sonnet",
					context_length: 200000,
					architecture: { input_modalities: ["image"] },
					top_provider: { max_completion_tokens: 8192 },
					pricing: { prompt: "0.000003", completion: "0.000015" },
					supported_parameters: ["tools"],
				},
				{
					id: "free/model",
					pricing: { prompt: "0", completion: "0" },
				},
			],
		};

		const snapshot = parseCatalogSnapshot(legacySlimFile);
		assert.deepStrictEqual(snapshot.models, [
			{
				id: "anthropic/claude-3.5-sonnet",
				name: "Anthropic: Claude 3.5 Sonnet",
				fields: {
					context_length: 200000,
					max_output_tokens: 8192,
					supports_vision: true,
					supports_function_calling: true,
					supports_reasoning: false,
				},
			},
			{ id: "free/model", fields: {} },
		]);

		const lookup = createCatalogLookup(snapshot, { implicitLookup: true });
		assert.deepStrictEqual(lookup.byExactId("free/model"), { kind: "found", id: "free/model", fields: {} });

		// The runtime store re-encodes through slimCatalogPayload on every
		// successful refresh, so a legacy file sheds its pricing keys.
		const reSlimmed = slimCatalogPayload(legacySlimFile);
		assert.deepStrictEqual(reSlimmed, {
			data: [
				{
					id: "anthropic/claude-3.5-sonnet",
					name: "Anthropic: Claude 3.5 Sonnet",
					context_length: 200000,
					architecture: { input_modalities: ["image"] },
					top_provider: { max_completion_tokens: 8192 },
					supported_parameters: ["tools"],
				},
				{ id: "free/model" },
			],
		});
		assert.ok(!JSON.stringify(reSlimmed).includes("pricing"));
	});
});

/**
 * The one retry rule both fetchers consult, pinned as whole outcomes per
 * failure class. Discovery's SDK rule: the transport failures and the four
 * status classes the SDK retries (408, 409, 429, 5xx) earn another attempt;
 * every other 4xx and a body that is not JSON are settled. The 407/410,
 * 499/500 and 599/600 neighbours pin the edges of the two status windows;
 * 600 is not an HTTP 5xx and earns nothing.
 */
describe("isRetryableOpenRouterFailure", () => {
	const http = (status: number): OpenRouterFetchFailure => ({ kind: "http", status });
	const cases: readonly { readonly failure: OpenRouterFetchFailure; readonly retryable: boolean }[] = [
		{ failure: { kind: "timeout", phase: "headers" }, retryable: true },
		{ failure: { kind: "timeout", phase: "body" }, retryable: true },
		{ failure: { kind: "network" }, retryable: true },
		{ failure: http(408), retryable: true },
		{ failure: http(409), retryable: true },
		{ failure: http(429), retryable: true },
		{ failure: http(500), retryable: true },
		{ failure: http(503), retryable: true },
		{ failure: http(599), retryable: true },
		{ failure: http(400), retryable: false },
		{ failure: http(401), retryable: false },
		{ failure: http(403), retryable: false },
		{ failure: http(404), retryable: false },
		{ failure: http(407), retryable: false },
		{ failure: http(410), retryable: false },
		{ failure: http(428), retryable: false },
		{ failure: http(430), retryable: false },
		{ failure: http(499), retryable: false },
		{ failure: http(600), retryable: false },
		{ failure: { kind: "unparseable" }, retryable: false },
	];
	for (const { failure, retryable } of cases) {
		test(`${JSON.stringify(failure)} ${retryable ? "earns another attempt" : "is settled"}`, () => {
			assert.strictEqual(isRetryableOpenRouterFailure(failure), retryable);
		});
	}
});
