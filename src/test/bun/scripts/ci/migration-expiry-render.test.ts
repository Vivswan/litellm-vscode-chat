import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MIGRATION_EXPIRY_MARKER, renderMigrationExpiryTable } from "../../../../../scripts/ci/migration-expiry-render";
import type { MigrationExpiry } from "../../../../extension/migrations/index";
import { REPO_ROOT } from "../../../util/repoRoot";

// Synthetic rows typed as the real registry entry type, taken through the
// index re-export on purpose: this pins that the re-export stays in place
// for consumers (the type itself is the leaf's, so it cannot drift).
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

	test("release-pr-comment.yml runs the executable with --no-install, like the scaffold smoke run", () => {
		// The workflow has no dependency-install step, and without --no-install
		// bun silently auto-installs a package import when node_modules is
		// absent; this pin keeps the flag from being dropped as clutter.
		const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "release-pr-comment.yml"), "utf8");
		expect(workflow).toContain("bun --no-install scripts/ci/migration-expiry-table.ts");
	});

	test("the executable renders the real registry without node_modules", () => {
		// The release-PR workflow runs the executable with bare bun and no
		// dependency install, so its runtime graph must stay repo-local with
		// zero package imports. Running it from a scaffold holding exactly that
		// graph, with --no-install matching the workflow invocation (without it
		// bun silently auto-installs a package import when node_modules is
		// absent), pins the contract: a new import fails here, on the PR that
		// introduced it, instead of on a release run.
		const RUNTIME_GRAPH = [
			join("scripts", "ci", "migration-expiry-table.ts"),
			join("scripts", "ci", "migration-expiry-render.ts"),
			join("src", "extension", "migrations", "expiries.ts"),
		];
		const scaffold = mkdtempSync(join(tmpdir(), "lvt-expiry-smoke-"));
		try {
			for (const file of RUNTIME_GRAPH) {
				mkdirSync(join(scaffold, dirname(file)), { recursive: true });
				copyFileSync(join(REPO_ROOT, file), join(scaffold, file));
			}
			const result = Bun.spawnSync(
				[process.execPath, "--no-install", join("scripts", "ci", "migration-expiry-table.ts")],
				{ cwd: scaffold }
			);
			expect(result.stderr.toString()).toBe("");
			expect(result.exitCode).toBe(0);
			const stdout = result.stdout.toString();
			expect(stdout.startsWith(`${MIGRATION_EXPIRY_MARKER}\n`)).toBe(true);
			expect(stdout).toContain("| Migration | Introduced | Expires | Days remaining |");
			expect(stdout).toMatch(
				/^\| `[^`]+` \(`src\/extension\/migrations\/[^`]+`\) \| \d{4}-\d{2}-\d{2} \| \d{4}-\d{2}-\d{2} \| -?\d+ \|$/m
			);
		} finally {
			rmSync(scaffold, { recursive: true, force: true });
		}
	});
});
