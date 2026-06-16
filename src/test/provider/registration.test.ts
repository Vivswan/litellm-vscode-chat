import * as assert from "assert";
import { buildModelInfos } from "../../provider/registration";
import type { LiteLLMModelItem, LiteLLMProvider } from "../../types";
import type { ServerWithKey } from "../../extension/serverRegistry";

const SERVER: ServerWithKey = {
	id: "srv",
	label: "Test",
	baseUrl: "http://localhost:4000",
	apiKey: "sk-test",
};

const noop = () => {};

function provider(overrides: Partial<LiteLLMProvider> = {}): LiteLLMProvider {
	return {
		provider: "anthropic",
		status: "ok",
		source: "model_info",
		supports_tools: true,
		supports_prompt_caching: true,
		...overrides,
	};
}

function model(id: string, prov: LiteLLMProvider): LiteLLMModelItem {
	return {
		id,
		object: "model",
		created: 0,
		owned_by: "test",
		providers: [prov],
	};
}

function buildOne(id: string, prov: LiteLLMProvider) {
	const result = buildModelInfos([model(id, prov)], SERVER, 1, noop);
	const exposedId = [...result.cacheControlNoInline.keys()][0];
	return {
		cacheControlNoInline: result.cacheControlNoInline.get(exposedId),
		toolsCacheNo1h: result.toolsCacheNo1h.get(exposedId),
	};
}

suite("registration Gemini cache_control scoping", () => {
	// `cacheControlIncompatible` (the cacheControlNoInline flag) must fire ONLY
	// for native Gemini, never for Anthropic Claude / Llama / Mistral that are
	// merely *hosted* on Vertex (provider name `vertex_ai`). Those use the same
	// inline cache_control semantics as direct Anthropic and would lose prompt
	// caching entirely if wrongly flagged.

	test("native Gemini provider is flagged incompatible", () => {
		const { cacheControlNoInline } = buildOne("gemini-2.5-pro", provider({ provider: "gemini" }));
		assert.strictEqual(cacheControlNoInline, true);
	});

	test("Gemini on Vertex (vertex_ai + gemini model id) is flagged incompatible", () => {
		const { cacheControlNoInline } = buildOne("vertex_ai/gemini-2.5-flash", provider({ provider: "vertex_ai" }));
		assert.strictEqual(cacheControlNoInline, true);
	});

	test("Claude on Vertex is NOT flagged (keeps inline cache_control)", () => {
		const { cacheControlNoInline } = buildOne("vertex_ai/claude-3-5-sonnet", provider({ provider: "vertex_ai" }));
		assert.strictEqual(cacheControlNoInline, false);
	});

	test("Llama on Vertex is NOT flagged", () => {
		const { cacheControlNoInline } = buildOne("vertex_ai/llama-3.1-70b", provider({ provider: "vertex_ai" }));
		assert.strictEqual(cacheControlNoInline, false);
	});

	test("Mistral on Vertex is NOT flagged", () => {
		const { cacheControlNoInline } = buildOne("vertex_ai/mistral-large", provider({ provider: "vertex_ai" }));
		assert.strictEqual(cacheControlNoInline, false);
	});

	test("direct Anthropic is NOT flagged", () => {
		const { cacheControlNoInline } = buildOne("claude-3-5-sonnet", provider({ provider: "anthropic" }));
		assert.strictEqual(cacheControlNoInline, false);
	});

	test("Bedrock provider sets toolsCacheNo1h but not cacheControlNoInline", () => {
		const { cacheControlNoInline, toolsCacheNo1h } = buildOne(
			"anthropic.claude-3-5-sonnet",
			provider({ provider: "bedrock" })
		);
		assert.strictEqual(toolsCacheNo1h, true);
		assert.strictEqual(cacheControlNoInline, false);
	});
});

suite("registration heterogeneous group aggregation", () => {
	// A multi-provider model (the `:cheapest` route) degrades to the most
	// restrictive provider via `.some(...)`.
	function buildGroup(id: string, providers: LiteLLMProvider[]) {
		const m: LiteLLMModelItem = { id, object: "model", created: 0, owned_by: "test", providers };
		const result = buildModelInfos([m], SERVER, 1, noop);
		const cheapestId = [...result.cacheControlNoInline.keys()].find((k) => k.includes("cheapest"));
		assert.ok(cheapestId, "expected a :cheapest exposed id");
		return {
			cacheControlNoInline: result.cacheControlNoInline.get(cheapestId),
			toolsCacheNo1h: result.toolsCacheNo1h.get(cheapestId),
		};
	}

	test("group with a Gemini member disables inline cache_control for the whole group", () => {
		const { cacheControlNoInline } = buildGroup("gemini-2.5-pro", [
			provider({ provider: "vertex_ai" }),
			provider({ provider: "gemini" }),
		]);
		assert.strictEqual(cacheControlNoInline, true);
	});

	test("group with a Bedrock member sets toolsCacheNo1h for the whole group", () => {
		const { toolsCacheNo1h } = buildGroup("claude-3-5-sonnet", [
			provider({ provider: "anthropic" }),
			provider({ provider: "bedrock" }),
		]);
		assert.strictEqual(toolsCacheNo1h, true);
	});

	test("all-Anthropic group keeps both flags false", () => {
		const { cacheControlNoInline, toolsCacheNo1h } = buildGroup("claude-3-5-sonnet", [
			provider({ provider: "anthropic" }),
			provider({ provider: "anthropic" }),
		]);
		assert.strictEqual(cacheControlNoInline, false);
		assert.strictEqual(toolsCacheNo1h, false);
	});
});
