import * as vscode from "vscode";
import { isRecord } from "../util/json";
import type { OpenAIFunctionToolDef } from "./wire";

function isIntegerLikePropertyName(propertyName: string | undefined): boolean {
	if (!propertyName) {
		return false;
	}
	const lowered = propertyName.toLowerCase();
	const integerMarkers = [
		"id",
		"limit",
		"count",
		"index",
		"size",
		"offset",
		"length",
		"results_limit",
		"maxresults",
		"debugsessionid",
		"cellid",
	];
	return integerMarkers.some((m) => lowered.includes(m)) || lowered.endsWith("_id");
}

function sanitizeFunctionName(name: unknown): string {
	if (typeof name !== "string" || !name) {
		return "tool";
	}
	let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (!/^[a-zA-Z]/.test(sanitized)) {
		sanitized = `tool_${sanitized}`;
	}
	sanitized = sanitized.replace(/_+/g, "_");
	return sanitized.slice(0, 64);
}

const ALLOWED_SCHEMA_KEYWORDS = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"description",
	"enum",
	"default",
	"items",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"pattern",
	"format",
	"const",
	"examples",
	"title",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"minItems",
	"maxItems",
	"uniqueItems",
	"$ref",
	"definitions",
	"$defs",
	"anyOf",
	"oneOf",
	"allOf",
]);

/** A fresh object holding only the allow-listed keywords, so sanitizeSchema can mutate it freely. */
function pruneUnknownSchemaKeywords(schema: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema)) {
		if (ALLOWED_SCHEMA_KEYWORDS.has(k)) {
			out[k] = v;
		}
	}
	return out;
}

const COMPOSITE_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

function sanitizeSchema(input: unknown, propName?: string): Record<string, unknown> {
	if (!isRecord(input)) {
		return { type: "object", properties: {} };
	}

	const schema = pruneUnknownSchemaKeywords(input);

	for (const composite of COMPOSITE_KEYWORDS) {
		const branch = schema[composite];
		if (Array.isArray(branch) && branch.length > 0) {
			// Arrays pass this object guard deliberately: an array branch member
			// falls through to sanitizeSchema's non-record default schema instead
			// of being dropped, keeping the composite's branch count stable.
			schema[composite] = branch
				.filter((b) => typeof b === "object" && b !== null)
				.map((b) => sanitizeSchema(b, propName));
		}
	}

	for (const defKey of ["definitions", "$defs"]) {
		const defs = schema[defKey];
		if (isRecord(defs)) {
			const sanitized: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(defs)) {
				sanitized[k] = sanitizeSchema(v);
			}
			schema[defKey] = sanitized;
		}
	}

	const hasComposite = COMPOSITE_KEYWORDS.some((key) => {
		const branch = schema[key];
		return Array.isArray(branch) && branch.length > 0;
	});
	const hasRef = typeof schema.$ref === "string";
	const hasConst = "const" in schema;

	const rawType = schema.type;
	let t = typeof rawType === "string" ? rawType : undefined;
	if (rawType == null && !hasComposite && !hasRef && !hasConst) {
		t = "object";
		schema.type = t;
	}

	if (t === "number" && propName && isIntegerLikePropertyName(propName)) {
		schema.type = "integer";
		t = "integer";
	}

	if (t === "object") {
		const props = schema.properties ?? {};
		const newProps: Record<string, unknown> = {};
		// Arrays pass this object guard deliberately: an array `properties` value
		// sanitizes into an index-keyed property map rather than being emptied.
		if (typeof props === "object" && props !== null) {
			for (const [k, v] of Object.entries(props)) {
				newProps[k] = sanitizeSchema(v, k);
			}
		}
		schema.properties = newProps;

		const req = schema.required;
		if (Array.isArray(req)) {
			schema.required = req.filter((r) => typeof r === "string");
		} else if (req !== undefined) {
			schema.required = [];
		}

		const ap = schema.additionalProperties;
		if (ap !== undefined && typeof ap !== "boolean") {
			delete schema.additionalProperties;
		}
	} else if (t === "array") {
		const items = schema.items;
		if (Array.isArray(items) && items.length > 0) {
			schema.items = sanitizeSchema(items[0]);
		} else if (typeof items === "object" && items !== null) {
			schema.items = sanitizeSchema(items);
		} else {
			schema.items = { type: "string" };
		}
	}

	return schema;
}

/** Which tool the model must call: OpenAI's tool_choice values as this extension sends them. */
type OpenAIToolChoice = "auto" | "required" | { type: "function"; function: { name: string } };

/**
 * Tools and their choice directive travel as one unit: a request either
 * carries both or neither, so a tool_choice can never ship without the tools
 * it refers to.
 */
export interface ToolConfig {
	tools: OpenAIFunctionToolDef[];
	tool_choice: OpenAIToolChoice;
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions, or
 * undefined when the request carries no tools.
 * @param options Request options containing tools and toolMode.
 */
export function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): ToolConfig | undefined {
	const tools = options.tools ?? [];
	if (tools.length === 0) {
		return undefined;
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t): t is vscode.LanguageModelChatTool => typeof t === "object" && t !== null)
		.map((t: vscode.LanguageModelChatTool) => {
			const name = sanitizeFunctionName(t.name);
			const description = typeof t.description === "string" ? t.description : "";
			const params = sanitizeSchema(t.inputSchema ?? { type: "object", properties: {} });
			return {
				type: "function" as const,
				function: {
					name,
					description,
					parameters: params,
				},
			} satisfies OpenAIFunctionToolDef;
		});

	let tool_choice: OpenAIToolChoice = "auto";
	if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
		const [soleTool] = tools;
		if (tools.length === 1 && soleTool !== undefined) {
			tool_choice = { type: "function", function: { name: sanitizeFunctionName(soleTool.name) } };
		} else {
			tool_choice = "required";
		}
	}

	return { tools: toolDefs, tool_choice };
}
