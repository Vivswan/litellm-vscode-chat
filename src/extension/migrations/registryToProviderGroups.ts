import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { z } from "zod";
import { VENDOR_ID } from "../../shared/config/commandIds";
import {
	apiKeySecret,
	GROUP_MIGRATION_COMPLETE_KEY,
	MIGRATED_SERVER_IDS_KEY,
	MIGRATED_SERVER_LABELS_KEY,
	PENDING_GROUP_SUBMISSION_KEY,
	PENDING_SECRET_DELETIONS_KEY,
	SEEDED_PROVIDER_GROUPS_KEY,
	SKIPPED_MIGRATION_SERVERS_KEY,
} from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import type { ServerWithKey } from "../../shared/servers";
import { fingerprint, fingerprintSchema } from "../../shared/util/fingerprint";
import type { FingerprintSaltSession } from "../fingerprintSalt";
import { ServerRegistry } from "../servers/serverRegistry";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";
import { getMigratedServerLabels } from "./labelScopedModelParameters";
import { hasLegacyConfig } from "./legacySingleServer";

/**
 * Internal host action: validates a { vendor, name, label, baseUrl, apiKey }
 * group by calling the provider once, persists it, and takes ownership of the
 * secret. Not stable API, so every use is wrapped and failure defers the
 * migration to the next activation.
 */
const MIGRATE_GROUP_COMMAND = "lm.migrateLanguageModelsProviderGroup";

const seededGroupSchema = z.object({
	id: z.string(),
	name: z.string(),
	label: z.string(),
	baseUrl: z.string(),
	// Branded: a raw apiKey where the non-secret identity belongs does not typecheck.
	keyFingerprint: fingerprintSchema,
});

type SeededGroup = z.infer<typeof seededGroupSchema>;

const seededGroupsSchema = z.array(seededGroupSchema);

const skippedServersSchema = z.array(z.string());

const migratedServerIdsSchema = z.array(z.string());

const pendingSecretDeletionsSchema = z.array(z.string());

const pendingSubmissionSchema = z.object({
	id: z.string(),
	name: z.string(),
	baseUrl: z.string(),
	keyFingerprint: fingerprintSchema,
});

type PendingSubmission = z.infer<typeof pendingSubmissionSchema>;

function getPendingSubmission(globalState: vscode.Memento): PendingSubmission | undefined {
	const parsed = pendingSubmissionSchema.safeParse(globalState.get<unknown>(PENDING_GROUP_SUBMISSION_KEY));
	return parsed.success ? parsed.data : undefined;
}

function getPendingSecretDeletions(globalState: vscode.Memento): string[] {
	const parsed = pendingSecretDeletionsSchema.safeParse(globalState.get<unknown>(PENDING_SECRET_DELETIONS_KEY));
	return parsed.success ? parsed.data : [];
}

const migrationState = { running: false };

/**
 * True once a nonempty registry was fully migrated and emptied. While unset,
 * the registry is retained and the migration reruns on every activation that
 * finds servers in it.
 */
export function isGroupMigrationComplete(globalState: vscode.Memento): boolean {
	return globalState.get<boolean>(GROUP_MIGRATION_COMPLETE_KEY, false) === true;
}

function getSeededGroups(globalState: vscode.Memento): SeededGroup[] {
	const parsed = seededGroupsSchema.safeParse(globalState.get<unknown>(SEEDED_PROVIDER_GROUPS_KEY));
	return parsed.success ? parsed.data : [];
}

function getSkippedServers(globalState: vscode.Memento): string[] {
	const parsed = skippedServersSchema.safeParse(globalState.get<unknown>(SKIPPED_MIGRATION_SERVERS_KEY));
	return parsed.success ? parsed.data : [];
}

function getMigratedServerIds(globalState: vscode.Memento): string[] {
	const parsed = migratedServerIdsSchema.safeParse(globalState.get<unknown>(MIGRATED_SERVER_IDS_KEY));
	return parsed.success ? parsed.data : [];
}

/**
 * The host refuses a taken group name with "Language model group with name
 * <name> already exists for vendor <vendor>". Matching on all three parts
 * keeps an unrelated "already exists" error from reading as a duplicate.
 */
function isDuplicateGroupError(error: unknown, name: string): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("already exists") && message.includes(name) && message.includes(VENDOR_ID);
}

/** Group names must be unique host-side; duplicate registry labels get a numeric suffix. */
function disambiguateGroupName(label: string, usedNames: ReadonlySet<string>): string {
	if (!usedNames.has(label)) {
		return label;
	}
	for (let n = 2; ; n++) {
		const candidate = `${label} (${n})`;
		if (!usedNames.has(candidate)) {
			return candidate;
		}
	}
}

/**
 * A label is recorded under a base URL only while it maps to exactly one. A
 * label seen on two URLs is dropped everywhere, because its scoped
 * modelParameters entries cannot be resolved to one server.
 */
function mergeLabelMap(existing: Record<string, string[]>, seeded: readonly SeededGroup[]): Record<string, string[]> {
	const urlsByLabel = new Map<string, Set<string>>();
	for (const [baseUrl, labels] of Object.entries(existing)) {
		for (const label of labels) {
			const urls = urlsByLabel.get(label) ?? new Set<string>();
			urls.add(baseUrl);
			urlsByLabel.set(label, urls);
		}
	}
	for (const group of seeded) {
		const urls = urlsByLabel.get(group.label) ?? new Set<string>();
		urls.add(group.baseUrl);
		urlsByLabel.set(group.label, urls);
	}

	const labelMap: Record<string, string[]> = {};
	for (const [label, urls] of urlsByLabel) {
		if (urls.size !== 1) {
			continue;
		}
		const [baseUrl] = urls;
		if (baseUrl === undefined) {
			continue;
		}
		const labels = labelMap[baseUrl] ?? [];
		if (!labels.includes(label)) {
			labels.push(label);
		}
		labelMap[baseUrl] = labels;
	}
	return labelMap;
}

function matchesSeededConfig(server: ServerWithKey, record: SeededGroup): boolean {
	return (
		server.label === record.label &&
		server.baseUrl === record.baseUrl &&
		fingerprint(server.apiKey) === record.keyFingerprint
	);
}

/*
 * Memento has no compare-and-swap, so every metadata write below re-reads its
 * key and unions immediately before writing. A concurrent window can still
 * interleave between that read and the write; the residual race degrades
 * safely because the unions are monotonic and recovery is idempotent: a lost
 * seeded record resurfaces as a marker-less duplicate on the next activation,
 * where the name collision retires the entry with a notice (the group itself
 * survives host-side with the same configuration), never as a silent deletion.
 */

async function persistSeededRecord(globalState: vscode.Memento, record: SeededGroup): Promise<SeededGroup[]> {
	const merged = getSeededGroups(globalState);
	if (!merged.some((group) => group.id === record.id && group.name === record.name)) {
		merged.push(record);
	}
	await globalState.update(SEEDED_PROVIDER_GROUPS_KEY, merged);
	return merged;
}

async function persistPendingSecretDeletions(globalState: vscode.Memento, serverIds: readonly string[]): Promise<void> {
	const merged = new Set(getPendingSecretDeletions(globalState));
	for (const id of serverIds) {
		merged.add(id);
	}
	await globalState.update(PENDING_SECRET_DELETIONS_KEY, merged.size > 0 ? [...merged] : undefined);
}

type ExecuteCommand = (command: string, ...args: unknown[]) => Thenable<unknown>;

/**
 * How one server's submission ended. "seeded": the group exists and its
 * progress record verifiably persisted, so removing the registry entry is
 * safe. "deferred": the host did not accept it; retry next activation.
 * "unmigratable": a foreign group owns the name, so equivalence can never be
 * verified - the caller retires the entry as a straggler. "halt-pass": the
 * progress record would not persist, so the whole pass stops - continuing
 * would let the next server overwrite the single pending-marker slot this
 * retry depends on.
 */
type SeedSubmissionOutcome = "seeded" | "deferred" | "unmigratable" | "halt-pass";

/**
 * Submit one registry server as the provider group `record` describes and
 * persist that progress record. Owns the submission lifecycle's touches of
 * PENDING_GROUP_SUBMISSION_KEY (finalizeIfDone's completion clear is the only
 * other writer): written before the submission, read back on retry to tell our
 * own interrupted submission from a foreign name collision, cleared on
 * ordinary rejection, and cleared after success only once the seeded record
 * verifiably survives in storage.
 */
async function submitGroupSeed(
	globalState: vscode.Memento,
	logger: Logger,
	executeCommand: ExecuteCommand,
	current: ServerWithKey,
	record: SeededGroup
): Promise<SeedSubmissionOutcome> {
	// The marker tells a crashed in-flight submission apart from a foreign name
	// collision, but only while the server's identity still matches what the
	// marker recorded. Only an accepted-but-lost submission may leave it standing.
	const pending = getPendingSubmission(globalState);
	const wasOurSubmission =
		pending !== undefined &&
		pending.id === record.id &&
		pending.name === record.name &&
		pending.baseUrl === record.baseUrl &&
		fingerprint(current.apiKey) === pending.keyFingerprint;
	await globalState.update(PENDING_GROUP_SUBMISSION_KEY, {
		id: record.id,
		name: record.name,
		baseUrl: record.baseUrl,
		keyFingerprint: record.keyFingerprint,
	} satisfies PendingSubmission);
	try {
		await executeCommand(MIGRATE_GROUP_COMMAND, {
			vendor: VENDOR_ID,
			name: record.name,
			// Stamped the way the sync engine stamps a declared entry's label: it
			// is what lets per-entry modelParameters resolve against this group's
			// models. Groups seeded before this field existed carry none.
			label: record.label,
			baseUrl: record.baseUrl,
			apiKey: current.apiKey || undefined,
		});
	} catch (error) {
		if (!isDuplicateGroupError(error, record.name)) {
			await globalState.update(PENDING_GROUP_SUBMISSION_KEY, undefined);
			// Classification only: host errors can embed the user's server label,
			// and log lines feed the public issue-report buffer.
			logger.log("Provider-group migration deferred a server: the host did not accept it; retrying on next activation");
			return "deferred";
		}
		if (!wasOurSubmission) {
			// A group with this name exists but its configuration is not
			// readable, so equivalence with this server is unknowable - ever.
			// The caller retires the entry as a straggler.
			await globalState.update(PENDING_GROUP_SUBMISSION_KEY, undefined);
			return "unmigratable";
		}
		logger.log("The colliding provider group was created by an interrupted earlier submission; treating it as seeded");
	}

	const records = await persistSeededRecord(globalState, record);
	await globalState.update(MIGRATED_SERVER_LABELS_KEY, mergeLabelMap(getMigratedServerLabels(globalState), records));

	// Removing the entry is only safe while its progress record verifiably sits
	// in storage: an entry removed without a surviving record has nothing left
	// to resurface it. One re-persist is attempted; if it still does not stick,
	// the entry stays for the next activation.
	const recordSurvives = () =>
		getSeededGroups(globalState).some((group) => group.id === record.id && group.name === record.name);
	if (!recordSurvives()) {
		await persistSeededRecord(globalState, record);
	}
	if (!recordSurvives()) {
		logger.log("Provider-group migration stopped: a progress record did not persist; retrying on next activation");
		return "halt-pass";
	}
	await globalState.update(PENDING_GROUP_SUBMISSION_KEY, undefined);
	return "seeded";
}

/**
 * Hand every registry server to VS Code as a named provider group, one at a
 * time: seed the group, persist a progress record (with a non-secret key
 * fingerprint), merge the label map, then remove the registry entry, but only
 * after re-reading the registry and confirming the entry still matches what
 * was seeded. Entries whose group can never be verified (a foreign name
 * collision, an entry that changed against its seeded record) are retired as
 * stragglers: announced once and removed with their secrets, since the legacy
 * edit surface that once resolved them is gone. Finalization is state-derived:
 * progress records present and the registry empty completes the migration, on
 * this activation or a later one. Returns true when the migration completed
 * during this call.
 */
export async function migrateServersToProviderGroups(
	registry: ServerRegistry,
	globalState: vscode.Memento,
	secrets: vscode.SecretStorage,
	logger: Logger,
	// Required on purpose: a defaulted "durable" would let a future caller
	// silently seed unmatchable records under a session-only salt.
	fingerprintSalt: FingerprintSaltSession,
	executeCommand: ExecuteCommand = (command, ...args) => vscode.commands.executeCommand(command, ...args)
): Promise<boolean> {
	if (migrationState.running) {
		return false;
	}
	migrationState.running = true;
	try {
		if (isGroupMigrationComplete(globalState)) {
			await retryPendingSecretDeletions(globalState, secrets, logger);
			await cleanUpOrphanedServers(registry, globalState, logger);
			if (registry.getServers().length === 0) {
				return false;
			}
			// Entries the cleanup had no record for still deserve groups, so
			// completion does not close the seeding path.
		} else if (await finalizeIfDone(registry, globalState, secrets, logger)) {
			return true;
		}
		// A straggler is an entry the migration can never verify a group for (a
		// foreign name collision, or an edit that raced the seeding). The legacy
		// edit surface that once resolved them is gone, so parking them would
		// park them forever: instead the entry is retired - removed from the
		// registry with its stored API key deleted - and announced ONCE, naming
		// the label and base URL so the user can re-add the server through the
		// dashboard's Add Server or the servers setting (re-entering the key,
		// which cannot be surfaced). The removal happens first, and the notice
		// fires exactly when the ENTRY removal landed: removeServer persists the
		// entry's removal before deleting the secret, so a rejection can also
		// mean the entry is already gone with only its secret orphaned - the
		// notice must not go missing there, or the destruction would be silent.
		// A removal that did not land stays unannounced and retries next
		// activation (a repeat notice on retry is a retry, not permanence).
		const retireStraggler = async (server: { id: string; label: string; baseUrl: string }): Promise<void> => {
			let keyDeleted = true;
			let retryQueued = true;
			try {
				await registry.removeServer(server.id);
			} catch (error) {
				logger.error("Failed to retire an unmigratable legacy server", error);
				// Two reads, both required. The CURRENT instance's in-memory view is
				// authoritative for a rolled-back removal persist (the optimistic
				// Memento cache can hold the rejected entry-gone blob, which a plain
				// re-parse would misread as destroyed). A FRESH parse of the persisted
				// blob catches the opposite hazard: a concurrent window's EQUAL-version
				// restore, which this instance's version gate would ignore
				// (legacySingleServer's post-import re-read exists for the same race).
				// Either view showing the entry means nothing was destroyed.
				const survivedHere = registry.getServers().some((existing) => existing.id === server.id);
				const survivedInStorage = new ServerRegistry(globalState, secrets)
					.getServers()
					.some((existing) => existing.id === server.id);
				if (survivedHere || survivedInStorage) {
					// Nothing is announced and nothing queued; the next activation
					// retries the retirement.
					return;
				}
				// The entry is gone but its secret delete failed: queue the orphaned
				// secret for the every-activation retry, and fall through to the
				// notice - the removal the notice reports DID land.
				keyDeleted = false;
				try {
					await persistPendingSecretDeletions(globalState, [server.id]);
				} catch (pendingError) {
					// A SecretStorage failure plus a Memento failure in one pass: no
					// retry record survives, and the notice below says so instead of
					// claiming an automatic retry.
					retryQueued = false;
					logger.error("Failed to queue a retired server's orphaned secret for retry", pendingError);
				}
			}
			// Classification only in the log; the toast names the server so the
			// user can act, and claims exactly what happened to the key: deleted,
			// queued for automatic retry, or possibly still in secret storage.
			logger.log("Provider-group migration retired an unmigratable legacy server; it must be re-added manually");
			const notice = keyDeleted
				? l10n.t(
						'LiteLLM: Server "{0}" ({1}) could not be migrated to a provider group and was removed from legacy storage; its stored API key was deleted. Re-add it with the dashboard\'s Add Server or in the "{2}" setting.',
						server.label,
						server.baseUrl,
						"litellm-vscode-chat.servers"
					)
				: retryQueued
					? l10n.t(
							'LiteLLM: Server "{0}" ({1}) could not be migrated to a provider group and was removed from legacy storage; deleting its stored API key failed and is retried automatically. Re-add it with the dashboard\'s Add Server or in the "{2}" setting.',
							server.label,
							server.baseUrl,
							"litellm-vscode-chat.servers"
						)
					: l10n.t(
							'LiteLLM: Server "{0}" ({1}) could not be migrated to a provider group and was removed from legacy storage; deleting its stored API key failed, and it may remain in VS Code secret storage. Re-add it with the dashboard\'s Add Server or in the "{2}" setting.',
							server.label,
							server.baseUrl,
							"litellm-vscode-chat.servers"
						);
			void vscode.window.showWarningMessage(notice);
		};

		// Skip markers an earlier version parked lift once their entry is gone;
		// a marker's LIVE entry deliberately goes back through the ordinary
		// seeding pass below instead of retiring here. The marker records an
		// old verdict, not proof of unmigratability now: the old notice told the
		// user to resolve the collision in the language models UI, and an entry
		// whose collision was resolved that way migrates cleanly - only a
		// still-standing collision retires it, through the same classification
		// every other entry gets.
		const storedSkipped = getSkippedServers(globalState);
		if (storedSkipped.length > 0) {
			const liveIds = new Set(registry.getServers().map((server) => server.id));
			const liveSkipped = storedSkipped.filter((id) => liveIds.has(id));
			if (liveSkipped.length !== storedSkipped.length) {
				await globalState.update(SKIPPED_MIGRATION_SERVERS_KEY, liveSkipped.length > 0 ? liveSkipped : undefined);
			}
		}
		const snapshot = await registry.getServersWithKeys();
		if (snapshot.length === 0) {
			// Retiring the last straggler can complete the migration right here.
			return finalizeIfDone(registry, globalState, secrets, logger);
		}
		// The pass persists key fingerprints a LATER session must recognize, and
		// its recovery compares stored records against freshly computed ones.
		// Under a salt not confirmed durable neither works: fresh records would
		// be unmatchable next session, and a durable record would misread as
		// "the server changed". Confirmed at decision time, since another
		// window's salt store can supersede this session's after load; the
		// registry is retained until completion, so deferring loses nothing.
		if ((await fingerprintSalt.confirmDurable()) !== "durable") {
			logger.log("Deferring the provider-group migration: the fingerprint salt is session-only");
			return false;
		}

		let seeded = getSeededGroups(globalState);
		const usedNames = new Set(seeded.map((group) => group.name));

		for (const server of snapshot) {
			// Re-confirmed per server: a salt mutation detected mid-loop must stop
			// the remaining writes; whatever was not seeded retries next activation.
			if ((await fingerprintSalt.confirmDurable()) !== "durable") {
				logger.log("Stopping the provider-group migration mid-pass: the fingerprint salt is no longer confirmed");
				break;
			}

			const record = seeded.find((group) => group.id === server.id);
			if (record) {
				// Seeded in a run that stopped before removing the entry; remove it
				// only if it still is the config the group was built from - an entry
				// that changed since can never be verified again, so it retires.
				const current = (await registry.getServersWithKeys()).find((s) => s.id === server.id);
				if (!current) {
					continue;
				}
				if (matchesSeededConfig(current, record)) {
					await removeMigratedServer(registry, current, logger);
				} else {
					await retireStraggler(current);
				}
				continue;
			}

			const current = (await registry.getServersWithKeys()).find((s) => s.id === server.id);
			if (!current) {
				continue;
			}

			const name = disambiguateGroupName(current.label, usedNames);
			const newRecord: SeededGroup = {
				id: current.id,
				name,
				label: current.label,
				baseUrl: current.baseUrl,
				keyFingerprint: fingerprint(current.apiKey),
			};
			const outcome = await submitGroupSeed(globalState, logger, executeCommand, current, newRecord);
			if (outcome === "deferred") {
				continue;
			}
			if (outcome === "unmigratable") {
				await retireStraggler(current);
				continue;
			}
			if (outcome === "halt-pass") {
				break;
			}
			usedNames.add(name);
			seeded = getSeededGroups(globalState);

			// The seed command validates over the network; re-read before removing
			// so an entry another migration pass already drained is never
			// double-handled - and one that changed mid-flight retires, since its
			// group holds the earlier settings and can never be verified again.
			const afterSeed = (await registry.getServersWithKeys()).find((s) => s.id === server.id);
			if (!afterSeed) {
				continue;
			}
			if (matchesSeededConfig(afterSeed, newRecord)) {
				await removeMigratedServer(registry, afterSeed, logger);
			} else {
				await retireStraggler(afterSeed);
			}
		}

		const finalized = await finalizeIfDone(registry, globalState, secrets, logger);
		if (!finalized) {
			logger.log("Provider-group migration incomplete: unmigrated servers stay in the registry until next activation");
		}
		return finalized;
	} finally {
		migrationState.running = false;
	}
}

/**
 * State-derived completion: seeded records present and the registry empty
 * means the migration is over, whichever run got it there. Secrets are
 * re-deleted per record; a failed deletion joins the pending list and is
 * retried every activation, so completion never orphans a secret.
 */
async function finalizeIfDone(
	registry: ServerRegistry,
	globalState: vscode.Memento,
	secrets: vscode.SecretStorage,
	logger: Logger
): Promise<boolean> {
	const seeded = getSeededGroups(globalState);
	if (seeded.length === 0 || registry.getServers().length > 0) {
		return false;
	}

	// The durable id list must outlive the seeded records cleared below: it is
	// the only evidence the post-completion orphan cleanup accepts. Written
	// first so a failure here retries the whole finalization.
	const migratedIds = new Set(getMigratedServerIds(globalState));
	for (const group of seeded) {
		migratedIds.add(group.id);
	}
	await globalState.update(MIGRATED_SERVER_IDS_KEY, [...migratedIds]);

	await globalState.update(MIGRATED_SERVER_LABELS_KEY, mergeLabelMap(getMigratedServerLabels(globalState), seeded));
	const failedSecretIds: string[] = [];
	for (const group of seeded) {
		try {
			await secrets.delete(apiKeySecret(group.id));
		} catch (error) {
			failedSecretIds.push(group.id);
			logger.error("Failed to delete a migrated server secret; retrying on next activation", error);
		}
	}
	if (failedSecretIds.length > 0) {
		await persistPendingSecretDeletions(globalState, failedSecretIds);
	}
	// Records second-to-last and the flag LAST: every step is idempotent, so
	// while the records survive, a failure anywhere above reruns the whole
	// finalization next activation. The flag written any earlier would let the
	// completed fast path skip the unfinished rest forever.
	await globalState.update(SKIPPED_MIGRATION_SERVERS_KEY, undefined);
	await globalState.update(PENDING_GROUP_SUBMISSION_KEY, undefined);
	await globalState.update(SEEDED_PROVIDER_GROUPS_KEY, undefined);
	await globalState.update(GROUP_MIGRATION_COMPLETE_KEY, true);

	logger.log(`Migrated ${seeded.length} server(s) to VS Code provider groups`);
	return true;
}

async function retryPendingSecretDeletions(
	globalState: vscode.Memento,
	secrets: vscode.SecretStorage,
	logger: Logger
): Promise<void> {
	const pending = getPendingSecretDeletions(globalState);
	if (pending.length === 0) {
		return;
	}
	const deleted = new Set<string>();
	for (const serverId of pending) {
		try {
			await secrets.delete(apiKeySecret(serverId));
			deleted.add(serverId);
		} catch (error) {
			logger.error("Failed to delete a migrated server secret; retrying on next activation", error);
		}
	}
	// Re-read and drop only the ids this pass actually deleted, so an id a
	// concurrent window added meanwhile survives the write.
	const remaining = getPendingSecretDeletions(globalState).filter((serverId) => !deleted.has(serverId));
	await globalState.update(PENDING_SECRET_DELETIONS_KEY, remaining.length > 0 ? remaining : undefined);
}

async function removeMigratedServer(registry: ServerRegistry, server: ServerWithKey, logger: Logger): Promise<void> {
	try {
		await registry.removeServer(server.id);
	} catch (error) {
		logger.error("Failed to remove a migrated server from the registry", error);
	}
}

/**
 * Registry entries surviving a completed migration hold secrets nothing serves
 * anymore; they are retried every activation until the registry is empty.
 *
 * Deletion requires POSITIVE evidence the server was migrated: its id in the
 * durable migrated-ids list or in a surviving seeded record. Not the
 * completion flag (another window can set it concurrently with this window's
 * legacy import), and not the label map, because a user who re-adds a server
 * with a previously migrated label and base URL mints a new id but repeats the
 * pair. Unrecognized entries stay and the caller reopens the seeding pass.
 */
async function cleanUpOrphanedServers(
	registry: ServerRegistry,
	globalState: vscode.Memento,
	logger: Logger
): Promise<void> {
	const candidates = registry.getServers();
	if (candidates.length === 0) {
		return;
	}
	const seeded = getSeededGroups(globalState);
	const migratedIds = new Set(getMigratedServerIds(globalState));
	const orphans = candidates.filter(
		(server) => migratedIds.has(server.id) || seeded.some((group) => group.id === server.id)
	);
	const unrecognized = candidates.length - orphans.length;
	if (unrecognized > 0) {
		logger.log(
			`Leaving ${unrecognized} registry server(s) in place after migration completion: no migration record matches them`
		);
	}
	if (orphans.length === 0) {
		return;
	}
	logger.log(`Removing ${orphans.length} orphaned registry server(s) left behind by the group migration`);
	for (const orphan of orphans) {
		try {
			await registry.removeServer(orphan.id);
		} catch (error) {
			await persistPendingSecretDeletions(globalState, [orphan.id]);
			logger.error("Failed to remove an orphaned server from the registry", error);
		}
	}
}

/**
 * A fresh install has nothing to migrate, so it is marked complete right away.
 * Every trace of an unfinished migration blocks this - the stored skip markers
 * included, since they mean straggler entries are still awaiting their retire
 * pass. The hasLegacyConfig guard keeps the flag honest: the legacy migration
 * is best-effort, so on its failure the registry looks fresh here while an
 * import is still due.
 */
async function completeFreshInstall(ctx: MigrationContext): Promise<boolean> {
	if (
		migrationState.running ||
		isGroupMigrationComplete(ctx.globalState) ||
		ctx.registry.getServers().length > 0 ||
		getSeededGroups(ctx.globalState).length > 0 ||
		getSkippedServers(ctx.globalState).length > 0 ||
		getPendingSubmission(ctx.globalState) !== undefined ||
		(await hasLegacyConfig(ctx.secrets))
	) {
		return false;
	}
	await ctx.globalState.update(GROUP_MIGRATION_COMPLETE_KEY, true);
	return true;
}

/**
 * Migrates away from: the registry-backed server storage of v0.2.3 through
 * v0.3.1 (host provider groups replace it in the first release after v0.3.1).
 * Deletable once installs still carrying registry servers are judged extinct;
 * the always-on maintenance (secret-deletion retries, orphan cleanup) has to
 * survive as long as the completion flag does. The engine reruns across
 * activations by design, so this wrapper only maps its result onto outcomes.
 */
export const registryToProviderGroupsMigration: ExtensionMigration = {
	state: "registry-to-provider-groups",
	description: "Migrated the server registry to VS Code provider groups",
	sourceRelease: "0.3.1",
	phase: "post-registration",
	async run(ctx: MigrationContext): Promise<MigrationOutcome> {
		// No rerun needed for the label map this seeding merges: the
		// pre-registration pass's union already covered every registry server.
		const completed = await migrateServersToProviderGroups(
			ctx.registry,
			ctx.globalState,
			ctx.secrets,
			ctx.logger,
			ctx.fingerprintSalt
		);
		if (completed) {
			return "migrated";
		}
		if (ctx.registry.getServers().length > 0) {
			return "in-progress";
		}
		if (isGroupMigrationComplete(ctx.globalState)) {
			return "nothing-to-do";
		}
		if (await completeFreshInstall(ctx)) {
			ctx.logger.log("No legacy servers to migrate; marked the provider-group migration complete");
			return "nothing-to-do";
		}
		// Seeded records, a skip marker, a pending submission, or unfinished
		// legacy config all keep the migration open.
		return "in-progress";
	},
};
