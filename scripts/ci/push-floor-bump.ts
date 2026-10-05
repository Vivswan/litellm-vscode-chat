/**
 * Commits and pushes the floor bump sync-vscode-floor.ts wrote onto Dependabot's own PR branch
 * (dependabot-vscode-floor.yml). Dependabot can rebase or amend the same head in this window, so a rejected push
 * refetches and rebases onto it; three attempts, then a loud failure.
 *
 *   nothing to commit                       -> exit 0, no push
 *   pushed with REPO_PLATFORM_TOKEN          -> exit 0
 *   pushed with github.token (no re-trigger) -> no_retrigger=true, a warning, exit 0
 *   three rejected pushes                    -> ::error::, exit 1
 */
import { spawnSync } from "node:child_process";
import { setOutput } from "./githubActions";

/** Only the files sync-vscode-floor.ts owns, so a stray runner edit can never ride along. */
const FLOOR_FILES = ["package.json", "README.md", "README.zh-cn.md", "README.zh-tw.md", "docs"];
const PUSH_ATTEMPTS = 3;

function env(name: string): string {
	const value = process.env[name];
	if (value === undefined) {
		throw new Error(`${name} is unset`);
	}
	return value;
}

function git(args: readonly string[]): boolean {
	return spawnSync("git", args, { stdio: "inherit" }).status === 0;
}

function must(args: readonly string[]): void {
	if (!git(args)) {
		throw new Error(`git ${args[0]} failed`);
	}
}

function main(): void {
	const token = env("TOKEN");
	const headRef = env("HEAD_REF");
	const repository = env("GITHUB_REPOSITORY");
	if (git(["diff", "--quiet"])) {
		console.log("floor already in sync");
		return;
	}
	must(["config", "user.name", "github-actions[bot]"]);
	must(["config", "user.email", "github-actions[bot]@users.noreply.github.com"]);
	must(["add", "-u", "--", ...FLOOR_FILES]);
	// [dependabot skip] keeps Dependabot rebasing and updating the PR over this commit.
	must(["commit", "-m", "build: raise engines.vscode to match @types/vscode", "-m", "[dependabot skip]"]);
	const remote = `https://x-access-token:${token}@github.com/${repository}.git`;
	let pushed = false;
	for (let attempt = 1; attempt <= PUSH_ATTEMPTS && !pushed; attempt++) {
		pushed = git(["push", remote, `HEAD:${headRef}`]);
		if (!pushed) {
			must(["fetch", "origin", headRef]);
			must(["rebase", `origin/${headRef}`]);
		}
	}
	if (!pushed) {
		console.log(`::error::could not push the floor bump after ${PUSH_ATTEMPTS} attempts`);
		process.exitCode = 1;
		return;
	}
	if (env("CAN_RETRIGGER") === "true") {
		return;
	}
	// github.token starts no workflows: say so on the PR (the workflow's sticky comment) and as an annotation, but
	// stay green, since the fleet legitimately runs without the token.
	setOutput("no_retrigger", "true");
	console.log(
		"::warning::floor bump pushed without REPO_PLATFORM_TOKEN - checks will not re-run on the new head; " +
			"close/reopen the PR or register the token as a Dependabot secret"
	);
}

main();
