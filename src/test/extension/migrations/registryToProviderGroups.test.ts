import * as assert from "node:assert";
import * as vscode from "vscode";
import type { FingerprintSaltSession } from "../../../extension/fingerprintSalt";
import { getMigratedServerLabels, unionLabelSources } from "../../../extension/migrations/labelScopedModelParameters";
import { legacySingleServerMigration } from "../../../extension/migrations/legacySingleServer";
import {
	isGroupMigrationComplete,
	isGroupMigrationRunning,
	migrateServersToProviderGroups,
	registryToProviderGroupsMigration,
} from "../../../extension/migrations/registryToProviderGroups";
import { ServerRegistry } from "../../../extension/servers/serverRegistry";
import {
	apiKeySecret,
	GROUP_MIGRATION_COMPLETE_KEY,
	LEGACY_API_KEY_SECRET,
	LEGACY_BASE_URL_SECRET,
	MIGRATED_SERVER_IDS_KEY,
	MIGRATED_SERVER_LABELS_KEY,
	PENDING_GROUP_SUBMISSION_KEY,
	PENDING_SECRET_DELETIONS_KEY,
	SEEDED_PROVIDER_GROUPS_KEY,
	SERVER_REGISTRY_KEY,
	SKIPPED_MIGRATION_SERVERS_KEY,
} from "../../../shared/config/storageKeys";
import type { Logger } from "../../../shared/logger";
import { fingerprint } from "../../../shared/util/fingerprint";
import { makeLogger } from "../../pureHelpers";
import type { FakeExtensionStorage } from "../../testUtils";
import { fakeFingerprintSaltSession, makeExtensionStorage, makeMigrationContext } from "../../testUtils";

interface GroupSubmission {
	command: string;
	group: { vendor: string; name: string; label: string; baseUrl: string; apiKey: string | undefined };
}

/**
 * Simulates the host side of lm.migrateLanguageModelsProviderGroup: accepted
 * group names persist, and re-submitting one is rejected the way the real
 * host rejects duplicates. `failOnce` injects one non-duplicate failure per
 * matching name.
 */
function makeFakeHost(failOnce: ReadonlySet<string> = new Set()) {
	const groups = new Set<string>();
	const submissions: GroupSubmission[] = [];
	const pendingFailures = new Set(failOnce);
	const exec = async (command: string, ...args: unknown[]): Promise<unknown> => {
		const group = args[0] as GroupSubmission["group"];
		submissions.push({ command, group });
		if (pendingFailures.has(group.name)) {
			pendingFailures.delete(group.name);
			throw new Error("host rejected the group");
		}
		if (groups.has(group.name)) {
			throw new Error(`Language model group with name ${group.name} already exists for vendor litellm`);
		}
		groups.add(group.name);
		return undefined;
	};
	return { exec, groups, submissions };
}

function migrate(
	registry: ServerRegistry,
	storage: FakeExtensionStorage,
	logger: Logger,
	exec: (command: string, ...args: unknown[]) => Promise<unknown>
): Promise<boolean> {
	return migrateServersToProviderGroups(
		registry,
		storage.memento,
		storage.secrets,
		logger,
		fakeFingerprintSaltSession(),
		exec
	);
}

/** Capture skip notices; migration warns once per skipped server. */
async function withWarnings(fn: () => Promise<void>): Promise<string[]> {
	const warnings: string[] = [];
	const origWarn = vscode.window.showWarningMessage;
	(vscode.window as Record<string, unknown>).showWarningMessage = async (message: string) => {
		warnings.push(message);
		return undefined;
	};
	try {
		await fn();
	} finally {
		(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
	}
	return warnings;
}

function expectMessage(message: string | undefined): string {
	assert.ok(message !== undefined, "expected a warning message");
	return message;
}

suite("extension/migrations/registryToProviderGroups", () => {
	test("migrates every registry server, persists the label map, and clears the registry", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Production", "http://prod.test", "prod-key");
		await registry.addServer("Local", "http://local.test", "");
		const { logger } = makeLogger();
		const host = makeFakeHost();

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, true);
		assert.deepStrictEqual(
			host.submissions.map((s) => [s.command, s.group.vendor, s.group.name, s.group.baseUrl, s.group.apiKey]),
			[
				["lm.migrateLanguageModelsProviderGroup", "litellm", "Production", "http://prod.test", "prod-key"],
				["lm.migrateLanguageModelsProviderGroup", "litellm", "Local", "http://local.test", undefined],
			]
		);
		assert.deepStrictEqual(
			host.submissions.map((s) => s.group.label),
			["Production", "Local"],
			"the label rides each submission so migrated groups can serve per-entry modelParameters"
		);
		assert.strictEqual(storage.mementoStore.get(GROUP_MIGRATION_COMPLETE_KEY), true);
		assert.deepStrictEqual(storage.mementoStore.get(MIGRATED_SERVER_LABELS_KEY), {
			"http://prod.test": ["Production"],
			"http://local.test": ["Local"],
		});
		assert.strictEqual(storage.mementoStore.get(SEEDED_PROVIDER_GROUPS_KEY), undefined);
		assert.strictEqual(storage.mementoStore.get(SKIPPED_MIGRATION_SERVERS_KEY), undefined);
		assert.deepStrictEqual(registry.getServers(), []);
		assert.strictEqual(storage.secretStore.size, 0, "per-server secrets must be deleted with the registry entries");
	});

	test("a rejected server stays while accepted ones migrate, with their label mappings live immediately", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Production", "http://prod.test", "prod-key");
		await registry.addServer("Local", "http://local.test", "local-key");
		const { logger, lines } = makeLogger();
		const host = makeFakeHost(new Set(["Local"]));

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, false);
		assert.strictEqual(isGroupMigrationComplete(storage.memento), false);
		assert.deepStrictEqual(
			storage.mementoStore.get(MIGRATED_SERVER_LABELS_KEY),
			{ "http://prod.test": ["Production"] },
			"the migrated server's label mapping must be live while a sibling still fails"
		);
		assert.deepStrictEqual(
			registry.getServers().map((s) => s.label),
			["Local"],
			"the accepted server is removed as it seeds; the rejected one stays"
		);
		assert.strictEqual(storage.secretStore.size, 1, "only the unmigrated server's secret remains");
		const progress = storage.mementoStore.get(SEEDED_PROVIDER_GROUPS_KEY) as Array<{ name: string }>;
		assert.deepStrictEqual(
			progress.map((p) => p.name),
			["Production"]
		);
		assert.ok(
			lines.some((l) => l.includes("deferred a server")),
			`Expected a deferred-server log line. Lines: ${lines.join(" | ")}`
		);
	});

	test("retrying after a partial failure completes without re-submitting accepted groups", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Production", "http://prod.test", "prod-key");
		await registry.addServer("Local", "http://local.test", "local-key");
		const { logger } = makeLogger();
		const host = makeFakeHost(new Set(["Local"]));

		await migrate(registry, storage, logger, host.exec);
		const retryStart = host.submissions.length;
		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, true);
		assert.deepStrictEqual(
			host.submissions.slice(retryStart).map((s) => s.group.name),
			["Local"],
			"accepted groups must not be re-submitted, and the host would reject them as duplicates"
		);
		assert.strictEqual(isGroupMigrationComplete(storage.memento), true);
		assert.deepStrictEqual(registry.getServers(), []);
		assert.deepStrictEqual(storage.mementoStore.get(MIGRATED_SERVER_LABELS_KEY), {
			"http://prod.test": ["Production"],
			"http://local.test": ["Local"],
		});
	});

	test("a crash after seeding finishes on the next run: matching entries are removed via their records", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const server = await registry.addServer("Production", "http://prod.test", "prod-key");
		storage.mementoStore.set(SEEDED_PROVIDER_GROUPS_KEY, [
			{
				id: server.id,
				name: "Production",
				label: "Production",
				baseUrl: "http://prod.test",
				keyFingerprint: fingerprint("prod-key"),
			},
		]);
		const { logger } = makeLogger();
		const host = makeFakeHost();
		host.groups.add("Production");

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, true);
		assert.deepStrictEqual(host.submissions, [], "a recorded group must not be re-submitted");
		assert.deepStrictEqual(registry.getServers(), []);
		assert.strictEqual(isGroupMigrationComplete(storage.memento), true);
	});

	test("the seeding pass defers entirely under a session-only fingerprint salt", async () => {
		// Seeded records and the pending marker persist key fingerprints a
		// LATER session must recognize, and the recovery path compares stored
		// records against freshly computed ones. Under a session-only salt
		// both would misfire, so nothing may be seeded, recorded, or skipped.
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Production", "http://prod.test", "prod-key");
		const { logger, lines } = makeLogger();
		const host = makeFakeHost();

		const completed = await migrateServersToProviderGroups(
			registry,
			storage.memento,
			storage.secrets,
			logger,
			fakeFingerprintSaltSession("session-only"),
			host.exec
		);

		assert.strictEqual(completed, false);
		assert.deepStrictEqual(host.submissions, [], "no group may be submitted under a session-only salt");
		assert.strictEqual(registry.getServers().length, 1, "the registry retains the deferred server");
		assert.strictEqual(storage.mementoStore.get(SEEDED_PROVIDER_GROUPS_KEY), undefined);
		assert.strictEqual(storage.mementoStore.get(PENDING_GROUP_SUBMISSION_KEY), undefined);
		assert.strictEqual(storage.mementoStore.get(SKIPPED_MIGRATION_SERVERS_KEY), undefined);
		assert.ok(
			lines.some((line) => line.includes("session-only")),
			"the deferral is logged as a classification"
		);
	});

	test("a salt mutation detected mid-loop stops the remaining seeding", async () => {
		// The salt is re-confirmed per server: each iteration persists a record
		// or compares stored fingerprints, so a mutation landing mid-loop must
		// stop the remaining writes; the rest retries next activation.
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("First", "http://first.test", "key-1");
		await registry.addServer("Second", "http://second.test", "key-2");
		const { logger } = makeLogger();
		const host = makeFakeHost();
		// Pre-loop gate, First's iteration, then the mutation lands.
		const answers: ("durable" | "session-only")[] = ["durable", "durable", "session-only"];
		const mutatingSession: FingerprintSaltSession = {
			state: () => "durable",
			confirmDurable: async () => answers.shift() ?? "session-only",
		};

		const completed = await migrateServersToProviderGroups(
			registry,
			storage.memento,
			storage.secrets,
			logger,
			mutatingSession,
			host.exec
		);

		assert.strictEqual(completed, false);
		assert.strictEqual(host.submissions.length, 1, "only the server seeded before the mutation lands");
		assert.strictEqual(host.submissions[0]?.group.name, "First");
		assert.strictEqual(registry.getServers().length, 1, "the second server stays for the next activation");
	});

	test("a recorded entry that no longer matches its record is kept, marked skipped, and announced once", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const server = await registry.addServer("Production", "http://prod.test", "edited-key");
		storage.mementoStore.set(SEEDED_PROVIDER_GROUPS_KEY, [
			{
				id: server.id,
				name: "Production",
				label: "Production",
				baseUrl: "http://prod.test",
				keyFingerprint: fingerprint("original-key"),
			},
		]);
		const { logger } = makeLogger();
		const host = makeFakeHost();

		const warnings = await withWarnings(async () => {
			assert.strictEqual(await migrate(registry, storage, logger, host.exec), false);
			assert.strictEqual(await migrate(registry, storage, logger, host.exec), false);
		});

		assert.strictEqual(registry.getServers().length, 1, "the mismatched entry must not be removed");
		assert.deepStrictEqual(storage.mementoStore.get(SKIPPED_MIGRATION_SERVERS_KEY), [server.id]);
		assert.strictEqual(warnings.length, 1, "the skip must be announced exactly once across runs");
		const skipWarning = expectMessage(warnings[0]);
		assert.ok(skipWarning.includes("changed after it was migrated"), skipWarning);
	});

	test("a finalization that fails after the durable-id write retries and completes", async () => {
		// The completion flag is written LAST: were it written before the
		// record clears, a failed clear would leave the completed fast path
		// returning early forever with the finalization half done.
		const storage = makeExtensionStorage();
		storage.mementoStore.set(SEEDED_PROVIDER_GROUPS_KEY, [
			{ id: "aaaa1111", name: "Production", label: "Production", baseUrl: "http://prod.test", keyFingerprint: "0" },
		]);
		const { logger } = makeLogger();
		const host = makeFakeHost();
		const originalUpdate = storage.memento.update.bind(storage.memento);
		let broken = true;
		(storage.memento as { update(key: string, value: unknown): Thenable<void> }).update = async (key, value) => {
			if (key === SEEDED_PROVIDER_GROUPS_KEY && value === undefined && broken) {
				throw new Error("memento write failed");
			}
			await originalUpdate(key, value);
		};
		const registry = new ServerRegistry(storage.memento, storage.secrets);

		await assert.rejects(migrate(registry, storage, logger, host.exec), /memento write failed/);

		assert.deepStrictEqual(storage.mementoStore.get(MIGRATED_SERVER_IDS_KEY), ["aaaa1111"]);
		assert.strictEqual(
			isGroupMigrationComplete(storage.memento),
			false,
			"the flag must not be set while the finalization is unfinished"
		);

		broken = false;
		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, true, "the state-derived finalization must retry and finish");
		assert.strictEqual(isGroupMigrationComplete(storage.memento), true);
		assert.strictEqual(storage.mementoStore.get(SEEDED_PROVIDER_GROUPS_KEY), undefined);
		assert.deepStrictEqual(storage.mementoStore.get(MIGRATED_SERVER_IDS_KEY), ["aaaa1111"]);
	});

	test("crash before the flag: finalization is state-derived on the next activation", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		storage.mementoStore.set(SEEDED_PROVIDER_GROUPS_KEY, [
			{ id: "aaaa1111", name: "Production", label: "Production", baseUrl: "http://prod.test", keyFingerprint: "0" },
			{ id: "bbbb2222", name: "Local", label: "Local", baseUrl: "http://local.test", keyFingerprint: "0" },
		]);
		// A removal that cleared the entry but failed on the secret leaves this orphan.
		storage.secretStore.set(apiKeySecret("aaaa1111"), "orphaned-key");
		const { logger } = makeLogger();
		const host = makeFakeHost();

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, true);
		assert.deepStrictEqual(host.submissions, []);
		assert.strictEqual(isGroupMigrationComplete(storage.memento), true);
		assert.deepStrictEqual(storage.mementoStore.get(MIGRATED_SERVER_LABELS_KEY), {
			"http://prod.test": ["Production"],
			"http://local.test": ["Local"],
		});
		assert.strictEqual(storage.mementoStore.get(SEEDED_PROVIDER_GROUPS_KEY), undefined);
		assert.strictEqual(storage.secretStore.size, 0, "orphaned secrets must be re-deleted at finalization");
	});

	test("an unrelated 'already exists' error is an ordinary failure, not a duplicate", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Production", "http://prod.test", "");
		const { logger } = makeLogger();

		const warnings = await withWarnings(async () => {
			const completed = await migrateServersToProviderGroups(
				registry,
				storage.memento,
				storage.secrets,
				logger,
				fakeFingerprintSaltSession(),
				async () => {
					throw new Error("a chat session with this identifier already exists");
				}
			);
			assert.strictEqual(completed, false);
		});

		assert.strictEqual(storage.mementoStore.get(SKIPPED_MIGRATION_SERVERS_KEY), undefined);
		assert.deepStrictEqual(warnings, [], "an ordinary failure retries silently on next activation");
		assert.strictEqual(registry.getServers().length, 1);
	});

	test("the host's duplicate shape with a different vendor is not a duplicate", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Production", "http://prod.test", "");
		const { logger } = makeLogger();

		const warnings = await withWarnings(async () => {
			const completed = await migrateServersToProviderGroups(
				registry,
				storage.memento,
				storage.secrets,
				logger,
				fakeFingerprintSaltSession(),
				async () => {
					throw new Error("Language model group with name Production already exists for vendor openai");
				}
			);
			assert.strictEqual(completed, false);
		});

		assert.strictEqual(storage.mementoStore.get(SKIPPED_MIGRATION_SERVERS_KEY), undefined);
		assert.deepStrictEqual(warnings, []);
		assert.strictEqual(registry.getServers().length, 1);
	});

	test("a duplicate caused by our own interrupted submission counts as seeded", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const server = await registry.addServer("Production", "http://prod.test", "prod-key");
		// A previous run crashed while the submission was in flight, leaving
		// only the pending marker (full identity) behind.
		storage.mementoStore.set(PENDING_GROUP_SUBMISSION_KEY, {
			id: server.id,
			name: "Production",
			baseUrl: "http://prod.test",
			keyFingerprint: fingerprint("prod-key"),
		});
		const { logger } = makeLogger();
		const host = makeFakeHost();
		host.groups.add("Production");

		const warnings = await withWarnings(async () => {
			assert.strictEqual(await migrate(registry, storage, logger, host.exec), true);
		});

		assert.deepStrictEqual(registry.getServers(), []);
		assert.strictEqual(isGroupMigrationComplete(storage.memento), true);
		assert.deepStrictEqual(warnings, [], "our own interrupted submission is not a collision to announce");
	});

	test("a marker whose recorded identity no longer matches the server is a foreign collision", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const server = await registry.addServer("Production", "http://prod.test", "rotated-key");
		// The marker recorded the pre-rotation identity; the group's real
		// configuration is unknowable, so the entry must be retained.
		storage.mementoStore.set(PENDING_GROUP_SUBMISSION_KEY, {
			id: server.id,
			name: "Production",
			baseUrl: "http://prod.test",
			keyFingerprint: fingerprint("old-key"),
		});
		const { logger } = makeLogger();
		const host = makeFakeHost();
		host.groups.add("Production");

		const warnings = await withWarnings(async () => {
			assert.strictEqual(await migrate(registry, storage, logger, host.exec), false);
		});

		assert.strictEqual(registry.getServers().length, 1, "a mismatched marker must not authorize removal");
		assert.deepStrictEqual(storage.mementoStore.get(SKIPPED_MIGRATION_SERVERS_KEY), [server.id]);
		assert.strictEqual(warnings.length, 1);
	});

	test("an ordinary failure clears the pending marker", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Production", "http://prod.test", "");
		const { logger } = makeLogger();

		const completed = await migrateServersToProviderGroups(
			registry,
			storage.memento,
			storage.secrets,
			logger,
			fakeFingerprintSaltSession(),
			async () => {
				throw new Error("host rejected the group");
			}
		);

		assert.strictEqual(completed, false);
		assert.strictEqual(
			storage.mementoStore.get(PENDING_GROUP_SUBMISSION_KEY),
			undefined,
			"a rejected submission must not leave a stale marker that later legitimizes a foreign group"
		);
	});

	test("metadata writes union with concurrent additions instead of overwriting them", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Production", "http://prod.test", "prod-key");
		await registry.addServer("Local", "http://local.test", "local-key");
		const { logger } = makeLogger();
		const foreignRecord = {
			id: "ffff9999",
			name: "Foreign",
			label: "Foreign",
			baseUrl: "http://foreign.test",
			keyFingerprint: fingerprint("x"),
		};
		const host = makeFakeHost(new Set(["Local"]));
		let injected = false;
		const exec = async (command: string, ...args: unknown[]): Promise<unknown> => {
			// Another window persists its own record while this submission is in
			// flight; the write that follows must not clobber it.
			if (!injected) {
				injected = true;
				const existing = (storage.mementoStore.get(SEEDED_PROVIDER_GROUPS_KEY) as unknown[]) ?? [];
				storage.mementoStore.set(SEEDED_PROVIDER_GROUPS_KEY, [...existing, foreignRecord]);
			}
			return host.exec(command, ...args);
		};

		await migrate(registry, storage, logger, exec);

		const records = storage.mementoStore.get(SEEDED_PROVIDER_GROUPS_KEY) as Array<{ name: string }>;
		assert.deepStrictEqual(
			records.map((r) => r.name).sort(),
			["Foreign", "Production"],
			"the concurrent window's record must survive the union write"
		);
	});

	test("a secret that fails to delete at finalization is retried on the next activation", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const server = await registry.addServer("Production", "http://prod.test", "prod-key");
		const { logger } = makeLogger();
		const host = makeFakeHost();
		const failingKey = apiKeySecret(server.id);
		const originalDelete = storage.secrets.delete.bind(storage.secrets);
		let deletionsBroken = true;
		storage.secrets.delete = async (key: string) => {
			if (key === failingKey && deletionsBroken) {
				throw new Error("keychain unavailable");
			}
			await originalDelete(key);
		};

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, true, "a failed secret deletion must not block completion");
		assert.deepStrictEqual(storage.mementoStore.get(PENDING_SECRET_DELETIONS_KEY), [server.id]);
		assert.ok(storage.secretStore.has(failingKey), "the secret is still orphaned after the failed run");

		deletionsBroken = false;
		const secondRun = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(secondRun, false);
		assert.strictEqual(
			storage.mementoStore.get(PENDING_SECRET_DELETIONS_KEY),
			undefined,
			"the retry on the next activation must clear the pending list"
		);
		assert.strictEqual(storage.secretStore.size, 0, "the orphaned secret must be gone after the retry");
	});

	test("a skip marker lifts when the server is renamed, letting the migration complete", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const server = await registry.addServer("Production", "http://prod.test", "prod-key");
		const { logger } = makeLogger();
		const host = makeFakeHost();
		host.groups.add("Production");

		await withWarnings(async () => {
			assert.strictEqual(await migrate(registry, storage, logger, host.exec), false);
		});
		assert.deepStrictEqual(storage.mementoStore.get(SKIPPED_MIGRATION_SERVERS_KEY), [server.id]);

		// Renaming is the natural resolution of a name collision.
		await registry.updateServer(server.id, "Production EU", "http://prod.test", undefined);
		assert.strictEqual(
			storage.mementoStore.get(SKIPPED_MIGRATION_SERVERS_KEY),
			undefined,
			"the rename must lift the skip marker"
		);

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, true);
		assert.ok(host.groups.has("Production EU"), "the renamed server must migrate under its new name");
		assert.deepStrictEqual(registry.getServers(), []);
	});

	test("an entry is never removed unless its progress record survives persistence", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Production", "http://prod.test", "prod-key");
		await registry.addServer("Backup", "http://backup.test", "backup-key");
		const { logger, lines } = makeLogger();
		const host = makeFakeHost();
		// A concurrent window's stale wholesale write lands right after every
		// write of the seeded records, erasing them.
		const origUpdate = storage.memento.update.bind(storage.memento);
		(storage.memento as { update(key: string, value: unknown): Thenable<void> }).update = async (key, value) => {
			await origUpdate(key, value);
			if (key === SEEDED_PROVIDER_GROUPS_KEY && Array.isArray(value) && value.length > 0) {
				storage.mementoStore.set(SEEDED_PROVIDER_GROUPS_KEY, []);
			}
		};

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, false);
		assert.strictEqual(registry.getServers().length, 2, "no removal without a surviving progress record");
		assert.strictEqual(host.groups.size, 1, "the pass must stop at the failed server, not submit the rest");
		assert.ok(
			lines.some((l) => l.includes("did not persist")),
			`Expected a record-did-not-persist log line. Lines: ${lines.join(" | ")}`
		);
		const marker = storage.mementoStore.get(PENDING_GROUP_SUBMISSION_KEY) as { name?: string } | undefined;
		assert.strictEqual(
			marker?.name,
			"Production",
			"The failed server's pending marker must survive so the retry can recognize its own group"
		);

		// The concurrent-writer interference stops; the next activation must
		// recognize the already-created group as its own submission and finish.
		(storage.memento as { update(key: string, value: unknown): Thenable<void> }).update = origUpdate;
		const retried = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(retried, true, "The retry recovers via the surviving pending marker");
		assert.deepStrictEqual(registry.getServers(), []);
		assert.deepStrictEqual([...host.groups].sort(), ["Backup", "Production"], "Both servers end up seeded");
		assert.ok(
			!lines.some((l) => l.includes("skipped a server")),
			`Recovery must not degrade to a foreign-collision skip. Lines: ${lines.join(" | ")}`
		);
	});

	test("an orphan whose secret deletion fails lands on the pending list and clears later", async () => {
		const storage = makeExtensionStorage({ [GROUP_MIGRATION_COMPLETE_KEY]: true });
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const server = await registry.addServer("Orphan", "http://orphan.test", "orphan-key");
		// The durable id list is the orphan's migration record; without it the
		// cleanup would (correctly) refuse to touch the entry.
		storage.mementoStore.set(MIGRATED_SERVER_IDS_KEY, [server.id]);
		const { logger } = makeLogger();
		const host = makeFakeHost();
		const failingKey = apiKeySecret(server.id);
		let deletionsBroken = true;
		const originalDelete = storage.secrets.delete.bind(storage.secrets);
		storage.secrets.delete = async (key: string) => {
			if (key === failingKey && deletionsBroken) {
				throw new Error("keychain unavailable");
			}
			await originalDelete(key);
		};

		await migrate(registry, storage, logger, host.exec);

		assert.deepStrictEqual(registry.getServers(), [], "the entry removal persisted before the secret failure");
		assert.deepStrictEqual(storage.mementoStore.get(PENDING_SECRET_DELETIONS_KEY), [server.id]);
		assert.ok(storage.secretStore.has(failingKey), "the secret is still orphaned after the failed cleanup");

		deletionsBroken = false;
		await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(storage.mementoStore.get(PENDING_SECRET_DELETIONS_KEY), undefined);
		assert.strictEqual(storage.secretStore.size, 0, "the retried deletion must clear the orphaned secret");
	});

	test("a pending deletion added concurrently during the retry pass survives the write", async () => {
		const storage = makeExtensionStorage({
			[GROUP_MIGRATION_COMPLETE_KEY]: true,
			[PENDING_SECRET_DELETIONS_KEY]: ["aaaa1111"],
		});
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		storage.secretStore.set(apiKeySecret("aaaa1111"), "orphaned");
		const { logger } = makeLogger();
		const host = makeFakeHost();
		const originalDelete = storage.secrets.delete.bind(storage.secrets);
		storage.secrets.delete = async (key: string) => {
			// Another window queues its own failed deletion while this pass runs.
			const pending = (storage.mementoStore.get(PENDING_SECRET_DELETIONS_KEY) as string[]) ?? [];
			if (!pending.includes("bbbb2222")) {
				storage.mementoStore.set(PENDING_SECRET_DELETIONS_KEY, [...pending, "bbbb2222"]);
			}
			await originalDelete(key);
		};

		await migrate(registry, storage, logger, host.exec);

		assert.deepStrictEqual(
			storage.mementoStore.get(PENDING_SECRET_DELETIONS_KEY),
			["bbbb2222"],
			"the concurrently queued id must survive the retry's write"
		);
	});

	test("a genuine name collision keeps the entry, marks it skipped, and announces once", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const server = await registry.addServer("Production", "http://prod.test", "prod-key");
		await registry.addServer("Local", "http://local.test", "");
		const { logger } = makeLogger();
		const host = makeFakeHost();
		host.groups.add("Production");

		const warnings = await withWarnings(async () => {
			assert.strictEqual(await migrate(registry, storage, logger, host.exec), false);
			assert.strictEqual(await migrate(registry, storage, logger, host.exec), false);
		});

		assert.deepStrictEqual(
			registry.getServers().map((s) => s.label),
			["Production"],
			"the collided entry stays because the existing group's config is unknowable; the other migrates"
		);
		assert.deepStrictEqual(storage.mementoStore.get(SKIPPED_MIGRATION_SERVERS_KEY), [server.id]);
		assert.strictEqual(
			host.submissions.filter((s) => s.group.name === "Production").length,
			1,
			"a skipped server must not be re-submitted on later runs"
		);
		assert.strictEqual(warnings.length, 1, "the collision must be announced exactly once across runs");
		const collisionWarning = expectMessage(warnings[0]);
		assert.ok(collisionWarning.includes("already exists"), collisionWarning);
	});

	test("a cross-window edit during the seed command keeps the edited entry and marks it skipped", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const server = await registry.addServer("Production", "http://prod.test", "prod-key");
		const { logger } = makeLogger();
		const host = makeFakeHost();
		const exec = async (command: string, ...args: unknown[]): Promise<unknown> => {
			const result = await host.exec(command, ...args);
			await registry.updateServer(server.id, "Production", "http://prod-edited.test", undefined);
			return result;
		};

		const warnings = await withWarnings(async () => {
			assert.strictEqual(await migrate(registry, storage, logger, exec), false);
		});

		assert.deepStrictEqual(
			registry.getServers().map((s) => s.baseUrl),
			["http://prod-edited.test"],
			"the edited entry must survive; the seeded group has the earlier settings"
		);
		assert.deepStrictEqual(storage.mementoStore.get(SKIPPED_MIGRATION_SERVERS_KEY), [server.id]);
		const progress = storage.mementoStore.get(SEEDED_PROVIDER_GROUPS_KEY) as Array<{ name: string }>;
		assert.deepStrictEqual(
			progress.map((p) => p.name),
			["Production"],
			"the seeded group is recorded even though the entry stays"
		);
		assert.strictEqual(warnings.length, 1);
		const editWarning = expectMessage(warnings[0]);
		assert.ok(editWarning.includes("changed while it was being migrated"), editWarning);
	});

	test("a server added during seeding stays in the registry and defers completion", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Production", "http://prod.test", "prod-key");
		const { logger, lines } = makeLogger();
		const runningDuringSeed: boolean[] = [];

		const completed = await migrateServersToProviderGroups(
			registry,
			storage.memento,
			storage.secrets,
			logger,
			fakeFingerprintSaltSession(),
			async () => {
				runningDuringSeed.push(isGroupMigrationRunning());
				await registry.addServer("Added Mid-Flight", "http://new.test", "");
			}
		);

		assert.strictEqual(completed, false);
		assert.deepStrictEqual(runningDuringSeed, [true], "the migration lock must be held while seeding");
		assert.strictEqual(isGroupMigrationRunning(), false, "the migration lock must be released afterwards");
		assert.strictEqual(isGroupMigrationComplete(storage.memento), false);
		assert.deepStrictEqual(
			registry.getServers().map((s) => s.label),
			["Added Mid-Flight"],
			"the added server must survive; the seeded one is already migrated"
		);
		assert.ok(
			lines.some((l) => l.includes("migration incomplete")),
			`Expected an incomplete-migration log line. Lines: ${lines.join(" | ")}`
		);
	});

	test("an empty registry leaves the flag unset and invokes nothing", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const { logger } = makeLogger();
		const host = makeFakeHost();

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, false);
		assert.deepStrictEqual(host.submissions, []);
		assert.strictEqual(isGroupMigrationComplete(storage.memento), false);
	});

	test("a server added after a fresh install is still migrated later", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const { logger } = makeLogger();
		const host = makeFakeHost();

		await migrate(registry, storage, logger, host.exec);
		assert.strictEqual(
			isGroupMigrationComplete(storage.memento),
			false,
			"a fresh install's empty registry must not mark the migration complete"
		);

		await registry.addServer("Fallback", "http://fallback.test", "");
		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, true);
		assert.deepStrictEqual(
			host.submissions.map((s) => s.group.name),
			["Fallback"]
		);
		assert.strictEqual(isGroupMigrationComplete(storage.memento), true);
		assert.deepStrictEqual(registry.getServers(), []);
	});

	test("registry entries surviving past a completed migration are cleaned up on activation", async () => {
		const storage = makeExtensionStorage({ [GROUP_MIGRATION_COMPLETE_KEY]: true });
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const server = await registry.addServer("Orphan", "http://orphan.test", "orphan-key");
		storage.mementoStore.set(MIGRATED_SERVER_IDS_KEY, [server.id]);
		const { logger, lines } = makeLogger();
		const host = makeFakeHost();

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, false);
		assert.deepStrictEqual(host.submissions, [], "no group may be seeded after the migration completed");
		assert.deepStrictEqual(registry.getServers(), []);
		assert.strictEqual(storage.secretStore.size, 0, "orphaned secrets must be deleted");
		assert.ok(
			lines.some((l) => l.includes("orphaned")),
			`Expected an orphan-cleanup log line. Lines: ${lines.join(" | ")}`
		);
	});

	test("a surviving entry with no migration record is re-seeded, never swept", async () => {
		// The completion flag alone must not authorize deletion: another window
		// can set it while this window imports a server (the fresh-install
		// race), and that server has no migration record. Completion also must
		// not close the seeding path, or the entry would sit in a registry
		// nothing serves in production.
		const storage = makeExtensionStorage({ [GROUP_MIGRATION_COMPLETE_KEY]: true });
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const server = await registry.addServer("Default", "http://legacy:4000", "legacy-key");
		const { logger, lines } = makeLogger();
		const host = makeFakeHost();

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, true, "the recordless entry must go through the normal seeding pass");
		assert.ok(host.groups.has("Default"), "the entry must become a provider group, not be swept");
		assert.deepStrictEqual(registry.getServers(), []);
		assert.strictEqual(storage.secretStore.size, 0, "the secret is cleaned up by finalization, after seeding");
		assert.ok(
			(storage.mementoStore.get(MIGRATED_SERVER_IDS_KEY) as string[]).includes(server.id),
			"the re-seeded entry joins the durable migration record"
		);
		const notice = lines.find((l) => l.includes("no migration record"));
		assert.ok(notice !== undefined, `expected a count-only notice. Lines: ${lines.join(" | ")}`);
		assert.ok(!notice.includes("Default") && !notice.includes("legacy"), "the notice must not name the server");
	});

	test("a re-added server reusing a migrated label and base URL is never swept as an orphan", async () => {
		// Labels and base URLs recur when a user re-adds a server; only ids
		// are unique. Matching on the historical (label, baseUrl) pair would
		// delete the new server and its secret without any submission.
		const storage = makeExtensionStorage({
			[GROUP_MIGRATION_COMPLETE_KEY]: true,
			[MIGRATED_SERVER_IDS_KEY]: ["oldid111"],
			[MIGRATED_SERVER_LABELS_KEY]: { "http://prod.test": ["Production"] },
		});
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		const readded = await registry.addServer("Production", "http://prod.test", "new-key");
		const { logger } = makeLogger();
		const host = makeFakeHost();

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(
			host.submissions.filter((s) => s.group.name === "Production").length,
			1,
			"the re-added server must be seeded, not silently deleted"
		);
		assert.strictEqual(completed, true);
		assert.ok(host.groups.has("Production"));
		assert.notStrictEqual(readded.id, "oldid111");
	});

	test("a skip marker for a server no longer in the registry lifts, unblocking completion", async () => {
		// The skipped server was deleted via the manage UI, as the skip notice
		// instructs; its marker must not block the fresh-install completion
		// forever.
		const storage = makeExtensionStorage({ [SKIPPED_MIGRATION_SERVERS_KEY]: ["gone1234"] });
		const ctx = makeMigrationContext(storage);

		const outcome = await registryToProviderGroupsMigration.run(ctx);

		assert.strictEqual(storage.mementoStore.get(SKIPPED_MIGRATION_SERVERS_KEY), undefined, "the stale marker lifts");
		assert.strictEqual(outcome, "nothing-to-do");
		assert.strictEqual(isGroupMigrationComplete(storage.memento), true);
	});

	test("another window's mid-flight legacy import survives a racing fresh-install completion", async () => {
		const shared = makeExtensionStorage();
		shared.secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");
		shared.secretStore.set(LEGACY_API_KEY_SECRET, "legacy-key");

		// Window B finishes its pre-registration legacy migration.
		const bCtx = makeMigrationContext(shared);
		assert.strictEqual(await legacySingleServerMigration.run(bCtx), "migrated");

		// Window A raced it: its Memento still serves the pre-import registry
		// blob (change broadcasts are asynchronous) while its secret reads see
		// the post-deletion state, so every fresh-install guard passes.
		const staleMemento = {
			get: (key: string, defaultValue?: unknown) =>
				key === SERVER_REGISTRY_KEY ? undefined : shared.memento.get(key, defaultValue),
			update: (key: string, value: unknown) => shared.memento.update(key, value),
		} as unknown as vscode.Memento;
		const aCtx = makeMigrationContext(shared, {
			globalState: staleMemento,
			registry: new ServerRegistry(staleMemento, shared.secrets),
		});
		await registryToProviderGroupsMigration.run(aCtx);
		assert.strictEqual(isGroupMigrationComplete(shared.memento), true, "the race must really have happened");

		// Window B's next engine pass sees the flag; without a migration
		// record for the imported server, cleanup must leave it alone, and the
		// reopened seeding pass must migrate it instead of stranding it.
		const { logger, lines } = makeLogger();
		const host = makeFakeHost();
		const completed = await migrate(bCtx.registry, shared, logger, host.exec);

		assert.ok(
			lines.some((l) => l.includes("no migration record")),
			`expected the unrecognized-entry notice. Lines: ${lines.join(" | ")}`
		);
		assert.strictEqual(completed, true, "the raced import is migrated on the next activation, never swept");
		assert.ok(host.groups.has("Default"), "the imported server must end up as a provider group");
		assert.deepStrictEqual(bCtx.registry.getServers(), []);
	});

	test("duplicate labels get disambiguated group names and no label mapping", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Prod", "http://one.test", "");
		await registry.addServer("Prod", "http://two.test", "");
		const { logger } = makeLogger();
		const host = makeFakeHost();

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, true);
		assert.deepStrictEqual(
			host.submissions.map((s) => s.group.name),
			["Prod", "Prod (2)"]
		);
		assert.deepStrictEqual(
			storage.mementoStore.get(MIGRATED_SERVER_LABELS_KEY),
			{},
			"a label naming two base URLs cannot be mapped to either"
		);
	});

	test("two labels sharing one base URL are both recorded under that URL", async () => {
		const storage = makeExtensionStorage();
		const registry = new ServerRegistry(storage.memento, storage.secrets);
		await registry.addServer("Production", "http://shared.test", "key-a");
		await registry.addServer("Staging", "http://shared.test", "key-b");
		const { logger } = makeLogger();
		const host = makeFakeHost();

		const completed = await migrate(registry, storage, logger, host.exec);

		assert.strictEqual(completed, true);
		assert.deepStrictEqual(storage.mementoStore.get(MIGRATED_SERVER_LABELS_KEY), {
			"http://shared.test": ["Production", "Staging"],
		});
	});

	test("getMigratedServerLabels tolerates missing and malformed stored values", () => {
		const empty = makeExtensionStorage();
		assert.deepStrictEqual(getMigratedServerLabels(empty.memento), {});

		const malformed = makeExtensionStorage({ [MIGRATED_SERVER_LABELS_KEY]: { "http://prod.test": "Production" } });
		assert.deepStrictEqual(getMigratedServerLabels(malformed.memento), {});

		const valid = makeExtensionStorage({ [MIGRATED_SERVER_LABELS_KEY]: { "http://prod.test": ["Production"] } });
		assert.deepStrictEqual(getMigratedServerLabels(valid.memento), { "http://prod.test": ["Production"] });
	});

	// The wiring tests only exercise engine paths that never reach the host
	// command; submission behavior stays pinned by the fake-host tests above.
	suite("migration wiring", () => {
		test("runs the engine's maintenance and reports nothing-to-do once complete", async () => {
			const storage = makeExtensionStorage({
				[GROUP_MIGRATION_COMPLETE_KEY]: true,
				[PENDING_SECRET_DELETIONS_KEY]: ["aaaa1111"],
			});
			storage.secretStore.set(apiKeySecret("aaaa1111"), "orphaned");

			const outcome = await registryToProviderGroupsMigration.run(makeMigrationContext(storage));

			assert.strictEqual(outcome, "nothing-to-do");
			assert.strictEqual(storage.secretStore.size, 0, "the pending deletion must be retried through the wrapper");
		});

		test("finalizes crash-left seeded state and reports migrated", async () => {
			const storage = makeExtensionStorage();
			storage.mementoStore.set(SEEDED_PROVIDER_GROUPS_KEY, [
				{ id: "aaaa1111", name: "Production", label: "Production", baseUrl: "http://prod.test", keyFingerprint: "0" },
			]);

			const outcome = await registryToProviderGroupsMigration.run(makeMigrationContext(storage));

			assert.strictEqual(outcome, "migrated");
			assert.strictEqual(isGroupMigrationComplete(storage.memento), true);
		});

		test("a pass that merges new label-map entries needs no label-copy rerun: the fold's union already covers them", async () => {
			// The label-scoped rewrite is folded into the settings-redesign
			// pipeline (pre-registration), whose label union includes the
			// REGISTRY SNAPSHOT - so every label this pass can merge into the
			// map was already visible to the fold before registration, seeded
			// or not. This pins the premise: the merged map adds nothing the
			// union did not already carry.
			const storage = makeExtensionStorage();
			const registry = new ServerRegistry(storage.memento, storage.secrets);
			await registry.addServer("Production", "http://prod.test", "key");
			const unionBefore = unionLabelSources(getMigratedServerLabels(storage.memento), registry.getServers());
			assert.deepStrictEqual(unionBefore, { "http://prod.test": ["Production"] });

			storage.mementoStore.set(SEEDED_PROVIDER_GROUPS_KEY, [
				{ id: "aaaa1111", name: "Production", label: "Production", baseUrl: "http://prod.test", keyFingerprint: "0" },
			]);
			await registryToProviderGroupsMigration.run(makeMigrationContext(storage, { registry }));

			const unionAfter = unionLabelSources(getMigratedServerLabels(storage.memento), registry.getServers());
			assert.deepStrictEqual(unionAfter, unionBefore, "seeding merged no label the union had not already derived");
		});
	});

	suite("fresh-install completion", () => {
		test("a fresh install with nothing to migrate is marked complete", async () => {
			const storage = makeExtensionStorage();

			const outcome = await registryToProviderGroupsMigration.run(makeMigrationContext(storage));

			assert.strictEqual(outcome, "nothing-to-do");
			assert.strictEqual(isGroupMigrationComplete(storage.memento), true);
		});

		test("an empty registry with legacy secrets is NOT marked complete", async () => {
			const storage = makeExtensionStorage();
			storage.secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");

			const outcome = await registryToProviderGroupsMigration.run(makeMigrationContext(storage));

			assert.strictEqual(outcome, "in-progress", "pending legacy config keeps the migration open");
			assert.strictEqual(
				isGroupMigrationComplete(storage.memento),
				false,
				"pending legacy config means this install is not fresh"
			);
		});

		test("a pending submission blocks completion even with an empty registry", async () => {
			// Unlike a stale skip marker, an in-flight submission marker means a
			// group may exist that no record accounts for yet, so completion
			// must wait for the interrupted run to be recognized and finished.
			const storage = makeExtensionStorage({
				[PENDING_GROUP_SUBMISSION_KEY]: {
					id: "aaaa1111",
					name: "Production",
					baseUrl: "http://prod.test",
					keyFingerprint: fingerprint("key"),
				},
			});

			const outcome = await registryToProviderGroupsMigration.run(makeMigrationContext(storage));

			assert.strictEqual(outcome, "in-progress");
			assert.strictEqual(isGroupMigrationComplete(storage.memento), false);
		});

		test("a failed legacy migration cannot lead to the migrated server's deletion as an orphan", async () => {
			// Activation 1: the (best-effort) legacy migration failed, so the
			// registry is empty while legacy secrets still exist. Without the
			// hasLegacyConfig guard, the fresh-install completion would set the
			// flag here, and activation 2's orphan cleanup would then delete the
			// just-migrated server and its secret.
			const storage = makeExtensionStorage();
			storage.secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");
			storage.secretStore.set(LEGACY_API_KEY_SECRET, "legacy-key");

			await registryToProviderGroupsMigration.run(makeMigrationContext(storage));
			assert.strictEqual(isGroupMigrationComplete(storage.memento), false);

			// Activation 2: the legacy migration succeeds this time.
			const ctx = makeMigrationContext(storage);
			assert.strictEqual(await legacySingleServerMigration.run(ctx), "migrated");
			assert.strictEqual(ctx.registry.getServers().length, 1);

			// The group migration must now seed the server, not delete it.
			const { logger, lines } = makeLogger();
			const host = makeFakeHost();
			const completed = await migrate(ctx.registry, storage, logger, host.exec);

			assert.strictEqual(completed, true);
			assert.ok(host.groups.has("Default"), "the recovered legacy server must become a provider group");
			assert.ok(
				!lines.some((l) => l.includes("orphaned")),
				`the server must never take the orphan-cleanup path. Lines: ${lines.join(" | ")}`
			);
			assert.deepStrictEqual(ctx.registry.getServers(), []);
		});
	});
});
