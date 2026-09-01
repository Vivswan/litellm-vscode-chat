/**
 * The dead-man switch that keeps migrations from accumulating: every member of
 * MIGRATIONS (plus any out-of-runner migration module, today the bareArrayBlobs
 * read-time view) declares the date its legacy state stops being worth
 * carrying - its introduction date plus three months - and a fail-closed test
 * turns the build red once today is past it. The dates are deliberate expiry
 * decisions, free to push out - what is not free is silence.
 *
 * ZERO imports on purpose: scripts/ci/migration-expiry-table.ts static-imports
 * this module, and the release-PR workflow runs that script with bare bun and
 * --no-install (no node_modules), so this leaf must stay dependency-free -
 * the bun smoke test enforces it. An import of the extension's vscode-typed
 * graph would also break the scripts tsconfig program, which lacks the
 * extension program's ambient vscode augmentations.
 */

export interface MigrationExpiry {
	/** The migration's `state` slug, or the registered slug of an out-of-runner module. */
	readonly state: string;
	/** The module to delete when the entry expires, relative to src/extension/migrations/. */
	readonly file: string;
	/** ISO date (yyyy-mm-dd) the module landed on main (`git log --follow --diff-filter=A`). */
	readonly introduced: string;
	/** Introduction date + 3 months; the build fails once today is later. */
	readonly expires: string;
}

export const MIGRATION_EXPIRIES: readonly MigrationExpiry[] = [
	{ state: "settings-redesign", file: "settingsRedesign/apply.ts", introduced: "2026-08-08", expires: "2026-11-08" },
	{ state: "unstamped-server-secrets", file: "stampSecretOwners.ts", introduced: "2026-08-19", expires: "2026-11-19" },
	{ state: "bare-array-blobs", file: "bareArrayBlobs.ts", introduced: "2026-08-23", expires: "2026-11-23" },
	{ state: "legacy-registry-state", file: "legacyRegistryCleanup.ts", introduced: "2026-08-24", expires: "2026-11-24" },
	{
		state: "full-args-sync-fingerprints",
		file: "fingerprintProjection.ts",
		introduced: "2026-08-30",
		expires: "2026-11-30",
	},
];
