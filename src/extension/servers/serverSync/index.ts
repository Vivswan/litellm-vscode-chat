/**
 * The declarative server sync: litellm-vscode-chat.servers is the settings side's source of truth for servers, and
 * this module keeps VS Code's provider groups in step with it. The command rejects an existing name and the host has
 * no update or removal command (hostGroupCommand.test.ts pins this), so the engine treats a duplicate rejection for an
 * unchanged entry as the synced steady state and surfaces an actionable error when an entry changed underneath its
 * group.
 *
 *   Each entry        -> registers through the host's add-only lm.addLanguageModelsProviderGroup command
 *   its secret fields -> resolved as inline-in-settings value first, then the label's SecretStorage blob, then absent
 *
 *   Errors are logged -> never thrown into activation
 */

export type {
	DeclaredGroupIdentity,
	DeclaredIdentities,
	DeclaredServerView,
	RemovedEntryEvent,
	ServerSyncEnv,
	SyncFailure,
} from "./engine";
export { buildGroupArgs, declaredCredentials, IndeterminateServersSettingError, ServerSyncEngine } from "./engine";
export { rejectsWithOwnRow } from "./rejects";
export type { SecretStore, StoredServerSecrets } from "./secrets";
export { deleteServerSecrets, inlineSecretValues, secretLocations, updateServerSecret } from "./secrets";
export type { DeclaredServer, ServerEntryReport } from "./setting";
export {
	acceptedEntry,
	declaresServerRows,
	entryExpectedFailuresFor,
	entryIncludeModesFor,
	entryModelCapabilitiesFor,
	entryModelParametersFor,
	entrySupersedingBaseUrl,
	parseServersSetting,
	rejectedCarrierLabels,
	serverSettingReports,
	supersedingBaseUrl,
} from "./setting";
export {
	createServerSyncEnv,
	currentDeclaredServers,
	currentSettingDeclaresRows,
	readEntryApiVersion,
	readEntryCredentials,
	readEntryDeclaredModels,
	readEntryExpectedFailures,
	readEntryHeaders,
	readEntryIncludeModes,
	readEntryModelCapabilities,
	readEntryModelParameters,
	readEntrySupersedingBaseUrl,
	registerSetServerSecretCommand,
} from "./vscodeEnv";
