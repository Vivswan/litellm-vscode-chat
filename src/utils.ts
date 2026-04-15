import * as vscode from "vscode";
import type {
	OpenAIChatContentBlock,
	OpenAIChatFileContentBlock,
	OpenAIChatImageUrlContentBlock,
	OpenAIChatMessage,
	OpenAIChatRole,
	OpenAIFunctionToolDef,
	OpenAIToolCall,
} from "./types";
import { log, warn, error } from "./logger";

// Tool calling sanitization helpers

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
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
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
		// Widely supported by OpenAI, Anthropic, Gemini, and most LiteLLM-backed providers
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
		// Composite schemas — preserved and recursively sanitized
		"anyOf",
		"oneOf",
		"allOf",
	]);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
		if (allow.has(k)) {
			out[k] = v as unknown;
		}
	}
	return out;
}

function sanitizeSchema(input: unknown, propName?: string): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { type: "object", properties: {} } as Record<string, unknown>;
	}

	let schema = input as Record<string, unknown>;

	schema = pruneUnknownSchemaKeywords(schema);

	// Recursively sanitize composite schema branches instead of collapsing them
	for (const composite of ["anyOf", "oneOf", "allOf"]) {
		const branch = schema[composite] as unknown;
		if (Array.isArray(branch) && branch.length > 0) {
			schema[composite] = branch.filter((b) => b && typeof b === "object").map((b) => sanitizeSchema(b, propName));
		}
	}

	// Recursively sanitize definitions/$defs
	for (const defKey of ["definitions", "$defs"]) {
		const defs = schema[defKey] as Record<string, unknown> | undefined;
		if (defs && typeof defs === "object" && !Array.isArray(defs)) {
			const sanitized: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(defs)) {
				sanitized[k] = sanitizeSchema(v);
			}
			schema[defKey] = sanitized;
		}
	}

	// Detect whether this node is primarily defined by composites, $ref, or const.
	// These nodes should not have a default type forced on them.
	const hasComposite = ["anyOf", "oneOf", "allOf"].some(
		(k) => Array.isArray(schema[k]) && (schema[k] as unknown[]).length > 0
	);
	const hasRef = typeof schema["$ref"] === "string";
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

// Multimodal content helpers

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isImageMimeType(mime: string): boolean {
	return IMAGE_MIME_TYPES.has(mime.toLowerCase());
}

function isTextMimeType(mime: string): boolean {
	const lower = mime.toLowerCase();
	return lower.startsWith("text/") || lower === "application/json" || lower.endsWith("+json");
}

function convertDataPartToContentBlock(
	part: vscode.LanguageModelDataPart
): OpenAIChatImageUrlContentBlock | OpenAIChatFileContentBlock | null {
	const mime = part.mimeType.toLowerCase();
	if (isImageMimeType(mime)) {
		const base64 = Buffer.from(part.data).toString("base64");
		return { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } };
	}
	if (mime === "application/pdf") {
		const base64 = Buffer.from(part.data).toString("base64");
		return { type: "file", file: { file_data: `data:${mime};base64,${base64}` } };
	}
	return null;
}

function decodeDataPartText(part: vscode.LanguageModelDataPart): string | null {
	if (isTextMimeType(part.mimeType)) {
		return new TextDecoder().decode(part.data);
	}
	return null;
}

/**
 * Convert VS Code chat request messages into OpenAI-compatible message objects.
 * @param messages The VS Code chat messages to convert.
 * @returns OpenAI-compatible messages array.
 */
// Optionally mark the system prompt with cache_control for prompt caching.
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options?: { cacheSystemPrompt?: boolean }
): OpenAIChatMessage[] {
	const out: OpenAIChatMessage[] = [];
	for (const m of messages) {
		const role = mapRole(m);
		const textParts: string[] = [];
		const toolCalls: OpenAIToolCall[] = [];
		const toolResults: { callId: string; content: string }[] = [];
		const contentBlocks: OpenAIChatContentBlock[] = [];
		let hasNonTextBlocks = false;

		for (const part of m.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				let args;
				try {
					args = JSON.stringify(part.input ?? {});
				} catch {
					args = "{}";
				}
				toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
			} else if (isToolResultPart(part)) {
				const callId = (part as { callId?: string }).callId ?? "";
				const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
				toolResults.push({ callId, content });
			} else if (part instanceof vscode.LanguageModelDataPart) {
				const block = convertDataPartToContentBlock(part);
				if (block) {
					// Flush accumulated text before the non-text block to preserve ordering
					if (textParts.length > 0) {
						contentBlocks.push({ type: "text", text: textParts.join("") });
						textParts.length = 0;
					}
					contentBlocks.push(block);
					hasNonTextBlocks = true;
				} else {
					const decoded = decodeDataPartText(part);
					if (decoded !== null) {
						textParts.push(decoded);
					} else {
						log(`Skipping unsupported LanguageModelDataPart with MIME type: ${part.mimeType}`);
					}
				}
			} else if (isPromptTsxPart(part)) {
				const extracted = extractPromptTsxText(part);
				if (extracted) {
					textParts.push(extracted);
				}
			}
		}

		let emittedAssistantToolCall = false;
		if (toolCalls.length > 0) {
			out.push({ role: "assistant", content: textParts.join("") || undefined, tool_calls: toolCalls });
			emittedAssistantToolCall = true;
		}

		for (const tr of toolResults) {
			out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "" });
		}

		if (role === "user" && hasNonTextBlocks) {
			// Flush any remaining text after the last non-text block
			if (textParts.length > 0) {
				contentBlocks.push({ type: "text", text: textParts.join("") });
			}
			if (contentBlocks.length > 0) {
				out.push({ role, content: contentBlocks });
			}
		} else {
			const text = textParts.join("");
			if (text && (role === "system" || role === "user" || (role === "assistant" && !emittedAssistantToolCall))) {
				if (role === "system" && options?.cacheSystemPrompt) {
					const content: OpenAIChatContentBlock[] = [
						{
							type: "text",
							text,
							cache_control: { type: "ephemeral" },
						},
					];
					out.push({ role, content });
				} else {
					out.push({ role, content: text });
				}
			}
		}
	}
	return out;
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
		if (tools.length === 1) {
			tool_choice = { type: "function", function: { name: sanitizeFunctionName(tools[0].name) } };
		} else {
			tool_choice = "required";
		}
	}

	return { tools: toolDefs, tool_choice };
}

/**
 * Validate the request message sequence for correct tool call/result pairing.
 * @param messages The full request message list.
 */
export function validateRequest(messages: readonly vscode.LanguageModelChatRequestMessage[]): void {
	const lastMessage = messages[messages.length - 1];
	if (!lastMessage) {
		error("No messages in request");
		throw new Error("Invalid request: no messages.");
	}

	messages.forEach((message, i) => {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const toolCallIds = new Set(
				message.content
					.filter((part) => part instanceof vscode.LanguageModelToolCallPart)
					.map((part) => (part as unknown as vscode.LanguageModelToolCallPart).callId)
			);
			if (toolCallIds.size === 0) {
				return;
			}

			let nextMessageIdx = i + 1;
			const errMsg =
				"Invalid request: Tool call part must be followed by a User message with a LanguageModelToolResultPart with a matching callId.";
			while (toolCallIds.size > 0) {
				const nextMessage = messages[nextMessageIdx++];
				if (!nextMessage || nextMessage.role !== vscode.LanguageModelChatMessageRole.User) {
					error("Validation failed: missing tool result for call IDs:", Array.from(toolCallIds));
					throw new Error(errMsg);
				}

				nextMessage.content.forEach((part) => {
					if (!isToolResultPart(part)) {
						const ctorName =
							(Object.getPrototypeOf(part as object) as { constructor?: { name?: string } } | undefined)?.constructor
								?.name ?? typeof part;
						error("Validation failed: expected tool result part, got:", ctorName);
						throw new Error(errMsg);
					}
					const callId = (part as { callId: string }).callId;
					toolCallIds.delete(callId);
				});
			}
		}
	});
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
function mapRole(message: vscode.LanguageModelChatRequestMessage): Exclude<OpenAIChatRole, "tool"> {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (c instanceof vscode.LanguageModelDataPart) {
			const decoded = decodeDataPartText(c);
			if (decoded !== null) {
				text += decoded;
			} else if (isImageMimeType(c.mimeType)) {
				log("Tool returned image data which cannot be forwarded as tool result text");
			}
		} else if (isPromptTsxPart(c)) {
			const extracted = extractPromptTsxText(c);
			if (extracted) {
				text += extracted;
			}
		} else if (typeof c === "string") {
			text += c;
		} else {
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	return text;
}

/**
 * Type guard for LanguageModelPromptTsxPart-like values.
 */
function isPromptTsxPart(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const ctorName = (Object.getPrototypeOf(value as object) as { constructor?: { name?: string } } | undefined)
		?.constructor?.name;
	return ctorName === "LanguageModelPromptTsxPart";
}

/**
 * Extract text from a LanguageModelPromptTsxPart-like value.
 */
function extractPromptTsxText(part: unknown): string | null {
	const obj = part as Record<string, unknown>;
	if (typeof obj.value === "string") {
		return obj.value;
	}
	if (obj.value !== undefined && obj.value !== null) {
		try {
			return JSON.stringify(obj.value);
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}
