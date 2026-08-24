import type * as vscode from "vscode";
import type { Logger } from "../../shared/logger";
import type { FingerprintSaltSession } from "../fingerprintSalt";
import { loadFingerprintSalt } from "../fingerprintSalt";
import type { MigrationContext } from "../migrations";
import { runMigrations } from "../migrations";
import { bareArrayWrappingMemento } from "../migrations/bareArrayBlobs";
import { isGroupMigrationComplete } from "../migrations/registryToProviderGroups";
import { GroupRemovalStore } from "../servers/groupRemovals";
import { ServerRegistry } from "../servers/serverRegistry";

export interface StorageWiring {
	readonly fingerprintSalt: FingerprintSaltSession;
	readonly registry: ServerRegistry;
	readonly isMigrated: () => boolean;
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
 * (the group migration's read source; nothing serves or edits it), the
 * group-removal tombstone store, and the migration runners whose ordering
 * activate() owns.
 */
export async function wireStorage(context: vscode.ExtensionContext, logger: Logger): Promise<StorageWiring> {
	// Before anything else: every credential identity in the process is keyed by
	// this salt, so it must be installed before migrations or the provider can
	// compute a fingerprint.
	const fingerprintSalt = await loadFingerprintSalt(context.secrets, context.globalStorageUri, logger);
	// Before the registry and removal stores exist: both parse their Memento
	// blobs at construction and adopt stored snapshots only when strictly
	// newer, so a pre-versioning bare-array blob must read as its versioned
	// shape from the very first parse. The wrapping view normalizes reads;
	// each region's first genuine persist promotes the format durably (see
	// migrations/bareArrayBlobs.ts for why there is deliberately no writer).
	const globalState = bareArrayWrappingMemento(context.globalState);
	const registry = new ServerRegistry(globalState, context.secrets);
	const isMigrated = () => isGroupMigrationComplete(context.globalState);
	// Groups the user explicitly removed (the host command is add-only, so
	// removal works by tombstoning): the provider consults the store on every
	// group refresh, and tombstone changes fire the model-change event.
	const groupRemovals = new GroupRemovalStore(globalState);
	const migrationContext: MigrationContext = {
		globalState,
		secrets: context.secrets,
		registry,
		logger,
		fingerprintSalt,
	};
	return {
		fingerprintSalt,
		registry,
		isMigrated,
		groupRemovals,
		runPreRegistrationMigrations: () => runMigrations("pre-registration", migrationContext),
		runPostRegistrationMigrations: () => runMigrations("post-registration", migrationContext),
	};
}
