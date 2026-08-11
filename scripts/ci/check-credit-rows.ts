/**
 * Crediting-convention gate: when a subject carries "(#N, thanks @login)",
 * the ACKNOWLEDGMENTS.md being committed must have a row for every credited
 * login. Two callers: .husky/commit-msg passes the message file path (the
 * history guard in src/test/creditConvention.test.ts only sees committed
 * subjects, so this catches the crediting commit itself), and the checks.yml
 * PR-title job passes `--subject <title>` (squash-merge makes the PR title
 * the landing subject, which no local hook ever sees).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ACKNOWLEDGMENTS_FILE, acknowledgedLogins, extractSubjectCredits } from "../../src/test/creditConvention";

function main(): void {
	const argument = process.argv[2];
	if (argument === undefined) {
		console.error("usage: bun scripts/ci/check-credit-rows.ts <commit-message-file> | --subject <subject>");
		process.exitCode = 1;
		return;
	}
	let subject: string;
	if (argument === "--subject") {
		subject = process.argv[3] ?? "";
	} else {
		// The subject is the first content line; commit-msg can still see the
		// editor template's leading comments under the default cleanup mode.
		let commentChar = "#";
		try {
			const configured = execFileSync("git", ["config", "core.commentChar"], { encoding: "utf8" }).trim();
			if (configured !== "" && configured !== "auto") {
				commentChar = configured;
			}
		} catch {
			// Unset config exits nonzero; the default comment char stands.
		}
		subject =
			readFileSync(argument, "utf8")
				.split(/\r?\n/)
				.find((line) => line.trim() !== "" && !line.startsWith(commentChar)) ?? "";
	}
	const credits = extractSubjectCredits(subject);
	if (credits.length === 0) {
		return;
	}
	// The staged copy is what this commit will contain; the index has stage 0
	// for every tracked file outside deletions and conflicts. Fail closed when
	// it is unreadable - falling back to HEAD would wave a staged deletion
	// through.
	let acknowledgments: string;
	try {
		acknowledgments = execFileSync("git", ["show", `:${ACKNOWLEDGMENTS_FILE}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		console.error(
			`Could not read the staged ${ACKNOWLEDGMENTS_FILE} (deleted or unmerged?); a crediting commit requires it.`
		);
		process.exitCode = 1;
		return;
	}
	const rows = acknowledgedLogins(acknowledgments);
	const missing = credits.filter((credit) => !rows.has(credit.login.toLowerCase()));
	if (missing.length === 0) {
		return;
	}
	console.error(`The subject credits a reporter, but ${ACKNOWLEDGMENTS_FILE} has no row for them.`);
	console.error("Its header requires one: a row there means the report changed the code. Add, for each:");
	for (const { login, issues } of missing) {
		const issue = issues[0] ?? 0;
		console.error(
			`  | [@${login}](https://github.com/${login}) | <what the report helped with> ` +
				`([#${issue}](https://github.com/Vivswan/litellm-vscode-chat/issues/${issue})) |`
		);
	}
	console.error(`to the matching table (alphabetical order) in ${ACKNOWLEDGMENTS_FILE} and land it with this change.`);
	process.exitCode = 1;
}

main();
