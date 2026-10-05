/**
 * Fails when a file outside a redaction boundary's sanctioned exit writes past it: an output-channel write outside the
 * Logger, or a tool result, result part, or prepared invocation built outside the EXIT_SITES functions, or a tool
 * whose exit member returns anything else or cannot be followed to a body. Two callers run this one script,
 * .husky/pre-commit through check:static and the format-check workflow, so a local green predicts the gate. Zero
 * judgments on either boundary is a failure too: the wiring sites always create the channel and build the agent
 * tools' result, so seeing nothing means the scan could not resolve vscode's types and would pass every write.
 *
 * This check covers accidental omissions and analysis gaps: a model-facing tool result or invocation message
 * constructed outside the sanctioned exits (wiring.ts toolResult and preparedInvocation, and the consult tool's two
 * methods until #74) fails the build; deliberate hiding is out of scope.
 */
import * as path from "node:path";
import {
	EXIT_SITES,
	type Judgment,
	LOGGER_FILE,
	NON_WRITING_MEMBERS,
	type Rule,
	type RuleScan,
	scanRedactionBoundaries,
	WIRING_FILE,
} from "./output-channel-writes";

const tsconfigPath = path.resolve(__dirname, "../../tsconfig.prod.json");
const { channel, exits } = scanRedactionBoundaries(tsconfigPath);

const VERDICTS: Readonly<Record<Rule, (shape: string) => string>> = {
	channel: (shape) => `${shape} writes to the output channel`,
	construct: (shape) => `${shape} reaches the model without the modelFacing pass`,
	return: (shape) => `${shape} hands the host a value no sanctioned exit built`,
	member: (shape) => `${shape}: no function body is reachable from this tool, so its returns cannot be judged`,
};

const SITES = EXIT_SITES.map(
	(site) => `${site.file}${site.functions === undefined ? "" : `: ${site.functions.join(", ")}`}`
).join("; ");

function report(scan: RuleScan, blind: string, remedy: string): boolean {
	if (scan.judgments.length === 0) {
		process.stderr.write(
			`${blind}, so the scan could not resolve vscode's types (run bun install) and would pass every write\n`
		);
		return false;
	}
	const refused = scan.judgments.filter((judgment: Judgment) => !judgment.allowed);
	if (refused.length > 0) {
		for (const judgment of refused) {
			process.stderr.write(
				`${judgment.file}:${judgment.line}:${judgment.column}: ${VERDICTS[judgment.rule](judgment.shape)}\n`
			);
		}
		process.stderr.write(`${remedy}\n`);
		return false;
	}
	return true;
}

const channelGreen = report(
	channel,
	`No output-channel access found at all: ${WIRING_FILE} creates the channel`,
	`Output-channel text is written only by ${LOGGER_FILE}, where redaction lives; route these through the Logger. ` +
		`Members that write nothing (${[...NON_WRITING_MEMBERS].join(", ")}) are allowed anywhere; only ${WIRING_FILE} ` +
		"creates the channel."
);
const exitsGreen = report(
	exits,
	`No model-facing exit found at all: ${EXIT_SITES[0].file} builds the agent tools' result`,
	`A tool result, a result part, or a prepared invocation is built only inside the sanctioned exits (${SITES}), and a ` +
		"tool's invoke/prepareInvocation return those exits' calls from a body the scan can reach; hand the text to " +
		"modelFacing() and build the result there."
);

if (!channelGreen || !exitsGreen) {
	process.exit(1);
}
process.stdout.write(
	`Output channel: ${channel.judgments.length} member accesses, none writing outside the Logger\n` +
		`Model-facing exits: ${exits.judgments.length} constructs, members, and returns, all through the sanctioned exits\n`
);
