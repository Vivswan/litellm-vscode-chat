import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { LiteLLMModelInfo } from "../../provider/catalog/groupModels";
import { thrownErrorDisplayText } from "../../provider/transport/transportErrors";
import { CMD, INTERNAL_CMD } from "../../shared/config/commandIds";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import { failureClassification, failureTexts } from "../../shared/failureCause";
import { type ErrorRecorder, Logger, type RecordedError } from "../../shared/logger";
import type { SecretFieldId } from "../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../shared/serverEntry";
import type { ServerStatus } from "../../shared/servers";
import { unexpectedFailureCount } from "../../shared/servers";
import { DOCS_GETTING_STARTED_URL, GITHUB_FEATURE_REQUEST_URL, GITHUB_REPO_URL } from "../../shared/util/links";
import { openUrl } from "../../shared/util/openUrl";
import type { DashboardController } from "../dashboard/panel";
import type { DeclaredServerView, ServerSyncEngine } from "../servers/serverSync";
import { updateServerSecret } from "../servers/serverSync";
import { secretDestination } from "../servers/serverSync/secrets";
import { acceptedEntry } from "../servers/serverSync/setting";
import { buildDiagnosticsSnapshot } from "./diagnostics";
import type { IssueReporter } from "./issueReporter";
import { readLastIssueReport, rememberIssueReport, reportFingerprint } from "./issueReporter";
import {
	commandErrorActions,
	configureNowLabel,
	openChatAction,
	reconfigureAction,
	reportIssueAction,
	showActionableMessage,
	showMessage,
	viewOutputAction,
} from "./notifier";
import { profileUserFileUri } from "./profilePath";
import { detectSetupProblem, showSetupProblemGate } from "./setupGate";
import type { ConnectionStatus, ZeroModelJudgment } from "./status";
import { zeroModelTexts } from "./status";

interface ModelInfoProvider {
	provideLanguageModelChatInformation(
		options: { silent: boolean; configuration?: Record<string, string> },
		token: vscode.CancellationToken
	): Promise<LiteLLMModelInfo[]>;
}

interface StatusSnapshotProvider {
	getServerSnapshots(): ReadonlyArray<{ readonly status: ServerStatus }>;
}

/**
 * refreshGroups resolves once every group it knows has reported this pass, so the status read after it is this
 * pass's; `refreshedGroups` is how many group reports landed during it, zero when it had no group to probe.
 */
interface GroupRefreshingProvider {
	refreshGroups(): Promise<{ readonly refreshedGroups: number }>;
}

/**
 * A refresh in which no report landed (no group in the status window), or that threw before reporting, leaves no
 * fresh status to read: the bar may still show a state restored from the last session or the pre-refresh count,
 * which must not toast as this pass's. One verdict is still this pass's own: the error the forced server sync just
 * judged (a refused group upsert, a refused entry), which exists before any group reports and so leaves nothing for
 * the refresh to probe. The live configured-servers gate decides what remains to say: nothing configured anywhere,
 * or nothing reporting.
 */
function freshStatus(
	status: ConnectionStatus,
	refreshedGroups: number | undefined,
	hasConfiguredServers: () => boolean,
	syncVerdict?: ConnectionStatus
): ConnectionStatus | undefined {
	if (refreshedGroups !== undefined && refreshedGroups > 0) {
		return status;
	}
	if (isSyncJudgedError(syncVerdict) && hasConfiguredServers()) {
		return syncVerdict;
	}
	return hasConfiguredServers() ? undefined : { state: "not-configured" };
}

/**
 * An error only a sync pass produces: its cause is the sync engine's class or a parser-refused entry, never a
 * transport failure (which needs a group report this pass did not get, so a transport error here is a restore).
 */
function isSyncJudgedError(status: ConnectionStatus | undefined): status is ConnectionStatus & { state: "error" } {
	return status?.state === "error" && (status.cause.kind === "sync" || status.cause.kind === "misconfiguredEntry");
}

function showStatusUnavailableToast(outputChannel: vscode.OutputChannel): void {
	void showActionableMessage("warning", l10n.t("LiteLLM: Connection status is unavailable; try again in a moment."), [
		viewOutputAction(outputChannel),
	]);
}

/**
 *   like every other surface of this judgment (bar, hero, notifier) -> warning-grade
 *   the verdict text already names the cause and the recovery -> the "Connection failed"/"sync failed" framing must
 *       not wrap it
 *   the restore lives in the dashboard's server list -> a hidden group earns the Open Dashboard label
 */
function showZeroModelOutcomeToast(zero: ZeroModelJudgment, outputChannel: vscode.OutputChannel): void {
	void showActionableMessage("warning", l10n.t("LiteLLM: {0}", zeroModelTexts(zero).display), [
		viewOutputAction(outputChannel),
		zero.hiddenCount > 0 ? reconfigureAction(l10n.t("Open Dashboard")) : reconfigureAction(),
		reportIssueAction(),
	]);
}

interface StatusBarLike {
	readonly connectionStatus: ConnectionStatus;
	updateStatusBar(status?: ConnectionStatus): Promise<void>;
}

// A second invocation while one test is mid-flight would capture "loading" as the pre-test status and misreport; it is
// refused instead.
let connectionTestRunning = false;
/**
 * A second invocation mid-run joins the running pass instead of starting its own: one outcome, one toast, and a
 * truthful answer about when the work finished (the dashboard's Retry waits on it). The provider's refreshGroups is
 * single-flight too; this guard owns the command's outcome, not the network.
 */
let modelSyncInFlight: Promise<void> | undefined;

/**
 * The status, not any returned model list, is the source of truth: the host owns the per-group fetches, so the direct
 * refresh alone proves nothing.
 */
export async function runConnectionTest(
	provider: GroupRefreshingProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger,
	/** The shared configured-servers gate (wiring/provider.ts), read when the refresh had no group to probe. */
	hasConfiguredServers: () => boolean
): Promise<void> {
	if (connectionTestRunning) {
		logger.log("A connection test is already running");
		return;
	}
	connectionTestRunning = true;
	try {
		logger.log("Testing connection to all servers...");
		outputChannel.show(true);

		const previous = statusBar.connectionStatus;
		await statusBar.updateStatusBar({ state: "loading" });
		// The probe pass alone: a group-agnostic call here would serve nothing and only open a new window cycle, taking
		// the groups the host served out of the probe set.
		let refreshedGroups: number | undefined;
		try {
			refreshedGroups = (await provider.refreshGroups()).refreshedGroups;
		} catch (error) {
			// The failing probes already reported their error statuses; the toast below reads them.
			logger.error("Connection test failed", error);
		}

		let status = statusBar.connectionStatus;
		if (status.state === "loading") {
			await statusBar.updateStatusBar(previous);
			status = previous;
		}
		const outcome = freshStatus(status, refreshedGroups, hasConfiguredServers);
		if (outcome === undefined) {
			logger.log("Connection test landed no group report: no group known to probe");
		}

		switch (outcome?.state) {
			case "connected": {
				const zero = outcome.zeroModel;
				if (zero !== undefined) {
					logger.log(`Connection test finished with 0 models: ${zeroModelTexts(zero).logSafe}`);
					showZeroModelOutcomeToast(zero, outputChannel);
					break;
				}
				const count = outcome.totalModels;
				logger.log(`SUCCESS: ${count} models available`);
				void showActionableMessage(
					"info",
					count === 1
						? l10n.t("LiteLLM: Connection successful! Found 1 model.")
						: l10n.t("LiteLLM: Connection successful! Found {0} models.", count),
					[viewOutputAction(outputChannel, l10n.t("View Models")), openChatAction()]
				);
				break;
			}
			case "degraded": {
				// The shared unexpected-failure count: expected failures stay out, the same reading of the same window
				// as the status bar tooltip.
				const failed = unexpectedFailureCount(outcome.serverStatuses);
				logger.log(`WARNING: ${failed} server(s) failing`);
				const total = outcome.totalModels;
				void showActionableMessage(
					"warning",
					total === 1
						? failed === 1
							? l10n.t("LiteLLM: Connected with issues - 1 model available, 1 server failing.")
							: l10n.t("LiteLLM: Connected with issues - 1 model available, {0} servers failing.", failed)
						: failed === 1
							? l10n.t("LiteLLM: Connected with issues - {0} models available, 1 server failing.", total)
							: l10n.t("LiteLLM: Connected with issues - {0} models available, {1} servers failing.", total, failed),
					[viewOutputAction(outputChannel), reconfigureAction(), reportIssueAction()]
				);
				break;
			}
			case "error":
				// The toast carries the transport headline verbatim (it already says what to do); a classified failure
				// only adds the docs action.
				void showActionableMessage(
					"error",
					l10n.t(
						"LiteLLM: Connection failed - {0}",
						Logger.redact(failureTexts(outcome.cause, outcome.baseUrl ?? "").display)
					),
					commandErrorActions(failureClassification(outcome.cause), outputChannel)
				);
				break;
			case "not-configured":
				void showActionableMessage(
					"error",
					l10n.t("LiteLLM: No servers configured. Add one in the LiteLLM dashboard."),
					[reconfigureAction(configureNowLabel())]
				);
				break;
			default:
				showStatusUnavailableToast(outputChannel);
		}
	} finally {
		connectionTestRunning = false;
	}
}

export function registerTestConnectionCommand(
	context: vscode.ExtensionContext,
	provider: GroupRefreshingProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger,
	hasConfiguredServers: () => boolean
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.testConnection, () =>
			runConnectionTest(provider, statusBar, outputChannel, logger, hasConfiguredServers)
		),
		// The dashboard Diagnostics tab's Open-output-log action. Registered here because this registration already
		// holds the output channel.
		vscode.commands.registerCommand(INTERNAL_CMD.openOutput, () => outputChannel.show())
	);
}

/**
 * Force-refresh every model list: discovery results are normally cached (see the discovery.cacheTtl setting), and this
 * is the user's way to skip the cache. The outcome is read from the connection status the refresh left behind, like the
 * connection test.
 */
export async function runModelSync(
	provider: GroupRefreshingProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger,
	hasConfiguredServers: () => boolean,
	/** The bar's verdict right after the forced server sync, when the command ran one (registerSyncModelsCommand). */
	syncVerdict?: ConnectionStatus
): Promise<void> {
	const running = modelSyncInFlight;
	if (running !== undefined) {
		logger.log("A model sync is already running; joining it");
		return running;
	}
	const pass = runModelSyncPass(provider, statusBar, outputChannel, logger, hasConfiguredServers, syncVerdict);
	modelSyncInFlight = pass;
	try {
		await pass;
	} finally {
		modelSyncInFlight = undefined;
	}
}

/** One sync pass, without the re-entrancy guard: every caller reaches it through runModelSync. */
async function runModelSyncPass(
	provider: GroupRefreshingProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger,
	hasConfiguredServers: () => boolean,
	syncVerdict?: ConnectionStatus
): Promise<void> {
	{
		logger.log("Syncing models: refreshing every provider group over the network");
		let refreshedGroups: number | undefined;
		try {
			refreshedGroups = (await provider.refreshGroups()).refreshedGroups;
		} catch (error) {
			// The failing refresh already reported an error status; the toast below reads it.
			logger.error("Model sync failed", error);
		}

		const outcome = freshStatus(statusBar.connectionStatus, refreshedGroups, hasConfiguredServers, syncVerdict);
		if (outcome === undefined) {
			logger.log("Model sync landed no group report: no group known to probe");
		}
		switch (outcome?.state) {
			case "connected": {
				const zero = outcome.zeroModel;
				if (zero !== undefined) {
					logger.log(`Model sync finished with 0 models: ${zeroModelTexts(zero).logSafe}`);
					showZeroModelOutcomeToast(zero, outputChannel);
					break;
				}
				const count = outcome.totalModels;
				logger.log(`Model sync finished: ${count} models available`);
				void showActionableMessage(
					"info",
					count === 1
						? l10n.t("LiteLLM: Models synced - found 1 model.")
						: l10n.t("LiteLLM: Models synced - found {0} models.", count),
					[viewOutputAction(outputChannel, l10n.t("View Models")), openChatAction()]
				);
				break;
			}
			case "degraded": {
				const failed = unexpectedFailureCount(outcome.serverStatuses);
				logger.log(`Model sync finished with issues: ${failed} server(s) failing`);
				const total = outcome.totalModels;
				void showActionableMessage(
					"warning",
					total === 1
						? failed === 1
							? l10n.t("LiteLLM: Models synced with issues - 1 model available, 1 server failing.")
							: l10n.t("LiteLLM: Models synced with issues - 1 model available, {0} servers failing.", failed)
						: failed === 1
							? l10n.t("LiteLLM: Models synced with issues - {0} models available, 1 server failing.", total)
							: l10n.t(
									"LiteLLM: Models synced with issues - {0} models available, {1} servers failing.",
									total,
									failed
								),
					[viewOutputAction(outputChannel), reconfigureAction(), reportIssueAction()]
				);
				break;
			}
			case "error":
				// logSafeError, never error: this line lands in the issue-report buffer.
				logger.log(`Model sync failed: ${outcome.logSafeError}`);
				void showActionableMessage(
					"error",
					l10n.t(
						"LiteLLM: Model sync failed - {0}",
						Logger.redact(failureTexts(outcome.cause, outcome.baseUrl ?? "").display)
					),
					commandErrorActions(failureClassification(outcome.cause), outputChannel)
				);
				break;
			case "not-configured":
				logger.log("Model sync found no configured servers");
				void showActionableMessage(
					"error",
					l10n.t("LiteLLM: No servers configured. Add one in the LiteLLM dashboard."),
					[reconfigureAction(configureNowLabel())]
				);
				break;
			default:
				logger.log("Model sync finished without a settled connection status");
				showStatusUnavailableToast(outputChannel);
		}
	}
}

export function registerSyncModelsCommand(
	context: vscode.ExtensionContext,
	provider: GroupRefreshingProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger,
	hasConfiguredServers: () => boolean,
	/** Runs before the model refresh; the server sync engine reconciles provider groups here. */
	beforeSync?: () => Promise<void>
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.syncModels, async () => {
			await beforeSync?.();
			// The bar re-judges the owner's rows as the engine publishes (statusFanout), so this is the forced sync's
			// own verdict: with only a refused upsert or a refused entry, no group ever reports and the refresh below
			// probes nothing, yet the error is this pass's and the toast must carry it.
			const syncVerdict = beforeSync === undefined ? undefined : statusBar.connectionStatus;
			return runModelSync(provider, statusBar, outputChannel, logger, hasConfiguredServers, syncVerdict);
		})
	);
}

/**
 * The snapshot is built before the setup gate so a gated report still shows what the gate judged. Neither dialog is
 * awaited, because the dashboard's executeCommand intent awaits this command inside its serialized message chain, and
 * an unanswered dialog would freeze later messages on that chain.
 */
export async function runReportIssue(
	getConnectionStatus: () => ConnectionStatus,
	/** The sync engine's declared views: the owner's credential reading the snapshot reports (diagnostics.ts). */
	getDeclared: () => readonly DeclaredServerView[],
	extVersion: string,
	vscodeVersion: string,
	issueReporter: IssueReporter,
	globalState: vscode.Memento
): Promise<void> {
	const connectionStatus = getConnectionStatus();
	const snapshot = buildDiagnosticsSnapshot(connectionStatus, getDeclared(), extVersion, vscodeVersion, issueReporter);
	const fingerprint = reportFingerprint(snapshot);
	const openIssue = async () => {
		await issueReporter.openIssue(snapshot);
		try {
			await rememberIssueReport(globalState, { fingerprint, openedAt: Date.now() });
		} catch {
			// The ledger is advisory: the issue is already open, and a failed write only loses the next repeat hint.
		}
	};
	const problem = detectSetupProblem(connectionStatus);
	if (problem !== undefined) {
		void showSetupProblemGate(problem, openIssue);
		return;
	}
	const last = readLastIssueReport(globalState);
	if (last !== undefined && last.fingerprint === fingerprint) {
		const elapsed = Date.now() - last.openedAt;
		// Negative elapsed (a clock rollback or corrupt timestamp) counts as expired: fail open toward reporting rather
		// than prompting forever.
		if (elapsed >= 0 && elapsed <= REPEAT_REPORT_WINDOW_MS) {
			void showRepeatReportHint(elapsed, openIssue);
			return;
		}
	}
	await openIssue();
}

const REPEAT_REPORT_WINDOW_MS = 72 * 60 * 60 * 1000;

/** The repo's open issues carrying the reporter template's label ("bug", see createIssueUrl). */
const GITHUB_OPEN_BUG_ISSUES_URL = `${GITHUB_REPO_URL}/issues?q=${encodeURIComponent("is:issue is:open label:bug")}`;

function relativeTimeText(elapsedMs: number): string {
	const hours = Math.floor(elapsedMs / (60 * 60 * 1000));
	if (hours < 1) {
		return l10n.t("less than an hour ago");
	}
	if (hours < 24) {
		return hours === 1 ? l10n.t("1 hour ago") : l10n.t("{0} hours ago", hours);
	}
	const days = Math.floor(hours / 24);
	return days === 1 ? l10n.t("1 day ago") : l10n.t("{0} days ago", days);
}

/**
 * The repeat-report hint: modal, because the user is one click from filing a public duplicate. Callers void the
 * returned promise, so a failing report must surface here rather than die as an unhandled rejection.
 */
async function showRepeatReportHint(elapsedMs: number, reportAnyway: () => Promise<void>): Promise<void> {
	const openExisting = l10n.t("Open Existing Issues");
	const reportAnywayLabel = l10n.t("Report Anyway");
	const choice = await showMessage(
		"info",
		l10n.t(
			"LiteLLM: You opened an issue report that looks the same as one from {0}. Adding details to the existing issue helps more than a new report.",
			relativeTimeText(elapsedMs)
		),
		[openExisting, reportAnywayLabel],
		{ modal: true }
	);
	if (choice === openExisting) {
		try {
			await openUrl(GITHUB_OPEN_BUG_ISSUES_URL);
		} catch (error) {
			const detail = thrownErrorDisplayText(error);
			void showMessage("error", l10n.t("LiteLLM: Could not open the issues list - {0}", detail), []);
		}
		return;
	}
	if (choice === reportAnywayLabel) {
		try {
			await reportAnyway();
		} catch (error) {
			const detail = thrownErrorDisplayText(error);
			void showMessage("error", l10n.t("LiteLLM: Could not open the issue report - {0}", detail), []);
		}
	}
}

export function registerReportIssueCommand(
	context: vscode.ExtensionContext,
	getConnectionStatus: () => ConnectionStatus,
	getDeclared: () => readonly DeclaredServerView[],
	extVersion: string,
	vscodeVersion: string,
	issueReporter: IssueReporter
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.reportIssue, () =>
			runReportIssue(getConnectionStatus, getDeclared, extVersion, vscodeVersion, issueReporter, context.globalState)
		)
	);
}

/** The host's provider-groups file, directly under the profile's User directory. */
const GROUPS_FILE_NAME = "chatLanguageModels.json";

/**
 * Extensions have no removal API, so the host's provider-groups JSON is the fallback route for deleting a leftover
 * group beside Manage Language Models; VS Code has no API for this file either, and a profile that inherits its
 * language models keeps it in another profile's directory, so the open is best-effort. The log line stays
 * classification-only because the resolved path embeds the local user name and the log buffer feeds public issue
 * reports.
 */
export function registerOpenGroupsFileCommand(context: vscode.ExtensionContext, logger: Logger): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(INTERNAL_CMD.openGroupsFile, async () => {
			const uri = profileUserFileUri(context.globalStorageUri, GROUPS_FILE_NAME);
			try {
				const document = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(document, { preview: false });
			} catch {
				logger.log("Provider-groups file could not be opened");
				void showMessage(
					"error",
					l10n.t(
						"LiteLLM: Could not open the provider groups file (User/{0}). It may not exist yet - VS Code creates it with the first provider group - or it lives on the desktop profile, out of reach of this window.",
						GROUPS_FILE_NAME
					),
					[]
				);
			}
		})
	);
}

export function registerHelpAndFeedbackCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.helpAndFeedback, async () => {
			// Each entry carries its own action, so a new entry cannot be added without saying what it does.
			const choice = await vscode.window.showQuickPick(
				[
					{ label: l10n.t("$(bug) Report Bug"), run: () => vscode.commands.executeCommand(CMD.reportIssue) },
					{ label: l10n.t("$(lightbulb) Request Feature"), run: () => openUrl(GITHUB_FEATURE_REQUEST_URL) },
					{ label: l10n.t("$(book) Documentation"), run: () => openUrl(DOCS_GETTING_STARTED_URL) },
				],
				{ title: l10n.t("LiteLLM: Help & Feedback"), placeHolder: l10n.t("What would you like to do?") }
			);
			await choice?.run();
		})
	);
}

export function registerTestCommands(
	context: vscode.ExtensionContext,
	provider: ModelInfoProvider & StatusSnapshotProvider,
	issueReporter: Pick<IssueReporter, "getRecentLogs" | "getLatestError">,
	syncEngine: Pick<ServerSyncEngine, "getDeclared" | "resolveGroupArgs">,
	dashboard: Pick<DashboardController, "injectMessageForTest">,
	sessionLogs: Pick<SessionLogTee, "readSince">
): void {
	if (context.extensionMode === vscode.ExtensionMode.Production) {
		return;
	}

	context.subscriptions.push(
		// getDeclaredServers returns the sync engine's views, which carry secret locations but no secret values by
		// construction.
		vscode.commands.registerCommand("litellm._test.getRecentLogs", () => issueReporter.getRecentLogs()),
		// The lossless counterpart for the leak oracles: the rolling window above can evict a line between two probes,
		// so the secrecy sweeps read the session tee through a cursor instead.
		vscode.commands.registerCommand("litellm._test.getSessionLogs", (cursor: unknown) =>
			sessionLogs.readSince(typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0)
		),
		vscode.commands.registerCommand("litellm._test.getLatestError", () => issueReporter.getLatestError()),
		vscode.commands.registerCommand(
			"litellm._test.setServerSecret",
			(label: string, field: string, value: string | undefined) => {
				// Loud on junk: a typoed field silently no-oping would let a suite pass while testing nothing.
				if (!(SECRET_FIELD_IDS as readonly string[]).includes(field)) {
					throw new Error(`Unknown secret field: ${field}`);
				}
				// Stamped like the palette when the label resolves to a declared entry; a secret seeded before its
				// entry is declared writes unstamped and resolves anywhere, like a pre-stamping blob.
				const entry = acceptedEntry(
					vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY),
					label
				)?.entry;
				const owner = entry !== undefined ? secretDestination(entry, field as SecretFieldId) : undefined;
				return updateServerSecret(context.secrets, label, field as SecretFieldId, value, owner);
			}
		),
		vscode.commands.registerCommand("litellm._test.getDeclaredServers", () => syncEngine.getDeclared()),
		// The group serving path is otherwise host-invoked only. The typed destructure strips the litellm attachment
		// (the served group's identity and model metadata), so a rename of that field breaks the compile here instead
		// of leaking it.
		//
		//   the args the engine would build NOW -> can differ from what the add-only host stored at group creation
		//   non-silent                           -> a discovery failure serves the declared set or throws, like Test
		//                                           Connection
		vscode.commands.registerCommand("litellm._test.refreshEntryModels", async (label: string) => {
			const configuration = await syncEngine.resolveGroupArgs(label);
			if (configuration === undefined) {
				throw new Error(`No declared server entry labeled "${label}"`);
			}
			const infos = await provider.provideLanguageModelChatInformation(
				{ silent: false, configuration },
				new vscode.CancellationTokenSource().token
			);
			return infos.map(({ litellm: _litellm, ...registration }) => registration);
		}),
		// The status window's statuses, for suites that must observe what the host's per-group calls delivered.
		vscode.commands.registerCommand("litellm._test.getServerStatuses", () =>
			provider.getServerSnapshots().map((snapshot) => snapshot.status)
		),
		// The monkey fuzzer's intent injection: the raw payload runs through the panel's actual webview-message path,
		// validation included.
		vscode.commands.registerCommand("litellm._test.dashboardMessage", async (raw: unknown) => {
			await vscode.commands.executeCommand(CMD.openDashboard);
			return dashboard.injectMessageForTest(raw);
		}),
		// SecretStorage has no enumeration API, so secret keys stay out of reach here.
		vscode.commands.registerCommand("litellm._test.getStorageKeys", () => [...context.globalState.keys()])
	);
}

/**
 * A sequence-numbered tee of the session's issue-report log lines and error snapshots, wrapped around the production
 * recorder in non-production mode only. The production buffer is a small rolling window, so a busy sync burst can evict
 * a line between two probes of a test's leak scan; readSince gives suites a lossless read instead, and reports how many
 * lines a lagging cursor lost to eviction so an overflow fails loudly.
 *
 *   Eviction retires a chunk at a time -> the array shift amortizes
 */
export class SessionLogTee implements ErrorRecorder {
	private static readonly MAX_LINES = 250000;
	private static readonly EVICT_CHUNK = 25000;
	private readonly lines: string[] = [];
	/** The sequence number of lines[0]; grows as evictions retire old lines. */
	private firstSeq = 0;

	constructor(private readonly inner: ErrorRecorder) {}

	appendLog(line: string): void {
		this.push(line);
	}

	recordError(source: string, error: RecordedError): void {
		this.inner.recordError(source, error);
		// The reporter's latest-error slot is last-write-wins, so a snapshot overwritten between two reads would escape
		// a scan of the slot; every snapshot's public rendering joins the line stream instead. Self-contained on
		// purpose - it must not rely on the caller also having appended a message line.
		this.push(`[error] ${source}: ${error.message}${error.stack === undefined ? "" : `\n${error.stack}`}`);
	}

	private push(line: string): void {
		this.lines.push(line);
		if (this.lines.length > SessionLogTee.MAX_LINES) {
			this.lines.splice(0, SessionLogTee.EVICT_CHUNK);
			this.firstSeq += SessionLogTee.EVICT_CHUNK;
		}
	}

	/**
	 *   A cursor past the end means the reader outlived this tee -> everything live is returned and the evicted
	 *       prefix reported
	 */
	readSince(cursor: number): { next: number; lines: string[]; dropped: number } {
		const end = this.firstSeq + this.lines.length;
		const stale = cursor > end;
		const start = stale ? this.firstSeq : Math.max(cursor, this.firstSeq);
		return {
			next: end,
			lines: this.lines.slice(start - this.firstSeq),
			dropped: stale ? this.firstSeq : Math.max(0, this.firstSeq - cursor),
		};
	}
}
