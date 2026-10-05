/**
 * Fails when a file outside the Logger and its wiring writes to the output channel. Two callers run this one script,
 * .husky/pre-commit through check:static and the format-check workflow, so a local green predicts the gate. Zero
 * channel accesses is a failure too: the wiring site always creates the channel, so seeing nothing means the scan
 * could not resolve vscode's types and would pass every write.
 */
import * as path from "node:path";
import { CHANNEL_OWNERS, NON_WRITING_MEMBERS, scanOutputChannelAccess } from "./output-channel-writes";

const tsconfigPath = path.resolve(__dirname, "../../tsconfig.prod.json");
const { seen, refused } = scanOutputChannelAccess(tsconfigPath);

if (seen === 0) {
	process.stderr.write(
		"No output-channel access found at all: src/extension.ts creates the channel, so the scan could not resolve " +
			"vscode's types (run bun install) and would pass every write\n"
	);
	process.exit(1);
}
if (refused.length > 0) {
	for (const access of refused) {
		process.stderr.write(
			`${access.file}:${access.line}:${access.column}: ${access.member} writes to the output channel\n`
		);
	}
	process.stderr.write(
		`Output-channel text is written only by src/shared/logger.ts, where redaction lives; route these through the ` +
			`Logger. Members that write nothing (${[...NON_WRITING_MEMBERS].join(", ")}) are allowed anywhere; the ` +
			`channel itself lives in ${[...CHANNEL_OWNERS].join(" and ")}.\n`
	);
	process.exit(1);
}
process.stdout.write(`Output channel: ${seen} member accesses, none writing outside the Logger\n`);
