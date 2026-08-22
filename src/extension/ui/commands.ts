import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { LiteLLMModelInfo } from "../../provider/catalog/groupModels";
import type { OneShotClient } from "../../provider/transport/oneShotClient";
import { CMD, INTERNAL_CMD } from "../../shared/config/commandIds";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import type { ErrorRecorder, Logger } from "../../shared/logger";
import { publicErrorStack, publicErrorText } from "../../shared/logger";
import type { SecretFieldId } from "../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../shared/serverEntry";
import type { ServerStatus } from "../../shared/servers";
import { unexpectedFailureCount } from "../../shared/servers";
import { GITHUB_DOCS_URL, GITHUB_REPO_URL } from "../../shared/util/links";
import { openUrl } from "../../shared/util/openUrl";
import type { DashboardController } from "../dashboard/panel";
import type { GenerateCommitDeps } from "../scm/generateCommitCommand";
import { runGenerateCommitMessage } from "../scm/generateCommitCommand";
import type { ServerRegistry } from "../servers/serverRegistry";
import type { ServerSyncEngine } from "../servers/serverSync";
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
	statusErrorHeadline,
	viewOutputAction,
} from "./notifier";
import { profileUserFileUri } from "./profilePath";
import { detectSetupProblem, showSetupProblemGate } from "./setupGate";
import type { ConnectionStatus, ZeroModelTexts } from "./status";
import { zeroModelJudgment } from "./status";

const GITHUB_NEW_ISSUE_FEATURE = `${GITHUB_REPO_URL}/issues/new?labels=enhancement&title=%5BFeature%5D+`;

interface ModelInfoProvider {
	provideLanguageModelChatInformation(
		options: { silent: boolean; configuration?: Record<string, string> },
		token: vscode.CancellationToken
	): Promise<LiteLLMModelInfo[]>;
}

/**
 * The extra slice the test commands read: the live status window, so suites
 * can observe what the host's per-group calls actually delivered.
 */
interface StatusSnapshotProvider {
	getServerSnapshots(): ReadonlyArray<{ readonly status: ServerStatus }>;
}

/**
 * refreshViaHost drops the provider's discovery cache before asking the host
 * to re-resolve, so every group is fetched over the network.
 */
interface HostRefreshableProvider {
	refreshViaHost(): Promise<void>;
}

interface ConnectionTestableProvider extends ModelInfoProvider, HostRefreshableProvider {}

/**
 * The toast for the synthetic zero-model verdict, shared by the connection
 * test and the model sync: warning-grade like every other surface of this
 * judgment (bar, hero, notifier), the verdict text already names the cause and
 * the recovery, so the "Connection failed"/"sync failed" framing must not wrap
 * it, and a hidden group earns the Open Dashboard label - the restore lives in
 * the dashboard's server list.
 */
function showZeroModelOutcomeToast(zero: ZeroModelTexts, outputChannel: vscode.OutputChannel): void {
	void showActionableMessage("warning", l10n.t("LiteLLM: {0}", zero.display), [
		viewOutputAction(outputChannel),
		zero.hiddenCount > 0 ? reconfigureAction(l10n.t("Open Dashboard")) : reconfigureAction(),
		reportIssueAction(),
	]);
}

interface StatusBarLike {
	readonly connectionStatus: ConnectionStatus;
	updateStatusBar(status?: ConnectionStatus): Promise<void>;
}

// A second invocation while one test is mid-flight would capture "loading" as
// the pre-test status and misreport; it is refused instead.
let connectionTestRunning = false;
/**
 * The sync in flight, if any - the PROMISE, not a boolean. A second invocation
 * mid-run must not start a second pass: it would clear the provider's
 * discovery cache under the refresh already running and report a half-settled
 * status. Handing the second caller the first caller's promise refuses the
 * duplicate pass and still tells the truth about when the work finished (the
 * dashboard's Retry waits on the answer).
 */
let modelSyncInFlight: Promise<void> | undefined;

/**
 * Trigger a non-silent refresh, ask the host to re-resolve every provider
 * group, and report from the connection status all of that left behind. The
 * status, not any returned model list, is the source of truth: the host owns
 * the per-group fetches, so the direct refresh alone proves nothing.
 */
export async function runConnectionTest(
	provider: ConnectionTestableProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger
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
		try {
			await statusBar.updateStatusBar({ state: "loading" });
			await provider.provideLanguageModelChatInformation({ silent: false }, new vscode.CancellationTokenSource().token);
		} catch (error) {
			// The failing refresh already reported an error status; the toast below reads it.
			logger.error("Connection test failed", error);
		}
		try {
			await provider.refreshViaHost();
		} catch (error) {
			logger.error("Provider-group connection test failed", error);
		}

		let status = statusBar.connectionStatus;
		if (status.state === "loading") {
			await statusBar.updateStatusBar(previous);
			status = previous;
		}

		switch (status.state) {
			case "connected": {
				// The shared zero-model judgment: connected-with-nothing-to-serve is
				// a warning here exactly like the bar and the notifier.
				const zero = zeroModelJudgment(status.serverStatuses, status.totalModels);
				if (zero !== undefined) {
					logger.log(`Connection test finished with 0 models: ${zero.logSafe}`);
					showZeroModelOutcomeToast(zero, outputChannel);
					break;
				}
				const count = status.totalModels;
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
				// The shared unexpected-failure count: expected failures stay out,
				// the same reading of the same window as the status bar tooltip.
				const failed = unexpectedFailureCount(status.serverStatuses);
				logger.log(`WARNING: ${failed} server(s) failing`);
				const total = status.totalModels;
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
				// The toast carries the transport headline verbatim (it already
				// says what to do); a classified failure only adds the docs action.
				void showActionableMessage(
					"error",
					l10n.t("LiteLLM: Connection failed - {0}", statusErrorHeadline(status.error)),
					commandErrorActions(status.classification, outputChannel)
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
				void showActionableMessage(
					"warning",
					l10n.t("LiteLLM: Connection status is unavailable; try again in a moment."),
					[viewOutputAction(outputChannel)]
				);
		}
	} finally {
		connectionTestRunning = false;
	}
}

export function registerTestConnectionCommand(
	context: vscode.ExtensionContext,
	provider: ConnectionTestableProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.testConnection, () =>
			runConnectionTest(provider, statusBar, outputChannel, logger)
		),
		// The dashboard Diagnostics tab's Open-output-log action. Registered here
		// because this registration already holds the output channel.
		vscode.commands.registerCommand(INTERNAL_CMD.openOutput, () => outputChannel.show())
	);
}

/**
 * Force-refresh every model list: discovery results are normally cached (see
 * the discovery.cacheTtl setting), and this is the user's way to skip the
 * cache. The outcome is read from the connection status the refresh left
 * behind, like the connection test.
 */
export async function runModelSync(
	provider: HostRefreshableProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger
): Promise<void> {
	// Already running: join it rather than starting a second pass, so this
	// caller's answer still means "a sync finished".
	const running = modelSyncInFlight;
	if (running !== undefined) {
		logger.log("A model sync is already running; joining it");
		return running;
	}
	const pass = runModelSyncPass(provider, statusBar, outputChannel, logger);
	modelSyncInFlight = pass;
	try {
		await pass;
	} finally {
		modelSyncInFlight = undefined;
	}
}

/** One sync pass, without the re-entrancy guard: every caller reaches it through runModelSync. */
async function runModelSyncPass(
	provider: HostRefreshableProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger
): Promise<void> {
	{
		logger.log("Syncing models: refreshing every provider group over the network");
		try {
			await provider.refreshViaHost();
		} catch (error) {
			// The failing refresh already reported an error status; the toast below reads it.
			logger.error("Model sync failed", error);
		}

		const status = statusBar.connectionStatus;
		switch (status.state) {
			case "connected": {
				// The same warning-grade zero-model treatment as the connection test.
				const zero = zeroModelJudgment(status.serverStatuses, status.totalModels);
				if (zero !== undefined) {
					logger.log(`Model sync finished with 0 models: ${zero.logSafe}`);
					showZeroModelOutcomeToast(zero, outputChannel);
					break;
				}
				const count = status.totalModels;
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
				// The same shared unexpected-failure count as the connection test's
				// toast and the status bar tooltip.
				const failed = unexpectedFailureCount(status.serverStatuses);
				logger.log(`Model sync finished with issues: ${failed} server(s) failing`);
				const total = status.totalModels;
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
				// logSafeError, never error: this line lands in the issue-report
				// buffer. Same headline-only classification treatment as the
				// connection test's error toast.
				logger.log(`Model sync failed: ${status.logSafeError}`);
				void showActionableMessage(
					"error",
					l10n.t("LiteLLM: Model sync failed - {0}", statusErrorHeadline(status.error)),
					commandErrorActions(status.classification, outputChannel)
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
				void showActionableMessage(
					"warning",
					l10n.t("LiteLLM: Connection status is unavailable; try again in a moment."),
					[viewOutputAction(outputChannel)]
				);
		}
	}
}

export function registerSyncModelsCommand(
	context: vscode.ExtensionContext,
	provider: HostRefreshableProvider,
	statusBar: StatusBarLike,
	outputChannel: vscode.OutputChannel,
	logger: Logger,
	/** Runs before the model refresh; the server sync engine reconciles provider groups here. */
	beforeSync?: () => Promise<void>
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.syncModels, async () => {
			await beforeSync?.();
			return runModelSync(provider, statusBar, outputChannel, logger);
		})
	);
}

/**
 * Build the diagnostics snapshot and open a prefilled GitHub issue, behind the
 * setup gate: when the connection status is setup-shaped (not configured, or
 * failed with a setup hint), the user first gets a non-modal offer of the
 * faster fix, and only Report Anyway opens the issue (snapshot built up front,
 * so the report shows what the gate judged).
 *
 * The pass-through path remembers each opened report's diagnostic fingerprint
 * and, when the next attempt fingerprints the same within the recency window,
 * interposes a modal repeat-report hint. A changed fingerprint proceeds
 * without it. The setup gate keeps precedence over the repeat hint.
 *
 * Neither dialog is awaited: the dashboard's executeCommand intent awaits this
 * command inside its serialized message chain, so an unanswered dialog would
 * freeze every subsequent dashboard message.
 */
export async function runReportIssue(
	registry: ServerRegistry,
	getConnectionStatus: () => ConnectionStatus,
	extVersion: string,
	vscodeVersion: string,
	issueReporter: IssueReporter,
	globalState: vscode.Memento
): Promise<void> {
	const connectionStatus = getConnectionStatus();
	const snapshot = await buildDiagnosticsSnapshot(registry, connectionStatus, extVersion, vscodeVersion, issueReporter);
	const fingerprint = reportFingerprint(snapshot);
	const openIssue = async () => {
		await issueReporter.openIssue(snapshot);
		try {
			await rememberIssueReport(globalState, { fingerprint, openedAt: Date.now() });
		} catch {
			// The ledger is advisory: the issue is already open, and a failed
			// write only loses the next repeat hint.
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
		// Negative elapsed (a clock rollback or corrupt timestamp) counts as
		// expired: fail open toward reporting rather than prompting forever.
		if (elapsed >= 0 && elapsed <= REPEAT_REPORT_WINDOW_MS) {
			void showRepeatReportHint(elapsed, openIssue);
			return;
		}
	}
	await openIssue();
}

/** How long an opened report's fingerprint keeps triggering the repeat hint. */
const REPEAT_REPORT_WINDOW_MS = 72 * 60 * 60 * 1000;

/** The repo's open issues carrying the reporter template's label ("bug", see createIssueUrl). */
const GITHUB_OPEN_BUG_ISSUES_URL = `${GITHUB_REPO_URL}/issues?q=${encodeURIComponent("is:issue is:open label:bug")}`;

/** "{0} hours ago" for the repeat hint; coarse buckets are enough for a 72-hour window. */
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
 * The repeat-report hint: modal, because the user is one click from filing a
 * public duplicate. Dismissal aborts silently; Report Anyway proceeds exactly
 * as an unprompted report and refreshes the stored fingerprint. Callers void
 * the returned promise, so a failing report must surface here rather than die
 * as an unhandled rejection.
 */
async function showRepeatReportHint(elapsedMs: number, reportAnyway: () => Promise<void>): Promise<void> {
	const openExisting = l10n.t("Open Existing Issues");
	const reportAnywayLabel = l10n.t("Report Anyway");
	const choice = await vscode.window.showInformationMessage(
		l10n.t(
			"LiteLLM: You opened an issue report that looks the same as one from {0}. Adding details to the existing issue helps more than a new report.",
			relativeTimeText(elapsedMs)
		),
		{ modal: true },
		openExisting,
		reportAnywayLabel
	);
	if (choice === openExisting) {
		try {
			await openUrl(GITHUB_OPEN_BUG_ISSUES_URL);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(l10n.t("LiteLLM: Could not open the issues list - {0}", detail));
		}
		return;
	}
	if (choice === reportAnywayLabel) {
		try {
			await reportAnyway();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(l10n.t("LiteLLM: Could not open the issue report - {0}", detail));
		}
	}
}

export function registerReportIssueCommand(
	context: vscode.ExtensionContext,
	registry: ServerRegistry,
	getConnectionStatus: () => ConnectionStatus,
	extVersion: string,
	vscodeVersion: string,
	issueReporter: IssueReporter
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.reportIssue, () =>
			runReportIssue(registry, getConnectionStatus, extVersion, vscodeVersion, issueReporter, context.globalState)
		)
	);
}

/** The host's provider-groups file, directly under the profile's User directory. */
const GROUPS_FILE_NAME = "chatLanguageModels.json";

/**
 * Open the host's provider-groups JSON in an editor tab: the one place a
 * leftover provider group can be deleted (VS Code offers no removal API).
 * Best-effort by necessity: VS Code exposes no API for this file, and a
 * profile configured to inherit its language models keeps the governing file
 * in another profile's directory. The failure toast covers both ways the open
 * can fail: the file does not exist yet, or this window cannot reach the
 * desktop profile that holds it. The log line stays classification-only: the
 * resolved path embeds the local user name and the log buffer feeds public
 * issue reports.
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
				void vscode.window.showErrorMessage(
					l10n.t(
						"LiteLLM: Could not open the provider groups file (User/{0}). It may not exist yet - VS Code creates it with the first provider group - or it lives on the desktop profile, out of reach of this window.",
						GROUPS_FILE_NAME
					)
				);
			}
		})
	);
}

export function registerHelpAndFeedbackCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.helpAndFeedback, async () => {
			// Each entry carries its own action, so a new entry cannot be added
			// without saying what it does.
			const choice = await vscode.window.showQuickPick(
				[
					{ label: l10n.t("$(bug) Report Bug"), run: () => vscode.commands.executeCommand(CMD.reportIssue) },
					{ label: l10n.t("$(lightbulb) Request Feature"), run: () => openUrl(GITHUB_NEW_ISSUE_FEATURE) },
					{ label: l10n.t("$(book) Documentation"), run: () => openUrl(GITHUB_DOCS_URL) },
				],
				{ title: l10n.t("LiteLLM: Help & Feedback"), placeHolder: l10n.t("What would you like to do?") }
			);
			await choice?.run();
		})
	);
}

/**
 * Commit message generation: the handler is registered unconditionally (the
 * SCM-title and palette surfaces hide behind the enable when-clause, but
 * executeCommand and keybindings do not), and the run function answers a
 * disabled invocation with the enable hint.
 */
export function registerGenerateCommitMessageCommand(
	context: vscode.ExtensionContext,
	oneShot: OneShotClient,
	deps: GenerateCommitDeps
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.generateCommitMessage, (commandArg?: unknown) =>
			runGenerateCommitMessage(oneShot, deps, commandArg)
		)
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
		// Observability commands. getRecentLogs is the production
		// classification-only buffer that feeds public issue reports.
		// getDeclaredServers returns the sync engine's views, which carry secret
		// locations but no secret values by construction.
		vscode.commands.registerCommand("litellm._test.getRecentLogs", () => issueReporter.getRecentLogs()),
		// The lossless counterpart for the leak oracles: the rolling window above
		// can evict a line between two probes, so the secrecy sweeps read the
		// session tee through a cursor instead.
		vscode.commands.registerCommand("litellm._test.getSessionLogs", (cursor: unknown) =>
			sessionLogs.readSince(typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0)
		),
		vscode.commands.registerCommand("litellm._test.getLatestError", () => issueReporter.getLatestError()),
		vscode.commands.registerCommand(
			"litellm._test.setServerSecret",
			(label: string, field: string, value: string | undefined) => {
				// Loud on junk: a typoed field silently no-oping would let a suite
				// pass while testing nothing.
				if (!(SECRET_FIELD_IDS as readonly string[]).includes(field)) {
					throw new Error(`Unknown secret field: ${field}`);
				}
				// Stamped like the palette when the label resolves to a declared
				// entry; a secret seeded before its entry is declared writes
				// unstamped and resolves anywhere, like a pre-stamping blob.
				const entry = acceptedEntry(
					vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY),
					label
				)?.entry;
				const owner = entry !== undefined ? secretDestination(entry, field as SecretFieldId) : undefined;
				return updateServerSecret(context.secrets, label, field as SecretFieldId, value, owner);
			}
		),
		vscode.commands.registerCommand("litellm._test.getDeclaredServers", () => syncEngine.getDeclared()),
		// The group serving path is otherwise host-invoked only. Suites asserting
		// what a DECLARED entry registers drive it here: the configuration
		// resolves through the sync engine's own parse and secrets read - the
		// args the engine would build NOW, which can differ from what the
		// add-only host stored at group creation - and goes down the real group
		// path, non-silent so discovery failures throw like Test Connection. The
		// typed destructure strips the litellm attachment, which embeds the
		// group's resolved credentials, so a rename of that field breaks the
		// compile here instead of silently leaking.
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
		// The status window's statuses, for suites that must observe what the
		// host's per-group calls delivered.
		vscode.commands.registerCommand("litellm._test.getServerStatuses", () =>
			provider.getServerSnapshots().map((snapshot) => snapshot.status)
		),
		// The monkey fuzzer's intent injection: the raw payload runs through the
		// panel's actual webview-message path, validation included.
		vscode.commands.registerCommand("litellm._test.dashboardMessage", async (raw: unknown) => {
			await vscode.commands.executeCommand(CMD.openDashboard);
			return dashboard.injectMessageForTest(raw);
		}),
		// Every Memento key the extension holds, checked against
		// shared/config/storageKeys.ts. SecretStorage has no enumeration API, so
		// secret keys stay out of reach here.
		vscode.commands.registerCommand("litellm._test.getStorageKeys", () => [...context.globalState.keys()])
	);
}

/**
 * A sequence-numbered tee of the session's issue-report log lines and error
 * snapshots, wrapped around the production recorder in non-production mode
 * only. The production buffer is a small rolling window, so a busy sync burst
 * can evict a line between two probes of a test's leak scan; readSince gives
 * suites a lossless read instead, and reports how many lines a lagging cursor
 * lost to eviction so an overflow fails loudly. MAX_LINES is the load-bearing
 * bound: it caps the LINE COUNT (not bytes) a whole docker-suite session can
 * reach. Eviction retires a chunk at a time so the array shift amortizes.
 */
export class SessionLogTee implements ErrorRecorder {
	private static readonly MAX_LINES = 250000;
	private static readonly EVICT_CHUNK = 25000;
	private readonly lines: string[] = [];
	/** The sequence number of lines[0]; grows as evictions retire old lines. */
	private firstSeq = 0;

	constructor(private readonly inner: ErrorRecorder) {}

	appendLog(line: string): void {
		this.inner.appendLog(line);
		this.push(line);
	}

	recordError(source: string, error: unknown): void {
		this.inner.recordError(source, error);
		// The reporter's latest-error slot is last-write-wins, so a snapshot
		// overwritten between two reads would escape a scan of the slot; every
		// snapshot's public rendering joins the line stream instead.
		// Self-contained on purpose - it must not rely on the caller also
		// having appended a message line.
		const stack = publicErrorStack(error);
		this.push(`[error] ${source}: ${publicErrorText(error)}${stack === undefined ? "" : `\n${stack}`}`);
	}

	private push(line: string): void {
		this.lines.push(line);
		if (this.lines.length > SessionLogTee.MAX_LINES) {
			this.lines.splice(0, SessionLogTee.EVICT_CHUNK);
			this.firstSeq += SessionLogTee.EVICT_CHUNK;
		}
	}

	/**
	 * Lines at sequence >= cursor, the next cursor, and how many lines the
	 * cursor missed to eviction. A cursor past the end means the reader
	 * outlived this tee: everything live is returned and the evicted prefix
	 * reported, so a stale cursor degrades loudly instead of skipping the new
	 * tee's early lines.
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
