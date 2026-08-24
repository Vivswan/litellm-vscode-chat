import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_EXPIRY_MARKER, renderMigrationExpiryTable } from "../../../../../scripts/ci/migration-expiry-render";
import type { MigrationExpiry } from "../../../../extension/migrations/index";
import { REPO_ROOT } from "../../../util/repoRoot";

// Typed as the REAL registry entry type on purpose: passing these through the
// renderer is the compile-time pin that MigrationExpiry stays assignable to
// the renderer's structural MigrationExpiryRow (the scripts tsconfig program
// cannot import the registry, so the renderer mirrors the shape; this project
// can, so drift fails typecheck here).
const ENTRIES: readonly MigrationExpiry[] = [
	{ state: "settings-redesign", file: "settingsRedesign/apply.ts", introduced: "2026-08-08", expires: "2026-11-08" },
	{ state: "expires-today", file: "expiresToday.ts", introduced: "2026-06-01", expires: "2026-09-01" },
	{ state: "overdue", file: "overdue.ts", introduced: "2026-05-30", expires: "2026-08-30" },
];

describe("renderMigrationExpiryTable", () => {
	test("renders the marker first, the header note, and one row per entry with signed days remaining", () => {
		const rendered = renderMigrationExpiryTable(ENTRIES, new Date("2026-09-01T12:34:56Z"));
		expect(rendered).toBe(
			[
				MIGRATION_EXPIRY_MARKER,
				"Expired migrations fail the build; delete the migration and move its storage keys into the activation cleanup.",
				"",
				"| Migration | Introduced | Expires | Days remaining |",
				"| --- | --- | --- | --- |",
				"| `settings-redesign` (`src/extension/migrations/settingsRedesign/apply.ts`) | 2026-08-08 | 2026-11-08 | 68 |",
				"| `expires-today` (`src/extension/migrations/expiresToday.ts`) | 2026-06-01 | 2026-09-01 | 0 |",
				"| `overdue` (`src/extension/migrations/overdue.ts`) | 2026-05-30 | 2026-08-30 | -2 |",
				"",
			].join("\n")
		);
	});

	test("the marker is the first line, so the release workflow's startswith match finds the comment", () => {
		expect(MIGRATION_EXPIRY_MARKER).toBe("<!-- migration-expiries -->");
		expect(
			renderMigrationExpiryTable([], new Date("2026-09-01T00:00:00Z")).startsWith(`${MIGRATION_EXPIRY_MARKER}\n`)
		).toBe(true);
	});

	test("days remaining counts UTC calendar dates, indifferent to the time of day", () => {
		for (const instant of ["2026-09-01T00:00:00Z", "2026-09-01T23:59:59Z"]) {
			const rendered = renderMigrationExpiryTable(ENTRIES, new Date(instant));
			expect(rendered).toContain("| 2026-08-08 | 2026-11-08 | 68 |");
			expect(rendered).toContain("| 2026-06-01 | 2026-09-01 | 0 |");
			expect(rendered).toContain("| 2026-05-30 | 2026-08-30 | -2 |");
		}
	});

	test("release-pr-comment.yml's jq filter matches this exact marker literal", () => {
		// The workflow cannot import the constant, so the two literals are pinned
		// here: change the marker without the jq filter and every release-PR
		// refresh would POST a fresh comment instead of editing the old one.
		const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "release-pr-comment.yml"), "utf8");
		expect(workflow).toContain(`startswith("${MIGRATION_EXPIRY_MARKER}")`);
	});

	test("the executable renders the real registry through the vscode stub", () => {
		// The executable's registry import is deliberately invisible to tsc
		// (scripts/ci/migration-expiry-table.ts), so this smoke run is what
		// catches a moved registry or a new named vscode import in its module
		// graph on the PR instead of on a green main's release run.
		const result = Bun.spawnSync([process.execPath, join("scripts", "ci", "migration-expiry-table.ts")], {
			cwd: REPO_ROOT,
		});
		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		expect(stdout.startsWith(`${MIGRATION_EXPIRY_MARKER}\n`)).toBe(true);
		expect(stdout).toContain("| Migration | Introduced | Expires | Days remaining |");
		expect(stdout).toMatch(
			/^\| `[^`]+` \(`src\/extension\/migrations\/[^`]+`\) \| \d{4}-\d{2}-\d{2} \| \d{4}-\d{2}-\d{2} \| -?\d+ \|$/m
		);
	});
});
