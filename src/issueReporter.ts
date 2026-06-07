import * as vscode from "vscode";

const GITHUB_REPO_URL = "https://github.com/Vivswan/litellm-vscode-chat";
const MAX_LOG_ENTRIES = 50;
const MAX_URL_LENGTH = 8000;
const COMPACT_STACK_LINES = 8;

export interface ErrorContext {
	source: string;
	message: string;
	stack?: string;
	timestamp: string;
}

export interface DiagnosticsSnapshot {
	extensionVersion: string;
	vscodeVersion: string;
	platform: string;
	connectionState: string;
	modelCount?: number;
	apiKeyConfigured: boolean;
	baseUrlConfigured: boolean;
	latestError?: ErrorContext;
	recentLogs: string[];
}

interface BodyOptions {
	recentLogs?: string[];
	omittedLogCount?: number;
	stackMode?: "full" | "compact";
	compactedDiagnosticsHint?: string;
}

interface IssuePayload {
	url: string;
	fullBody: string;
	compacted: boolean;
}

export interface IssueReporterEnv {
	writeClipboard(text: string): PromiseLike<void>;
	openExternal(uri: vscode.Uri): PromiseLike<boolean>;
	saveDiagnosticsFile?(contents: string): PromiseLike<vscode.Uri>;
	showCompactedDiagnosticsMessage?(diagnosticsFile?: vscode.Uri): PromiseLike<void>;
}

const defaultIssueReporterEnv: IssueReporterEnv = {
	writeClipboard: (text) => vscode.env.clipboard.writeText(text),
	openExternal: (uri) => vscode.env.openExternal(uri),
	showCompactedDiagnosticsMessage: async () => {
		await vscode.window.showInformationMessage(
			"LiteLLM: Full diagnostics were too large to prefill in GitHub and were copied to your clipboard. Please paste them into the issue."
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
			const choice = await vscode.window.showInformationMessage(
				diagnosticsFile
					? "LiteLLM: Full diagnostics were saved to a redacted log file and copied to your clipboard. Attach the file to the GitHub issue or paste the contents."
					: "LiteLLM: Full diagnostics were too large to prefill in GitHub and were copied to your clipboard. Please paste them into the issue.",
				...(diagnosticsFile ? ["Reveal File"] : [])
			);

			if (choice === "Reveal File" && diagnosticsFile) {
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
		const message = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error ? error.stack : undefined;
		this._latestError = {
			source,
			message,
			stack,
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
			const firstLine = redactSecrets(snapshot.latestError.message.split("\n")[0]).slice(0, 80);
			return `[Bug] ${snapshot.latestError.source}: ${firstLine}`;
		}
		return "[Bug] Issue report from diagnostics";
	}

	buildBody(snapshot: DiagnosticsSnapshot, options: BodyOptions = {}): string {
		const sections: string[] = [];
		const recentLogs = options.recentLogs ?? snapshot.recentLogs;
		const stackMode = options.stackMode ?? "full";
		const compactedDiagnosticsHint = options.compactedDiagnosticsHint ?? "full diagnostics omitted from URL";

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
			`- API key configured: ${snapshot.apiKeyConfigured ? "yes" : "no"}`,
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

		if (recentLogs.length > 0 || options.omittedLogCount) {
			const logLines = recentLogs.map((l) => redactSecrets(l));
			if (options.omittedLogCount) {
				logLines.unshift(
					`... (${options.omittedLogCount} older log line${options.omittedLogCount === 1 ? "" : "s"} omitted; ${compactedDiagnosticsHint})`
				);
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
				stackMode === "compact"
					? compactStack(snapshot.latestError.stack, compactedDiagnosticsHint)
					: snapshot.latestError.stack;
			sections.push(
				[
					`<details><summary>${stackMode === "compact" ? "Stack trace (trimmed)" : "Stack trace"}</summary>`,
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
		const compactedDiagnosticsHint = this.env.saveDiagnosticsFile
			? "full diagnostics copied to clipboard and saved to a diagnostics file"
			: "full diagnostics copied to clipboard";
		const payload = this.buildIssuePayload(snapshot, compactedDiagnosticsHint);
		let diagnosticsFile: vscode.Uri | undefined;

		if (payload.compacted) {
			await this.env.writeClipboard(payload.fullBody);
			diagnosticsFile = await this.env.saveDiagnosticsFile?.(payload.fullBody);
		}

		await this.env.openExternal(vscode.Uri.parse(payload.url));

		if (payload.compacted) {
			void this.env.showCompactedDiagnosticsMessage?.(diagnosticsFile);
		}
	}

	private buildIssuePayload(
		snapshot: DiagnosticsSnapshot,
		compactedDiagnosticsHint = "full diagnostics omitted from URL"
	): IssuePayload {
		const title = this.buildTitle(snapshot);
		const fullBody = this.buildBody(snapshot);
		const fullUrl = createIssueUrl(title, fullBody);
		if (fullUrl.length <= MAX_URL_LENGTH) {
			return { url: fullUrl, fullBody, compacted: false };
		}

		const compactStackBody = this.buildBody(snapshot, { stackMode: "compact", compactedDiagnosticsHint });
		const compactStackUrl = createIssueUrl(title, compactStackBody);
		if (compactStackUrl.length <= MAX_URL_LENGTH) {
			return { url: compactStackUrl, fullBody, compacted: true };
		}

		for (let omitted = 1; omitted <= snapshot.recentLogs.length; omitted++) {
			const logs = snapshot.recentLogs.slice(omitted);
			const body = this.buildBody(snapshot, {
				recentLogs: logs,
				omittedLogCount: omitted,
				stackMode: "compact",
				compactedDiagnosticsHint,
			});
			const url = createIssueUrl(title, body);
			if (url.length <= MAX_URL_LENGTH) {
				return { url, fullBody, compacted: true };
			}
		}

		const fallbackBody = buildClipboardFallbackBody(snapshot, compactedDiagnosticsHint);
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

function compactStack(stack: string, compactedDiagnosticsHint: string): string {
	const lines = stack.split(/\r?\n/);
	if (lines.length <= COMPACT_STACK_LINES) {
		return stack;
	}

	const omitted = lines.length - COMPACT_STACK_LINES;
	return [
		...lines.slice(0, COMPACT_STACK_LINES),
		`... (${omitted} stack line${omitted === 1 ? "" : "s"} omitted; ${compactedDiagnosticsHint})`,
	].join("\n");
}

function buildClipboardFallbackBody(snapshot: DiagnosticsSnapshot, compactedDiagnosticsHint: string): string {
	const lines = [
		"## What happened",
		"",
		"<!-- Describe what happened -->",
		"",
		"## Diagnostics",
		"",
		`- Connection state: ${snapshot.connectionState}`,
		snapshot.modelCount !== undefined ? `- Model count: ${snapshot.modelCount}` : null,
		`- API key configured: ${snapshot.apiKeyConfigured ? "yes" : "no"}`,
		`- Base URL configured: ${snapshot.baseUrlConfigured ? "yes" : "no"}`,
	];

	if (snapshot.latestError) {
		lines.push("", "### Latest error", "");
		lines.push(`- Source: ${snapshot.latestError.source}`);
		lines.push(`- Time: ${snapshot.latestError.timestamp}`);
		lines.push(`- Message: ${shortenLine(redactSecrets(snapshot.latestError.message.split(/\r?\n/)[0]), 500)}`);
	}

	lines.push(
		"",
		`Full redacted diagnostics were too large to prefill in GitHub. ${capitalizeFirst(compactedDiagnosticsHint)}. ${getCompactedDiagnosticsAction(compactedDiagnosticsHint)}`
	);

	return lines.filter((line): line is string => line !== null).join("\n");
}

function capitalizeFirst(text: string): string {
	return text.length === 0 ? text : `${text[0].toUpperCase()}${text.slice(1)}`;
}

function getCompactedDiagnosticsAction(compactedDiagnosticsHint: string): string {
	if (compactedDiagnosticsHint.includes("saved to a diagnostics file")) {
		return "Please attach the generated file or paste the contents here.";
	}
	if (compactedDiagnosticsHint.includes("clipboard")) {
		return "Please paste the copied contents here.";
	}
	return "Please add the full diagnostics separately.";
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
			// JSON-encoded auth headers: "Authorization": "Bearer xxx" or "X-API-Key": "xxx"
			.replace(/("(?:Authorization|X-API-Key)":\s*")((?:Bearer\s+)?)[^"]*(")/gi, "$1$2[REDACTED]$3")
			// Bare auth header values
			.replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
			.replace(/(X-API-Key:\s*)\S+/gi, "$1[REDACTED]")
			.replace(/(Authorization:\s*)\S+/gi, "$1[REDACTED]")
			.replace(/(api[_-]?key[=:\s]+)\S+/gi, "$1[REDACTED]")
			// sk- prefixed API keys
			.replace(/(sk-[a-zA-Z0-9]{4})[a-zA-Z0-9]+/g, "$1[REDACTED]")
			// Credentials embedded in URLs
			.replace(/(https?:\/\/)[^/\s]*:[^@/\s]*@/g, "$1[REDACTED]@")
			// Full http(s) URLs — replace host+path with just the scheme and a placeholder
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
