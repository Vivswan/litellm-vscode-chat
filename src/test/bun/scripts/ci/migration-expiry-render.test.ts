import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderMigrationExpiryTable } from "../../../../../scripts/ci/migration-expiry-render";
import { MIGRATION_EXPIRIES } from "../../../../extension/migrations/expiries";
import type { MigrationExpiry } from "../../../../extension/migrations/index";
import { REPO_ROOT } from "../../../util/repoRoot";
import { CHILD_PROCESS_TIMEOUT_MS } from "../../childProcessTimeout";

// Synthetic rows typed as the real registry entry type, taken through the
// index re-export on purpose: this pins that the re-export stays in place
// for consumers (the type itself is the leaf's, so it cannot drift).
const ENTRIES: readonly MigrationExpiry[] = [
	{ state: "settings-redesign", file: "settingsRedesign/apply.ts", introduced: "2026-08-08", expires: "2026-11-08" },
	{ state: "expires-today", file: "expiresToday.ts", introduced: "2026-06-01", expires: "2026-09-01" },
	{ state: "overdue", file: "overdue.ts", introduced: "2026-05-30", expires: "2026-08-30" },
];

describe("renderMigrationExpiryTable", () => {
	test("renders the header note and one row per entry with signed days remaining", () => {
		const rendered = renderMigrationExpiryTable(ENTRIES, new Date("2026-09-01T12:34:56Z"));
		expect(rendered).toBe(
			[
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

	test("renders nothing for an empty registry, which the release workflow reads as delete the comment", () => {
		// The workflow tests the rendered file with `-s` and hands `delete: true`
		// to the sticky-comment action when it is empty; a header note or a
		// bare table skeleton here would keep an empty table alive on every
		// release PR instead.
		expect(renderMigrationExpiryTable([], new Date("2026-09-01T00:00:00Z"))).toBe("");
	});

	test("days remaining counts UTC calendar dates, indifferent to the time of day", () => {
		for (const instant of ["2026-09-01T00:00:00Z", "2026-09-01T23:59:59Z"]) {
			const rendered = renderMigrationExpiryTable(ENTRIES, new Date(instant));
			expect(rendered).toContain("| 2026-08-08 | 2026-11-08 | 68 |");
			expect(rendered).toContain("| 2026-06-01 | 2026-09-01 | 0 |");
			expect(rendered).toContain("| 2026-05-30 | 2026-08-30 | -2 |");
		}
	});

	test("update-release-pr.yml runs the executable with --no-install and hands the action the PR number", () => {
		const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "update-release-pr.yml"), "utf8");
		// The workflow has no dependency-install step, and without --no-install
		// bun silently auto-installs a package import when node_modules is
		// absent; this pin keeps the flag from being dropped as clutter.
		expect(workflow).toContain("bun --no-install scripts/ci/migration-expiry-table.ts");
		// The caller runs on push, so the action learns the release PR only from
		// this input, and it skips green rather than failing without one: on the
		// drained-registry path no output betrays the skip, so the wiring is
		// pinned here.
		expect(workflow).toMatch(
			/uses: marocchino\/sticky-pull-request-comment@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+with:\n\s+header: migration-expiries\n\s+number: \$\{\{ inputs\.pr_number \}\}\n/
		);
	});

	test(
		"the executable renders the real registry without node_modules",
		() => {
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
				// The real registry decides which rendering the workflow must see: a
				// drained registry renders nothing (the delete path), a live one the
				// table.
				if (MIGRATION_EXPIRIES.length === 0) {
					expect(stdout).toBe("");
				} else {
					expect(stdout).toContain("| Migration | Introduced | Expires | Days remaining |");
					expect(stdout).toMatch(
						/^\| `[^`]+` \(`src\/extension\/migrations\/[^`]+`\) \| \d{4}-\d{2}-\d{2} \| \d{4}-\d{2}-\d{2} \| -?\d+ \|$/m
					);
				}
			} finally {
				rmSync(scaffold, { recursive: true, force: true });
			}
		},
		CHILD_PROCESS_TIMEOUT_MS
	);
});
