/**
 * Pure renderer for the migration-expiry sticky comment posted on the
 * release-please release PR (.github/workflows/update-release-pr.yml).
 * The executable wrapper is migration-expiry-table.ts. The comment's
 * identity is the sticky-comment action's header, not anything in this
 * body: the body carries only what a reader sees.
 */

import type { MigrationExpiry } from "../../src/extension/migrations/expiries";

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

/**
 * The full markdown document for the sticky comment, or the empty string
 * when no migration is live: the workflow reads an empty rendering as "delete
 * the comment", so a release PR carries no table once the registry drains.
 */
export function renderMigrationExpiryTable(expiries: readonly MigrationExpiry[], today: Date): string {
	if (expiries.length === 0) {
		return "";
	}
	const lines = [
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
