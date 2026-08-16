import type * as vscode from "vscode";
import type { Logger } from "../../shared/logger";
import type { FingerprintSaltSession } from "../fingerprintSalt";
import { loadFingerprintSalt } from "../fingerprintSalt";
import type { MigrationContext } from "../migrations";
import { runMigrations } from "../migrations";
import { isGroupMigrationComplete } from "../migrations/registryToProviderGroups";
import { GroupRemovalStore } from "../servers/groupRemovals";
import { type ManagementUiMode, registryMutationVerdict } from "../servers/serverManagement";
import { ServerRegistry } from "../servers/serverRegistry";

export interface StorageWiring {
	readonly fingerprintSalt: FingerprintSaltSession;
	readonly registry: ServerRegistry;
	readonly isMigrated: () => boolean;
	readonly getManagementUiMode: () => ManagementUiMode;
	readonly groupRemovals: GroupRemovalStore;
	/**
	 * The pre-registration migrations. The provider must not see a half-migrated
	 * registry, so activate() awaits this before
	 * registerLanguageModelChatProvider. Best-effort: a failed migration logs and
	 * retries on the next activation.
	 */
	runPreRegistrationMigrations(): Promise<void>;
	/**
	 * Hands registry servers to VS Code as provider groups. The host validates
	 * each group by calling the registered provider, so activate() starts this
	 * after registration, and fire-and-forget because it hits the network.
	 */
	runPostRegistrationMigrations(): Promise<void>;
}

/**
 * The storage layer's wiring: the fingerprint salt, the legacy server registry
 * with its mutation guard, the group-removal tombstone store, and the migration
 * runners whose ordering activate() owns.
 */
export async function wireStorage(context: vscode.ExtensionContext, logger: Logger): Promise<StorageWiring> {
	// Before anything else: every credential identity in the process is keyed by
	// this salt, so it must be installed before migrations or the provider can
	// compute a fingerprint.
	const fingerprintSalt = await loadFingerprintSalt(context.secrets, context.globalStorageUri, logger);
	const registry = new ServerRegistry(context.globalState, context.secrets);
	const isMigrated = () => isGroupMigrationComplete(context.globalState);
	// The management UI mode: the dashboard once the registry is migrated or was
	// never populated, the legacy quick-pick flows while it still holds servers.
	const getManagementUiMode = (): ManagementUiMode => {
		if (isMigrated()) {
			return "groupsOnly";
		}
		return registry.getServers().length === 0 ? "groupsWithRegistry" : "legacy";
	};
	// The registry-side enforcement of the verdict the prompt flows show notices
	// for: mutators refuse with typed errors while the migration seeds groups or
	// after it retired the registry; the migrations mutate through the unguarded
	// methods.
	registry.installMutationGuard(() => registryMutationVerdict(getManagementUiMode));
	// Groups the user explicitly removed (the host command is add-only, so
	// removal works by tombstoning): the provider consults the store on every
	// group refresh, and tombstone changes fire the model-change event.
	const groupRemovals = new GroupRemovalStore(context.globalState);
	const migrationContext: MigrationContext = {
		globalState: context.globalState,
		secrets: context.secrets,
		registry,
		logger,
		fingerprintSalt,
	};
	return {
		fingerprintSalt,
		registry,
		isMigrated,
		getManagementUiMode,
		groupRemovals,
		runPreRegistrationMigrations: () => runMigrations("pre-registration", migrationContext),
		runPostRegistrationMigrations: () => runMigrations("post-registration", migrationContext),
	};
}
