import * as assert from "node:assert";
import * as fc from "fast-check";
import * as vscode from "vscode";
import { convertTools } from "../../shared/tools";
import type { OpenAIFunctionToolDef } from "../../shared/wire";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
// Pinned: a required CI gate must not fail on unrelated changes via seed luck.
const SEED = 20260726;

function isPlainRecord(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursive schema-shaped values: real JSON Schema keywords with nested
 * properties/items/$defs branches, salted with arbitrary JSON so unknown and
 * malformed keywords get exercised alongside meaningful ones.
 */
const schemaShaped = fc.letrec<{ schema: unknown }>((tie) => ({
	schema: fc.oneof(
		{ maxDepth: 3, withCrossShrink: true },
		fc.jsonValue({ maxDepth: 1 }),
		fc.record(
			{
				type: fc.constantFrom("object", "string", "array", "number", "integer", "boolean", "null", 42 as unknown),
				description: fc.string({ maxLength: 12 }),
				properties: fc.dictionary(fc.stringMatching(/^[a-z_]{1,8}$/), tie("schema"), { maxKeys: 3 }),
				required: fc.array(fc.stringMatching(/^[a-z_]{1,8}$/), { maxLength: 3 }),
				items: tie("schema"),
				enum: fc.array(fc.jsonValue({ maxDepth: 0 }), { maxLength: 3 }),
				additionalProperties: fc.oneof(fc.boolean(), tie("schema")),
				$defs: fc.dictionary(fc.stringMatching(/^[a-z_]{1,8}$/), tie("schema"), { maxKeys: 2 }),
				anyOf: fc.array(tie("schema"), { maxLength: 2 }),
				minLength: fc.nat({ max: 10 }),
				format: fc.constantFrom("uri", "date-time", "made-up-format"),
				"x-unknown-keyword": fc.jsonValue({ maxDepth: 1 }),
			},
			{ requiredKeys: [] }
		)
	),
})).schema;

/** Anything a misbehaving caller could hand over as a tool definition. */
const toolShaped = fc.record(
	{
		name: fc.oneof(fc.string({ maxLength: 90 }), fc.constant(""), fc.integer().map(String)),
		description: fc.oneof(fc.string({ maxLength: 60 }), fc.constant(undefined)),
		inputSchema: fc.oneof(schemaShaped, fc.constant(undefined)),
	},
	{ requiredKeys: ["name"] }
);

function asOptions(
	tools: vscode.LanguageModelChatTool[],
	toolMode?: vscode.LanguageModelChatToolMode
): vscode.ProvideLanguageModelChatResponseOptions {
	return { tools, toolMode } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
}

function assertToolDefInvariants(def: OpenAIFunctionToolDef): void {
	assert.strictEqual(def.type, "function");
	assert.ok(/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(def.function.name), `sanitized name is invalid: "${def.function.name}"`);
	assert.ok(def.function.name.length <= 64, "sanitized name must be at most 64 chars");
	assert.ok(isPlainRecord(def.function.parameters), "parameters must be a plain object");
	// The schema must be JSON-serializable as sent on the wire.
	JSON.stringify(def.function.parameters);
}

suite("shared/tools convertTools properties", () => {
	test("never throws and always yields wire-safe sanitized definitions", () => {
		fc.assert(
			fc.property(fc.array(toolShaped, { maxLength: 5 }), (tools) => {
				const result = convertTools(asOptions(tools as unknown as vscode.LanguageModelChatTool[]));
				if (tools.length === 0) {
					assert.deepStrictEqual(result, {});
					return;
				}
				const defs = result.tools ?? [];
				assert.strictEqual(defs.length, tools.length, "every object tool definition must survive conversion");
				for (const def of defs) {
					assertToolDefInvariants(def);
				}
				assert.strictEqual(result.tool_choice, "auto");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("schema sanitization is idempotent", () => {
		fc.assert(
			fc.property(schemaShaped, (schema) => {
				const once = convertTools(
					asOptions([{ name: "t", description: "", inputSchema: schema } as vscode.LanguageModelChatTool])
				);
				const sanitized = once.tools?.[0]?.function.parameters;
				const twice = convertTools(
					asOptions([{ name: "t", description: "", inputSchema: sanitized } as vscode.LanguageModelChatTool])
				);
				assert.deepStrictEqual(
					twice.tools?.[0]?.function.parameters,
					sanitized,
					"sanitizing an already-sanitized schema must be a no-op"
				);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("required tool mode targets the sanitized name of a sole tool", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 90 }), (name) => {
				const result = convertTools(
					asOptions(
						[{ name, description: "", inputSchema: undefined } as vscode.LanguageModelChatTool],
						vscode.LanguageModelChatToolMode.Required
					)
				);
				const choice = result.tool_choice;
				assert.ok(typeof choice === "object" && choice.type === "function", "sole required tool must be targeted");
				assert.strictEqual(choice.function.name, result.tools?.[0]?.function.name);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
