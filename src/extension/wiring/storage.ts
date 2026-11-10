import type * as vscode from "vscode";
import type { Logger } from "../../shared/logger";
import type { FingerprintSaltSession } from "../fingerprintSalt";
import { loadFingerprintSalt } from "../fingerprintSalt";
import type { MigrationContext } from "../migrations";
import { runMigrations } from "../migrations";
import { GroupRemovalStore } from "../servers/groupRemovals";

export interface StorageWiring {
	readonly fingerprintSalt: FingerprintSaltSession;
	readonly groupRemovals: GroupRemovalStore;
	/**
	 * The provider must not see half-migrated settings or storage, so activate() awaits this before
	 * registerLanguageModelChatProvider. Best-effort: a failed migration logs and retries on the next activation.
	 */
	runMigrations(): Promise<void>;
}

export async function wireStorage(context: vscode.ExtensionContext, logger: Logger): Promise<StorageWiring> {
	// Before anything else: every credential identity in the process is keyed by this salt, so it must be installed
	// before migrations or the provider can compute a fingerprint.
	const fingerprintSalt = await loadFingerprintSalt(context.secrets, context.globalStorageUri, logger);
	// Groups the user explicitly removed (the host command is add-only, so removal works by tombstoning): the provider
	// consults the store on every group refresh, and tombstone changes fire the model-change event. The salt decides
	// whether a group-keyed tombstone can outlive the session.
	const groupRemovals = new GroupRemovalStore(context.globalState, fingerprintSalt);
	const migrationContext: MigrationContext = {
		globalState: context.globalState,
		secrets: context.secrets,
		logger,
	};
	return {
		fingerprintSalt,
		groupRemovals,
		runMigrations: () => runMigrations(migrationContext),
	};
}
