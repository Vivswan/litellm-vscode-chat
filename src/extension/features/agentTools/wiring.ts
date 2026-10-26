import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { DashboardState } from "../../../dashboard/viewModels";
import type { AgentToolContribution, AgentToolId } from "../../../shared/config/commandIds";
import { AGENT_TOOL_IDS, AGENT_TOOLS } from "../../../shared/config/commandIds";
import type { ModelRecordMap } from "../../../shared/config/modelMatcher";
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
import { isRecord } from "../../../shared/util/json";
import type { DashboardController } from "../../dashboard/panel";
import type { DeclaredServerView } from "../../servers/serverSync/engine";
import type { SettingsAccess } from "../../settingsAccess";
import { resolveConfiguredScope } from "../../settingsAccess";
import { buildDiagnosticsSnapshot } from "../../ui/diagnostics";
import type { IssueReporter } from "../../ui/issueReporter";
import type { ConnectionStatus } from "../../ui/status";
import { statusServerStatuses } from "../../ui/status";
import { featureDisabledMessage, featureDisabledMessageEnglish } from "../featureGate";
import { preparedInvocation, toolResult } from "../modelFacingExit";
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
	type ConfirmationCard,
	confirmationCard,
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
 * The agent tools' host adapter and the feature's single logging boundary. Each tool registers under the feature
 * switch plus, for a write, its own toggle; the manifest's `when` clauses read the same two settings, so the agent's
 * tool picker shows exactly the registered set.
 *
 *   Every write is a second client of the dashboard controller
 *     -> the same parse, the same intent executor, the same serialized chain the webview's saves join
 */

type LogFn = (message: string, data?: unknown) => void;

/**
 * The masked secret prompt, injectable so the host suite can answer it; the token dismisses it when the agent turn is
 * cancelled.
 */
type SecretPromptFn = (
	prompt: SecretPrompt,
	label: string,
	token: vscode.CancellationToken
) => Thenable<string | undefined>;

/**
 * What the tools take from the host. `settings` is the one settings reader the cards read current values through (the
 * dashboard's own access). `getDeclared` is the sync engine's declared views, the credential reading the diagnostics
 * tool reports (ui/diagnostics.ts).
 */
export interface AgentToolsDeps {
	readonly dashboard: Pick<DashboardController, "submit" | "readState">;
	readonly settings: Pick<SettingsAccess, "readEffective" | "inspect">;
	readonly getConnectionStatus: () => ConnectionStatus;
	readonly getDeclared: () => readonly DeclaredServerView[];
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
 * The display text names what the agent sent (a setting key, a label) so the agent can fix the call; the English
 * mirror is what the output channel and the issue-report buffer record, so it carries the classification alone and
 * never an agent-controlled identifier.
 */
function refusalError(tool: AgentToolId, text: string, classification: string): Error {
	const tag = `AgentTools(${tool}: ${classification})`;
	return localizedError(text, `Agent tool refused the call: ${tag}`, tag);
}

/** The record map a patch applies to: the scoped setting's, or the named entry's, empty when the entry is unknown. */
function currentRecordMap(input: AgentToolInput<"editModelRecords">, state: DashboardState): ModelRecordMap {
	if (input.server === undefined) {
		return input.kind === "capabilities"
			? state.settings.modelCapabilities.value
			: state.settings.modelParameters.value;
	}
	const row = declaredRow(state, input.server);
	if (row === undefined) {
		return {};
	}
	return (input.kind === "capabilities" ? row.config.modelCapabilities : row.config.modelParameters) ?? {};
}

/** What a run action's card names: the entry (with its base URL when declared), the feature, or nothing. */
function runActionTarget(input: AgentToolInput<"runAction">, state: DashboardState): string | undefined {
	if ("label" in input) {
		const row = declaredRow(state, input.label);
		return row === undefined ? input.label : l10n.t("{0} at {1}", input.label, row.baseUrl);
	}
	if ("feature" in input) {
		return input.feature;
	}
	return undefined;
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
	 * Writes get the confirmation card with the change spelled out from the CURRENT state; a plan that would refuse
	 * gets no card, so invoke can hand the refusal straight back to the agent.
	 */
	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<unknown>): vscode.PreparedToolInvocation {
		if (this.contribution.toggle === undefined) {
			return preparedInvocation(l10n.t("Reading LiteLLM {0}...", this.id));
		}
		return preparedInvocation(l10n.t("LiteLLM: {0}", this.id), this.confirmationCard(options.input));
	}

	/** The setting card, or undefined when the input is malformed or the planner would refuse the call. */
	private setSettingCard(raw: unknown): ConfirmationCard | undefined {
		const parsed = parseAgentToolInput("setSetting", raw);
		if (!parsed.ok) {
			return undefined;
		}
		const { setting, value } = parsed.input;
		// The planner's refusals (servers, the records, this feature's own switches) get no card: rendering the
		// current value of the servers setting would show its inline keys.
		if (planSetSetting(parsed.input).kind === "refused") {
			return undefined;
		}
		const inspection = this.deps.settings.inspect(setting);
		return confirmationCard(
			l10n.t("Change the LiteLLM setting {0}?", setting),
			describeSettingChange(
				setting,
				this.deps.settings.readEffective(setting),
				value,
				inspection === undefined ? null : resolveConfiguredScope(inspection)
			)
		);
	}

	/** The record-edit card: the patched key beside the current one, under the scope or entry it lands in. */
	private editModelRecordsCard(raw: unknown, state: DashboardState): ConfirmationCard | undefined {
		const parsed = parseAgentToolInput("editModelRecords", raw);
		if (!parsed.ok) {
			return undefined;
		}
		const input = parsed.input;
		if (planEditModelRecords(input, state).kind === "refused") {
			return undefined;
		}
		const current = currentRecordMap(input, state);
		const patched = applyRecordPatch(current, input);
		const scope =
			input.kind === "capabilities"
				? state.settings.modelCapabilities.editScope
				: state.settings.modelParameters.editScope;
		const target =
			input.server === undefined ? l10n.t("the {0} settings", scope) : l10n.t('servers entry "{0}"', input.server);
		return confirmationCard(
			l10n.t("Edit the LiteLLM model record {0}?", input.key),
			describeRecordChange(input.kind, input.key, current[input.key], patched[input.key], target)
		);
	}

	/** The save card: an adoption names the stored group, an edit shows the entry before and after. */
	private saveServerCard(raw: unknown, state: DashboardState): ConfirmationCard | undefined {
		const parsed = parseAgentToolInput("saveServer", raw);
		if (!parsed.ok) {
			return undefined;
		}
		const input = parsed.input;
		const plan = planSaveServer(input, state, agentToolsAcceptSecretValues());
		if (plan.kind === "refused") {
			return undefined;
		}
		if ("adoptFrom" in input) {
			// The card describes the STORED group (the plan accepted, so it resolves), whichever spelling of its URL the
			// agent named it by.
			const source = externalRow(state, input.adoptFrom.label, input.adoptFrom.baseUrl) ?? input.adoptFrom;
			return confirmationCard(
				l10n.t("Adopt the provider group {0} as the LiteLLM server {1}?", input.adoptFrom.label, input.label),
				describeAdoption(source, input.label, input.secretLocations ?? {})
			);
		}
		const payload = plan.requests[0]?.payload;
		const existing = declaredRow(state, input.renameFrom ?? input.label);
		const after = isRecord(payload) && isRecord(payload.server) ? payload.server : { label: input.label };
		return confirmationCard(
			l10n.t("Save the LiteLLM server {0}?", input.label),
			describeServerChange(
				input.label,
				existing === undefined ? undefined : { ...savePayloadFromRow(existing) },
				after,
				plan.secrets,
				plan.prompts
			)
		);
	}

	/**
	 * The remove card. A hide or unhide is identified by label AND base URL (two groups can share a label), so the
	 * card names both.
	 */
	private removeServerCard(raw: unknown, state: DashboardState): ConfirmationCard | undefined {
		const parsed = parseAgentToolInput("removeServer", raw);
		if (!parsed.ok) {
			return undefined;
		}
		const input = parsed.input;
		if (planRemoveServer(input, state).kind === "refused") {
			return undefined;
		}
		const target = input.action === "remove" ? input.label : l10n.t("{0} at {1}", input.label, input.baseUrl);
		return confirmationCard(
			l10n.t("{0} the LiteLLM server {1}?", input.action, input.label),
			describeAction(input.action, target)
		);
	}

	/** The run-action card, naming the entry or feature the action targets. */
	private runActionCard(raw: unknown, state: DashboardState): ConfirmationCard | undefined {
		const parsed = parseAgentToolInput("runAction", raw);
		if (!parsed.ok) {
			return undefined;
		}
		if (planRunAction(parsed.input, state).kind === "refused") {
			return undefined;
		}
		const input = parsed.input;
		return confirmationCard(
			l10n.t("Run the LiteLLM action {0}?", input.action),
			describeAction(input.action, runActionTarget(input, state))
		);
	}

	private confirmationCard(raw: unknown): ConfirmationCard | undefined {
		const state = this.deps.dashboard.readState();
		switch (this.id) {
			case "setSetting":
				return this.setSettingCard(raw);
			case "editModelRecords":
				return this.editModelRecordsCard(raw, state);
			case "saveServer":
				return this.saveServerCard(raw, state);
			case "removeServer":
				return this.removeServerCard(raw, state);
			case "runAction":
				return this.runActionCard(raw, state);
			default:
				return undefined;
		}
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<unknown>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		// Registration already gates on the switches, but a configuration change races an in-flight agent turn: the
		// tool answers the live settings.
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
			return toolResult(renderJson(payload));
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				throw error;
			}
			// The logger records the classification the thrown error carries; the agent's input and the dashboard's
			// messages never reach the buffer.
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
					buildDiagnosticsSnapshot(
						status,
						this.deps.getDeclared(),
						this.deps.extVersion,
						this.deps.vscodeVersion,
						this.deps.issueReporter
					),
					statusServerStatuses(status),
					state.diagnostics,
					input.includeLogs === true
				);
			}
			case "configuration":
				return shapeConfiguration(state, this.parse("configuration", raw).sections);
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

	private parse<K extends AgentToolId>(tool: K, raw: unknown): AgentToolInput<K> {
		const parsed = parseAgentToolInput(tool, raw);
		if (!parsed.ok) {
			const issues = parsed.issues.map((issue) => `${issue.path || "(input)"}: ${issue.message}`).join("; ");
			throw refusalError(tool, `The ${AGENT_TOOLS[tool].name} tool input is malformed: ${issues}`, "malformed input");
		}
		return parsed.input;
	}

	/**
	 * The dashboard's own failure message rides the result (it may quote an entered key, so it is for the agent, never
	 * for the log).
	 */
	private async execute(plan: ToolPlan, token: vscode.CancellationToken, label = ""): Promise<unknown> {
		if (plan.kind === "refused") {
			throw refusalError(this.id, refusalText(plan.reason, plan.detail), plan.reason);
		}
		const values = await this.promptSecrets(plan.prompts, label, token);
		const results: unknown[] = [];
		for (const planned of plan.requests) {
			// A cancel stops the plan before its next submit; what already landed stays, since a dashboard write is not
			// undone.
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const request = values === undefined ? planned : withSecretValues(planned, values);
			const submission = await this.deps.dashboard.submit(frame(request));
			results.push(shapeSubmission(request, submission));
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

/** Whether a tool registers right now: the feature switch, plus a write tool's own toggle. */
function toolActive(id: AgentToolId, featureOn: boolean): boolean {
	const toggle = AGENT_TOOLS[id].toggle;
	return featureOn && (toggle === undefined || isAgentWriteToolEnabled(toggle));
}

/**
 * Registers each tool that should be live and disposes each that should not; a tool already in its state is left
 * alone.
 */
function applyToolEnablement(
	tools: ReadonlyMap<AgentToolId, AgentTool>,
	registrations: Map<AgentToolId, vscode.Disposable>
): void {
	const featureOn = isFeatureEnabled("agentTools");
	for (const id of AGENT_TOOL_IDS) {
		const active = toolActive(id, featureOn);
		const registration = registrations.get(id);
		if (active && registration === undefined) {
			const tool = tools.get(id);
			if (tool !== undefined) {
				registrations.set(id, vscode.lm.registerTool(AGENT_TOOLS[id].name, tool));
			}
			continue;
		}
		if (!active && registration !== undefined) {
			registration.dispose();
			registrations.delete(id);
		}
	}
}

export function wireAgentTools(context: vscode.ExtensionContext, logger: Logger, deps: AgentToolsDeps): void {
	const tools = new Map<AgentToolId, AgentTool>(AGENT_TOOL_IDS.map((id) => [id, new AgentTool(id, deps, logger)]));
	const registrations = new Map<AgentToolId, vscode.Disposable>();
	applyToolEnablement(tools, registrations);
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				applyToolEnablement(tools, registrations);
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
