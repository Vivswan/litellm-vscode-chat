import * as vscode from "vscode";
import { isRecord } from "./json";
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

function pruneUnknownSchemaKeywords(schema: unknown): Record<string, unknown> {
	if (!isRecord(schema)) {
		return {};
	}
	const allow = new Set([
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
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema)) {
		if (allow.has(k)) {
			out[k] = v as unknown;
		}
	}
	return out;
}

function sanitizeSchema(input: unknown, propName?: string): Record<string, unknown> {
	if (!isRecord(input)) {
		return { type: "object", properties: {} } as Record<string, unknown>;
	}

	let schema = input;

	schema = pruneUnknownSchemaKeywords(schema);

	for (const composite of ["anyOf", "oneOf", "allOf"]) {
		const branch = schema[composite] as unknown;
		if (Array.isArray(branch) && branch.length > 0) {
			schema[composite] = branch.filter((b) => b && typeof b === "object").map((b) => sanitizeSchema(b, propName));
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

	const hasComposite = ["anyOf", "oneOf", "allOf"].some(
		(k) => Array.isArray(schema[k]) && (schema[k] as unknown[]).length > 0
	);
	const hasRef = typeof schema.$ref === "string";
	const hasConst = "const" in schema;

	let t = schema.type as string | undefined;
	if (t == null && !hasComposite && !hasRef && !hasConst) {
		t = "object";
		schema.type = t;
	}

	if (t === "number" && propName && isIntegerLikePropertyName(propName)) {
		schema.type = "integer";
		t = "integer";
	}

	if (t === "object") {
		const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
		const newProps: Record<string, unknown> = {};
		if (props && typeof props === "object") {
			for (const [k, v] of Object.entries(props)) {
				newProps[k] = sanitizeSchema(v, k);
			}
		}
		schema.properties = newProps;

		const req = schema.required as unknown;
		if (Array.isArray(req)) {
			schema.required = req.filter((r) => typeof r === "string");
		} else if (req !== undefined) {
			schema.required = [];
		}

		const ap = schema.additionalProperties as unknown;
		if (ap !== undefined && typeof ap !== "boolean") {
			delete schema.additionalProperties;
		}
	} else if (t === "array") {
		const items = schema.items as unknown;
		if (Array.isArray(items) && items.length > 0) {
			schema.items = sanitizeSchema(items[0]);
		} else if (items && typeof items === "object") {
			schema.items = sanitizeSchema(items);
		} else {
			schema.items = { type: "string" } as Record<string, unknown>;
		}
	}

	return schema;
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
export function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | "required" | { type: "function"; function: { name: string } };
} {
	const tools = options.tools ?? [];
	if (!tools || tools.length === 0) {
		return {};
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t): t is vscode.LanguageModelChatTool => t && typeof t === "object")
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

	let tool_choice: "auto" | "required" | { type: "function"; function: { name: string } } = "auto";
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
