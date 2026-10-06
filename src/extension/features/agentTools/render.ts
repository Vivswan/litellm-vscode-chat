import * as l10n from "@vscode/l10n";
import type { DashboardServer, DashboardState } from "../../../dashboard/viewModels";
import type { DashboardSubmission } from "../../../extension/dashboard/panel";
import { failureTexts } from "../../../shared/failureCause";
import { Logger } from "../../../shared/logger";
import { isCredentialHeader } from "../../../shared/serverEntry";
import type { ServerStatus } from "../../../shared/servers";
import { statusClassification } from "../../../shared/servers";
import type { DiagnosticsSnapshot } from "../../ui/issueReporter";
import type { ConfigurationSection } from "./inputSchema";
import type { AgentRequest, RefusalReason, SecretPrompt } from "./planner";

/**
 * The reply bound, in UTF-16 code units, fixed in code like the consult tool's outgoing bound: a configuration with
 * hundreds of models must not flood the agent's context. The cut is marked so the agent knows to ask for a section.
 */
const AGENT_RESULT_CHAR_LIMIT = 60_000;

const TRUNCATION_MARKER = '\n... [truncated: ask for fewer "sections", or inspect one model at a time]';

/** JSON for the model, through the one output door, cut at the bound with a visible marker. */
export function renderJson(value: unknown): string {
	const text = Logger.redact(JSON.stringify(value, null, 2) ?? "null");
	if (text.length <= AGENT_RESULT_CHAR_LIMIT) {
		return text;
	}
	return `${text.slice(0, AGENT_RESULT_CHAR_LIMIT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/** The diagnostics read: the report's snapshot plus the per-server rows the report withholds. */
export function shapeDiagnostics(
	snapshot: DiagnosticsSnapshot,
	servers: readonly ServerStatus[],
	problems: DashboardState["diagnostics"],
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
			hasVirtualKey: server.hasVirtualKey,
			...(server.state === "error"
				? {
						error: failureTexts(server.cause, server.baseUrl).english,
						classification: statusClassification(server),
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
						message: snapshot.latestError.message,
					},
		...(includeLogs ? { recentLogs: snapshot.recentLogs } : {}),
	};
}

/**
 * What a configuration read shows in place of a credential-bearing custom header's value: the header's name is the
 * agent's to see (it edits the entry), its value is not. A header is a credential by isCredentialHeader, the entry's
 * own carrier included.
 */
export const CREDENTIAL_HEADER_PLACEHOLDER = "<redacted header value>";

function withCredentialHeaderValuesHidden<T extends DashboardServer>(server: T): T {
	if (server.origin !== "declared" || server.config.headers === undefined) {
		return server;
	}
	const carriers = typeof server.config.virtualKeyHeader === "string" ? [server.config.virtualKeyHeader] : [];
	const headers = Object.fromEntries(
		Object.entries(server.config.headers).map(([name, value]) => [
			name,
			isCredentialHeader(name, carriers) ? CREDENTIAL_HEADER_PLACEHOLDER : value,
		])
	);
	return { ...server, config: { ...server.config, headers } };
}

/**
 * The read hides credential header values by structure (withCredentialHeaderValuesHidden) and renders a failing
 * row's cause in English beside the row (the rows themselves carry no text); every other text is as held.
 */
export function shapeConfiguration(
	state: DashboardState,
	sections: readonly ConfigurationSection[] | undefined
): Record<string, unknown> {
	const wanted = new Set<ConfigurationSection>(
		sections ?? ["servers", "settings", "models", "hiddenGroups", "catalog", "usage"]
	);
	const servers = state.servers.map((server) => {
		const hidden = withCredentialHeaderValuesHidden(server);
		return hidden.state === "error" ? { ...hidden, error: failureTexts(hidden.cause, hidden.baseUrl).english } : hidden;
	});
	return {
		...(wanted.has("servers") ? { servers, servedModelCount: state.servedModelCount } : {}),
		...(wanted.has("settings") ? { settings: state.settings } : {}),
		...(wanted.has("models") ? { models: state.models } : {}),
		...(wanted.has("hiddenGroups") ? { hiddenGroups: state.hiddenGroups } : {}),
		...(wanted.has("catalog") ? { catalog: state.settings.catalog } : {}),
		...(wanted.has("usage") ? { usage: state.usage } : {}),
	};
}

export function shapeSubmission(request: AgentRequest, submission: DashboardSubmission): Record<string, unknown> {
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
				message: submission.reply.message,
				...(submission.reply.classification !== undefined ? { classification: submission.reply.classification } : {}),
				...(submission.issues !== undefined ? { issues: submission.issues } : {}),
			};
		case "ignored-malformed":
			return { method: request.method, ok: false, issues: submission.issues };
	}
}

/**
 * Identifiers from `detail` only, never a secret value.
 *
 *   The refusal texts -> addressed to the calling model
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
			return `No external provider group is at "${detail.baseUrl ?? ""}"${detail.label !== undefined ? ` labeled "${detail.label}"` : ""}.`;
		case "hidden-group-not-found":
			return `No removed group is labeled "${detail.label}" at "${detail.baseUrl ?? ""}". Read the configuration tool's "hiddenGroups" section; only groups with reason "removed" can be unhidden.`;
		case "secret-locations-unproven":
			return `The entry "${detail.label}" has not finished loading its secret locations; call again in a moment.`;
		case "secret-value-refused":
			return `Tool input carried a secret value for ${detail.fields}, which agentTools.secretValues.enabled does not allow. Omit "value": the user is asked to type it.`;
		case "kept-secret-destination-change":
			return (
				`The change moves "${detail.label}" to another destination while keeping ${detail.fields}. A stored ` +
				"secret never follows a changed destination (the base URL; for an OAuth client secret, the token URL and " +
				`client id): set ${detail.fields} again (omit "value" and the user is asked to type it), or clear it.`
			);
		case "base-url-required":
			return `"${detail.label}" needs a baseUrl.`;
		case "credential-header-placeholder":
			return `headers ${detail.headers} of "${detail.label}" carry the placeholder the configuration read shows for a credential header; re-enter the value, the configuration read hides header values.`;
		case "feature-model-not-set":
			return `No model is picked for ${detail.feature}; set "${detail.feature}.model" first.`;
		case "model-not-found":
			return `Server "${detail.server}" serves no model "${detail.model}". Read the configuration tool's "models" section.`;
		case "model-ambiguous":
			return `More than one row serves "${detail.model}" under the label "${detail.server}" (scopeKeys ${detail.scopeKeys}). Pass the scopeKey of the row you mean, from the configuration tool's "models" section.`;
		case "nothing-to-change":
			return `The record for "${detail.key}" already reads this way; nothing to change.`;
		case "language-filter-one-half":
			return `Set "${detail.setting}" one half per call: { "mode": ... } in one call and { "languages": [...] } in another, like the dashboard's two rows.`;
	}
}

// ---------------------------------------------------------------------------
// Confirmation cards: what the user sees before a write runs
// ---------------------------------------------------------------------------

/** A confirmation card: its title through the one output door here, its body through fenced by its describe* function. */
export function confirmationCard(title: string, message: string): ConfirmationCard {
	return { title: Logger.redact(title), message };
}

export interface ConfirmationCard {
	readonly title: string;
	readonly message: string;
}

/** A confirmation card's body, through the one output door, inside a fence no backtick run in it can close. */
function fenced(lines: readonly string[]): string {
	const body = Logger.redact(lines.join("\n"));
	let longestRun = 0;
	for (const run of body.matchAll(/`+/g)) {
		longestRun = Math.max(longestRun, run[0].length);
	}
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return `${fence}\n${body}\n${fence}`;
}

function shown(value: unknown): string {
	return JSON.stringify(value) ?? "undefined";
}

function valueLabels(): { readonly before: string; readonly after: string } {
	const before = l10n.t("before:");
	const after = l10n.t("after:");
	const width = Math.max(before.length, after.length) + 1;
	return { before: before.padEnd(width), after: after.padEnd(width) };
}

/** A setting change: the full key, the scope the write lands in, and both values. */
export function describeSettingChange(setting: string, before: unknown, after: unknown, scope: string | null): string {
	const labels = valueLabels();
	return fenced([
		`litellm-vscode-chat.${setting}${scope !== null ? `  ${l10n.t("(configured in: {0})", scope)}` : ""}`,
		`${labels.before}${shown(before)}`,
		`${labels.after}${after === null ? l10n.t("(removed from its configured scope)") : shown(after)}`,
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
	const labels = valueLabels();
	return fenced([
		`models.${kind}["${key}"]  (${target})`,
		`${labels.before}${before === undefined ? l10n.t("(absent)") : shown(before)}`,
		`${labels.after}${after === undefined ? l10n.t("(removed)") : shown(after)}`,
	]);
}

/**
 * A server save: field names that change, never their values for secrets. A moved base URL is spelled out because it
 * decides where credentials go.
 */
export function describeServerChange(
	label: string,
	before: Readonly<Record<string, unknown>> | undefined,
	after: Readonly<Record<string, unknown>>,
	secrets: readonly string[],
	prompts: readonly SecretPrompt[]
): string {
	const lines: string[] = [
		before === undefined ? l10n.t('new servers entry "{0}"', label) : l10n.t('servers entry "{0}"', label),
	];
	const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
	for (const key of [...keys].sort()) {
		const previous = before?.[key];
		const next = after[key];
		if (JSON.stringify(previous) !== JSON.stringify(next)) {
			const shownPrevious = previous === undefined ? l10n.t("(absent)") : shown(previous);
			const shownNext = next === undefined ? l10n.t("(absent)") : shown(next);
			lines.push(`${key}: ${shownPrevious} -> ${shownNext}`);
		}
	}
	for (const line of secrets) {
		lines.push(line);
	}
	for (const prompt of prompts) {
		lines.push(l10n.t("{0}: you will be asked to type it (stored in {1})", prompt.field, prompt.location));
	}
	if (lines.length === 1) {
		lines.push(l10n.t("(no field changes)"));
	}
	return fenced(lines);
}

/** An adoption: which external group is copied, under which label, and where each copied secret lands. */
export function describeAdoption(
	source: { readonly label: string; readonly baseUrl: string },
	label: string,
	locations: Readonly<Partial<Record<string, "settings" | "secure">>>
): string {
	const lines = [
		l10n.t('adopt provider group "{0}" at {1} as servers entry "{2}"', source.label, source.baseUrl, label),
	];
	for (const field of ["apiKey", "oauthClientSecret", "virtualKeyValue"]) {
		lines.push(l10n.t("{0}: copied to {1} storage if the group holds one", field, locations[field] ?? "secure"));
	}
	return fenced(lines);
}

export function describeAction(action: string, target: string | undefined): string {
	return fenced([target === undefined ? action : `${action}: ${target}`]);
}
