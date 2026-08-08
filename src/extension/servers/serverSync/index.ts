/**
 * The declarative server sync: litellm-vscode-chat.servers is the settings
 * side's source of truth for servers, and this module keeps VS Code's
 * provider groups in step with it. Each entry is registered through the
 * host's add-only lm.addLanguageModelsProviderGroup command, with its secret
 * fields resolved as inline-in-settings value first, then the label's
 * SecretStorage blob, then absent. The command rejects an existing name and
 * the host has no update or removal command (hostGroupCommand.test.ts pins
 * this), so the engine treats a duplicate rejection for an unchanged entry
 * as the synced steady state and surfaces an actionable error when an entry
 * changed underneath its existing group.
 *
 * The engine takes its effects as an injected environment, so everything but
 * the last-mile vscode wiring (createServerSyncEnv, the palette command) is
 * unit-testable. Errors are logged, never thrown into activation, and no log
 * line ever carries a secret: labels, base URLs, and has-credential booleans
 * at most.
 *
 * setting.ts parses the setting, secrets.ts owns the SecretStorage blobs and
 * the inline-precedence rule, engine.ts is the sync engine itself, and
 * vscodeEnv.ts is the vscode wiring. This index is the import surface.
 */

export type { DeclaredEntryIdentity, DeclaredServerView, RemovedEntryEvent, ServerSyncEnv } from "./engine";
export {
	buildGroupArgs,
	GROUP_UPDATE_UNAVAILABLE_MESSAGE,
	GROUP_UPSERT_FAILED_MESSAGE,
	SALT_UNAVAILABLE_MESSAGE,
	SECRETS_READ_FAILED_MESSAGE,
	ServerSyncEngine,
} from "./engine";
export type { SecretStore, StoredServerSecrets } from "./secrets";
export {
	copyServerSecrets,
	deleteServerSecrets,
	inlineSecretValues,
	readServerSecrets,
	updateServerSecret,
} from "./secrets";
export type { DeclaredServer, ServerEntryReport } from "./setting";
export {
	acceptedEntry,
	entryExpectedFailuresFor,
	entryModelCapabilitiesFor,
	entryModelParametersFor,
	parseServersSetting,
	serverSettingReports,
} from "./setting";
export {
	createServerSyncEnv,
	readEntryDeclaredModels,
	readEntryExpectedFailures,
	readEntryHeaders,
	readEntryModelCapabilities,
	readEntryModelParameters,
	registerSetServerSecretCommand,
} from "./vscodeEnv";
