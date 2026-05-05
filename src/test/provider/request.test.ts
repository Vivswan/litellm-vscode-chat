import * as assert from "assert";
import { buildRequestBody } from "../../provider/request";

function buildWithParams(rawModelId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return buildRequestBody({
		rawModelId,
		openaiMessages: [],
		maxTokens: 1000,
		modelParams: {
			_replaceDefaults: true,
			temperature: 0.5,
			top_p: 0.9,
			frequency_penalty: 0.1,
			presence_penalty: 0.2,
			...extra,
		},
		toolConfig: {},
	});
}

suite("buildRequestBody param filtering", () => {
	test("o1 model strips temperature, top_p, frequency_penalty, presence_penalty", () => {
		const body = buildWithParams("o1-preview");
		assert.strictEqual(body.temperature, undefined);
		assert.strictEqual(body.top_p, undefined);
		assert.strictEqual(body.frequency_penalty, undefined);
		assert.strictEqual(body.presence_penalty, undefined);
	});

	test("base o1 model also strips params", () => {
		const body = buildWithParams("o1");
		assert.strictEqual(body.temperature, undefined);
		assert.strictEqual(body.top_p, undefined);
		assert.strictEqual(body.frequency_penalty, undefined);
		assert.strictEqual(body.presence_penalty, undefined);
	});

	test("claude model strips temperature", () => {
		const body = buildWithParams("claude-3-5-sonnet-20241022");
		assert.strictEqual(body.temperature, undefined);
		assert.strictEqual(body.top_p, 0.9);
		assert.strictEqual(body.frequency_penalty, 0.1);
		assert.strictEqual(body.presence_penalty, 0.2);
	});

	test("gpt-4o retains all params", () => {
		const body = buildWithParams("gpt-4o");
		assert.strictEqual(body.temperature, 0.5);
		assert.strictEqual(body.top_p, 0.9);
		assert.strictEqual(body.frequency_penalty, 0.1);
		assert.strictEqual(body.presence_penalty, 0.2);
	});

	test("gpt-5.1-codex strips temperature, frequency_penalty, presence_penalty but keeps top_p", () => {
		const body = buildWithParams("gpt-5.1-codex");
		assert.strictEqual(body.temperature, undefined);
		assert.strictEqual(body.top_p, 0.9);
		assert.strictEqual(body.frequency_penalty, undefined);
		assert.strictEqual(body.presence_penalty, undefined);
	});

	test("provider-prefixed model ID strips params correctly", () => {
		const body = buildWithParams("openai/o1-preview");
		assert.strictEqual(body.temperature, undefined);
		assert.strictEqual(body.top_p, undefined);
		assert.strictEqual(body.frequency_penalty, undefined);
		assert.strictEqual(body.presence_penalty, undefined);
	});

	test("provider-prefixed unmatched model retains all params", () => {
		const body = buildWithParams("openai/gpt-4o");
		assert.strictEqual(body.temperature, 0.5);
		assert.strictEqual(body.top_p, 0.9);
	});
});
