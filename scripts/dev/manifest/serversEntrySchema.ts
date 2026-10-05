/**
 * Lives in scripts/ because nothing at runtime reads it.
 *
 *   This is a second statement of the parser's shape (src/extension/servers/serverSync/ setting.ts)
 *     -> stays one until that parser is rewritten as a schema
 *   the three enums are spliced from the shared constants -> the manifest cannot offer a category, mode, or header type
 *                                                            the code never learned
 */
import { ENTRY_VIEW_FIELD_IDS, EXPECTED_FAILURE_CATEGORIES, NON_CHAT_MODES } from "../../../src/shared/serverEntry";
import { HEADER_SCALAR_TYPES } from "../../../src/shared/util/headers";

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];

function nls(path: string): string {
	return `%litellm.config.servers.${path}.description%`;
}

function virtualKeySchema(descriptionKey: "description" | "markdownDescription", path: string): JsonObject {
	return {
		type: "object",
		additionalProperties: false,
		required: ["header"],
		[descriptionKey]: nls(path),
		properties: {
			header: { type: "string", description: nls("auth.virtualKey.header") },
			value: { type: "string", description: nls("auth.virtualKey.value") },
		},
	};
}

export const SERVERS_ENTRY_SCHEMA: JsonObject = {
	type: "object",
	required: ["label", "baseUrl"],
	additionalProperties: false,
	properties: {
		label: { type: "string", description: nls("label") },
		baseUrl: { type: "string", format: "uri", description: nls("baseUrl") },
		apiVersion: { type: "string", description: nls("apiVersion") },
		auth: {
			type: "object",
			additionalProperties: false,
			minProperties: 1,
			markdownDescription: nls("auth"),
			properties: {
				apiKey: { type: "string", description: nls("auth.apiKey") },
				oauth: {
					type: "object",
					additionalProperties: false,
					required: ["tokenUrl", "clientId"],
					markdownDescription: nls("auth.oauth"),
					properties: {
						tokenUrl: { type: "string", format: "uri", description: nls("auth.oauth.tokenUrl") },
						clientId: { type: "string", description: nls("auth.oauth.clientId") },
						clientSecret: { type: "string", description: nls("auth.oauth.clientSecret") },
						scopes: { type: "string", description: nls("auth.oauth.scopes") },
						apiKey: { type: "string", description: nls("auth.oauth.apiKey") },
						virtualKey: virtualKeySchema("description", "auth.oauth.virtualKey"),
					},
				},
				virtualKey: virtualKeySchema("markdownDescription", "auth.virtualKey"),
			},
		},
		headers: {
			type: "object",
			description: nls("headers"),
			additionalProperties: { type: [...HEADER_SCALAR_TYPES] },
		},
		models: {
			type: "object",
			additionalProperties: false,
			markdownDescription: nls("models"),
			properties: {
				parameters: {
					type: "object",
					additionalProperties: { type: "object" },
					description: nls("models.parameters"),
				},
				capabilities: {
					type: "object",
					additionalProperties: { type: "object" },
					description: nls("models.capabilities"),
				},
			},
		},
		discovery: {
			type: "object",
			additionalProperties: false,
			markdownDescription: nls("discovery"),
			properties: {
				expectedFailures: {
					type: "array",
					items: { type: "string", enum: [...EXPECTED_FAILURE_CATEGORIES] },
					uniqueItems: true,
					description: nls("discovery.expectedFailures"),
				},
				declared: {
					type: "array",
					items: { type: "string" },
					uniqueItems: true,
					description: nls("discovery.declared"),
				},
				includeModes: {
					type: "array",
					items: { type: "string", enum: [...NON_CHAT_MODES] },
					uniqueItems: true,
					description: nls("discovery.includeModes"),
				},
			},
		},
		budget: { type: "number", exclusiveMinimum: 0, description: nls("budget") },
		mcp: {
			type: ["boolean", "object"],
			additionalProperties: false,
			markdownDescription: nls("mcp"),
			properties: {
				url: { type: "string", format: "uri", description: nls("mcp.url") },
			},
		},
	},
};

/**
 * The parser's field ids and the manifest's property names differ for the nested ones, so the map is explicit rather
 * than derived.
 */
const ENTRY_VIEW_FIELD_PATHS: Readonly<Record<(typeof ENTRY_VIEW_FIELD_IDS)[number], string>> = {
	apiVersion: "apiVersion",
	headers: "headers",
	modelParameters: "models.parameters",
	modelCapabilities: "models.capabilities",
	expectedFailures: "discovery.expectedFailures",
	declaredModels: "discovery.declared",
	includeModes: "discovery.includeModes",
	budget: "budget",
	mcp: "mcp",
};

function objectNode(value: JsonValue | undefined): JsonObject | undefined {
	return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function schemaAt(root: JsonObject, dotted: string): JsonValue | undefined {
	let node: JsonValue | undefined = root;
	for (const segment of dotted.split(".")) {
		const properties = objectNode(objectNode(node)?.properties);
		node = properties?.[segment];
	}
	return node;
}

export function assertServersSchemaCoversEntryFields(schema: JsonObject = SERVERS_ENTRY_SCHEMA): void {
	const missing = ENTRY_VIEW_FIELD_IDS.filter((field) => schemaAt(schema, ENTRY_VIEW_FIELD_PATHS[field]) === undefined);
	if (missing.length > 0) {
		throw new Error(`the servers items schema declares no property for ${missing.join(", ")}`);
	}
}
