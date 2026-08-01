import * as vscode from "vscode";
import { publicErrorStack, publicErrorText } from "../../shared/logger";
import { GITHUB_REPO_URL } from "../../shared/util/links";
import { openUrl } from "../../shared/util/openUrl";

const MAX_LOG_ENTRIES = 50;
const MAX_URL_LENGTH = 8000;
const COMPACT_STACK_LINES = 8;

export interface ErrorContext {
	source: string;
	message: string;
	stack?: string | undefined;
	timestamp: string;
}

export interface DiagnosticsSnapshot {
	extensionVersion: string;
	vscodeVersion: string;
	platform: string;
	connectionState: string;
	modelCount?: number | undefined;
	/** "unknown" when the configurations are VS Code-managed and none were observed yet. */
	apiKeyConfigured: boolean | "unknown";
	baseUrlConfigured: boolean;
	latestError?: ErrorContext | undefined;
	recentLogs: string[];
}

function apiKeyConfiguredText(snapshot: DiagnosticsSnapshot): string {
	if (snapshot.apiKeyConfigured === "unknown") {
		return "Unknown (managed by VS Code)";
	}
	return snapshot.apiKeyConfigured ? "yes" : "no";
}

/**
 * Where the full diagnostics land when the issue URL had to be compacted,
 * derived once from the environment's capabilities in openIssue. "unknown"
 * is the plain URL-building path (buildIssueUrl), where no environment is in
 * play: nothing gets copied anywhere, so the hint promises nothing.
 */
type CompactedDiagnosticsSink = "clipboard" | "clipboard-and-file" | "unknown";

/** What the compacted body tells the reader per sink: where the omitted content went, and what to do with it. */
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

/**
 * Which body buildBody renders: the full one, or one of the compaction steps
 * with the sink hint its omission markers quote. "compact-logs" also compacts
 * the stack (it is the step after "compact-stack" in buildIssuePayload's
 * shrinking sequence) and always omits at least one line.
 */
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
	writeClipboard: (text) => vscode.env.clipboard.writeText(text),
	openExternal: openUrl,
	showCompactedDiagnosticsMessage: async () => {
		await vscode.window.showInformationMessage(
			vscode.l10n.t(
				"LiteLLM: Full diagnostics were too large to prefill in GitHub and were copied to your clipboard. Please paste them into the issue."
			)
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
			const revealFile = vscode.l10n.t("Reveal File");
			const choice = await vscode.window.showInformationMessage(
				diagnosticsFile
					? vscode.l10n.t(
							"LiteLLM: Full diagnostics were saved to a redacted log file and copied to your clipboard. Attach the file to the GitHub issue or paste the contents."
						)
					: vscode.l10n.t(
							"LiteLLM: Full diagnostics were too large to prefill in GitHub and were copied to your clipboard. Please paste them into the issue."
						),
				...(diagnosticsFile ? [revealFile] : [])
			);

			if (choice === revealFile && diagnosticsFile) {
				await vscode.commands.executeCommand("revealFileInOS", diagnosticsFile);
			}
		},
	};
}

export class IssueReporter {
	private _logBuffer: string[] = [];
	private _latestError?: ErrorContext;

	constructor(private readonly env: IssueReporterEnv = defaultIssueReporterEnv) {}

	appendLog(message: string): void {
		this._logBuffer.push(message);
		if (this._logBuffer.length > MAX_LOG_ENTRIES) {
			this._logBuffer.shift();
		}
	}

	recordError(source: string, error: unknown): void {
		// The public renderings: an http RequestError's message (and the copy of
		// it V8 prefixes onto the stack) embeds the response body, so both
		// degrade to its classification; every other error keeps its text.
		this._latestError = {
			source,
			message: publicErrorText(error),
			stack: publicErrorStack(error),
			timestamp: new Date().toISOString(),
		};
	}

	getLatestError(): ErrorContext | undefined {
		return this._latestError;
	}

	getRecentLogs(): string[] {
		return [...this._logBuffer];
	}

	buildIssueUrl(snapshot: DiagnosticsSnapshot): string {
		return this.buildIssuePayload(snapshot).url;
	}

	buildTitle(snapshot: DiagnosticsSnapshot): string {
		if (snapshot.latestError) {
			const firstLine = redactSecrets(snapshot.latestError.message.split("\n")[0] ?? "").slice(0, 80);
			return `[Bug] ${snapshot.latestError.source}: ${firstLine}`;
		}
		return "[Bug] Issue report from diagnostics";
	}

	buildBody(snapshot: DiagnosticsSnapshot, variant: BodyVariant = { kind: "full" }): string {
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
		].filter((l): l is string => l !== null);

		if (snapshot.latestError) {
			diagLines.push("");
			diagLines.push("### Latest error");
			diagLines.push("");
			diagLines.push(`- Source: ${snapshot.latestError.source}`);
			diagLines.push(`- Time: ${snapshot.latestError.timestamp}`);
			diagLines.push(`- Message: ${redactSecrets(snapshot.latestError.message)}`);
		}
		diagLines.push("");
		sections.push(diagLines.join("\n"));

		if (recentLogs.length > 0 || variant.kind === "compact-logs") {
			const logLines = recentLogs.map((l) => redactSecrets(l));
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
			const stack =
				variant.kind === "full" ? snapshot.latestError.stack : compactStack(snapshot.latestError.stack, variant.hint);
			sections.push(
				[
					`<details><summary>${variant.kind === "full" ? "Stack trace" : "Stack trace (trimmed)"}</summary>`,
					"",
					"```",
					redactSecrets(stack),
					"```",
					"",
					"</details>",
					"",
				].join("\n")
			);
		}

		return sections.join("\n");
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

	private buildIssuePayload(snapshot: DiagnosticsSnapshot, sink: CompactedDiagnosticsSink = "unknown"): IssuePayload {
		const { hint } = SINK_TEXT[sink];
		const title = this.buildTitle(snapshot);
		const fullBody = this.buildBody(snapshot);
		const fullUrl = createIssueUrl(title, fullBody);
		if (fullUrl.length <= MAX_URL_LENGTH) {
			return { url: fullUrl, fullBody, compacted: false };
		}

		const compactStackBody = this.buildBody(snapshot, { kind: "compact-stack", hint });
		const compactStackUrl = createIssueUrl(title, compactStackBody);
		if (compactStackUrl.length <= MAX_URL_LENGTH) {
			return { url: compactStackUrl, fullBody, compacted: true };
		}

		for (let omitted = 1; omitted <= snapshot.recentLogs.length; omitted++) {
			const body = this.buildBody(snapshot, { kind: "compact-logs", hint, omittedLogCount: omitted });
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
	];

	if (snapshot.latestError) {
		lines.push("", "### Latest error", "");
		lines.push(`- Source: ${snapshot.latestError.source}`);
		lines.push(`- Time: ${snapshot.latestError.timestamp}`);
		lines.push(`- Message: ${shortenLine(redactSecrets(snapshot.latestError.message.split(/\r?\n/)[0] ?? ""), 500)}`);
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

export function redactSecrets(text: string): string {
	return (
		text
			// JSON-encoded auth headers: "Authorization": "Bearer xxx" or "X-API-Key": "xxx".
			// The value pattern consumes escaped sequences so an escaped quote
			// inside the secret cannot end the match early and leak the suffix.
			.replace(/("(?:Authorization|X-API-Key)":\s*")((?:Bearer\s+)?)(?:\\.|[^"\\])*(")/gi, "$1$2[REDACTED]$3")
			// JSON-encoded OAuth material: "client_secret": "xxx" or "access_token": "xxx"
			.replace(/("(?:client[_-]?secret|access[_-]?token)":\s*")(?:\\.|[^"\\])*(")/gi, "$1[REDACTED]$2")
			// Bare auth header values
			.replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
			.replace(/(X-API-Key:\s*)\S+/gi, "$1[REDACTED]")
			.replace(/(Authorization:\s*)\S+/gi, "$1[REDACTED]")
			.replace(/(api[_-]?key[=:\s]+)\S+/gi, "$1[REDACTED]")
			// Bare OAuth material: client_secret=xxx, access_token: xxx
			.replace(/(client[_-]?secret[=:\s]+)\S+/gi, "$1[REDACTED]")
			.replace(/(access[_-]?token[=:\s]+)\S+/gi, "$1[REDACTED]")
			// sk- prefixed API keys
			.replace(/(sk-[a-zA-Z0-9]{4})[a-zA-Z0-9]+/g, "$1[REDACTED]")
			// Credentials embedded in URLs
			.replace(/(https?:\/\/)[^/\s]*:[^@/\s]*@/g, "$1[REDACTED]@")
			// Full http(s) URLs: replace host+path with just the scheme and a placeholder
			.replace(/https?:\/\/[^\s"')>\]]+/g, (match) => {
				try {
					const u = new URL(match);
					const host = u.hostname;
					// Keep localhost/127.0.0.1 as-is since they aren't sensitive
					if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
						return match;
					}
					return `${u.protocol}//[REDACTED_HOST]${u.pathname}`;
				} catch {
					return "[REDACTED_URL]";
				}
			})
	);
}
