/**
 * Fails when a settings reader trims or numbers a user's text itself instead of reading through the two homes, or when
 * an allowlist row matches no read. The same two callers as check-output-channel-writes.ts run it, .husky/pre-commit
 * through check:static and the format-check workflow, so a local green predicts the gate. Zero reads is a failure too:
 * decimalText.ts always calls Number(), so seeing nothing means the scan lost its homes.
 */
import * as path from "node:path";
import { DECIMAL_HOME, scanUserTextReaders, TRIM_HOME } from "./user-text-readers";

const tsconfigPath = path.resolve(__dirname, "../../tsconfig.prod.json");
const { seen, refused, unusedAllowed } = scanUserTextReaders(tsconfigPath);

if (seen === 0) {
	process.stderr.write(
		`No trim or number read found at all: ${DECIMAL_HOME} always calls Number(), so the scan lost its homes\n`
	);
	process.exit(1);
}
if (refused.length > 0 || unusedAllowed.length > 0) {
	for (const read of refused) {
		process.stderr.write(
			`${read.file}:${read.line}:${read.column}: ${read.shape} reads user text outside the one rule\n`
		);
	}
	for (const row of unusedAllowed) {
		process.stderr.write(
			`${row.file}: ALLOWED_READS names ${row.function}, which has no trim or number read; delete the row\n`
		);
	}
	process.stderr.write(
		`Settings readers trim through usableHttpText or trimHttpWhitespace (${TRIM_HOME}) and number through ` +
			`parseDecimalText (${DECIMAL_HOME}); a read that is not user text is an ALLOWED_READS row carrying its reason.\n`
	);
	process.exit(1);
}
process.stdout.write(`User-text readers: ${seen} trim and number reads, none outside the one rule\n`);
