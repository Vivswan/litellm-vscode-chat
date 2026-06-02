import * as assert from "assert";
import * as vscode from "vscode";
import { convertTools } from "../../shared/tools";

suite("shared/tools", () => {
	test("convertTools returns function tool definitions", () => {
		const out = convertTools({
			tools: [
				{
					name: "do_something",
					description: "Does something",
					inputSchema: { type: "object", properties: { x: { type: "number" } }, additionalProperties: false },
				},
			],
			toolMode: vscode.LanguageModelChatToolMode.Auto,
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);

		assert.ok(out);
		assert.equal(out.tool_choice, "auto");
		assert.ok(Array.isArray(out.tools) && out.tools[0].type === "function");
		assert.equal(out.tools[0].function.name, "do_something");
	});

	test("convertTools tags only the last tool when cacheTools is enabled", () => {
		const out = convertTools(
			{
				tools: [
					{ name: "tool_a", description: "A", inputSchema: {} },
					{ name: "tool_b", description: "B", inputSchema: {} },
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions,
			{ cacheTools: true }
		);

		assert.ok(Array.isArray(out.tools) && out.tools.length === 2);
		assert.equal(out.tools[0].cache_control, undefined);
		assert.deepEqual(out.tools[1].cache_control, { type: "ephemeral" });
	});

	test("convertTools does not tag tools unless cacheTools is enabled", () => {
		const out = convertTools({
			tools: [
				{ name: "tool_a", description: "A", inputSchema: {} },
				{ name: "tool_b", description: "B", inputSchema: {} },
			],
			toolMode: vscode.LanguageModelChatToolMode.Auto,
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);

		assert.ok(Array.isArray(out.tools) && out.tools.length === 2);
		assert.equal(out.tools[0].cache_control, undefined);
		assert.equal(out.tools[1].cache_control, undefined);
	});

	test("convertTools respects ToolMode.Required for single tool", () => {
		const out = convertTools({
			toolMode: vscode.LanguageModelChatToolMode.Required,
			tools: [{ name: "only_tool", description: "Only tool", inputSchema: {} }],
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.deepEqual(out.tool_choice, { type: "function", function: { name: "only_tool" } });
	});

	test("convertTools uses 'required' for ToolMode.Required with multiple tools", () => {
		const out = convertTools({
			toolMode: vscode.LanguageModelChatToolMode.Required,
			tools: [
				{ name: "tool_a", description: "A", inputSchema: {} },
				{ name: "tool_b", description: "B", inputSchema: {} },
			],
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.equal(out.tool_choice, "required");
		assert.ok(Array.isArray(out.tools) && out.tools.length === 2);
	});

	test("schema preserves anyOf/oneOf/allOf branches", () => {
		const out = convertTools({
			tools: [
				{
					name: "flexible_tool",
					description: "Tool with composite schema",
					inputSchema: { type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } } },
				},
			],
			toolMode: vscode.LanguageModelChatToolMode.Auto,
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out.tools);
		const params = out.tools![0].function.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, Record<string, unknown>>;
		assert.ok(Array.isArray(props.value.anyOf), "anyOf should be preserved");
		assert.equal((props.value.anyOf as unknown[]).length, 2);
	});

	test("schema preserves const keyword", () => {
		const out = convertTools({
			tools: [
				{
					name: "const_tool",
					description: "Tool with const",
					inputSchema: { type: "object", properties: { action: { type: "string", const: "submit" } } },
				},
			],
			toolMode: vscode.LanguageModelChatToolMode.Auto,
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out.tools);
		const params = out.tools![0].function.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, Record<string, unknown>>;
		assert.equal(props.action.const, "submit", "const keyword should be preserved");
	});

	test("schema does not force type on const-only nodes", () => {
		const out = convertTools({
			tools: [
				{
					name: "const_only_tool",
					description: "Tool with const-only property",
					inputSchema: { type: "object", properties: { action: { const: "submit" } } },
				},
			],
			toolMode: vscode.LanguageModelChatToolMode.Auto,
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out.tools);
		const params = out.tools![0].function.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, Record<string, unknown>>;
		assert.equal(props.action.const, "submit");
		assert.equal(props.action.type, undefined);
		assert.equal(props.action.properties, undefined);
	});

	test("schema does not force type on $ref-only nodes", () => {
		const out = convertTools({
			tools: [
				{
					name: "ref_tool",
					description: "Tool with $ref",
					inputSchema: {
						type: "object",
						properties: { item: { $ref: "#/$defs/Item" } },
						$defs: { Item: { type: "string" } },
					},
				},
			],
			toolMode: vscode.LanguageModelChatToolMode.Auto,
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out.tools);
		const params = out.tools![0].function.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, Record<string, unknown>>;
		assert.equal(props.item["$ref"], "#/$defs/Item");
		assert.equal(props.item.type, undefined);
		assert.equal(props.item.properties, undefined);
	});

	test("schema does not force type on type-less anyOf nodes", () => {
		const out = convertTools({
			tools: [
				{
					name: "union_tool",
					description: "Tool with typeless anyOf",
					inputSchema: {
						type: "object",
						properties: {
							value: { anyOf: [{ type: "string" }, { type: "number" }], description: "A string or number" },
						},
					},
				},
			],
			toolMode: vscode.LanguageModelChatToolMode.Auto,
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out.tools);
		const params = out.tools![0].function.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, Record<string, unknown>>;
		assert.ok(Array.isArray(props.value.anyOf));
		assert.equal(props.value.type, undefined);
		assert.equal(props.value.properties, undefined);
	});
});
