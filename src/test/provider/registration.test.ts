import * as assert from "assert";
import { applyCapabilityOverrides } from "../../provider/registration";

suite("applyCapabilityOverrides", () => {
	test("enables toolCalling when override specifies it", () => {
		const result = applyCapabilityOverrides(
			"my-model",
			{ toolCalling: false, imageInput: false },
			{ "my-model": "toolCalling" }
		);
		assert.strictEqual(result.toolCalling, true);
		assert.strictEqual(result.imageInput, false);
	});

	test("enables imageInput when override specifies it", () => {
		const result = applyCapabilityOverrides(
			"my-model",
			{ toolCalling: false, imageInput: false },
			{ "my-model": "imageInput" }
		);
		assert.strictEqual(result.toolCalling, false);
		assert.strictEqual(result.imageInput, true);
	});

	test("enables both capabilities", () => {
		const result = applyCapabilityOverrides(
			"my-model",
			{ toolCalling: false, imageInput: false },
			{ "my-model": "toolCalling,imageInput" }
		);
		assert.strictEqual(result.toolCalling, true);
		assert.strictEqual(result.imageInput, true);
	});

	test("prefix matching applies override to longer model ID", () => {
		const result = applyCapabilityOverrides(
			"gpt-4-turbo",
			{ toolCalling: false, imageInput: false },
			{ "gpt-4": "toolCalling" }
		);
		assert.strictEqual(result.toolCalling, true);
	});

	test("returns original capabilities when no override matches", () => {
		const result = applyCapabilityOverrides(
			"claude-3",
			{ toolCalling: false, imageInput: true },
			{ "gpt-4": "toolCalling" }
		);
		assert.strictEqual(result.toolCalling, false);
		assert.strictEqual(result.imageInput, true);
	});

	test("does not disable capabilities that are already true", () => {
		const result = applyCapabilityOverrides(
			"my-model",
			{ toolCalling: true, imageInput: true },
			{ "my-model": "toolCalling" }
		);
		assert.strictEqual(result.toolCalling, true);
		assert.strictEqual(result.imageInput, true);
	});

	test("server-scoped override takes priority over unscoped", () => {
		const overrides = { "my-model": "toolCalling", "Production/my-model": "imageInput" };
		const result = applyCapabilityOverrides(
			"my-model",
			{ toolCalling: false, imageInput: false },
			overrides,
			"Production"
		);
		assert.strictEqual(result.toolCalling, false);
		assert.strictEqual(result.imageInput, true);
	});

	test("falls back to unscoped override when no server match", () => {
		const overrides = { "my-model": "toolCalling", "Production/my-model": "imageInput" };
		const result = applyCapabilityOverrides(
			"my-model",
			{ toolCalling: false, imageInput: false },
			overrides,
			"Staging"
		);
		assert.strictEqual(result.toolCalling, true);
		assert.strictEqual(result.imageInput, false);
	});
});
