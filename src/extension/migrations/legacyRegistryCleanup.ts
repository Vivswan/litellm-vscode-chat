import type * as vscode from "vscode";
import {
	apiKeySecret,
	GROUP_MIGRATION_COMPLETE_KEY,
	LEGACY_API_KEY_SECRET,
	LEGACY_BASE_URL_SECRET,
	LEGACY_CLEANUP_PENDING_KEY,
	MIGRATED_SERVER_IDS_KEY,
	PENDING_GROUP_SUBMISSION_KEY,
	PENDING_SECRET_DELETIONS_KEY,
	SEEDED_PROVIDER_GROUPS_KEY,
	SERVER_REGISTRY_KEY,
	SKIPPED_MIGRATION_SERVERS_KEY,
} from "../../shared/config/storageKeys";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

/**
 * Every globalState key the retired legacy server registry and its migrations
 * (the pre-registry single-server import and the registry-to-provider-groups
 * seeding) ever wrote. NOT here: MIGRATED_SERVER_LABELS_KEY and
 * MIGRATED_ENTRY_PARAMETER_COPIES_KEY, which the settings-redesign pipeline
 * still reads.
 */
const LEGACY_STATE_KEYS: readonly string[] = [
	SERVER_REGISTRY_KEY,
	GROUP_MIGRATION_COMPLETE_KEY,
	SEEDED_PROVIDER_GROUPS_KEY,
	SKIPPED_MIGRATION_SERVERS_KEY,
	PENDING_GROUP_SUBMISSION_KEY,
	PENDING_SECRET_DELETIONS_KEY,
	MIGRATED_SERVER_IDS_KEY,
	LEGACY_CLEANUP_PENDING_KEY,
];

/**
 * Every per-server SecretStorage id the legacy blobs reference, read leniently:
 * the registry blob's entries (versioned { servers } or the pre-versioning bare
 * array), the seeded-progress records, the pending-deletion queue, the skip
 * markers, the migrated-ids ledger, the in-flight submission marker, and the
 * single-server cleanup marker's orphan list - each source may be the only
 * survivor of an interrupted pass, so all of them contribute. An unparseable
 * blob yields no ids; its key is still deleted.
 */
function referencedSecretIds(globalState: vscode.Memento): Set<string> {
	const ids = new Set<string>();
	const addIdsFrom = (records: unknown): void => {
		if (!Array.isArray(records)) {
			return;
		}
		for (const record of records) {
			if (typeof record === "string") {
				ids.add(record);
			} else if (typeof record === "object" && record !== null && "id" in record && typeof record.id === "string") {
				ids.add(record.id);
			}
		}
	};
	const registryBlob = globalState.get<unknown>(SERVER_REGISTRY_KEY);
	addIdsFrom(Array.isArray(registryBlob) ? registryBlob : (registryBlob as { servers?: unknown } | undefined)?.servers);
	addIdsFrom(globalState.get<unknown>(SEEDED_PROVIDER_GROUPS_KEY));
	addIdsFrom(globalState.get<unknown>(PENDING_SECRET_DELETIONS_KEY));
	addIdsFrom(globalState.get<unknown>(SKIPPED_MIGRATION_SERVERS_KEY));
	addIdsFrom(globalState.get<unknown>(MIGRATED_SERVER_IDS_KEY));
	addIdsFrom([globalState.get<unknown>(PENDING_GROUP_SUBMISSION_KEY)]);
	const marker = globalState.get<unknown>(LEGACY_CLEANUP_PENDING_KEY);
	addIdsFrom((marker as { orphanedSecretIds?: unknown } | undefined)?.orphanedSecretIds);
	return ids;
}

async function cleanUpLegacyRegistryState(ctx: MigrationContext): Promise<MigrationOutcome> {
	const presentKeys = LEGACY_STATE_KEYS.filter((key) => ctx.globalState.get<unknown>(key) !== undefined);
	const hasSingleServerSecrets =
		(await ctx.secrets.get(LEGACY_BASE_URL_SECRET)) !== undefined ||
		(await ctx.secrets.get(LEGACY_API_KEY_SECRET)) !== undefined;
	if (presentKeys.length === 0 && !hasSingleServerSecrets) {
		return "nothing-to-do";
	}
	// Secrets first, keys second: a failed delete throws, the runner logs the
	// classification, the keys survive, and this same pass retries next
	// activation - no bookkeeping needed.
	for (const id of referencedSecretIds(ctx.globalState)) {
		await ctx.secrets.delete(apiKeySecret(id));
	}
	await ctx.secrets.delete(LEGACY_API_KEY_SECRET);
	await ctx.secrets.delete(LEGACY_BASE_URL_SECRET);
	for (const key of presentKeys) {
		await ctx.globalState.update(key, undefined);
	}
	return "migrated";
}

/**
 * Best-effort deletion of everything the retired legacy server registry left
 * behind: its globalState keys and the per-server API keys they reference, plus
 * the pre-registry single-server secret pair. There is no import and no user
 * notice - installs still carrying legacy servers re-add them through the
 * dashboard or the servers setting. The runner's one "migrated" line is the
 * only log output (classification only; stored values never appear).
 *
 * Migrates away from: the registry-backed server storage of v0.2.2 through
 * v0.3.1 and the group migration's own progress markers, which every install
 * that ever activated a post-v0.3.1 build carries (the fresh-install completion
 * flag included).
 */
export const legacyRegistryCleanupMigration: ExtensionMigration = {
	state: "legacy-registry-state",
	description: "Deleted leftover legacy server-registry state and its stored secrets",
	sourceRelease: "0.3.1",
	run: cleanUpLegacyRegistryState,
};
