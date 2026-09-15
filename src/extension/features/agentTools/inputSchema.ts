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
import type { AgentToolId } from "../../../shared/config/commandIds";
import { FEATURE_MODEL_IDS } from "../../../shared/config/settingSpec";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { recordFromKeys } from "../../../shared/util/json";

/** Bounds on agent-typed strings, so a runaway argument cannot bloat a request or a card. */
const LABEL_MAX = 200;
const QUERY_MAX = 200;

/**
 * Labels are trimmed here because the dashboard's save trims too: an untrimmed
 * " Prod " would miss the stored Prod in the planner (new-entry defaults, no
 * replace identity) and then overwrite Prod on save, deleting its fields.
 */
const label = z.string().trim().min(1).max(LABEL_MAX);

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
const secretLocation = z.union([z.literal("settings"), z.literal("secure")]);

const agentSecretDirectiveSchema = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("keep") }),
	z.strictObject({ action: z.literal("clear") }),
	z.strictObject({ action: z.literal("set"), location: secretLocation, value: z.string().min(1).optional() }),
]);

export type AgentSecretDirective = z.infer<typeof agentSecretDirectiveSchema>;

/** A string field an agent may set, or clear with null; absent leaves the stored value alone. */
const clearable = z.string().nullable().optional();

export const AGENT_TOOL_INPUT_SCHEMAS = {
	diagnostics: z.strictObject({ includeLogs: z.boolean().optional() }),
	configuration: z.strictObject({ sections: z.array(z.enum(CONFIGURATION_SECTIONS)).min(1).optional() }),
	// Model IDs are raw server strings, never trimmed: the server, discovery,
	// and the dashboard keep them byte for byte.
	inspectModel: z.strictObject({ server: label, model: z.string().min(1).max(LABEL_MAX) }),
	searchCatalog: z.strictObject({ query: z.string().min(1).max(QUERY_MAX) }),
	setSetting: z.strictObject({ setting: z.string().min(1).max(LABEL_MAX), value: z.unknown() }),
	editModelRecords: z.strictObject({
		kind: z.enum(["capabilities", "parameters"]),
		key: z.string().min(1).max(LABEL_MAX),
		set: z.record(z.string(), z.unknown()).optional(),
		unset: z.array(z.string().min(1)).optional(),
		removeKey: z.boolean().optional(),
		server: label.optional(),
	}),
	saveServer: z.union([
		// Adoption is its own grammar: the source group's identity, the new
		// label, and where each copied secret goes. No edit field and no secret
		// value can ride it, so the adopt intent copies exactly what the group
		// holds.
		z.strictObject({
			label,
			adoptFrom: z.strictObject({ label, baseUrl: z.string().min(1) }),
			secretLocations: z.strictObject(recordFromKeys(SECRET_FIELD_IDS, () => secretLocation.optional())).optional(),
		}),
		// The edit grammar: which stored field each argument replaces. The
		// values the save rebuilds travel as-is; the dashboard schema judges them.
		z.strictObject({
			label,
			baseUrl: z.string().min(1).optional(),
			apiVersion: clearable,
			oauthTokenUrl: clearable,
			oauthClientId: clearable,
			oauthScopes: clearable,
			virtualKeyHeader: clearable,
			headers: z.unknown().optional(),
			declaredModels: z.unknown().optional(),
			expectedFailures: z.unknown().optional(),
			modelCapabilities: z.unknown().optional(),
			modelParameters: z.unknown().optional(),
			budget: z.unknown().optional(),
			mcp: z.unknown().optional(),
			secrets: z.strictObject(recordFromKeys(SECRET_FIELD_IDS, () => agentSecretDirectiveSchema.optional())).optional(),
			renameFrom: label.optional(),
		}),
	]),
	removeServer: z.strictObject({
		label,
		baseUrl: z.string().min(1).optional(),
		action: z.enum(["remove", "hide", "unhide"]).optional(),
	}),
	// Each action names exactly the argument it needs, so a probe without its
	// target is a parse refusal, not a planner sentinel.
	runAction: z.discriminatedUnion("action", [
		z.strictObject({ action: z.literal("testConnection"), label }),
		z.strictObject({ action: z.literal("testFeatureModel"), feature: z.enum(FEATURE_MODEL_IDS) }),
		z.strictObject({ action: z.literal("syncModels") }),
		z.strictObject({ action: z.literal("refreshCatalog") }),
		z.strictObject({ action: z.literal("refreshUsage") }),
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
