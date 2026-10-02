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
 * version", "- Downloading") and VS Code's "[main ...]" lines start at column 0. Horizontal
 * whitespace only, so blank lines before a column-0 line never read as indentation.
 */
const MOCHA_OUTPUT = /^[ \t]{2,}\S|^[ \t]*\d+ (?:passing|failing|pending)\b/m;

/** Enough raw tail to rejoin a marker, an escape sequence, or a line start split across chunks. */
const CARRY = 64;

/** One per pipe: the decoder rejoins multi-byte glyphs split across chunks, the carry rejoins text. */
export class HostStallDetector {
	private readonly decoder = new StringDecoder("utf8");
	private carry = "";
	sawMarker = false;
	sawTests = false;

	feed(chunk: Buffer | string): void {
		const raw = this.carry + (typeof chunk === "string" ? chunk : this.decoder.write(chunk));
		const text = raw.replace(ANSI, "");
		if (!this.sawMarker && text.includes(HOST_STALL_MARKER)) {
			this.sawMarker = true;
		}
		if (!this.sawTests && MOCHA_OUTPUT.test(text)) {
			this.sawTests = true;
		}
		this.carry = raw.slice(-CARRY);
	}
}

/** True only for a non-zero exit after the stall marker and before any test output, across every pipe watched. */
export function stalledBeforeTests(status: number | null, ...pipes: readonly HostStallDetector[]): boolean {
	return status !== 0 && pipes.some((pipe) => pipe.sawMarker) && !pipes.some((pipe) => pipe.sawTests);
}
