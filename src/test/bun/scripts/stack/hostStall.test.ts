import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { HOST_STALL_MARKER, HostStallDetector, stalledBeforeTests } from "../../../../../scripts/stack/hostStall";

/**
 * The relaunch gate for a docker leg: what would drift silently is the line between "the runner stalled the host before
 * any test ran" (relaunch once) and "the tests ran and failed" (a verdict, never relaunched). The nightly legs that
 * died this way printed vscode-test's own progress, the marker, and nothing from mocha; mocha's lines arrive colored,
 * indented, and split anywhere.
 */
describe("stalledBeforeTests", () => {
	const nightly = [
		"Running the stream fuzzer...\n- Resolving version...\n\u001b[32m✔\u001b[0m Validated version: 1.140.0\n",
		"✔ Downloaded VS Code (abc) into .vscode-test/vscode-linux-x64-1.140.0\n",
		"[main 2026-10-01T15:12:17.292Z] StorageMainService: creating application shared storage\n",
		`[main 2026-10-01T15:12:33.721Z] ${HOST_STALL_MARKER}\n`,
		"Exit code:   1\n",
	];
	const cases: readonly {
		name: string;
		chunks: readonly (string | Buffer)[];
		status: number | null;
		stalled: boolean;
	}[] = [
		{
			name: "vscode-test's own check-marked progress, the marker, no mocha line, exit 1 (the nightly shape)",
			chunks: nightly,
			status: 1,
			stalled: true,
		},
		{
			name: "the marker split across two chunks",
			chunks: ["...] CodeWindow: detec", "ted unresponsive\nExit code:   1\n"],
			status: 1,
			stalled: true,
		},
		{
			name: "a column-0 line whose continuation chunk begins with two spaces is one line, not an indented one",
			chunks: ["[main] Validated version:", "  more words\n", `${HOST_STALL_MARKER}\n`],
			status: 1,
			stalled: true,
		},
		{
			// The kept tail is exactly "  " + 4094 x's: the head was dropped, so the
			// two spaces are mid-line, not indentation.
			name: "a column-0 line longer than the partial-line cap, cut so its kept tail begins with two spaces",
			chunks: [`${"y".repeat(500)}  ${"x".repeat(4094)}`, `\n${HOST_STALL_MARKER}\n`],
			status: 1,
			stalled: true,
		},
		{
			name: "blank lines before vscode-test's column-0 progress are not indentation",
			chunks: ["\n\n✔ Validated version: 1.140.0\n", `${HOST_STALL_MARKER}\n`],
			status: 1,
			stalled: true,
		},
		{
			name: "an indented check mark before the marker: a mid-run crash is a verdict",
			chunks: ["  \u001b[32m✔\u001b[0m a test that passed\n", ...nightly],
			status: 1,
			stalled: false,
		},
		{
			name: "a suite title alone before the marker: mocha started, so setup may have run",
			chunks: ["\u001b[0m  Docker LiteLLM stack\u001b[0m\n", ...nightly],
			status: 1,
			stalled: false,
		},
		{
			name: "a colored numbered failure line",
			chunks: ["\u001b[31m  1) a real test\u001b[0m\n", `${HOST_STALL_MARKER}\n`],
			status: 1,
			stalled: false,
		},
		{
			name: "a colored pending line",
			chunks: ["\u001b[36m  - a real test\u001b[0m\n", `${HOST_STALL_MARKER}\n`],
			status: 1,
			stalled: false,
		},
		{
			name: "a check mark whose UTF-8 bytes split across chunks",
			chunks: (() => {
				const bytes = Buffer.from("  ✔ a real test\n", "utf8");
				const cut = bytes.indexOf(Buffer.from("✔", "utf8")) + 1;
				return [bytes.subarray(0, cut), bytes.subarray(cut), Buffer.from(`${HOST_STALL_MARKER}\n`, "utf8")];
			})(),
			status: 1,
			stalled: false,
		},
		{
			name: "a mocha summary as the pipe's last line, with no trailing newline",
			chunks: [`${HOST_STALL_MARKER}\n  3 failing`],
			status: 1,
			stalled: false,
		},
		{ name: "a plain failure without the marker", chunks: ["Error: something else\n"], status: 1, stalled: false },
		{ name: "the marker on a green exit", chunks: nightly, status: 0, stalled: false },
		{ name: "a signal death without the marker", chunks: ["killed\n"], status: null, stalled: false },
	];
	for (const { name, chunks, status, stalled } of cases) {
		test(name, () => {
			const pipe = new HostStallDetector();
			for (const chunk of chunks) {
				pipe.feed(chunk);
			}
			pipe.end();
			assert.strictEqual(stalledBeforeTests(status, pipe), stalled);
		});
	}

	test("the verdict reads every pipe: a marker on stderr and a test line on stdout is a verdict, not a stall", () => {
		const stdout = new HostStallDetector();
		const stderr = new HostStallDetector();
		stdout.feed("  ✔ a real test\n");
		stderr.feed(`${HOST_STALL_MARKER}\n`);
		assert.strictEqual(stalledBeforeTests(1, stdout, stderr), false);
		const quiet = new HostStallDetector();
		assert.strictEqual(stalledBeforeTests(1, quiet, stderr), true);
	});
});
