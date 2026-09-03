import * as assert from "node:assert";
import * as vscode from "vscode";
import { convertTools } from "../../../shared/conversion/tools";
import { expectDefined } from "../../pureHelpers";

suite("shared/conversion/tools", () => {
	test("convertTools returns function tool definitions", () => {
		const out = convertTools({
			tools: [
				{
					name: "do_something",
					description: "Does something",
					inputSchema: {
						type: "object",
						properties: { x: { type: "number" }, count: { type: "number" } },
						additionalProperties: false,
					},
				},
			],
			toolMode: vscode.LanguageModelChatToolMode.Auto,
			requestInitiator: "test",
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);

		// The wire schema is the SANITIZED input: the integer-like property name
		// narrows to integer, so a verbatim pass-through cannot satisfy this.
		assert.deepStrictEqual(out, {
			tool_choice: "auto",
			tools: [
				{
					type: "function",
					function: {
						name: "do_something",
						description: "Does something",
						parameters: {
							type: "object",
							properties: { x: { type: "number" }, count: { type: "integer" } },
							additionalProperties: false,
						},
					},
				},
			],
		});
	});

	test("convertTools respects ToolMode.Required for single tool", () => {
		const out = convertTools({
			toolMode: vscode.LanguageModelChatToolMode.Required,
			requestInitiator: "test",
			tools: [{ name: "only_tool", description: "Only tool", inputSchema: {} }],
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out);
		assert.deepEqual(out.tool_choice, { type: "function", function: { name: "only_tool" } });
	});

	test("convertTools uses 'required' for ToolMode.Required with multiple tools", () => {
		const out = convertTools({
			toolMode: vscode.LanguageModelChatToolMode.Required,
			requestInitiator: "test",
			tools: [
				{ name: "tool_a", description: "A", inputSchema: {} },
				{ name: "tool_b", description: "B", inputSchema: {} },
			],
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out);
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
			requestInitiator: "test",
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out);
		const params = expectDefined(out.tools[0]).function.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, Record<string, unknown>>;
		const value = expectDefined(props.value);
		assert.ok(Array.isArray(value.anyOf), "anyOf should be preserved");
		assert.equal((value.anyOf as unknown[]).length, 2);
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
			requestInitiator: "test",
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out);
		const params = expectDefined(out.tools[0]).function.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, Record<string, unknown>>;
		assert.equal(expectDefined(props.action).const, "submit", "const keyword should be preserved");
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
			requestInitiator: "test",
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out);
		const params = expectDefined(out.tools[0]).function.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, Record<string, unknown>>;
		const action = expectDefined(props.action);
		assert.equal(action.const, "submit");
		assert.equal(action.type, undefined);
		assert.equal(action.properties, undefined);
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
			requestInitiator: "test",
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out);
		const params = expectDefined(out.tools[0]).function.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, Record<string, unknown>>;
		const item = expectDefined(props.item);
		assert.equal(item.$ref, "#/$defs/Item");
		assert.equal(item.type, undefined);
		assert.equal(item.properties, undefined);
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
			requestInitiator: "test",
		} satisfies vscode.ProvideLanguageModelChatResponseOptions);
		assert.ok(out);
		const params = expectDefined(out.tools[0]).function.parameters as Record<string, unknown>;
		const props = params.properties as Record<string, Record<string, unknown>>;
		const value = expectDefined(props.value);
		assert.ok(Array.isArray(value.anyOf));
		assert.equal(value.type, undefined);
		assert.equal(value.properties, undefined);
	});
});

suite("shared/conversion/tools additional schema keywords", () => {
	function convertWith(inputSchema: object, additionalKeywords?: readonly string[]) {
		const out = convertTools(
			{
				tools: [{ name: "keyword_tool", description: "Keyword tool", inputSchema }],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				requestInitiator: "test",
			} satisfies vscode.ProvideLanguageModelChatResponseOptions,
			additionalKeywords
		);
		assert.ok(out);
		return expectDefined(out.tools[0]).function.parameters as Record<string, unknown>;
	}

	test("an unlisted keyword is pruned by default and kept verbatim when listed", () => {
		const schema = {
			type: "object",
			properties: {},
			propertyNames: { pattern: "^[a-z]+$" },
		};
		const pruned = convertWith(schema);
		assert.equal(pruned.propertyNames, undefined);

		const kept = convertWith(schema, ["propertyNames"]);
		// The extra keyword's VALUE passes through verbatim: the sanitizer only
		// rewrites the structural built-ins it knows.
		assert.deepEqual(kept.propertyNames, { pattern: "^[a-z]+$" });
	});

	test("additional keywords extend the allowlist without changing the built-ins", () => {
		const schema = {
			type: "object",
			properties: { x: { type: "string", minLength: 1, unlisted: true } },
			required: ["x", 42],
		};
		const params = convertWith(schema, ["propertyNames"]);
		const props = params.properties as Record<string, Record<string, unknown>>;
		const x = expectDefined(props.x);
		assert.equal(x.minLength, 1, "built-in keywords still pass");
		assert.equal(x.unlisted, undefined, "keywords outside both sets still prune");
		assert.deepEqual(params.required, ["x"], "the built-in structural rewrites still apply");
	});

	test("additional keywords apply at every nesting level", () => {
		const schema = {
			type: "object",
			properties: {
				nested: { type: "object", properties: {}, propertyNames: { maxLength: 8 } },
				list: { type: "array", items: { type: "object", properties: {}, propertyNames: { maxLength: 8 } } },
			},
			$defs: {
				Entry: { type: "object", properties: {}, propertyNames: { maxLength: 8 } },
			},
		};
		const params = convertWith(schema, ["propertyNames"]);
		const props = params.properties as Record<string, Record<string, unknown>>;
		assert.deepEqual(expectDefined(props.nested).propertyNames, { maxLength: 8 });
		const items = expectDefined(props.list).items as Record<string, unknown>;
		assert.deepEqual(items.propertyNames, { maxLength: 8 });
		const defs = params.$defs as Record<string, Record<string, unknown>>;
		assert.deepEqual(expectDefined(defs.Entry).propertyNames, { maxLength: 8 });
	});

	test("an empty additions list behaves exactly like no additions", () => {
		const schema = { type: "object", properties: {}, propertyNames: { pattern: "^[a-z]+$" } };
		assert.deepEqual(convertWith(schema, []), convertWith(schema));
	});

	test("prototype-polluting keyword names are refused, so a schema's __proto__ key never becomes a prototype", () => {
		const schema = {
			type: "object",
			properties: {},
			// If "__proto__" were admitted, copying this key would ASSIGN the
			// sanitized object's prototype instead of forwarding an own keyword,
			// and the inherited `maximum` would leak into later reads.
			["__proto__"]: { maximum: 5 },
		};
		const params = convertWith(schema, ["__proto__", "constructor", "propertyNames"]);
		assert.strictEqual(Object.getPrototypeOf(params), Object.prototype, "the prototype must stay untouched");
		assert.strictEqual(Object.hasOwn(params, "__proto__"), false);
		assert.strictEqual(params.maximum, undefined, "nothing may be inherited from the schema value");
	});
});
