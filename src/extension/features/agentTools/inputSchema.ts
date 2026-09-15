/**
 * The agent tools' input envelopes: what an agent may hand each tool. The
 * contributed inputSchema documents the shape for the model; this parse binds
 * it, because the host forwards whatever the model sent. Every value that ends
 * up inside a dashboard intent stays `unknown` here - the intent schema is the
 * one judge of setting values, record fields, and server entries - so this
 * module parses only the tool's own grammar: which argument names what, and
 * the edit semantics the dashboard has no word for (null clears a field, a
 * valueless secret asks the user).
 */

import { z } from "zod";
import { WIRE_LIMITS } from "../../../dashboard/endpoints";
import type { AgentToolId } from "../../../shared/config/commandIds";
import { FEATURE_MODEL_IDS } from "../../../shared/config/settingSpec";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { recordFromKeys } from "../../../shared/util/json";

/** The catalog search's own bound; every other string takes the dashboard's wire limit for its kind. */
const QUERY_MAX = 200;

/**
 * Labels are trimmed here because the dashboard's save trims too: an untrimmed
 * " Prod " would miss the stored Prod in the planner (new-entry defaults, no
 * replace identity) and then overwrite Prod on save, deleting its fields.
 */
const label = z.string().trim().min(1).max(WIRE_LIMITS.label);

/** The sections of the configuration read, so an agent can ask for the slice it needs instead of everything. */
const CONFIGURATION_SECTIONS = ["servers", "settings", "models", "hiddenGroups", "catalog", "usage"] as const;

export type ConfigurationSection = (typeof CONFIGURATION_SECTIONS)[number];

/**
 * A save directive as the AGENT writes it: `set` may omit the value, which
 * asks the extension to prompt the user for it in a masked box. The dashboard's
 * own directive always carries the value (the form collected it); this shape
 * exists for the prompt, and the planner turns it into the dashboard's shape
 * before anything is submitted.
 */
const secretLocation = z.enum(["settings", "secure"]);

const agentSecretDirectiveSchema = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("keep").describe("Keep the stored secret.") }),
	z.strictObject({ action: z.literal("clear").describe("Remove the stored secret.") }),
	z.strictObject({
		action: z.literal("set").describe("Store a secret."),
		location: secretLocation.describe("Where a set secret is stored."),
		value: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Omit it: the user is asked to type the secret in a masked box. Allowed only when the user's agentTools.secretValues setting is on."
			),
	}),
]);

export type AgentSecretDirective = z.infer<typeof agentSecretDirectiveSchema>;

/** A string field an agent may set, or clear with null; absent leaves the stored value alone. */
const clearable = z
	.string()
	.nullable()
	.optional()
	.describe("A string sets it, null clears it, absent keeps the stored value.");

const removableLabel = label.describe(
	"The servers entry label (remove), or the external or hidden group's label (hide, unhide)."
);
const groupBaseUrl = z
	.string()
	.min(1)
	.describe("The group's base URL as litellm_configuration shows it; with the label it identifies the group.");

const serverLabel = label.describe("The entry's label (its identity; the model picker groups models under it).");

/**
 * The tools' input envelopes. The `.describe` texts are model-facing English:
 * `bun run tools:schemas` writes them, with the shapes, into package.json's
 * languageModelTools contributions, so this table is the one source of what
 * the model is told and what the parse accepts.
 */
export const AGENT_TOOL_INPUT_SCHEMAS = {
	diagnostics: z.strictObject({
		includeLogs: z.boolean().optional().describe("Include the recent log lines (redacted). Default false."),
	}),
	configuration: z.strictObject({
		sections: z
			.array(z.enum(CONFIGURATION_SECTIONS))
			.min(1)
			.optional()
			.describe("Which sections to return. Default: all."),
	}),
	// Model IDs are raw server strings, never trimmed: the server, discovery,
	// and the dashboard keep them byte for byte.
	// scopeKey (from the configuration tool's models) disambiguates when a
	// declared entry and an external group share a label and serve the same ID.
	inspectModel: z.strictObject({
		server: label.describe("The servers entry label, from litellm_configuration."),
		model: z
			.string()
			.min(1)
			.max(WIRE_LIMITS.modelId)
			.describe("The raw model ID as the server names it, from litellm_configuration."),
		scopeKey: z
			.string()
			.min(1)
			.optional()
			.describe(
				"The model row's scopeKey from litellm_configuration, needed only when two rows share the server label and model ID (a declared entry and its external leftover)."
			),
	}),
	searchCatalog: z.strictObject({
		query: z.string().min(1).max(QUERY_MAX).describe("Part of a model name or ID."),
	}),
	setSetting: z.strictObject({
		setting: z
			.string()
			.min(1)
			.max(WIRE_LIMITS.textField)
			.describe("The setting name without the litellm-vscode-chat. prefix."),
		value: z.unknown().describe("The new value, in the setting's own shape; null removes the configured value."),
	}),
	editModelRecords: z.strictObject({
		kind: z
			.enum(["capabilities", "parameters"])
			.describe("Which record to edit: models.capabilities or models.parameters."),
		key: z.string().min(1).max(WIRE_LIMITS.recordKey).describe("A raw model ID or a prefix pattern such as gpt-5*."),
		set: z.record(z.string(), z.unknown()).optional().describe("Fields to set on the record."),
		unset: z
			.array(z.string().min(1).max(WIRE_LIMITS.recordFieldName))
			.optional()
			.describe("Field names to remove from the record."),
		removeKey: z.boolean().optional().describe("Remove the whole key."),
		server: label
			.optional()
			.describe("A servers entry label, to edit that entry's own record instead of the global setting."),
	}),
	saveServer: z.union([
		// Adoption is its own grammar: the source group's identity, the new
		// label, and where each copied secret goes. No edit field and no secret
		// value can ride it, so the adopt intent copies exactly what the group
		// holds.
		z
			.strictObject({
				label: serverLabel,
				adoptFrom: z
					.strictObject({
						label: label.describe("The external group's label, from litellm_configuration."),
						baseUrl: z.string().min(1).describe("The external group's base URL, from litellm_configuration."),
					})
					.describe("The external provider group to copy, from litellm_configuration."),
				secretLocations: z
					.strictObject(
						recordFromKeys(SECRET_FIELD_IDS, (field) =>
							secretLocation.optional().describe(`Where the copied ${field} is stored.`)
						)
					)
					.optional()
					.describe("Where each copied secret is stored; default secure."),
			})
			.describe(
				"Adopt an external provider group (one not in the servers setting) into the setting under label. Nothing else can be changed in the same call; edit the entry afterwards."
			),
		// The edit grammar: which stored field each argument replaces. The
		// values the save rebuilds travel as-is; the dashboard schema judges them.
		z
			.strictObject({
				label: serverLabel,
				baseUrl: z
					.string()
					.min(1)
					.optional()
					.describe("The server's root URL, e.g. http://localhost:4000. Required for a new entry."),
				apiVersion: clearable,
				oauthTokenUrl: clearable,
				oauthClientId: clearable,
				oauthScopes: clearable,
				virtualKeyHeader: clearable,
				headers: z
					.unknown()
					.optional()
					.describe("Custom HTTP headers as an object of header name to value (plain text, not secrets)."),
				declaredModels: z
					.unknown()
					.optional()
					.describe("An array of model IDs to serve even when the server cannot list them (discovery.declared)."),
				expectedFailures: z
					.unknown()
					.optional()
					.describe("An array of the discovery endpoints this server is expected to fail: modelListing, modelInfo."),
				modelCapabilities: z.unknown().optional().describe("The entry's own models.capabilities record, whole."),
				modelParameters: z.unknown().optional().describe("The entry's own models.parameters record, whole."),
				budget: z.unknown().optional().describe("Manual usage budget in USD, a number; null clears it."),
				mcp: z.unknown().optional().describe("MCP opt-in: true, { url }, or null to clear."),
				secrets: z
					.strictObject(
						recordFromKeys(SECRET_FIELD_IDS, (field) =>
							agentSecretDirectiveSchema
								.optional()
								.describe(`What happens to the stored ${field}: keep, clear, or set.`)
						)
					)
					.optional()
					.describe("One directive per secret; a secret without a directive is kept."),
				renameFrom: label.optional().describe("The current label of the entry to rename to label."),
			})
			.describe("Add or edit a servers entry. On an edit, omitted fields keep their stored values."),
	]),
	// Hide and unhide name the base URL: two groups can share a label, and the
	// dashboard treats label plus base URL as the identity.
	removeServer: z.discriminatedUnion("action", [
		z.strictObject({
			action: z.literal("remove").describe("Remove a servers entry."),
			label: removableLabel,
		}),
		z.strictObject({
			action: z.literal("hide").describe("Hide an external provider group that is not in the setting."),
			label: removableLabel,
			baseUrl: groupBaseUrl,
		}),
		z.strictObject({
			action: z.literal("unhide").describe("Restore a hidden group."),
			label: removableLabel,
			baseUrl: groupBaseUrl,
		}),
	]),
	// Each action names exactly the argument it needs, so a probe without its
	// target is a parse refusal, not a planner sentinel.
	runAction: z.discriminatedUnion("action", [
		z.strictObject({
			action: z.literal("testConnection").describe("Probe a stored servers entry with its stored credentials."),
			label: label.describe("The stored servers entry to probe with its stored credentials."),
		}),
		z.strictObject({
			action: z.literal("testFeatureModel").describe("Send a feature's picked model a fixed probe prompt."),
			feature: z
				.enum(FEATURE_MODEL_IDS)
				.describe("The feature whose picked model receives a fixed probe prompt (a billable model request)."),
		}),
		z.strictObject({ action: z.literal("syncModels").describe("Re-discover every server's models.") }),
		z.strictObject({ action: z.literal("refreshCatalog").describe("Refresh the OpenRouter catalog.") }),
		z.strictObject({ action: z.literal("refreshUsage").describe("Re-poll spend and budgets.") }),
	]),
} satisfies Record<AgentToolId, z.ZodType>;

export type AgentToolInput<K extends AgentToolId> = z.infer<(typeof AGENT_TOOL_INPUT_SCHEMAS)[K]>;

/** One parse issue, flattened to path, code, and message; what a refusal hands back to the calling model. */
interface AgentInputIssue {
	readonly path: string;
	readonly code: string;
	readonly message: string;
}

type AgentInputParse<K extends AgentToolId> =
	| { readonly ok: true; readonly input: AgentToolInput<K> }
	| { readonly ok: false; readonly issues: readonly AgentInputIssue[] };

/** Parse one tool's raw input against its envelope. */
export function parseAgentToolInput<K extends AgentToolId>(tool: K, raw: unknown): AgentInputParse<K> {
	const parsed = AGENT_TOOL_INPUT_SCHEMAS[tool].safeParse(raw);
	if (!parsed.success) {
		return {
			ok: false,
			issues: parsed.error.issues.map((issue) => ({
				path: issue.path.map(String).join("."),
				code: issue.code,
				message: issue.message,
			})),
		};
	}
	return { ok: true, input: parsed.data as AgentToolInput<K> };
}
