/**
 * Leveled sink, structurally satisfied by vscode.LogOutputChannel. The host
 * adds timestamps and level tags to channel lines, so callers pass bare text.
 */
export interface LogSink {
	info(message: string): void;
	error(message: string): void;
}

/** Structurally matched by IssueReporter; kept as an interface so unit tests can omit it. */
export interface ErrorRecorder {
	appendLog(line: string): void;
	recordError(source: string, error: unknown): void;
}

/**
 * The single logging implementation for the extension. Every line goes to the
 * output channel and, when a recorder is attached, to the issue-report buffer,
 * so litellm.reportIssue sees logs from all layers. Channel output is not
 * readable back, so the buffer keeps its own hand-formatted [ISO] lines.
 */
export class Logger {
	constructor(
		private readonly output: LogSink,
		private readonly recorder?: ErrorRecorder
	) {}

	log(message: string, data?: unknown): void {
		const text = data !== undefined ? `${message}: ${JSON.stringify(data, null, 2)}` : message;
		this.output.info(text);
		this.recorder?.appendLog(`[${new Date().toISOString()}] ${text}`);
	}

	error(message: string, error: unknown): void {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const text = `${message}: ${errorMsg}`;
		this.output.error(text);
		this.recorder?.appendLog(`[${new Date().toISOString()}] ERROR: ${text}`);
		if (error instanceof Error && error.stack) {
			this.output.error(`Stack trace: ${error.stack}`);
		}
		this.recorder?.recordError(message, error);
	}
}
