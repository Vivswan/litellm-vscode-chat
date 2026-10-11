import { afterAll, describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeStackLogs } from "../../../../../scripts/stack/stackLogs";
import { CHILD_PROCESS_TIMEOUT_MS } from "../../childProcessTimeout";

/**
 * A service log past spawnSync's 1 MiB pipe buffer (bun stops the child there with ENOBUFS) still arrives whole in
 * its file, because the capture streams into the descriptor. A DEBUG proxy log over a nightly leg is many times that
 * size, and a truncated file would answer the timing question it exists for with a silence.
 */
const LOG_LINE = `${"x".repeat(1023)}\n`;
const LONG_LINES = 3 * 1024;

const tempDirs: string[] = [];
const savedComposeCmd = process.env.COMPOSE_CMD;

afterAll(() => {
	if (savedComposeCmd === undefined) {
		delete process.env.COMPOSE_CMD;
	} else {
		process.env.COMPOSE_CMD = savedComposeCmd;
	}
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function stubCompose(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-logs-"));
	tempDirs.push(dir);
	const stub = path.join(dir, "compose.ts");
	fs.writeFileSync(
		stub,
		[
			"const args = process.argv.slice(2);",
			'if (args.includes("config")) {',
			'\tprocess.stdout.write("litellm\\nfake-openai\\n");',
			"} else {",
			'\tprocess.stdout.write(args.join(" ") + "\\n");',
			'\tif (args.at(-1) === "litellm") {',
			`\t\tprocess.stdout.write(${JSON.stringify(LOG_LINE)}.repeat(${LONG_LINES}));`,
			"\t}",
			"}",
			"",
		].join("\n")
	);
	return stub;
}

describe("writeStackLogs", () => {
	test(
		"every declared service gets its full timestamped log, a 3 MiB one included",
		() => {
			process.env.COMPOSE_CMD = `"${process.execPath}" "${stubCompose()}"`;
			const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stack-logs-out-")), "leg");
			tempDirs.push(path.dirname(out));

			const captures = writeStackLogs(out);

			assert.deepStrictEqual(
				captures.sort((a, b) => a.file.localeCompare(b.file)),
				[
					{ file: path.join(out, "fake-openai.log"), status: 0 },
					{ file: path.join(out, "litellm.log"), status: 0 },
				]
			);
			const header = (service: string): string =>
				`-f docker/docker-compose.yml --project-directory . logs --no-color --timestamps ${service}\n`;
			assert.strictEqual(fs.readFileSync(path.join(out, "fake-openai.log"), "utf8"), header("fake-openai"));
			const litellm = fs.readFileSync(path.join(out, "litellm.log"), "utf8");
			assert.strictEqual(litellm, header("litellm") + LOG_LINE.repeat(LONG_LINES));
		},
		CHILD_PROCESS_TIMEOUT_MS
	);
});
