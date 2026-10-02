/**
 * Tells a VS Code test host that stalled on the runner apart from a test verdict. Electron's
 * watchdog logs "CodeWindow: detected unresponsive" and the host exits before mocha prints a
 * line; four nightly and CI legs died that way in two days with no code change behind them,
 * all but one on docker legs sharing one runner with the compose stack. Only that exact shape
 * earns a relaunch: any mocha output means the tests ran and the exit is their verdict.
 */

import { StringDecoder } from "node:string_decoder";

export const HOST_STALL_MARKER = "CodeWindow: detected unresponsive";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips mocha's ANSI color codes before matching
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * A line mocha's spec reporter has printed: it indents everything, suite titles included, by at
 * least two spaces (a suite title precedes suiteSetup, so a stall after it may already have run
 * state-mutating setup), and its summary stands alone. vscode-test's own progress ("✔ Validated
 * version", "- Downloading") and VS Code's "[main ...]" lines start at column 0. Judged per
 * complete line, so indentation is read only where the line's start is known.
 */
const MOCHA_LINE = /^[ \t]{2,}\S|^[ \t]*\d+ (?:passing|failing|pending)\b/;

/** An unterminated line kept past this loses its head and is then judged with its start unknown. */
const MAX_PARTIAL_LINE = 4096;

/** One per pipe: the decoder rejoins multi-byte glyphs split across chunks, the partial line rejoins text. */
export class HostStallDetector {
	private readonly decoder = new StringDecoder("utf8");
	private partial = "";
	private partialStartKnown = true;
	sawMarker = false;
	sawTests = false;

	feed(chunk: Buffer | string): void {
		const text = this.partial + (typeof chunk === "string" ? chunk : this.decoder.write(chunk));
		const lines = text.split("\n");
		this.partial = lines.pop() ?? "";
		lines.forEach((line, index) => {
			this.judge(line, index > 0 || this.partialStartKnown);
		});
		if (lines.length > 0) {
			this.partialStartKnown = true;
		}
		if (this.partial.length > MAX_PARTIAL_LINE) {
			this.partial = this.partial.slice(-MAX_PARTIAL_LINE);
			this.partialStartKnown = false;
		}
	}

	/** The pipe closed: the last line may have arrived without its newline. */
	end(): void {
		this.judge(this.partial + this.decoder.end(), this.partialStartKnown);
		this.partial = "";
	}

	private judge(line: string, startKnown: boolean): void {
		const clean = line.replace(ANSI, "");
		if (clean.includes(HOST_STALL_MARKER)) {
			this.sawMarker = true;
		}
		if (startKnown && MOCHA_LINE.test(clean)) {
			this.sawTests = true;
		}
	}
}

/** True only for a non-zero exit after the stall marker and before any test output, across every pipe watched. */
export function stalledBeforeTests(status: number | null, ...pipes: readonly HostStallDetector[]): boolean {
	return status !== 0 && pipes.some((pipe) => pipe.sawMarker) && !pipes.some((pipe) => pipe.sawTests);
}
