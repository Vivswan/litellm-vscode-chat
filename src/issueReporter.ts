import * as vscode from "vscode";

const GITHUB_REPO_URL = "https://github.com/Vivswan/litellm-vscode-chat";
const MAX_LOG_ENTRIES = 50;
const MAX_BODY_LENGTH = 1500;
const MAX_URL_LENGTH = 8000;

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

export class IssueReporter {
	private _logBuffer: string[] = [];
	private _latestError?: ErrorContext;

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
		const title = this.buildTitle(snapshot);
		const body = this.buildBody(snapshot);
		let truncatedBody = body.length > MAX_BODY_LENGTH ? body.slice(0, MAX_BODY_LENGTH) + "\n\n...(truncated)" : body;

		const params = new URLSearchParams({
			labels: "bug",
			title,
			body: truncatedBody,
		});

		let url = `${GITHUB_REPO_URL}/issues/new?${params.toString()}`;

		if (url.length > MAX_URL_LENGTH) {
			truncatedBody = body.slice(0, 800) + "\n\n...(truncated, full diagnostics copied to clipboard)";
			const shortParams = new URLSearchParams({
				labels: "bug",
				title,
				body: truncatedBody,
			});
			url = `${GITHUB_REPO_URL}/issues/new?${shortParams.toString()}`;
		}

		return url;
	}

	buildTitle(snapshot: DiagnosticsSnapshot): string {
		if (snapshot.latestError) {
			const firstLine = redactSecrets(snapshot.latestError.message.split("\n")[0]).slice(0, 80);
			return `[Bug] ${snapshot.latestError.source}: ${firstLine}`;
		}
		return "[Bug] Issue report from diagnostics";
	}

	buildBody(snapshot: DiagnosticsSnapshot): string {
		const sections: string[] = [];

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
			if (snapshot.latestError.stack) {
				diagLines.push("");
				diagLines.push("<details><summary>Stack trace</summary>");
				diagLines.push("");
				diagLines.push("```");
				diagLines.push(redactSecrets(snapshot.latestError.stack));
				diagLines.push("```");
				diagLines.push("");
				diagLines.push("</details>");
			}
		}
		diagLines.push("");
		sections.push(diagLines.join("\n"));

		if (snapshot.recentLogs.length > 0) {
			const logLines = snapshot.recentLogs.slice(-20).map((l) => redactSecrets(l));
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

		return sections.join("\n");
	}

	async openIssue(snapshot: DiagnosticsSnapshot): Promise<void> {
		const fullBody = this.buildBody(snapshot);
		const url = this.buildIssueUrl(snapshot);

		if (fullBody.length > MAX_BODY_LENGTH) {
			await vscode.env.clipboard.writeText(fullBody);
		}

		await vscode.env.openExternal(vscode.Uri.parse(url));
	}
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
