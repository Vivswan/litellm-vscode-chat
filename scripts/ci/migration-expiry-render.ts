/**
 * Pure renderer for the migration-expiry sticky comment posted on the
 * release-please release PR (.github/workflows/release-pr-comment.yml).
 * The executable wrapper is migration-expiry-table.ts.
 */

/**
 * Structural mirror of MigrationExpiry (src/extension/migrations/index.ts).
 * Deliberately not imported: a resolvable import would pull the extension
 * module graph into the scripts tsconfig program, which lacks the
 * src/vscodeApi.d.ts ambient augmentations and the root project's flags. The
 * bun test passes real MigrationExpiry entries through the renderer, so
 * assignability drift fails typecheck there.
 */
export interface MigrationExpiryRow {
	readonly state: string;
	readonly file: string;
	readonly introduced: string;
	readonly expires: string;
}

/**
 * First line of the rendered document and the sticky-comment identity: the
 * release-PR workflow finds its earlier comment by this exact prefix, so this
 * literal and the jq filter in release-pr-comment.yml move together (a bun
 * test pins them).
 */
export const MIGRATION_EXPIRY_MARKER = "<!-- migration-expiries -->";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Calendar days from `today` to the expiry date, on UTC calendar dates the
 * way the dead-man test compares them (runner.test.ts: `today <= expires`):
 * 0 means the migration expires today with the build still green; negative
 * means overdue.
 */
function daysRemaining(expires: string, today: Date): number {
	return Math.round((Date.parse(expires) - Date.parse(today.toISOString().slice(0, 10))) / DAY_MS);
}

/** The full markdown document for the sticky comment, marker line first. */
export function renderMigrationExpiryTable(expiries: readonly MigrationExpiryRow[], today: Date): string {
	const lines = [
		MIGRATION_EXPIRY_MARKER,
		"Expired migrations fail the build; delete the migration and move its storage keys into the activation cleanup.",
		"",
		"| Migration | Introduced | Expires | Days remaining |",
		"| --- | --- | --- | --- |",
		...expiries.map(
			(entry) =>
				`| \`${entry.state}\` (\`src/extension/migrations/${entry.file}\`) | ${entry.introduced} | ${entry.expires} | ${daysRemaining(entry.expires, today)} |`
		),
	];
	return `${lines.join("\n")}\n`;
}
