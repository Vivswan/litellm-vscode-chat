import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { FeatureId } from "../../shared/config/settingSpec";
import { FEATURE_IDS } from "../../shared/config/settingSpec";
import { LAST_ISSUE_REPORT_KEY } from "../../shared/config/storageKeys";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import { Logger, type RecordedError } from "../../shared/logger";
import { GITHUB_REPO_URL } from "../../shared/util/links";
import { openUrl } from "../../shared/util/openUrl";
import { copyToClipboard } from "./clipboard";
import { showMessage } from "./notifier";

const MAX_URL_LENGTH = 8000;
const COMPACT_STACK_LINES = 8;

export interface ErrorContext {
	source: string;
	message: string;
	stack?: string | undefined;
	timestamp: string;
	/**
	 * Classification only - enum ids and a status number, never message text - so triage can read the cause without
	 * the body.
	 */
	classification?: TransportErrorClassification | undefined;
}

/** One feature's report facts: the opt-in and whether a model ref is set - flags only, never which model or label. */
interface FeatureFlagFacts {
	readonly enabled: boolean;
	/** Absent for features with no model key (the chat participant uses the request's own model). */
	readonly modelConfigured?: boolean | undefined;
}

export interface DiagnosticsSnapshot {
	extensionVersion: string;
	vscodeVersion: string;
	platform: string;
	connectionState: string;
	modelCount?: number | undefined;
	apiKeyConfigured: boolean | "unknown";
	baseUrlConfigured: boolean;
	featureFlags: Readonly<Record<FeatureId, FeatureFlagFacts>>;
	/**
	 *   the MCP opt-in is a per-entry field rather than a FeatureId -> it cannot ride featureFlags
	 */
	mcpEntryCount: number;
	latestError?: ErrorContext | undefined;
	recentLogs: string[];
}

/**
 * English by the issue-report policy, and total over FeatureId so a new feature cannot ship without its report line.
 */
const FEATURE_PROSE_NAMES: Readonly<Record<FeatureId, string>> = {
	inlineCompletions: "Inline completions",
	commitGeneration: "Commit generation",
	prGeneration: "PR generation",
	consultTool: "Consult tool",
	quickFix: "Quick fix",
	reviewComments: "Review comments",
	chatParticipant: "Chat participant",
	agentTools: "Agent tools",
};

/**
 * The feature lines of a report body, one loop for every body variant: the enable line always, the model line where
 * the feature has a model key. `include` narrows the walk for the compacted clipboard fallback, which exists because
 * even the trimmed body blew the URL bound - features carrying no signal stay out of it.
 */
function featureFlagLines(
	flags: Readonly<Record<FeatureId, FeatureFlagFacts>>,
	include: (facts: FeatureFlagFacts) => boolean = () => true
): string[] {
	return FEATURE_IDS.flatMap((feature) => {
		const facts = flags[feature];
		if (!include(facts)) {
			return [];
		}
		const name = FEATURE_PROSE_NAMES[feature];
		const lines = [`- ${name} enabled: ${facts.enabled ? "yes" : "no"}`];
		if (facts.modelConfigured !== undefined) {
			lines.push(`- ${name} model configured: ${facts.modelConfigured ? "yes" : "no"}`);
		}
		return lines;
	});
}

function apiKeyConfiguredText(snapshot: DiagnosticsSnapshot): string {
	if (snapshot.apiKeyConfigured === "unknown") {
		return "Unknown (key presence not yet determined)";
	}
	return snapshot.apiKeyConfigured ? "yes" : "no";
}

export interface LastIssueReport {
	fingerprint: string;
	/** Epoch milliseconds. */
	openedAt: number;
}

/**
 * Deliberately NEVER the error message, stack, source, or log lines - the source strings interpolate server labels and
 * base URLs, and the rest is response-derived - because this string lands in globalState.
 */
export function reportFingerprint(snapshot: DiagnosticsSnapshot): string {
	const classification = snapshot.latestError?.classification;
	return [
		"v3",
		snapshot.extensionVersion,
		snapshot.connectionState,
		snapshot.modelCount ?? "-",
		String(snapshot.apiKeyConfigured),
		String(snapshot.baseUrlConfigured),
		String(snapshot.mcpEntryCount),
		...FEATURE_IDS.flatMap((feature) => {
			const facts = snapshot.featureFlags[feature];
			return [String(facts.enabled), String(facts.modelConfigured ?? "-")];
		}),
		classification?.kind ?? "-",
		classification?.status ?? "-",
		classification?.setupHint ?? "-",
	].join("|");
}

/** The persisted ledger, or undefined when absent or junk (globalState is untrusted on read). */
export function readLastIssueReport(state: vscode.Memento): LastIssueReport | undefined {
	const raw = state.get<unknown>(LAST_ISSUE_REPORT_KEY);
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const { fingerprint, openedAt } = raw as Record<string, unknown>;
	if (typeof fingerprint !== "string" || typeof openedAt !== "number" || !Number.isFinite(openedAt)) {
		return undefined;
	}
	return { fingerprint, openedAt };
}

export async function rememberIssueReport(state: vscode.Memento, report: LastIssueReport): Promise<void> {
	await state.update(LAST_ISSUE_REPORT_KEY, report);
}

/** "unknown" is the plain buildIssueUrl path: nothing gets copied anywhere, so the hint promises nothing. */
type CompactedDiagnosticsSink = "clipboard" | "clipboard-and-file" | "unknown";

const SINK_TEXT: Record<CompactedDiagnosticsSink, { hint: string; action: string }> = {
	"clipboard-and-file": {
		hint: "full diagnostics copied to clipboard and saved to a diagnostics file",
		action: "Please attach the generated file or paste the contents here.",
	},
	clipboard: {
		hint: "full diagnostics copied to clipboard",
		action: "Please paste the copied contents here.",
	},
	unknown: {
		hint: "full diagnostics omitted from URL",
		action: "Please add the full diagnostics separately.",
	},
};

/** "compact-logs" also compacts the stack and always omits at least one line. */
type BodyVariant =
	| { kind: "full" }
	| { kind: "compact-stack"; hint: string }
	| { kind: "compact-logs"; hint: string; omittedLogCount: number };

interface IssuePayload {
	url: string;
	fullBody: string;
	compacted: boolean;
}

export interface IssueReporterEnv {
	writeClipboard(text: string): PromiseLike<void>;
	openExternal(url: string): PromiseLike<void>;
	saveDiagnosticsFile?(contents: string): PromiseLike<vscode.Uri>;
	showCompactedDiagnosticsMessage?(diagnosticsFile?: vscode.Uri): PromiseLike<void>;
}

const defaultIssueReporterEnv: IssueReporterEnv = {
	writeClipboard: copyToClipboard,
	openExternal: openUrl,
	showCompactedDiagnosticsMessage: async () => {
		await showMessage(
			"info",
			l10n.t(
				"LiteLLM: Full diagnostics were too large to prefill in GitHub and were copied to your clipboard. Please paste them into the issue."
			),
			[]
		);
	},
};

export function createIssueReporterEnv(diagnosticsDirectory: vscode.Uri): IssueReporterEnv {
	return {
		...defaultIssueReporterEnv,
		saveDiagnosticsFile: async (contents) => {
			const directory = vscode.Uri.joinPath(diagnosticsDirectory, "issue-diagnostics");
			await vscode.workspace.fs.createDirectory(directory);
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const file = vscode.Uri.joinPath(directory, `litellm-diagnostics-${timestamp}.md`);
			await vscode.workspace.fs.writeFile(file, Buffer.from(contents, "utf8"));

			const document = await vscode.workspace.openTextDocument(file);
			await vscode.window.showTextDocument(document, { preview: false });
			return file;
		},
		showCompactedDiagnosticsMessage: async (diagnosticsFile) => {
			const revealFile = l10n.t("Reveal File");
			const choice = await showMessage(
				"info",
				diagnosticsFile
					? l10n.t(
							"LiteLLM: Full diagnostics were saved to a redacted log file and copied to your clipboard. Attach the file to the GitHub issue or paste the contents."
						)
					: l10n.t(
							"LiteLLM: Full diagnostics were too large to prefill in GitHub and were copied to your clipboard. Please paste them into the issue."
						),
				diagnosticsFile ? [revealFile] : []
			);

			if (choice === revealFile && diagnosticsFile) {
				await vscode.commands.executeCommand("revealFileInOS", diagnosticsFile);
			}
		},
	};
}

export class IssueReporter {
	private _latestError?: ErrorContext;

	/** `recentLogs` is the Logger's history (Logger.reportLines), the one record of what the channel showed. */
	constructor(
		private readonly env: IssueReporterEnv = defaultIssueReporterEnv,
		private readonly recentLogs: () => readonly string[] = () => []
	) {}

	/**
	 * Every string of the snapshot through the one output door, once and whole before any split, cut, or compaction
	 * (a value may span lines). The report redacts nothing else: hosts, paths, and account names stay.
	 */
	private redacted(snapshot: DiagnosticsSnapshot): DiagnosticsSnapshot {
		const redact = Logger.redact;
		const error = snapshot.latestError;
		return {
			...snapshot,
			extensionVersion: redact(snapshot.extensionVersion),
			vscodeVersion: redact(snapshot.vscodeVersion),
			platform: redact(snapshot.platform),
			connectionState: redact(snapshot.connectionState),
			recentLogs: snapshot.recentLogs.map(redact),
			latestError:
				error === undefined
					? undefined
					: {
							...error,
							source: redact(error.source),
							message: redact(error.message),
							timestamp: redact(error.timestamp),
							...(error.stack !== undefined ? { stack: redact(error.stack) } : {}),
						},
		};
	}

	recordError(source: string, error: RecordedError): void {
		this._latestError = {
			source,
			message: error.message,
			stack: error.stack,
			timestamp: new Date().toISOString(),
			...(error.classification !== undefined ? { classification: error.classification } : {}),
		};
	}

	getLatestError(): ErrorContext | undefined {
		return this._latestError;
	}

	getRecentLogs(): string[] {
		return [...this.recentLogs()];
	}

	buildIssueUrl(snapshot: DiagnosticsSnapshot): string {
		return this.buildIssuePayload(snapshot).url;
	}

	buildTitle(rawSnapshot: DiagnosticsSnapshot): string {
		return titleOf(this.redacted(rawSnapshot));
	}

	buildBody(rawSnapshot: DiagnosticsSnapshot, variant: BodyVariant = { kind: "full" }): string {
		return bodyOf(this.redacted(rawSnapshot), variant);
	}

	async openIssue(snapshot: DiagnosticsSnapshot): Promise<void> {
		const sink: CompactedDiagnosticsSink = this.env.saveDiagnosticsFile ? "clipboard-and-file" : "clipboard";
		const payload = this.buildIssuePayload(snapshot, sink);
		let diagnosticsFile: vscode.Uri | undefined;

		if (payload.compacted) {
			await this.env.writeClipboard(payload.fullBody);
			diagnosticsFile = await this.env.saveDiagnosticsFile?.(payload.fullBody);
		}

		await this.env.openExternal(payload.url);

		if (payload.compacted) {
			void this.env.showCompactedDiagnosticsMessage?.(diagnosticsFile);
		}
	}

	private buildIssuePayload(
		rawSnapshot: DiagnosticsSnapshot,
		sink: CompactedDiagnosticsSink = "unknown"
	): IssuePayload {
		const snapshot = this.redacted(rawSnapshot);
		const { hint } = SINK_TEXT[sink];
		const title = titleOf(snapshot);
		const fullBody = bodyOf(snapshot, { kind: "full" });
		const fullUrl = createIssueUrl(title, fullBody);
		if (fullUrl.length <= MAX_URL_LENGTH) {
			return { url: fullUrl, fullBody, compacted: false };
		}

		const compactStackBody = bodyOf(snapshot, { kind: "compact-stack", hint });
		const compactStackUrl = createIssueUrl(title, compactStackBody);
		if (compactStackUrl.length <= MAX_URL_LENGTH) {
			return { url: compactStackUrl, fullBody, compacted: true };
		}

		for (let omitted = 1; omitted <= snapshot.recentLogs.length; omitted++) {
			const body = bodyOf(snapshot, { kind: "compact-logs", hint, omittedLogCount: omitted });
			const url = createIssueUrl(title, body);
			if (url.length <= MAX_URL_LENGTH) {
				return { url, fullBody, compacted: true };
			}
		}

		const fallbackBody = buildClipboardFallbackBody(snapshot, sink);
		return {
			url: createIssueUrl(title, fallbackBody),
			fullBody,
			compacted: true,
		};
	}
}

/** `snapshot` is the redacted one (IssueReporter.redacted); nothing below masks again. */
function titleOf(snapshot: DiagnosticsSnapshot): string {
	const { latestError } = snapshot;
	if (latestError) {
		const firstLine = (latestError.message.split("\n")[0] ?? "").slice(0, 80);
		return `[Bug] ${latestError.source}: ${firstLine}`;
	}
	return "[Bug] Issue report from diagnostics";
}

function bodyOf(snapshot: DiagnosticsSnapshot, variant: BodyVariant): string {
	const sections: string[] = [];
	const recentLogs =
		variant.kind === "compact-logs" ? snapshot.recentLogs.slice(variant.omittedLogCount) : snapshot.recentLogs;

	sections.push("## What happened\n\n<!-- Describe what happened -->\n");
	sections.push("## Expected behavior\n\n<!-- What did you expect to happen? -->\n");
	sections.push("## Steps to reproduce\n\n1. \n2. \n3. \n");

	sections.push(
		[
			"## Environment",
			"",
			`- Extension version: ${snapshot.extensionVersion}`,
			`- VS Code version: ${snapshot.vscodeVersion}`,
			`- Platform: ${snapshot.platform}`,
			"",
		].join("\n")
	);

	const diagLines = [
		"## Diagnostics",
		"",
		`- Connection state: ${snapshot.connectionState}`,
		snapshot.modelCount !== undefined ? `- Model count: ${snapshot.modelCount}` : null,
		`- API key configured: ${apiKeyConfiguredText(snapshot)}`,
		`- Base URL configured: ${snapshot.baseUrlConfigured ? "yes" : "no"}`,
		`- MCP-enabled server entries: ${snapshot.mcpEntryCount}`,
		...featureFlagLines(snapshot.featureFlags),
	].filter((l): l is string => l !== null);

	if (snapshot.latestError) {
		diagLines.push(...latestErrorLines(snapshot.latestError));
		diagLines.push(`- Message: ${bulletContinuation(snapshot.latestError.message)}`);
	}
	diagLines.push("");
	sections.push(diagLines.join("\n"));

	if (recentLogs.length > 0 || variant.kind === "compact-logs") {
		const logLines = [...recentLogs];
		if (variant.kind === "compact-logs") {
			const omitted = variant.omittedLogCount;
			logLines.unshift(`... (${omitted} older log line${omitted === 1 ? "" : "s"} omitted; ${variant.hint})`);
		}
		sections.push(
			[
				"## Recent logs",
				"",
				"<details><summary>Last log entries</summary>",
				"",
				"```",
				...logLines,
				"```",
				"",
				"</details>",
				"",
			].join("\n")
		);
	}

	if (snapshot.latestError?.stack) {
		const { stack } = snapshot.latestError;
		sections.push(
			[
				`<details><summary>${variant.kind === "full" ? "Stack trace" : "Stack trace (trimmed)"}</summary>`,
				"",
				"```",
				variant.kind === "full" ? stack : compactStack(stack, variant.hint),
				"```",
				"",
				"</details>",
				"",
			].join("\n")
		);
	}

	return sections.join("\n");
}

/**
 * The Latest-error section's cause line: enum ids and an integer only, English by policy (the issue body is diagnostics
 * text), never anything response-derived.
 */
function classificationLine(classification: TransportErrorClassification): string {
	const status = classification.status !== undefined ? ` ${classification.status}` : "";
	const setupHint = classification.setupHint !== undefined ? ` (${classification.setupHint})` : "";
	return `- Classification: ${classification.kind}${status}${setupHint}`;
}

function latestErrorLines(error: ErrorContext): string[] {
	return [
		"",
		"### Latest error",
		"",
		`- Source: ${error.source}`,
		`- Time: ${error.timestamp}`,
		...(error.classification !== undefined ? [classificationLine(error.classification)] : []),
	];
}

/**
 * A multi-line message kept inside one markdown list item: blank lines are dropped and continuation lines indented,
 * because a blank line would end the list and spill the detail out of the bullet.
 */
function bulletContinuation(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.join("\n  ");
}

function createIssueUrl(title: string, body: string): string {
	const params = new URLSearchParams({
		labels: "bug",
		title,
		body,
	});

	return `${GITHUB_REPO_URL}/issues/new?${params.toString()}`;
}

function compactStack(stack: string, hint: string): string {
	const lines = stack.split(/\r?\n/);
	if (lines.length <= COMPACT_STACK_LINES) {
		return stack;
	}

	const omitted = lines.length - COMPACT_STACK_LINES;
	return [
		...lines.slice(0, COMPACT_STACK_LINES),
		`... (${omitted} stack line${omitted === 1 ? "" : "s"} omitted; ${hint})`,
	].join("\n");
}

function buildClipboardFallbackBody(snapshot: DiagnosticsSnapshot, sink: CompactedDiagnosticsSink): string {
	const { hint, action } = SINK_TEXT[sink];
	const lines = [
		"## What happened",
		"",
		"<!-- Describe what happened -->",
		"",
		"## Diagnostics",
		"",
		`- Connection state: ${snapshot.connectionState}`,
		snapshot.modelCount !== undefined ? `- Model count: ${snapshot.modelCount}` : null,
		`- API key configured: ${apiKeyConfiguredText(snapshot)}`,
		`- Base URL configured: ${snapshot.baseUrlConfigured ? "yes" : "no"}`,
		//   the full one blew the URL bound -> Signal-bearing features only
		...featureFlagLines(snapshot.featureFlags, (facts) => facts.enabled || facts.modelConfigured === true),
	];

	if (snapshot.latestError) {
		lines.push(...latestErrorLines(snapshot.latestError));
		lines.push(`- Message: ${shortenLine(snapshot.latestError.message.split(/\r?\n/)[0] ?? "", 500)}`);
	}

	lines.push("", `Full redacted diagnostics were too large to prefill in GitHub. ${capitalizeFirst(hint)}. ${action}`);

	return lines.filter((line): line is string => line !== null).join("\n");
}

function capitalizeFirst(text: string): string {
	return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function shortenLine(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}

	return `${text.slice(0, maxLength)}...`;
}
