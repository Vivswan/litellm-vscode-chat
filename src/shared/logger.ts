export interface LogSink {
	appendLine(line: string): void;
}

/** Structurally matched by IssueReporter; kept as an interface so unit tests can omit it. */
export interface ErrorRecorder {
	appendLog(line: string): void;
	recordError(source: string, error: unknown): void;
}

/**
 * The single logging implementation for the extension. Every line goes to the
 * output channel and, when a recorder is attached, to the issue-report buffer,
 * so litellm.reportIssue sees logs from all layers.
 */
export class Logger {
	constructor(
		private readonly output: LogSink,
		private readonly recorder?: ErrorRecorder
	) {}

	log(message: string, data?: unknown): void {
		const timestamp = new Date().toISOString();
		const line =
			data !== undefined ? `[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}` : `[${timestamp}] ${message}`;
		this.output.appendLine(line);
		this.recorder?.appendLog(line);
	}

	error(message: string, error: unknown): void {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const timestamp = new Date().toISOString();
		const line = `[${timestamp}] ERROR: ${message}: ${errorMsg}`;
		this.output.appendLine(line);
		this.recorder?.appendLog(line);
		if (error instanceof Error && error.stack) {
			this.output.appendLine(`Stack trace: ${error.stack}`);
		}
		this.recorder?.recordError(message, error);
	}
}
