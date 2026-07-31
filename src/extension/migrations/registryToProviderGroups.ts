import * as vscode from "vscode";
import { z } from "zod";
import { MANAGE_COMMAND_TITLE, VENDOR_ID } from "../../shared/commandIds";
import { fingerprint, fingerprintSchema } from "../../shared/fingerprint";
import type { Logger } from "../../shared/logger";
import type { ServerWithKey } from "../../shared/servers";
import {
	apiKeySecret,
	GROUP_MIGRATION_COMPLETE_KEY,
	MIGRATED_SERVER_IDS_KEY,
	MIGRATED_SERVER_LABELS_KEY,
	PENDING_GROUP_SUBMISSION_KEY,
	PENDING_SECRET_DELETIONS_KEY,
	SEEDED_PROVIDER_GROUPS_KEY,
	SKIPPED_MIGRATION_SERVERS_KEY,
} from "../../shared/storageKeys";
import type { ServerRegistry } from "../serverRegistry";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";
import { getMigratedServerLabels, labelScopedModelParametersMigration } from "./labelScopedModelParameters";
import { hasLegacyConfig } from "./legacySingleServer";

/**
 * Internal host action that validates a { vendor, name, baseUrl, apiKey }
 * group by calling the provider once with that configuration, persists the
 * group, and takes ownership of the secret. Not part of the stable API, so
 * every use is wrapped and failure defers the migration to the next activation.
 */
const MIGRATE_GROUP_COMMAND = "lm.migrateLanguageModelsProviderGroup";

const seededGroupSchema = z.object({
	id: z.string(),
	name: z.string(),
	label: z.string(),
	baseUrl: z.string(),
	// Branded at compile time: constructing a record with a raw apiKey where
	// the non-secret identity belongs does not typecheck.
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
			// Classification only: host errors can embed the group name, which
			// is the user's server label, and log lines feed the public
			// issue-report buffer.
			logger.log("Provider-group migration deferred a server: the host did not accept it; retrying on next activation");
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
		logger.log("The colliding provider group was created by an interrupted earlier submission; treating it as seeded");
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
		logger.log("Provider-group migration stopped: a progress record did not persist; retrying on next activation");
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
			if (registry.getServers().length === 0) {
				return false;
			}
			// Entries the cleanup had no record for (e.g. a legacy import that
			// raced a fresh-install completion in another window) still deserve
			// groups, so completion does not close the seeding path: fall
			// through and run the normal state-driven pass for them.
		} else if (await finalizeIfDone(registry, globalState, secrets, logger)) {
			return true;
		}
		const snapshot = await registry.getServersWithKeys();
		// A skip marker guards a live entry the user must resolve manually.
		// Once that entry is gone (deleted via the manage UI, as the notice
		// instructs), the marker has nothing left to guard and would block the
		// fresh-install completion forever, so stale markers lift here. This
		// removal can race another window's marker add, which self-heals by
		// re-skipping, the same trade the rename lift in ServerRegistry makes.
		const storedSkipped = getSkippedServers(globalState);
		if (storedSkipped.length > 0) {
			const liveIds = new Set(snapshot.map((server) => server.id));
			const liveSkipped = storedSkipped.filter((id) => liveIds.has(id));
			if (liveSkipped.length !== storedSkipped.length) {
				await globalState.update(SKIPPED_MIGRATION_SERVERS_KEY, liveSkipped.length > 0 ? liveSkipped : undefined);
			}
		}
		if (snapshot.length === 0) {
			return false;
		}

		let seeded = getSeededGroups(globalState);
		const skipped = new Set(getSkippedServers(globalState));
		const usedNames = new Set(seeded.map((group) => group.name));

		const markSkipped = async (serverId: string, notice: string): Promise<void> => {
			skipped.add(serverId);
			await persistSkippedServer(globalState, serverId);
			// The toast names the server so the user can act; the log line stays
			// classification-only because it feeds the public issue-report buffer.
			logger.log("Provider-group migration skipped a server; it stays in the registry for manual review");
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
	// The seeded records go second-to-last and the flag goes LAST: every step
	// is idempotent, so as long as the records survive, a failure anywhere
	// above reruns the whole finalization on the next activation, and a
	// failure on the flag write alone converges through the fresh-install
	// completion (everything else is already clean by then). The flag written
	// any earlier would let the completed fast path skip the unfinished rest
	// forever.
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
 * Registry entries surviving past a completed migration (a failed removal, or
 * writes from another window) hold secrets nothing serves anymore; they are
 * retried on every activation until the registry is empty. A removal that
 * cleared the entry but failed on its secret would lose the secret's id, so
 * the failure lands on the pending-deletions list.
 *
 * Deletion requires POSITIVE evidence the server was migrated: its id in the
 * durable migrated-ids list or in a surviving seeded record. Ids are the only
 * acceptable evidence: the completion flag is not (another window can set it
 * concurrently with this window's legacy import), and neither is the label
 * map, because a user who re-adds a server with a previously migrated label
 * and base URL mints a new id but repeats the pair, and matching on it would
 * delete the new server. Unrecognized entries stay, are counted in a log
 * line, and the caller reopens the seeding pass for them.
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
 * A fresh install has nothing to migrate, so it can be marked complete right
 * away, which routes server management to the native provider-group UI. Every
 * trace of an unfinished migration blocks this. The hasLegacyConfig guard
 * keeps the flag honest: the legacy migration is best-effort, so on its
 * failure the registry looks fresh here while an import is still due, and
 * completing now would flip the manage command to nativeRequired a release
 * early and force the next activation through the reopened-seeding path.
 * Nothing destructive rides on the guard: cleanup deletes only on id
 * evidence, and the engine seeds recordless entries even after completion.
 *
 * Deliberately not gated on extension mode: test mode forces the legacy
 * manage path and the groupless refresh regardless of the flag, servers the
 * litellm._test.* commands create have no migration record so they are never
 * swept (a later activation in the same profile seeds them into groups, which
 * throwaway test profiles tolerate), and gating would leave the production
 * fresh-install path untested.
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

function labelMapsEqual(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) {
		return false;
	}
	return aKeys.every((key) => {
		const left = a[key];
		const right = b[key];
		return (
			left !== undefined &&
			right !== undefined &&
			left.length === right.length &&
			left.every((label, index) => label === right[index])
		);
	});
}

/**
 * The label-scoped modelParameters copy runs pre-registration, but the label
 * map it reads is written here, during post-registration seeding. Without
 * this rerun, a user updating straight from a registry-era version would get
 * the map only mid-session and the copy pass would not see it until the next
 * activation. Best-effort with the runner's error isolation: a failure logs
 * once and never disturbs this migration's outcome.
 */
async function rerunLabelCopyForNewEntries(ctx: MigrationContext, before: Record<string, string[]>): Promise<void> {
	if (labelMapsEqual(before, getMigratedServerLabels(ctx.globalState))) {
		return;
	}
	try {
		if ((await labelScopedModelParametersMigration.run(ctx)) === "migrated") {
			ctx.logger.log(labelScopedModelParametersMigration.description);
		}
	} catch (error) {
		ctx.logger.error(`Migration "${labelScopedModelParametersMigration.state}" failed`, error);
	}
}

/**
 * Migrates away from: the registry-backed server storage of v0.2.3 through
 * v0.3.1 (host provider groups replace it in the first release after
 * v0.3.1). Deletable once installs still carrying registry servers are
 * judged extinct; the always-on maintenance (secret-deletion retries, orphan
 * cleanup) has to survive as long as the completion flag does.
 *
 * The migration engine above must keep running until every user's registry
 * has drained: it reruns across activations by design (deferred host
 * submissions, pending secret deletions, orphan cleanup), so this wrapper
 * only maps its result onto the runner's outcomes.
 */
export const registryToProviderGroupsMigration: ExtensionMigration = {
	state: "registry-to-provider-groups",
	description: "Migrated the server registry to VS Code provider groups",
	phase: "post-registration",
	async run(ctx: MigrationContext): Promise<MigrationOutcome> {
		const labelsBefore = getMigratedServerLabels(ctx.globalState);
		const completed = await migrateServersToProviderGroups(ctx.registry, ctx.globalState, ctx.secrets, ctx.logger);
		await rerunLabelCopyForNewEntries(ctx, labelsBefore);
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
		// Whatever refused the fresh-install completion (seeded records, a skip
		// marker, a pending submission, or legacy config the pre-registration
		// migration has not finished) keeps the migration open.
		return "in-progress";
	},
};
