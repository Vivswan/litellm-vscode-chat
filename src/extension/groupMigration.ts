import * as vscode from "vscode";
import { z } from "zod";
import { MANAGE_COMMAND_TITLE, VENDOR_ID } from "../shared/commandIds";
import { fingerprint } from "../shared/fingerprint";
import type { Logger } from "../shared/logger";
import type { ServerWithKey } from "../shared/servers";
import {
	apiKeySecret,
	GROUP_MIGRATION_COMPLETE_KEY,
	MIGRATED_SERVER_LABELS_KEY,
	PENDING_GROUP_SUBMISSION_KEY,
	PENDING_SECRET_DELETIONS_KEY,
	SEEDED_PROVIDER_GROUPS_KEY,
	SKIPPED_MIGRATION_SERVERS_KEY,
} from "../shared/storageKeys";
import type { ServerRegistry } from "./serverRegistry";

/**
 * Internal host action that validates a { vendor, name, baseUrl, apiKey }
 * group by calling the provider once with that configuration, persists the
 * group, and takes ownership of the secret. Not part of the stable API, so
 * every use is wrapped and failure defers the migration to the next activation.
 */
const MIGRATE_GROUP_COMMAND = "lm.migrateLanguageModelsProviderGroup";

const labelMapSchema = z.record(z.string(), z.array(z.string()));

const seededGroupSchema = z.object({
	id: z.string(),
	name: z.string(),
	label: z.string(),
	baseUrl: z.string(),
	keyFingerprint: z.string(),
});

type SeededGroup = z.infer<typeof seededGroupSchema>;

const seededGroupsSchema = z.array(seededGroupSchema);

const skippedServersSchema = z.array(z.string());

const pendingSecretDeletionsSchema = z.array(z.string());

const pendingSubmissionSchema = z.object({
	id: z.string(),
	name: z.string(),
	baseUrl: z.string(),
	keyFingerprint: z.string(),
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

/** True while a migration is seeding groups; registry mutations must wait it out. */
export function isGroupMigrationRunning(): boolean {
	return migrationState.running;
}

/**
 * True once a nonempty registry was fully migrated and emptied. While unset,
 * the registry stays live: the groupless refresh serves it and the migration
 * reruns on every activation that finds servers in it.
 */
export function isGroupMigrationComplete(globalState: vscode.Memento): boolean {
	return globalState.get<boolean>(GROUP_MIGRATION_COMPLETE_KEY, false) === true;
}

/** baseUrl -> labels for servers migrated to provider groups, written as each server seeds. */
export function getMigratedServerLabels(globalState: vscode.Memento): Record<string, string[]> {
	const parsed = labelMapSchema.safeParse(globalState.get<unknown>(MIGRATED_SERVER_LABELS_KEY));
	return parsed.success ? parsed.data : {};
}

function getSeededGroups(globalState: vscode.Memento): SeededGroup[] {
	const parsed = seededGroupsSchema.safeParse(globalState.get<unknown>(SEEDED_PROVIDER_GROUPS_KEY));
	return parsed.success ? parsed.data : [];
}

function getSkippedServers(globalState: vscode.Memento): string[] {
	const parsed = skippedServersSchema.safeParse(globalState.get<unknown>(SKIPPED_MIGRATION_SERVERS_KEY));
	return parsed.success ? parsed.data : [];
}

/**
 * The host refuses a taken group name with "Language model group with name
 * <name> already exists for vendor <vendor>". The match requires the group
 * name, our vendor, and the "already exists" phrase, so an unrelated error
 * that merely contains "already exists" is not mistaken for a duplicate.
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
 * Fold the seeded records into the persisted label map. A label is recorded
 * under a base URL only while it maps to exactly one: when a record (or the
 * previously persisted map) shows the same label on another URL, the label is
 * dropped everywhere, because its scoped modelParameters entries cannot be
 * resolved to one server.
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
 * seeded record resurfaces as a marker-less duplicate on the next activation
 * (the retained-entry skip-and-notify path), never as a silent deletion.
 */

async function persistSeededRecord(globalState: vscode.Memento, record: SeededGroup): Promise<SeededGroup[]> {
	const merged = getSeededGroups(globalState);
	if (!merged.some((group) => group.id === record.id && group.name === record.name)) {
		merged.push(record);
	}
	await globalState.update(SEEDED_PROVIDER_GROUPS_KEY, merged);
	return merged;
}

async function persistSkippedServer(globalState: vscode.Memento, serverId: string): Promise<void> {
	const merged = new Set(getSkippedServers(globalState));
	merged.add(serverId);
	await globalState.update(SKIPPED_MIGRATION_SERVERS_KEY, [...merged]);
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
 * How one server's group submission ended, for the migration loop to switch
 * on. "seeded": the group exists and its progress record verifiably persisted,
 * so removing the registry entry is safe. "deferred": the host did not accept
 * the submission; retry on the next activation. "skipped": a foreign group
 * already owns the name; the server was marked skipped and announced.
 * "halt-pass": the progress record would not persist, which signals storage
 * trouble every remaining submission would share - and continuing would let
 * the next server overwrite the single pending-marker slot this server's
 * retry depends on - so the whole pass stops.
 */
type SeedSubmissionOutcome = "seeded" | "deferred" | "skipped" | "halt-pass";

/**
 * Submit one registry server to the host as the provider group `record`
 * describes and persist that progress record. This function owns the
 * submission lifecycle's touches of PENDING_GROUP_SUBMISSION_KEY (the one
 * other writer is finalizeIfDone's wholesale completion clear): the marker is
 * written before the submission so a crash mid-flight is recognizable, read
 * back on retry to tell our own interrupted submission from a foreign name
 * collision, cleared on ordinary rejection, and cleared after success only
 * once the seeded record verifiably survives in storage - a persist failure
 * keeps the marker so the retry can still recognize the already-created group
 * as our own submission.
 */
async function submitGroupSeed(
	globalState: vscode.Memento,
	logger: Logger,
	executeCommand: ExecuteCommand,
	current: ServerWithKey,
	record: SeededGroup,
	markSkipped: (serverId: string, notice: string) => Promise<void>
): Promise<SeedSubmissionOutcome> {
	// A crash while a submission is in flight would make the retry collide
	// with our own group. The marker written before each submission tells
	// that case apart from a foreign name collision, but only when the
	// server's current identity still matches what the marker recorded.
	// An ordinary rejection clears it: only an accepted-but-lost
	// submission (a crash) may leave the marker standing.
	const pending = getPendingSubmission(globalState);
	const wasOurSubmission =
		pending !== undefined &&
		pending.id === record.id &&
		pending.name === record.name &&
		pending.baseUrl === record.baseUrl &&
		pending.keyFingerprint === record.keyFingerprint;
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
			baseUrl: record.baseUrl,
			apiKey: current.apiKey || undefined,
		});
	} catch (error) {
		if (!isDuplicateGroupError(error, record.name)) {
			await globalState.update(PENDING_GROUP_SUBMISSION_KEY, undefined);
			const message = error instanceof Error ? error.message : String(error);
			logger.log(
				`Provider-group migration deferred server "${current.label}": not accepted (${message}); retrying on next activation`
			);
			return "deferred";
		}
		if (!wasOurSubmission) {
			// A group with this name exists but its configuration is not
			// readable, so equivalence with this server is unknowable.
			await globalState.update(PENDING_GROUP_SUBMISSION_KEY, undefined);
			await markSkipped(
				current.id,
				`A language models group named "${record.name}" already exists, so server "${current.label}" was not migrated. Review the group in the language models UI, then remove the legacy server via "${MANAGE_COMMAND_TITLE}".`
			);
			return "skipped";
		}
		logger.log(
			`Provider group "${record.name}" was created by an interrupted earlier submission; treating it as seeded`
		);
	}

	const records = await persistSeededRecord(globalState, record);
	await globalState.update(MIGRATED_SERVER_LABELS_KEY, mergeLabelMap(getMigratedServerLabels(globalState), records));

	// Removing the entry is only safe while its progress record verifiably
	// sits in storage: a concurrent window's wholesale write can race the
	// record out, and an entry removed without a surviving record has
	// nothing left to resurface it. One re-persist is attempted; if the
	// record still does not stick, the entry stays for the next activation.
	const recordSurvives = () =>
		getSeededGroups(globalState).some((group) => group.id === record.id && group.name === record.name);
	if (!recordSurvives()) {
		await persistSeededRecord(globalState, record);
	}
	if (!recordSurvives()) {
		logger.log(
			`Provider-group migration stopped at server "${current.label}": its progress record did not persist; retrying on next activation`
		);
		return "halt-pass";
	}
	await globalState.update(PENDING_GROUP_SUBMISSION_KEY, undefined);
	return "seeded";
}

/**
 * Hand every registry server to VS Code as a named provider group, one server
 * at a time: seed the group, persist a progress record (with a non-secret key
 * fingerprint), merge the server's label into the label map, and remove the
 * registry entry, but only after re-reading the registry and confirming the
 * entry still matches what was seeded, since another window may have edited
 * it meanwhile. Entries whose group cannot be verified (a mid-seed edit, or a
 * pre-existing group with the same name) are marked skipped, left in place,
 * and announced once; the user resolves them manually. Finalization is
 * state-derived: whenever progress records exist and the registry is empty,
 * the completion flag is set, per-record secrets are re-deleted, and the
 * progress is cleared, including on a later activation after a crash.
 * Returns true when the migration completed during this call.
 */
export async function migrateServersToProviderGroups(
	registry: ServerRegistry,
	globalState: vscode.Memento,
	secrets: vscode.SecretStorage,
	logger: Logger,
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
			return false;
		}
		if (await finalizeIfDone(registry, globalState, secrets, logger)) {
			return true;
		}
		const snapshot = await registry.getServersWithKeys();
		if (snapshot.length === 0) {
			return false;
		}

		let seeded = getSeededGroups(globalState);
		const skipped = new Set(getSkippedServers(globalState));
		const usedNames = new Set(seeded.map((group) => group.name));

		const markSkipped = async (serverId: string, notice: string): Promise<void> => {
			skipped.add(serverId);
			await persistSkippedServer(globalState, serverId);
			logger.log(notice);
			void vscode.window.showWarningMessage(`LiteLLM: ${notice}`);
		};

		for (const server of snapshot) {
			if (skipped.has(server.id)) {
				continue;
			}

			const record = seeded.find((group) => group.id === server.id);
			if (record) {
				// Seeded in a run that stopped before removing the entry; remove it
				// only if it still is the config the group was built from.
				const current = (await registry.getServersWithKeys()).find((s) => s.id === server.id);
				if (!current) {
					continue;
				}
				if (matchesSeededConfig(current, record)) {
					await removeMigratedServer(registry, current, logger);
				} else {
					await markSkipped(
						server.id,
						`Server "${current.label}" changed after it was migrated; its provider group has the earlier settings. Review the group in the language models UI, then remove the legacy server via "${MANAGE_COMMAND_TITLE}".`
					);
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
			const outcome = await submitGroupSeed(globalState, logger, executeCommand, current, newRecord, markSkipped);
			if (outcome === "deferred" || outcome === "skipped") {
				continue;
			}
			if (outcome === "halt-pass") {
				break;
			}
			usedNames.add(name);
			seeded = getSeededGroups(globalState);

			// The seed command validates over the network; re-read before removing
			// so an edit from another window is never deleted.
			const afterSeed = (await registry.getServersWithKeys()).find((s) => s.id === server.id);
			if (!afterSeed) {
				continue;
			}
			if (matchesSeededConfig(afterSeed, newRecord)) {
				await removeMigratedServer(registry, afterSeed, logger);
			} else {
				await markSkipped(
					server.id,
					`Server "${afterSeed.label}" changed while it was being migrated; its provider group has the earlier settings. Review the group in the language models UI, then remove the legacy server via "${MANAGE_COMMAND_TITLE}".`
				);
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
 * State-derived completion: whenever seeded records exist and the registry is
 * empty, the migration is over regardless of which run got it there. Secrets
 * are re-deleted per record; a failed deletion joins the pending list and is
 * retried on every activation, so completion never orphans a secret.
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

	await globalState.update(MIGRATED_SERVER_LABELS_KEY, mergeLabelMap(getMigratedServerLabels(globalState), seeded));
	const failedSecretIds: string[] = [];
	for (const group of seeded) {
		try {
			await secrets.delete(apiKeySecret(group.id));
		} catch (error) {
			failedSecretIds.push(group.id);
			logger.error(
				`Failed to delete the migrated secret for server "${group.label}"; retrying on next activation`,
				error
			);
		}
	}
	if (failedSecretIds.length > 0) {
		await persistPendingSecretDeletions(globalState, failedSecretIds);
	}
	await globalState.update(GROUP_MIGRATION_COMPLETE_KEY, true);
	await globalState.update(SEEDED_PROVIDER_GROUPS_KEY, undefined);
	await globalState.update(SKIPPED_MIGRATION_SERVERS_KEY, undefined);
	await globalState.update(PENDING_GROUP_SUBMISSION_KEY, undefined);

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
		logger.error(`Failed to remove migrated server "${server.label}" from the registry`, error);
	}
}

/**
 * Registry entries surviving past a completed migration (a failed removal, or
 * writes from another window) hold secrets nothing serves anymore; they are
 * retried on every activation until the registry is empty. A removal that
 * cleared the entry but failed on its secret would lose the secret's id, so
 * the failure lands on the pending-deletions list.
 */
async function cleanUpOrphanedServers(
	registry: ServerRegistry,
	globalState: vscode.Memento,
	logger: Logger
): Promise<void> {
	const orphans = registry.getServers();
	if (orphans.length === 0) {
		return;
	}
	logger.log(`Removing ${orphans.length} orphaned registry server(s) left behind by the group migration`);
	for (const orphan of orphans) {
		try {
			await registry.removeServer(orphan.id);
		} catch (error) {
			await persistPendingSecretDeletions(globalState, [orphan.id]);
			logger.error(`Failed to remove orphaned server "${orphan.label}" from the registry`, error);
		}
	}
}
