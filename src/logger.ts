/**
 * Centralized logging utility for LiteLLM VS Code Chat Provider
 * Provides consistent logging interface across the extension
 */

import * as vscode from "vscode";

/**
 * Logger interface for dependency injection
 */
export interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

/**
 * No-op logger that discards all log messages
 * Used as a default when no logger is provided
 */
export class NullLogger implements Logger {
	log(_message: string, ..._args: unknown[]): void {
		// No-op
	}

	warn(_message: string, ..._args: unknown[]): void {
		// No-op
	}

	error(_message: string, ..._args: unknown[]): void {
		// No-op
	}
}

/**
 * Logger that writes to VS Code Output Channel
 */
export class OutputChannelLogger implements Logger {
	constructor(private readonly outputChannel: vscode.OutputChannel) {}

	log(message: string, ...args: unknown[]): void {
		const formatted = this.format("INFO", message, args);
		this.outputChannel.appendLine(formatted);
	}

	warn(message: string, ...args: unknown[]): void {
		const formatted = this.format("WARN", message, args);
		this.outputChannel.appendLine(formatted);
	}

	error(message: string, ...args: unknown[]): void {
		const formatted = this.format("ERROR", message, args);
		this.outputChannel.appendLine(formatted);
	}

	private format(level: string, message: string, args: unknown[]): string {
		const timestamp = new Date().toISOString();
		const argsStr = args.length > 0 ? " " + args.map((a) => this.stringify(a)).join(" ") : "";
		return `[${timestamp}] ${level}: ${message}${argsStr}`;
	}

	private stringify(value: unknown): string {
		if (typeof value === "string") {
			return value;
		}
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
}

/**
 * Console logger for development/testing
 * Falls back to console when no VS Code output channel is available
 */
export class ConsoleLogger implements Logger {
	constructor(private readonly prefix: string = "[LiteLLM]") {}

	log(message: string, ...args: unknown[]): void {
		console.log(`${this.prefix} ${message}`, ...args);
	}

	warn(message: string, ...args: unknown[]): void {
		console.warn(`${this.prefix} ${message}`, ...args);
	}

	error(message: string, ...args: unknown[]): void {
		console.error(`${this.prefix} ${message}`, ...args);
	}
}

/**
 * Global logger instance - defaults to null logger
 * Should be set by the extension activation
 */
let globalLogger: Logger = new NullLogger();

/**
 * Set the global logger instance
 */
export function setLogger(logger: Logger): void {
	globalLogger = logger;
}

/**
 * Get the current global logger
 */
export function getLogger(): Logger {
	return globalLogger;
}

/**
 * Log a message at info level
 */
export function log(message: string, ...args: unknown[]): void {
	globalLogger.log(message, ...args);
}

/**
 * Log a warning message
 */
export function warn(message: string, ...args: unknown[]): void {
	globalLogger.warn(message, ...args);
}

/**
 * Log an error message
 */
export function error(message: string, ...args: unknown[]): void {
	globalLogger.error(message, ...args);
}
