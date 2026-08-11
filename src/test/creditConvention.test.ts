import * as assert from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	ACKNOWLEDGMENTS_BOUNDARY,
	ACKNOWLEDGMENTS_FILE,
	acknowledgedLogins,
	extractSubjectCredits,
} from "./creditConvention";

/**
 * History guard for the crediting convention: every commit subject carrying
 * "(#N, thanks @login)" must have a row for that login in ACKNOWLEDGMENTS.md
 * (the file's header: a row here means the report changed the code). The
 * commit-msg hook (scripts/ci/check-credit-rows.ts) catches the crediting
 * commit itself, whose subject is not yet in `git log` when this runs; this
 * test is the safety net for anything that slipped past it - hooks bypassed
 * with --no-verify, subjects rewritten in the GitHub merge UI. Tests run
 * from out/test, so the repo root is two levels up.
 */
const repoRoot = path.resolve(__dirname, "..", "..");

const git = async (...args: string[]): Promise<string> =>
	(await promisify(execFile)("git", args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 })).stdout;

suite("credit convention guard: subject grammar", () => {
	test("the documented convention example extracts its login and issue", () => {
		assert.deepStrictEqual(extractSubjectCredits("fix: normalize base URL slashes (#53, thanks @Pandaplanes)"), [
			{ login: "Pandaplanes", issues: [53] },
		]);
	});

	test("multiple logins and issue refs in one credit group all extract", () => {
		assert.deepStrictEqual(
			extractSubjectCredits("feat: widen the net (#12, #34, thanks @first, @Se-cond and @third)"),
			[
				{ login: "first", issues: [12, 34] },
				{ login: "Se-cond", issues: [12, 34] },
				{ login: "third", issues: [12, 34] },
			]
		);
	});

	test("a subject that mentions an @login without the credit pattern is not a credit", () => {
		for (const subject of [
			"docs: describe @vscode/l10n extraction",
			"fix: follow up on a report from @someone",
			"fix: guard the parser (thanks @someone)",
			"fix: close the loop (#53) for @someone",
			"fix: harden the probe (#53, thanks for the report; ping @maintainer)",
			"fix: prose thanks (#53, thanks to the community around @someone)",
		]) {
			assert.deepStrictEqual(extractSubjectCredits(subject), [], subject);
		}
	});

	test("separator variants between logins all parse", () => {
		for (const list of ["@a, @b, and @c", "@a and @b and @c", "@a, @b, @c"]) {
			assert.deepStrictEqual(
				extractSubjectCredits(`fix: widen (#9, thanks ${list})`).map((credit) => credit.login),
				["a", "b", "c"],
				list
			);
		}
	});

	test("acknowledged rows match case-insensitively", () => {
		const rows = acknowledgedLogins("| [@MixedCase](https://github.com/MixedCase) | Something ([#1](x)) |\n");
		assert.ok(rows.has("mixedcase"));
		assert.ok(!rows.has("MixedCase"), "the set is lowercased; callers lowercase before lookup");
	});
});

suite("credit convention guard: git history vs ACKNOWLEDGMENTS.md", () => {
	test("every login credited in a commit subject since the file landed has a row", async function () {
		this.timeout(30000);
		// Shallow CI clones may not reach the boundary commit; scan whatever
		// history is available then (at worst just HEAD's subject). Ancestry,
		// not mere object existence: an unreachable boundary would make the
		// range scan and the regex-rot canary below reason about the wrong
		// history. The full range runs locally (pre-commit) and wherever
		// fetch-depth is 0.
		const boundaryPresent = await git("merge-base", "--is-ancestor", ACKNOWLEDGMENTS_BOUNDARY, "HEAD").then(
			() => true,
			() => false
		);
		const subjects = (await git("log", "--format=%s", boundaryPresent ? `${ACKNOWLEDGMENTS_BOUNDARY}..HEAD` : "HEAD"))
			.split("\n")
			.filter((subject) => subject !== "");
		const rows = acknowledgedLogins(fs.readFileSync(path.join(repoRoot, ACKNOWLEDGMENTS_FILE), "utf8"));
		assert.ok(rows.size >= 20, `ACKNOWLEDGMENTS.md parses into real rows (got ${rows.size})`);
		let credited = 0;
		for (const subject of subjects) {
			for (const credit of extractSubjectCredits(subject)) {
				credited += 1;
				assert.ok(
					rows.has(credit.login.toLowerCase()),
					`"${subject}" credits @${credit.login}, but ACKNOWLEDGMENTS.md has no row for them - add one (its header requires it)`
				);
			}
		}
		// The strict grammar rejects near-miss credit forms ("thanks @x for the
		// report", "thanks to @x") silently; make those loud instead of letting
		// a malformed credit land unguarded.
		const nearMisses = subjects.filter(
			(subject) => /thanks\s+@/i.test(subject) && extractSubjectCredits(subject).length === 0
		);
		assert.deepStrictEqual(
			nearMisses,
			[],
			"a subject thanks an @login in a form the credit grammar does not recognize; fix the subject or the grammar"
		);
		if (boundaryPresent) {
			// Regex-rot canary: post-boundary history is known to contain credits,
			// so extracting none means the grammar no longer matches reality.
			assert.ok(credited > 0, "the credit grammar matched no post-boundary subject; the extractor has drifted");
		}
	});
});
