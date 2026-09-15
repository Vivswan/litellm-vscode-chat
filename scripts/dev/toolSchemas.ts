/**
 * The agent tools' manifest inputSchema blocks, derived from their zod
 * envelopes so package.json can never tell the model a shape the parse
 * refuses. Two readers shape the output: VS Code's tool exporter drops a
 * schema whose root has no `type`, so a union root carries `type: "object"`
 * beside its `anyOf`; and this extension's own tool converter narrows an
 * untyped property to an object, so an unknown-valued field spells out every
 * JSON type instead of the bare `{}` zod would emit.
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AGENT_TOOL_INPUT_SCHEMAS } from "../../src/extension/features/agentTools/inputSchema";
import { AGENT_TOOL_IDS, AGENT_TOOLS, type AgentToolId } from "../../src/shared/config/commandIds";

/** Every JSON type: what an unknown-valued field admits. */
const ANY_JSON_TYPE = [
	"string",
	"number",
	"boolean",
	"object",
	"array",
	"null",
] as const satisfies readonly z.core.JSONSchema.SchemaType[];

export type ToolInputSchema = Record<string, unknown>;

/** One tool's inputSchema exactly as the manifest carries it. */
export function manifestInputSchema(id: AgentToolId): ToolInputSchema {
	const { $schema: _draft, ...schema } = z.toJSONSchema(AGENT_TOOL_INPUT_SCHEMAS[id], {
		io: "input",
		override: ({ zodSchema, jsonSchema, path }) => {
			const kind = zodSchema._zod.def.type;
			if (kind === "unknown") {
				jsonSchema.type = [...ANY_JSON_TYPE];
			}
			if (kind === "union") {
				// Discriminated unions come out as oneOf; anyOf is what the
				// hand-written schemas carried and what every provider accepts.
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

interface ManifestTool {
	readonly name?: string;
	inputSchema?: unknown;
}

interface Manifest {
	readonly contributes: {
		readonly languageModelTools: ManifestTool[];
	};
}

/** Tab-indented with a trailing newline: the formatting the repository's package.json uses. */
function serializeManifest(manifest: Manifest): string {
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}

export interface ToolSchemaRegeneration {
	/** The manifest text with every agent tool's inputSchema regenerated. */
	readonly next: string;
	/** The contribution names whose stored inputSchema differed from the generated one. */
	readonly drifted: readonly string[];
}

/** Regenerate every agent tool's inputSchema inside the manifest text; a tool the manifest does not contribute is an error. */
export function regenerateToolSchemas(manifestText: string): ToolSchemaRegeneration {
	const manifest = JSON.parse(manifestText) as Manifest;
	const drifted: string[] = [];
	for (const id of AGENT_TOOL_IDS) {
		const { name } = AGENT_TOOLS[id];
		const tool = manifest.contributes.languageModelTools.find((entry) => entry.name === name);
		if (tool === undefined) {
			throw new Error(`package.json does not contribute the ${name} tool`);
		}
		const schema = manifestInputSchema(id);
		if (!isDeepStrictEqual(tool.inputSchema, schema)) {
			drifted.push(name);
		}
		tool.inputSchema = schema;
	}
	return { next: serializeManifest(manifest), drifted };
}
