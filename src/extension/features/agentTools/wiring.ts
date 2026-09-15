import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { AgentToolContribution, AgentToolId } from "../../../shared/config/commandIds";
import { AGENT_TOOL_IDS, AGENT_TOOLS } from "../../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import {
	agentToolsAcceptSecretValues,
	getMaskSecretInputs,
	isAgentWriteToolEnabled,
	isFeatureEnabled,
} from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { localizedError } from "../../../shared/mirroredError";
import type { SecretFieldId } from "../../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { displayUrl } from "../../../shared/util/displayUrl";
import { isRecord } from "../../../shared/util/json";
import type { DashboardController } from "../../dashboard/panel";
import type { SettingsAccess } from "../../settingsAccess";
import { resolveConfiguredScope } from "../../settingsAccess";
import { buildDiagnosticsSnapshot } from "../../ui/diagnostics";
import type { IssueReporter } from "../../ui/issueReporter";
import { redactSecrets } from "../../ui/issueReporter";
import type { ConnectionStatus } from "../../ui/status";
import { statusServerStatuses } from "../../ui/status";
import { featureDisabledMessage, featureDisabledMessageEnglish } from "../featureGate";
import type { AgentToolInput } from "./inputSchema";
import { parseAgentToolInput } from "./inputSchema";
import type { AgentRequest, SecretPrompt, ToolPlan } from "./planner";
import {
	applyRecordPatch,
	declaredRow,
	externalRow,
	planEditModelRecords,
	planInspectModel,
	planRemoveServer,
	planRunAction,
	planSaveServer,
	planSetSetting,
	savePayloadFromRow,
	withSecretValues,
} from "./planner";
import {
	describeAction,
	describeAdoption,
	describeRecordChange,
	describeServerChange,
	describeSettingChange,
	refusalText,
	renderJson,
	shapeConfiguration,
	shapeDiagnostics,
	shapeSubmission,
} from "./render";

/**
 * The agent tools' host adapter and the feature's single logging boundary.
 * Each tool registers under the feature switch plus, for a write, its own
 * toggle; the manifest's `when` clauses read the same two settings, so the
 * agent's tool picker shows exactly the registered set. Every write is a
 * second client of the dashboard controller: the same parse, the same intent
 * executor, the same serialized chain the webview's saves join.
 */

type LogFn = (message: string, data?: unknown) => void;

/** The masked secret prompt, injectable so the host suite can answer it; the token dismisses it when the agent turn is cancelled. */
type SecretPromptFn = (
	prompt: SecretPrompt,
	label: string,
	token: vscode.CancellationToken
) => Thenable<string | undefined>;

export interface AgentToolsDeps {
	readonly dashboard: Pick<DashboardController, "submit" | "readState">;
	/** The one settings reader the cards read current values through (the dashboard's own access). */
	readonly settings: Pick<SettingsAccess, "readEffective" | "inspect">;
	readonly getConnectionStatus: () => ConnectionStatus;
	readonly issueReporter: IssueReporter;
	readonly extVersion: string;
	readonly vscodeVersion: string;
	readonly promptSecret?: SecretPromptFn | undefined;
}

function showSecretInput(
	prompt: SecretPrompt,
	label: string,
	token: vscode.CancellationToken
): Thenable<string | undefined> {
	return vscode.window.showInputBox(
		{
			title: l10n.t('LiteLLM: {0} for "{1}"', prompt.field, label),
			prompt: l10n.t(
				"The agent asked to store this secret in {0}. Type it here; it never enters the chat.",
				prompt.location
			),
			password: getMaskSecretInputs(),
			ignoreFocusOut: true,
		},
		token
	);
}

let nextRequestId = 0;

function frame(request: AgentRequest): unknown {
	nextRequestId += 1;
	return { kind: "request", id: `agent-${nextRequestId}`, method: request.method, payload: request.payload };
}

/**
 * The refusal to the calling model. The display text names what the agent
 * sent (a setting key, a label) so the agent can fix the call; the English
 * mirror is what the output channel and the issue-report buffer record, so it
 * carries the classification alone and never an agent-controlled identifier.
 */
function refusalError(tool: AgentToolId, text: string, classification: string): Error {
	const tag = `AgentTools(${tool}: ${classification})`;
	return localizedError(text, `Agent tool refused the call: ${tag}`, tag);
}

/** The card's secret lines: location and action only, never a value. */
function secretSummary(payload: unknown): string[] {
	if (!isRecord(payload) || !isRecord(payload.secrets)) {
		return [];
	}
	const lines: string[] = [];
	for (const field of SECRET_FIELD_IDS) {
		const directive = payload.secrets[field];
		if (!isRecord(directive)) {
			continue;
		}
		if (directive.action === "clear") {
			lines.push(`${field}: cleared`);
		} else if (directive.action === "set" && typeof directive.value === "string" && directive.value.length > 0) {
			lines.push(`${field}: set (${String(directive.location)})`);
		}
	}
	return lines;
}

class AgentTool implements vscode.LanguageModelTool<unknown> {
	private readonly contribution: AgentToolContribution;

	constructor(
		private readonly id: AgentToolId,
		private readonly deps: AgentToolsDeps,
		private readonly logger: Logger
	) {
		this.contribution = AGENT_TOOLS[id];
	}

	private log: LogFn = (message, data) => {
		this.logger.log(message, data);
	};

	/**
	 * Reads get a progress line. Writes get the confirmation card with the
	 * change spelled out from the CURRENT state; a plan that would refuse gets
	 * no card, so invoke can hand the refusal straight back to the agent.
	 */
	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<unknown>): vscode.PreparedToolInvocation {
		if (this.contribution.toggle === undefined) {
			return { invocationMessage: l10n.t("Reading LiteLLM {0}...", this.id) };
		}
		const card = this.confirmationCard(options.input);
		return card === undefined
			? { invocationMessage: l10n.t("LiteLLM: {0}", this.id) }
			: {
					invocationMessage: l10n.t("LiteLLM: {0}", this.id),
					confirmationMessages: { title: card.title, message: new vscode.MarkdownString(card.message) },
				};
	}

	private confirmationCard(raw: unknown): { readonly title: string; readonly message: string } | undefined {
		const state = this.deps.dashboard.readState();
		switch (this.id) {
			case "setSetting": {
				const parsed = parseAgentToolInput("setSetting", raw);
				if (!parsed.ok) {
					return undefined;
				}
				const { setting, value } = parsed.input;
				// The planner's refusals (servers, the records, this feature's own
				// switches) get no card: rendering the current value of the servers
				// setting would show its inline keys.
				if (planSetSetting(parsed.input).kind === "refused") {
					return undefined;
				}
				const inspection = this.deps.settings.inspect(setting);
				return {
					title: l10n.t("Change the LiteLLM setting {0}?", setting),
					message: describeSettingChange(
						setting,
						this.deps.settings.readEffective(setting),
						value,
						inspection === undefined ? null : resolveConfiguredScope(inspection)
					),
				};
			}
			case "editModelRecords": {
				const parsed = parseAgentToolInput("editModelRecords", raw);
				if (!parsed.ok) {
					return undefined;
				}
				const input = parsed.input;
				if (planEditModelRecords(input, state).kind === "refused") {
					return undefined;
				}
				const row = input.server === undefined ? undefined : declaredRow(state, input.server);
				const current =
					input.server === undefined
						? input.kind === "capabilities"
							? state.settings.modelCapabilities.value
							: state.settings.modelParameters.value
						: row === undefined
							? {}
							: ((input.kind === "capabilities" ? row.config.modelCapabilities : row.config.modelParameters) ?? {});
				const patched = applyRecordPatch(current, input);
				const target =
					input.server === undefined
						? `${input.kind === "capabilities" ? state.settings.modelCapabilities.editScope : state.settings.modelParameters.editScope} settings`
						: `servers entry "${input.server}"`;
				return {
					title: l10n.t("Edit the LiteLLM model record {0}?", input.key),
					message: describeRecordChange(input.kind, input.key, current[input.key], patched[input.key], target),
				};
			}
			case "saveServer": {
				const parsed = parseAgentToolInput("saveServer", raw);
				if (!parsed.ok) {
					return undefined;
				}
				const input = parsed.input;
				if (planSaveServer(input, state, agentToolsAcceptSecretValues()).kind === "refused") {
					return undefined;
				}
				if ("adoptFrom" in input) {
					// The card describes the STORED group (the plan accepted, so it
					// resolves): the agent only ever saw its URL without credentials.
					const source = externalRow(state, input.adoptFrom.label, input.adoptFrom.baseUrl) ?? input.adoptFrom;
					return {
						title: l10n.t(
							"Adopt the provider group {0} as the LiteLLM server {1}?",
							input.adoptFrom.label,
							input.label
						),
						message: describeAdoption(source, input.label, input.secretLocations ?? {}),
					};
				}
				const plan = planSaveServer(input, state, agentToolsAcceptSecretValues());
				const payload = plan.kind === "requests" ? plan.requests[0]?.payload : undefined;
				const prompts = plan.kind === "requests" ? plan.prompts : [];
				const existing = declaredRow(state, input.renameFrom ?? input.label);
				const after = isRecord(payload) && isRecord(payload.server) ? payload.server : { label: input.label };
				return {
					title: l10n.t("Save the LiteLLM server {0}?", input.label),
					message: describeServerChange(
						input.label,
						existing === undefined ? undefined : { ...savePayloadFromRow(existing) },
						after,
						secretSummary(payload),
						prompts
					),
				};
			}
			case "removeServer": {
				const parsed = parseAgentToolInput("removeServer", raw);
				if (!parsed.ok) {
					return undefined;
				}
				const input = parsed.input;
				if (planRemoveServer(input, state).kind === "refused") {
					return undefined;
				}
				// A hide or unhide is identified by label AND base URL (two groups can
				// share a label), so the card names both.
				const target = input.action === "remove" ? input.label : `${input.label} at ${displayUrl(input.baseUrl)}`;
				return {
					title: l10n.t("{0} the LiteLLM server {1}?", input.action, input.label),
					message: describeAction(input.action, target),
				};
			}
			case "runAction": {
				const parsed = parseAgentToolInput("runAction", raw);
				if (!parsed.ok) {
					return undefined;
				}
				if (planRunAction(parsed.input, state).kind === "refused") {
					return undefined;
				}
				const input = parsed.input;
				const target =
					"label" in input
						? `${input.label}${(() => {
								const row = declaredRow(state, input.label);
								return row === undefined ? "" : ` at ${displayUrl(row.baseUrl)}`;
							})()}`
						: "feature" in input
							? input.feature
							: undefined;
				return {
					title: l10n.t("Run the LiteLLM action {0}?", input.action),
					message: describeAction(input.action, target),
				};
			}
			default:
				return undefined;
		}
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<unknown>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		// Registration already gates on the switches, but a configuration change
		// races an in-flight agent turn: the tool answers the live settings.
		if (!isFeatureEnabled("agentTools")) {
			throw localizedError(
				featureDisabledMessage("agentTools"),
				featureDisabledMessageEnglish("agentTools"),
				`AgentTools(${this.id}: disabled)`
			);
		}
		const toggle = this.contribution.toggle;
		if (toggle !== undefined && !isAgentWriteToolEnabled(toggle)) {
			throw refusalError(
				this.id,
				`The ${this.contribution.name} tool is switched off; the user enables it with "${CONFIG_SECTION}.agentTools.${toggle}.enabled".`,
				"tool switched off"
			);
		}
		try {
			const payload = await this.run(options.input, token);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(renderJson(payload))]);
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				throw error;
			}
			// The logger records the classification the thrown error carries; the
			// agent's input and the dashboard's messages never reach the buffer.
			this.logger.error(`Agent tool ${this.id} failed`, error);
			throw error;
		}
	}

	private async run(raw: unknown, token: vscode.CancellationToken): Promise<unknown> {
		const state = this.deps.dashboard.readState();
		switch (this.id) {
			case "diagnostics": {
				const input = this.parse("diagnostics", raw);
				const status = this.deps.getConnectionStatus();
				return shapeDiagnostics(
					buildDiagnosticsSnapshot(status, this.deps.extVersion, this.deps.vscodeVersion, this.deps.issueReporter),
					statusServerStatuses(status),
					state.diagnostics,
					redactSecrets,
					input.includeLogs === true
				);
			}
			case "configuration":
				return shapeConfiguration(state, this.parse("configuration", raw).sections, redactSecrets);
			case "inspectModel":
				return this.execute(planInspectModel(this.parse("inspectModel", raw), state), token);
			case "searchCatalog":
				return this.execute(
					{
						kind: "requests",
						requests: [{ method: "searchCatalog", payload: this.parse("searchCatalog", raw) }],
						prompts: [],
					},
					token
				);
			case "setSetting":
				return this.execute(planSetSetting(this.parse("setSetting", raw)), token);
			case "editModelRecords":
				return this.execute(planEditModelRecords(this.parse("editModelRecords", raw), state), token);
			case "saveServer": {
				const input = this.parse("saveServer", raw);
				return this.execute(planSaveServer(input, state, agentToolsAcceptSecretValues()), token, input.label);
			}
			case "removeServer":
				return this.execute(planRemoveServer(this.parse("removeServer", raw), state), token);
			case "runAction":
				return this.execute(planRunAction(this.parse("runAction", raw), state), token);
		}
	}

	/** The contributed schema documents; this parse binds. A refusal names the offending paths for the agent. */
	private parse<K extends AgentToolId>(tool: K, raw: unknown): AgentToolInput<K> {
		const parsed = parseAgentToolInput(tool, raw);
		if (!parsed.ok) {
			const issues = parsed.issues.map((issue) => `${issue.path || "(input)"}: ${issue.message}`).join("; ");
			throw refusalError(tool, `The ${AGENT_TOOLS[tool].name} tool input is malformed: ${issues}`, "malformed input");
		}
		return parsed.input;
	}

	/**
	 * Run a plan: refusals go back to the agent, prompts go to the user, then
	 * each request is submitted in order and stops at the first that did not
	 * land. The dashboard's own failure message rides the result (it may quote
	 * an entered key, so it is for the agent, never for the log).
	 */
	private async execute(plan: ToolPlan, token: vscode.CancellationToken, label = ""): Promise<unknown> {
		if (plan.kind === "refused") {
			throw refusalError(this.id, refusalText(plan.reason, plan.detail), plan.reason);
		}
		const values = await this.promptSecrets(plan.prompts, label, token);
		const results: unknown[] = [];
		for (const planned of plan.requests) {
			// A cancel stops the plan before its next submit; what already landed
			// stays, since a dashboard write is not undone.
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const request = values === undefined ? planned : withSecretValues(planned, values);
			const submission = await this.deps.dashboard.submit(frame(request));
			results.push(shapeSubmission(request, submission, redactSecrets));
			if (submission.outcome !== "ok") {
				// Classification only: the method and the verdict.
				this.log("Agent tool request refused by the dashboard", {
					tool: this.id,
					method: request.method,
					outcome: submission.outcome,
				});
				break;
			}
		}
		return results.length === 1 ? results[0] : results;
	}

	/** One masked box per prompted field; a cancel aborts the whole call with nothing landed. */
	private async promptSecrets(
		prompts: readonly SecretPrompt[],
		label: string,
		token: vscode.CancellationToken
	): Promise<Partial<Record<SecretFieldId, string>> | undefined> {
		if (prompts.length === 0) {
			return undefined;
		}
		const ask = this.deps.promptSecret ?? showSecretInput;
		const values: Partial<Record<SecretFieldId, string>> = {};
		for (const prompt of prompts) {
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const value = await ask(prompt, label, token);
			if (value === undefined || value.length === 0 || token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			values[prompt.field] = value;
		}
		return values;
	}
}

/**
 * Wire the feature: one tool object per table row, registered exactly while
 * its switches are on. Re-evaluated on every configuration change.
 */
export function wireAgentTools(context: vscode.ExtensionContext, logger: Logger, deps: AgentToolsDeps): void {
	const tools = new Map<AgentToolId, AgentTool>(AGENT_TOOL_IDS.map((id) => [id, new AgentTool(id, deps, logger)]));
	const registrations = new Map<AgentToolId, vscode.Disposable>();
	const applyEnablement = (): void => {
		const featureOn = isFeatureEnabled("agentTools");
		for (const id of AGENT_TOOL_IDS) {
			const toggle = AGENT_TOOLS[id].toggle;
			const active = featureOn && (toggle === undefined || isAgentWriteToolEnabled(toggle));
			const registration = registrations.get(id);
			if (active && registration === undefined) {
				const tool = tools.get(id);
				if (tool !== undefined) {
					registrations.set(id, vscode.lm.registerTool(AGENT_TOOLS[id].name, tool));
				}
			} else if (!active && registration !== undefined) {
				registration.dispose();
				registrations.delete(id);
			}
		}
	};
	applyEnablement();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				applyEnablement();
			}
		}),
		new vscode.Disposable(() => {
			for (const registration of registrations.values()) {
				registration.dispose();
			}
			registrations.clear();
		})
	);
}
