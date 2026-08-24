/// <reference types="bun" />

/**
 * Prints the migration-expiry sticky comment for the release PR to stdout:
 * every MIGRATION_EXPIRIES row with its days remaining as of today.
 * .github/workflows/release-pr-comment.yml renders this and posts/updates the
 * comment.
 *
 * MIGRATION_EXPIRIES lives in src/extension/migrations/index.ts, whose module
 * graph reaches runtime `vscode` imports, so the registry loads behind a Bun
 * module stub registered before the dynamic import. The stub's named exports
 * cover every named vscode import reachable from that graph today; a new one
 * fails this script loudly ("Export named ... not found in module 'vscode'"),
 * and the bun smoke test runs this executable so the break lands on the PR
 * that introduced it.
 */

import type { MigrationExpiryRow } from "./migration-expiry-render";
import { renderMigrationExpiryTable } from "./migration-expiry-render";

/**
 * The registry crosses an untyped import (see main below), so its shape is
 * re-established at runtime; any drift fails the workflow step loudly.
 */
function parseExpiries(value: unknown): readonly MigrationExpiryRow[] {
	if (!Array.isArray(value)) {
		throw new Error("MIGRATION_EXPIRIES is not an array; did the registry move or get renamed?");
	}
	return value.map((entry: unknown, index) => {
		if (typeof entry !== "object" || entry === null) {
			throw new Error(`MIGRATION_EXPIRIES[${index}] is not an object`);
		}
		const { state, file, introduced, expires } = entry as Record<string, unknown>;
		if (
			typeof state !== "string" ||
			typeof file !== "string" ||
			typeof introduced !== "string" ||
			typeof expires !== "string"
		) {
			throw new Error(`MIGRATION_EXPIRIES[${index}] is missing one of state/file/introduced/expires`);
		}
		return { state, file, introduced, expires };
	});
}

async function main(): Promise<void> {
	Bun.plugin({
		name: "vscode-stub",
		setup(build) {
			build.module("vscode", () => ({
				exports: {
					CancellationError: class {},
					EventEmitter: class {},
					LanguageModelError: class {},
					ThemeIcon: class {},
				},
				loader: "object",
			}));
		},
	});
	// The specifier stays a variable so tsc cannot resolve it: a static import
	// would pull the extension module graph into the scripts tsconfig program,
	// which lacks the src/vscodeApi.d.ts ambient augmentations and the root
	// project's flags. Bun still resolves it relative to this file at runtime.
	const registryModule = "../../src/extension/migrations/index.ts";
	const { MIGRATION_EXPIRIES } = (await import(registryModule)) as { MIGRATION_EXPIRIES: unknown };
	process.stdout.write(renderMigrationExpiryTable(parseExpiries(MIGRATION_EXPIRIES), new Date()));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
