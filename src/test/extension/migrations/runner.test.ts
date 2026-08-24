import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "../../../extension/migrations";
import { MIGRATION_EXPIRIES, MIGRATIONS, runMigrations } from "../../../extension/migrations";
import { Logger } from "../../../shared/logger";
import { expectDefined } from "../../pureHelpers";
import { fakeFingerprintSaltSession, makeExtensionStorage } from "../../testUtils";
import { REPO_ROOT } from "../../util/repoRoot";

function makeContext(): { ctx: MigrationContext; lines: string[] } {
	const storage = makeExtensionStorage();
	const lines: string[] = [];
	const logger = new Logger({
		info: (message: string) => lines.push(message),
		error: (message: string) => lines.push(`ERROR: ${message}`),
	});
	return {
		ctx: {
			globalState: storage.memento,
			secrets: storage.secrets,
			logger,
			fingerprintSalt: fakeFingerprintSaltSession(),
		},
		lines,
	};
}

function synthetic(
	state: string,
	run: (ctx: MigrationContext) => Promise<MigrationOutcome>,
	description = `did ${state}`
): ExtensionMigration {
	return { state, description, sourceRelease: "0.0.0", run };
}

suite("extension/migrations/runner", () => {
	test("runs the migrations in registration order", async () => {
		const { ctx } = makeContext();
		const calls: string[] = [];
		const record = (state: string) => async () => {
			calls.push(state);
			return "nothing-to-do" as const;
		};

		await runMigrations(ctx, [synthetic("first", record("first")), synthetic("second", record("second"))]);

		assert.deepStrictEqual(calls, ["first", "second"]);
	});

	test("a throwing migration logs once and later migrations still run", async () => {
		const { ctx, lines } = makeContext();
		const calls: string[] = [];

		await runMigrations(ctx, [
			synthetic("broken", async () => {
				throw new Error("storage unavailable");
			}),
			synthetic("healthy", async () => {
				calls.push("healthy");
				return "nothing-to-do";
			}),
		]);

		assert.deepStrictEqual(calls, ["healthy"], "the failure must not stop later migrations");
		// Logger.error emits one failure line plus a stack-trace line; the
		// migration failure itself must be reported exactly once.
		const errors = lines.filter((l) => l.includes("failed"));
		assert.strictEqual(errors.length, 1, `expected exactly one failure line, got: ${lines.join(" | ")}`);
		const errorLine = expectDefined(errors[0]);
		assert.ok(errorLine.includes('"broken"'), errorLine);
		assert.ok(errorLine.includes("storage unavailable"), errorLine);
	});

	test("never rejects even when every migration throws", async () => {
		const { ctx } = makeContext();

		await runMigrations(ctx, [
			synthetic("broken-a", async () => {
				throw new Error("a");
			}),
			synthetic("broken-b", async () => {
				throw new Error("b");
			}),
		]);
	});

	test("logs the description and source release on 'migrated' and stays silent otherwise", async () => {
		const { ctx, lines } = makeContext();

		await runMigrations(ctx, [
			synthetic("worked", async () => "migrated", "moved the legacy state forward"),
			synthetic("idle", async () => "nothing-to-do", "must never appear"),
			synthetic("partial", async () => "in-progress", "must never appear either"),
		]);

		assert.deepStrictEqual(lines, ["moved the legacy state forward (away from v0.0.0 state)"]);
	});

	test("MIGRATIONS is ordered chronologically by sourceRelease", () => {
		// Ties keep registration order, so non-decreasing releases are the whole
		// contract; the array cannot drift when a new migration lands mid-list.
		const parse = (release: string): number[] => {
			assert.match(release, /^\d+\.\d+\.\d+$/, `sourceRelease "${release}" must be a plain semver triple`);
			return release.split(".").map(Number);
		};
		for (let i = 1; i < MIGRATIONS.length; i++) {
			const previous = expectDefined(MIGRATIONS[i - 1]);
			const current = expectDefined(MIGRATIONS[i]);
			const a = parse(previous.sourceRelease);
			const b = parse(current.sourceRelease);
			const laterThanNext =
				expectDefined(a[0]) > expectDefined(b[0]) ||
				(a[0] === b[0] && expectDefined(a[1]) > expectDefined(b[1])) ||
				(a[0] === b[0] && a[1] === b[1] && expectDefined(a[2]) > expectDefined(b[2]));
			assert.ok(
				!laterThanNext,
				`"${previous.state}" (v${previous.sourceRelease}) is registered before "${current.state}" (v${current.sourceRelease}) but migrates away from a later release`
			);
		}
	});

	suite("expiry registry", () => {
		const migrationsDir = path.join(REPO_ROOT, "src", "extension", "migrations");
		// The migration modules that live outside the MIGRATIONS runner: today
		// only the bareArrayBlobs read-time view. A new out-of-runner module
		// joins the dead-man switch by joining this set.
		const OUT_OF_RUNNER_STATES = ["bare-array-blobs"];
		/** A string is a real calendar date only if Date round-trips it unchanged. */
		const isRealIsoDate = (value: string): boolean =>
			/^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

		test("the registry and the live migrations match exactly, and every entry is well-formed", () => {
			// Fail-closed both ways: a migration without an expiry entry never
			// expires, and an entry no live migration answers to is a stale or
			// duplicate row to delete.
			const expected = [...MIGRATIONS.map((migration) => migration.state), ...OUT_OF_RUNNER_STATES].sort();
			assert.deepStrictEqual(
				MIGRATION_EXPIRIES.map((entry) => entry.state).sort(),
				expected,
				"MIGRATION_EXPIRIES must list every live migration exactly once"
			);
			for (const entry of MIGRATION_EXPIRIES) {
				assert.ok(
					fs.existsSync(path.join(migrationsDir, entry.file)),
					`MIGRATION_EXPIRIES entry "${entry.state}" names ${entry.file}, which no longer exists: delete the entry`
				);
				assert.ok(isRealIsoDate(entry.introduced), `"${entry.state}" introduced date must be a real yyyy-mm-dd date`);
				assert.ok(isRealIsoDate(entry.expires), `"${entry.state}" expiry date must be a real yyyy-mm-dd date`);
				assert.ok(entry.introduced < entry.expires, `"${entry.state}" must expire after it was introduced`);
			}
		});

		test("every module in migrations/ is covered by a registered expiry", () => {
			// The directory is the truth the registry must keep up with: a new
			// migration module - runner-registered or not - fails here until it
			// carries a MIGRATION_EXPIRIES row (a support module inside a registered
			// migration's own directory, like settingsRedesign/'s, rides its entry).
			const registeredFiles = MIGRATION_EXPIRIES.map((entry) => entry.file);
			for (const name of fs.readdirSync(migrationsDir)) {
				// index.ts (the runner and registrations) and expiries.ts (the expiry
				// registry itself) are registry machinery, not migrations.
				if (name === "index.ts" || name === "expiries.ts") {
					continue;
				}
				const covered = fs.statSync(path.join(migrationsDir, name)).isDirectory()
					? registeredFiles.some((file) => file.startsWith(`${name}/`))
					: registeredFiles.includes(name);
				assert.ok(
					covered,
					`src/extension/migrations/${name} has no MIGRATION_EXPIRIES entry: every migration module must declare its expiry date (introduction date + 3 months)`
				);
			}
		});

		test("no migration is past its expiry date", () => {
			// The dead-man switch: migrations may not accumulate silently. Real ISO
			// yyyy-mm-dd strings compare correctly as strings; no date library needed.
			const today = new Date().toISOString().slice(0, 10);
			for (const entry of MIGRATION_EXPIRIES) {
				assert.ok(
					today <= entry.expires,
					`Migration "${entry.state}" expired on ${entry.expires}. Delete src/extension/migrations/${entry.file}, its tests, its MIGRATIONS registration, and this MIGRATION_EXPIRIES entry; move any globalState keys it alone kept alive into legacyRegistryCleanup.ts's cleanup list so leftover state still gets deleted (when the cleanup itself is what expired, delete its keys from storageKeys.ts instead). Or deliberately push the date out.`
				);
			}
		});
	});
});
