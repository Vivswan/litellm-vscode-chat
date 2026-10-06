import { afterAll, describe, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { outputChannelWrites } from "../../../../../scripts/lint/outputChannelWrites";
import { REPO_ROOT } from "../../../util/repoRoot";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const FIXTURE = "src/test/bun/scripts/lint/outputChannelWritesFixture.ts";

function taggedLines(source: string, tag: string): number[] {
	return source.split("\n").flatMap((text, index) => (text.endsWith(`// ${tag}`) ? [index + 1] : []));
}

// The gate fails green, not red, when it goes blind: a write it misses is a credential in the channel with no signal
// anywhere, so the fixture's refused lines are the one place a missed shape shows. The fixture is linted under its own
// path, so the type checker resolves vscode's declarations the way the repository's lint run does.
const source = readFileSync(join(REPO_ROOT, FIXTURE), "utf8");
const ruleTester = new RuleTester({
	languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: REPO_ROOT } },
});

ruleTester.run("output-channel-writes", outputChannelWrites, {
	valid: [
		{
			name: "the allow option admits the wiring file's one creation call",
			filename: join(REPO_ROOT, FIXTURE),
			code: 'import * as vscode from "vscode";\nexport const channel = vscode.window.createOutputChannel("LiteLLM");\n',
			options: [{ allow: ["createOutputChannel"] }],
		},
	],
	invalid: [
		{
			name: "refuses every tagged write shape in the fixture and nothing else",
			filename: join(REPO_ROOT, FIXTURE),
			code: source,
			errors: taggedLines(source, "refused").map((line) => ({
				messageId: source.split("\n")[line - 1]?.includes("createOutputChannel(") ? "create" : "write",
				line,
			})),
		},
	],
});
