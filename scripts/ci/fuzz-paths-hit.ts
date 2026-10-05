/**
 * Decides whether a push or pull request touches fuzzer-related code; checks.yml's fuzz-paths job records the answer
 * as `hit` and the elevated fuzz jobs key off it. A run with no usable diff fuzzes rather than guesses.
 *
 *   dispatched run (no diff to inspect)        -> hit=false
 *   empty or unfetchable BASE                  -> hit=true
 *   BASE present but no merge base with HEAD   -> hit=true (a history rewrite)
 *   a changed path under FUZZ_PATHS            -> hit=true
 */
import { spawnSync } from "node:child_process";
import { fuzzPathsHit } from "./fuzzPaths";
import { setOutput } from "./githubActions";

function git(args: readonly string[]): { ok: boolean; stdout: string } {
	const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function decide(): boolean {
	const event = process.env.EVENT ?? "";
	const base = process.env.BASE ?? "";
	if (event !== "push" && event !== "pull_request") {
		return false;
	}
	if (base === "" || !git(["cat-file", "-e", `${base}^{commit}`]).ok) {
		console.log("no usable diff base, running the fuzz pass");
		return true;
	}
	const diff = git(["diff", "--name-only", `${base}...HEAD`]);
	if (!diff.ok) {
		console.log(`no merge base with ${base}, running the fuzz pass`);
		return true;
	}
	const changed = diff.stdout.split("\n").filter((line) => line !== "");
	console.log(changed.join("\n"));
	return fuzzPathsHit(changed);
}

setOutput("hit", String(decide()));
