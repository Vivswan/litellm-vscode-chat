import type * as vscode from "vscode";
import type { Logger } from "../../shared/logger";
import type { FingerprintSaltSession } from "../fingerprintSalt";
import { loadFingerprintSalt } from "../fingerprintSalt";
import type { MigrationContext } from "../migrations";
import { runMigrations } from "../migrations";
import { bareArrayWrappingMemento } from "../migrations/bareArrayBlobs";
import { GroupRemovalStore } from "../servers/groupRemovals";

export interface StorageWiring {
	readonly fingerprintSalt: FingerprintSaltSession;
	readonly groupRemovals: GroupRemovalStore;
	/**
	 * The state migrations. The provider must not see half-migrated settings or
	 * storage, so activate() awaits this before
	 * registerLanguageModelChatProvider. Best-effort: a failed migration logs and
	 * retries on the next activation.
	 */
	runMigrations(): Promise<void>;
}

/**
 * The storage layer's wiring: the fingerprint salt, the group-removal
 * tombstone store, and the migration runner activate() awaits before
 * registration.
 */
export async function wireStorage(context: vscode.ExtensionContext, logger: Logger): Promise<StorageWiring> {
	// Before anything else: every credential identity in the process is keyed by
	// this salt, so it must be installed before migrations or the provider can
	// compute a fingerprint.
	const fingerprintSalt = await loadFingerprintSalt(context.secrets, context.globalStorageUri, logger);
	// Before the removal store exists: it parses its Memento blobs at
	// construction and adopts stored snapshots only when strictly newer, so a
	// pre-versioning bare-array blob must read as its versioned shape from the
	// very first parse. The wrapping view normalizes reads; each region's first
	// genuine persist promotes the format durably (see migrations/bareArrayBlobs.ts
	// for why there is deliberately no writer).
	const globalState = bareArrayWrappingMemento(context.globalState);
	// Groups the user explicitly removed (the host command is add-only, so
	// removal works by tombstoning): the provider consults the store on every
	// group refresh, and tombstone changes fire the model-change event.
	const groupRemovals = new GroupRemovalStore(globalState);
	const migrationContext: MigrationContext = {
		globalState,
		secrets: context.secrets,
		logger,
		fingerprintSalt,
	};
	return {
		fingerprintSalt,
		groupRemovals,
		runMigrations: () => runMigrations(migrationContext),
	};
}
