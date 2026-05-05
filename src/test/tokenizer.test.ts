import * as assert from "assert";
import { countTextTokens, countMessageTokens } from "../tokenizer";

suite("Tokenizer", () => {
	test("countTextTokens returns 0 for empty string", () => {
		assert.equal(countTextTokens(""), 0);
	});

	test("countTextTokens handles short text", () => {
		const tokens = countTextTokens("hello world");
		assert.ok(tokens > 0);
		assert.equal(tokens, Math.ceil(Math.max("hello world".length / 3.5, 2 * 1.3)));
	});

	test("countTextTokens handles code with few spaces", () => {
		const code = "const x=foo(bar,baz);";
		const tokens = countTextTokens(code);
		assert.equal(tokens, Math.ceil(code.length / 3.5));
	});

	test("countTextTokens handles many short words", () => {
		const text = "I am a go to do it on";
		const tokens = countTextTokens(text);
		const words = text.split(/\s+/).filter(Boolean);
		assert.equal(tokens, Math.ceil(Math.max(text.length / 3.5, words.length * 1.3)));
	});

	test("countMessageTokens handles text parts", () => {
		const parts = [{ value: "hello world" }];
		const tokens = countMessageTokens(parts);
		assert.equal(tokens, countTextTokens("hello world"));
	});

	test("countMessageTokens handles tool call parts", () => {
		const parts = [{ name: "myTool", input: { key: "val" } }];
		const tokens = countMessageTokens(parts);
		assert.equal(tokens, countTextTokens('myTool{"key":"val"}'));
	});

	test("countMessageTokens handles image data parts", () => {
		const parts = [{ mimeType: "image/png", data: new Uint8Array([1, 2, 3]) }];
		assert.equal(countMessageTokens(parts), 765);
	});

	test("countMessageTokens handles PDF data parts", () => {
		const parts = [{ mimeType: "application/pdf", data: new Uint8Array([1]) }];
		assert.equal(countMessageTokens(parts), 500);
	});

	test("countMessageTokens decodes Uint8Array for text/json data parts", () => {
		const json = '{"key":"value"}';
		const data = new TextEncoder().encode(json);
		const parts = [{ mimeType: "application/json", data }];
		const tokens = countMessageTokens(parts);
		assert.equal(tokens, countTextTokens(json));
	});

	test("countMessageTokens sums mixed parts", () => {
		const parts = [{ value: "describe this" }, { mimeType: "image/png", data: new Uint8Array([1]) }];
		const tokens = countMessageTokens(parts);
		assert.equal(tokens, countTextTokens("describe this") + 765);
	});
});
