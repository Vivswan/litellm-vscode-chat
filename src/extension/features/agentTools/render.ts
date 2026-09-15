/**
 * What the agent tools hand back and what the confirmation cards say. Pure
 * text shaping over already-safe data: dashboard state (secret LOCATIONS by
 * construction), dashboard replies, and the diagnostics snapshot with its log
 * lines passed through the issue reporter's redaction. Every string here is
 * model-facing, so it stays English by policy.
 */

import type { DashboardState } from "../../../dashboard/viewModels";
import type { DashboardSubmission } from "../../../extension/dashboard/panel";
import type { ServerStatus } from "../../../shared/servers";
import { displayUrl } from "../../../shared/util/displayUrl";
import type { DiagnosticsSnapshot } from "../../ui/issueReporter";
import type { ConfigurationSection } from "./inputSchema";
import type { AgentRequest, RefusalReason, SecretPrompt } from "./planner";

/**
 * The reply bound, in UTF-16 code units, fixed in code like the consult tool's
 * outgoing bound: a configuration with hundreds of models must not flood the
 * agent's context. The cut is marked so the agent knows to ask for a section.
 */
const AGENT_RESULT_CHAR_LIMIT = 60_000;

/**
 * Every URL-shaped string anywhere in a value, rebuilt without userinfo
 * (displayUrl); other strings, and strings without a scheme, pass through.
 * Deep on purpose: a server's config nests its token URL and MCP URL.
 */
function scrubUrls<T>(value: T): T {
	if (typeof value === "string") {
		return (value.includes("://") || value.startsWith("//") ? displayUrl(value) : value) as T;
	}
	if (Array.isArray(value)) {
		return value.map(scrubUrls) as T;
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubUrls(entry)])) as T;
	}
	return value;
}

const TRUNCATION_MARKER = '\n... [truncated: ask for fewer "sections", or inspect one model at a time]';

/**
 * JSON for the model, cut at the bound with a visible marker. A base URL is
 * user configuration and may carry `user:password@`, so every URL-shaped
 * string in the value tree is rebuilt without userinfo first (scrubUrls).
 * Per string, never over the serialized text: a text-level pass would run
 * from one field's "//" to the next field's "@" and eat the JSON between.
 */
export function renderJson(value: unknown): string {
	const text = JSON.stringify(scrubUrls(value), null, 2) ?? "null";
	if (text.length <= AGENT_RESULT_CHAR_LIMIT) {
		return text;
	}
	return `${text.slice(0, AGENT_RESULT_CHAR_LIMIT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/** The diagnostics read: the report's snapshot plus the per-server rows the report withholds, logs redacted. */
export function shapeDiagnostics(
	snapshot: DiagnosticsSnapshot,
	servers: readonly ServerStatus[],
	problems: DashboardState["diagnostics"],
	redact: (text: string) => string,
	includeLogs: boolean
): Record<string, unknown> {
	return {
		extensionVersion: snapshot.extensionVersion,
		vscodeVersion: snapshot.vscodeVersion,
		platform: snapshot.platform,
		connectionState: snapshot.connectionState,
		modelCount: snapshot.modelCount,
		servers: servers.map((server) => ({
			label: server.label,
			baseUrl: server.baseUrl,
			state: server.state,
			servedModelCount: server.servedModelCount,
			lastChecked: server.lastChecked,
			hasApiKey: server.hasApiKey,
			hasOAuth: server.hasOAuth,
			...(server.state === "error"
				? {
						error: redact(server.error),
						classification: server.classification,
						expected: server.expected,
						declaredModelCount: server.declaredModelCount,
					}
				: { hiddenByRemoval: server.hiddenByRemoval, modelInfoUnsupported: server.modelInfoUnsupported }),
		})),
		features: snapshot.featureFlags,
		mcpEntryCount: snapshot.mcpEntryCount,
		configurationProblems: problems,
		latestError:
			snapshot.latestError === undefined
				? undefined
				: {
						source: snapshot.latestError.source,
						timestamp: snapshot.latestError.timestamp,
						classification: snapshot.latestError.classification,
						message: redact(snapshot.latestError.message),
					},
		...(includeLogs ? { recentLogs: snapshot.recentLogs.map(redact) } : {}),
	};
}

/**
 * The configuration read: the dashboard state's sections the agent asked for
 * (all by default). A server row's error text is the transport's display
 * rendering and can embed a response body, so it passes through the issue
 * report's redaction like a log line.
 */
export function shapeConfiguration(
	state: DashboardState,
	sections: readonly ConfigurationSection[] | undefined,
	redact: (text: string) => string
): Record<string, unknown> {
	const wanted = new Set<ConfigurationSection>(
		sections ?? ["servers", "settings", "models", "hiddenGroups", "catalog", "usage"]
	);
	const servers = state.servers.map((server) =>
		server.state === "error"
			? {
					...server,
					error: redact(server.error),
					...(server.errorEnglish !== undefined ? { errorEnglish: redact(server.errorEnglish) } : {}),
				}
			: server
	);
	return {
		...(wanted.has("servers") ? { servers, servedModelCount: state.servedModelCount } : {}),
		...(wanted.has("settings") ? { settings: state.settings } : {}),
		...(wanted.has("models") ? { models: state.models } : {}),
		...(wanted.has("hiddenGroups") ? { hiddenGroups: state.hiddenGroups } : {}),
		...(wanted.has("catalog") ? { catalog: state.settings.catalog } : {}),
		...(wanted.has("usage") ? { usage: state.usage } : {}),
	};
}

/**
 * One submitted request's outcome as the agent reads it: the reply's payload,
 * or the failure's reason. A failure message can carry a probe's transport
 * error, so it is redacted like the configuration rows.
 */
export function shapeSubmission(
	request: AgentRequest,
	submission: DashboardSubmission,
	redact: (text: string) => string
): Record<string, unknown> {
	switch (submission.outcome) {
		case "ok": {
			const reply = submission.reply;
			if (reply?.kind === "response") {
				return { method: request.method, ok: true, result: reply.payload };
			}
			return {
				method: request.method,
				ok: true,
				...(reply?.message !== undefined ? { note: reply.message } : {}),
			};
		}
		case "validation-error":
			return {
				method: request.method,
				ok: false,
				failureKind: submission.reply.failureKind,
				message: redact(submission.reply.message),
				...(submission.reply.classification !== undefined ? { classification: submission.reply.classification } : {}),
				...(submission.issues !== undefined ? { issues: submission.issues } : {}),
			};
		case "ignored-malformed":
			return { method: request.method, ok: false, issues: submission.issues };
	}
}

/**
 * The refusal texts, addressed to the calling model: each says what was wrong
 * and what to call instead, because the model can fix the call and retry.
 * Identifiers from `detail` only, never a secret value.
 */
export function refusalText(reason: RefusalReason, detail: Readonly<Record<string, string>>): string {
	switch (reason) {
		case "unknown-setting":
			return `"${detail.setting}" is not a litellm-vscode-chat setting. Read the configuration tool's "settings" section for the names.`;
		case "setting-owned-by-tool":
			return `"${detail.setting}" is not changed through litellm_set_setting; use the ${detail.tool} tool.`;
		case "agent-tools-switch":
			return `"${detail.setting}" switches the agent tools themselves and can only be changed by the user.`;
		case "server-not-found":
			return `No servers entry is labeled "${detail.label}". Read the configuration tool's "servers" section for the labels.`;
		case "server-not-declared":
			return `"${detail.label}" is a provider group outside the servers setting; call litellm_remove_server with action "hide" and its baseUrl.`;
		case "external-group-not-found":
			return `No external provider group is at "${displayUrl(detail.baseUrl ?? "")}"${detail.label !== undefined ? ` labeled "${detail.label}"` : ""}.`;
		case "hidden-group-not-found":
			return `No hidden group is labeled "${detail.label}". Read the configuration tool's "hiddenGroups" section.`;
		case "secret-locations-unproven":
			return `The entry "${detail.label}" has not finished loading its secret locations; call again in a moment.`;
		case "secret-value-refused":
			return `Tool input carried a secret value for ${detail.fields}, which agentTools.secretValues.enabled does not allow. Omit "value": the user is asked to type it.`;
		case "kept-secret-host-change":
			return `The change moves "${detail.label}" to another host while keeping ${detail.fields}. A stored secret never follows a changed host: set ${detail.fields} again (omit "value" and the user is asked to type it), or clear it.`;
		case "base-url-required":
			return `"${detail.label}" needs a baseUrl.`;
		case "feature-model-not-set":
			return `No model is picked for ${detail.feature}; set "${detail.feature}.model" first.`;
		case "model-not-found":
			return `Server "${detail.server}" serves no model "${detail.model}". Read the configuration tool's "models" section.`;
		case "nothing-to-change":
			return `The record for "${detail.key}" already reads this way; nothing to change.`;
		case "language-filter-one-half":
			return `Set "${detail.setting}" one half per call: { "mode": ... } in one call and { "languages": [...] } in another, like the dashboard's two rows.`;
	}
}

// ---------------------------------------------------------------------------
// Confirmation cards: what the user sees before a write runs
// ---------------------------------------------------------------------------

/** The fence outruns every backtick run in the content, so an agent-written key cannot close the card early. */
function fenced(lines: readonly string[]): string {
	const body = lines.join("\n");
	let longestRun = 0;
	for (const run of body.matchAll(/`+/g)) {
		longestRun = Math.max(longestRun, run[0].length);
	}
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return `${fence}\n${body}\n${fence}`;
}

/** Card values render through the same URL rebuild as results. */
function json(value: unknown): string {
	return JSON.stringify(scrubUrls(value)) ?? "undefined";
}

/** A setting change: the full key, the scope the write lands in, and both values. */
export function describeSettingChange(setting: string, before: unknown, after: unknown, scope: string | null): string {
	return fenced([
		`litellm-vscode-chat.${setting}${scope !== null ? `  (configured in: ${scope})` : ""}`,
		`before: ${json(before)}`,
		`after:  ${after === null ? "(removed from its configured scope)" : json(after)}`,
	]);
}

/** A record edit: the matcher key and the record before and after, for the scope or entry it lands in. */
export function describeRecordChange(
	kind: "capabilities" | "parameters",
	key: string,
	before: unknown,
	after: unknown,
	target: string
): string {
	return fenced([
		`models.${kind}["${key}"]  (${target})`,
		`before: ${before === undefined ? "(absent)" : json(before)}`,
		`after:  ${after === undefined ? "(removed)" : json(after)}`,
	]);
}

/**
 * A server save: field names that change, never their values for secrets. A
 * moved base URL is spelled out because it decides where credentials go.
 */
export function describeServerChange(
	label: string,
	before: Readonly<Record<string, unknown>> | undefined,
	after: Readonly<Record<string, unknown>>,
	secrets: readonly string[],
	prompts: readonly SecretPrompt[]
): string {
	const lines: string[] = [before === undefined ? `new servers entry "${label}"` : `servers entry "${label}"`];
	const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
	for (const key of [...keys].sort()) {
		const previous = before?.[key];
		const next = after[key];
		// Compared raw, rendered scrubbed: dropping a URL's credentials is a
		// change the card must show even though both sides display alike.
		if (JSON.stringify(previous) !== JSON.stringify(next)) {
			lines.push(
				`${key}: ${previous === undefined ? "(absent)" : json(previous)} -> ${next === undefined ? "(absent)" : json(next)}`
			);
		}
	}
	for (const line of secrets) {
		lines.push(line);
	}
	for (const prompt of prompts) {
		lines.push(`${prompt.field}: you will be asked to type it (stored in ${prompt.location})`);
	}
	if (lines.length === 1) {
		lines.push("(no field changes)");
	}
	return fenced(lines);
}

/** An adoption: which external group is copied, under which label, and where each copied secret lands. */
export function describeAdoption(
	source: { readonly label: string; readonly baseUrl: string },
	label: string,
	locations: Readonly<Partial<Record<string, "settings" | "secure">>>
): string {
	const lines = [`adopt provider group "${source.label}" at ${displayUrl(source.baseUrl)} as servers entry "${label}"`];
	for (const field of ["apiKey", "oauthClientSecret", "virtualKeyValue"]) {
		lines.push(`${field}: copied to ${locations[field] ?? "secure"} storage if the group holds one`);
	}
	return fenced(lines);
}

export function describeAction(action: string, target: string | undefined): string {
	return fenced([target === undefined ? action : `${action}: ${target}`]);
}
