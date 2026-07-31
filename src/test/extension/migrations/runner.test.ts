import * as assert from "node:assert";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "../../../extension/migrations";
import { MIGRATIONS, runMigrations } from "../../../extension/migrations";
import { ServerRegistry } from "../../../extension/servers/serverRegistry";
import { Logger } from "../../../shared/logger";
import { expectDefined, fakeFingerprintSaltSession, makeExtensionStorage } from "../../testUtils";

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
			registry: new ServerRegistry(storage.memento, storage.secrets),
			logger,
			fingerprintSalt: fakeFingerprintSaltSession(),
		},
		lines,
	};
}

function synthetic(
	state: string,
	phase: ExtensionMigration["phase"],
	run: (ctx: MigrationContext) => Promise<MigrationOutcome>,
	description = `did ${state}`
): ExtensionMigration {
	return { state, description, sourceRelease: "0.0.0", phase, run };
}

suite("extension/migrations/runner", () => {
	test("runs the phase's migrations in registration order", async () => {
		const { ctx } = makeContext();
		const calls: string[] = [];
		const record = (state: string) => async () => {
			calls.push(state);
			return "nothing-to-do" as const;
		};

		await runMigrations("pre-registration", ctx, [
			synthetic("first", "pre-registration", record("first")),
			synthetic("second", "pre-registration", record("second")),
			synthetic("third", "pre-registration", record("third")),
		]);

		assert.deepStrictEqual(calls, ["first", "second", "third"]);
	});

	test("runs only the requested phase", async () => {
		const { ctx } = makeContext();
		const calls: string[] = [];
		const record = (state: string) => async () => {
			calls.push(state);
			return "nothing-to-do" as const;
		};
		const migrations = [
			synthetic("pre", "pre-registration", record("pre")),
			synthetic("post", "post-registration", record("post")),
		];

		await runMigrations("pre-registration", ctx, migrations);
		assert.deepStrictEqual(calls, ["pre"]);

		await runMigrations("post-registration", ctx, migrations);
		assert.deepStrictEqual(calls, ["pre", "post"]);
	});

	test("a throwing migration logs once and later migrations still run", async () => {
		const { ctx, lines } = makeContext();
		const calls: string[] = [];

		await runMigrations("pre-registration", ctx, [
			synthetic("broken", "pre-registration", async () => {
				throw new Error("storage unavailable");
			}),
			synthetic("healthy", "pre-registration", async () => {
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

		await runMigrations("pre-registration", ctx, [
			synthetic("broken-a", "pre-registration", async () => {
				throw new Error("a");
			}),
			synthetic("broken-b", "pre-registration", async () => {
				throw new Error("b");
			}),
		]);
	});

	test("logs the description and source release on 'migrated' and stays silent otherwise", async () => {
		const { ctx, lines } = makeContext();

		await runMigrations("pre-registration", ctx, [
			synthetic("worked", "pre-registration", async () => "migrated", "moved the legacy state forward"),
			synthetic("idle", "pre-registration", async () => "nothing-to-do", "must never appear"),
			synthetic("partial", "pre-registration", async () => "in-progress", "must never appear either"),
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
});
