/**
 * The agent tools' manifest inputSchema blocks, derived from their zod envelopes so package.json can never tell the
 * model a shape the parse refuses. Two readers shape the output: VS Code's tool exporter drops a schema whose root has
 * no `type`, so a union root carries `type: "object"` beside its `anyOf`; and this extension's own tool converter
 * narrows an untyped property to an object, so an unknown-valued field spells out every JSON type instead of the bare
 * `{}` zod would emit.
 */
import { z } from "zod";
import { AGENT_TOOL_INPUT_SCHEMAS } from "../../../src/extension/features/agentTools/inputSchema";
import type { AgentToolId } from "../../../src/shared/config/commandIds";

const ANY_JSON_TYPE = [
	"string",
	"number",
	"boolean",
	"object",
	"array",
	"null",
] as const satisfies readonly z.core.JSONSchema.SchemaType[];

export function manifestInputSchema(id: AgentToolId): Record<string, unknown> {
	const { $schema: _draft, ...schema } = z.toJSONSchema(AGENT_TOOL_INPUT_SCHEMAS[id], {
		io: "input",
		override: ({ zodSchema, jsonSchema, path }) => {
			const kind = zodSchema._zod.def.type;
			if (kind === "unknown") {
				jsonSchema.type = [...ANY_JSON_TYPE];
			}
			if (kind === "union") {
				// Discriminated unions come out as oneOf; anyOf is what the hand-written schemas carried and what every
				// provider accepts.
				if (jsonSchema.oneOf !== undefined) {
					jsonSchema.anyOf = jsonSchema.oneOf;
					delete jsonSchema.oneOf;
				}
				if (path.length === 0) {
					jsonSchema.type = "object";
				}
			}
		},
	});
	return schema;
}
