/**
 * The settings export/import command surface: the host flows over the pure
 * core in src/extension/settingsTransfer/. Every dialog and side effect rides
 * the SettingsTransferEnv and prompts seams so the flows are fully fakeable.
 *
 * Secret rules pinned here: the pre-import snapshot serializes WHOLE (settings
 * half included - the recorded servers value can carry inline secret text)
 * into the one SecretStorage slot, never a file, never globalState, never a
 * log line. Logs stay English and carry classifications and counts only.
 */

import * as os from "node:os";
import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { CMD } from "../../shared/config/commandIds";
import { ALL_SETTING_KEYS, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import { PRE_IMPORT_SNAPSHOT_SECRET } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import type { SecretFieldId } from "../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { errorLabel } from "../../shared/util/errorLabel";
import { isRecord, isUnsafeRecordKey } from "../../shared/util/json";
import type { ServerSyncEngine } from "../servers/serverSync/engine";
import type { StoredSecretOwners, StoredSecretsRecord, StoredServerSecrets } from "../servers/serverSync/secrets";
import {
	deleteServerSecrets,
	readServerSecretsRecord,
	resolveOwnedSecrets,
	updateServerSecret,
} from "../servers/serverSync/secrets";
import { acceptedEntry, rawDeclaredLabels } from "../servers/serverSync/setting";
import type { SettingsAccess } from "../settingsAccess";
import { createSettingsAccess } from "../settingsAccess";
import { parseEnvelope } from "../settingsTransfer/envelope";
import { buildSettingsExport } from "../settingsTransfer/exportBuild";
import type { CollisionDecision } from "../settingsTransfer/importPlan";
import {
	connectionChangedLabels,
	planSettingsImport,
	resolveImportPlan,
	suggestRenamedLabel,
} from "../settingsTransfer/importPlan";
import type { PreImportSnapshot, SnapshotBlobEntry, SnapshotEntry } from "../settingsTransfer/snapshot";
import { buildPreImportSnapshot, planSnapshotRestore } from "../settingsTransfer/snapshot";
import type { MessageAction } from "./notifier";
import { showActionableMessage } from "./notifier";

/** The import file size cap; a settings export is small, so anything larger is not one. */
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

/** The preview modal's list caps: modal detail space is bounded. */
const PREVIEW_KEY_CAP = 8;
const PREVIEW_PROBLEM_CAP = 5;

/** What the import preview modal states; lists arrive pre-capped, the counts carry the totals. */
export interface ImportPreviewSummary {
	/** Non-servers keys the import writes. */
	readonly settingCount: number;
	/** The first settingCount keys, capped at PREVIEW_KEY_CAP. */
	readonly settingKeys: readonly string[];
	/** Distinct importable server labels in the file (collisions included). */
	readonly serverCount: number;
	/** Incoming labels already present in the current setting. */
	readonly collisionCount: number;
	/** Collisions whose overwrite changes connection fields, which the synced group cannot pick up in place. */
	readonly connectionChangedCount: number;
	/** Inline secret values that will move into VS Code secret storage. */
	readonly secretFieldCount: number;
	/** English parser problem lines per entry, capped at PREVIEW_PROBLEM_CAP. */
	readonly problemLines: readonly string[];
	/** Total problem lines before the cap. */
	readonly problemCount: number;
	/** Wrong-typed keys the scalar type gate skips. */
	readonly skippedKeyCount: number;
	/** File keys outside the setting vocabulary, ignored. */
	readonly unknownKeyCount: number;
	/** Server entries that cannot import (no usable label, or shadowed same-label siblings). */
	readonly skippedServerCount: number;
}

/** Every dialog the flows show; fully fakeable, and dismissals map to undefined/false. */
export interface SettingsTransferPrompts {
	/** The export-time include/exclude-secrets modal; undefined on dismissal (silent abort). */
	confirmSecrets(): Promise<"include" | "exclude" | undefined>;
	/** The import preview modal; false on dismissal (silent abort, nothing written). */
	confirmImport(summary: ImportPreviewSummary): Promise<boolean>;
	/** One label's collision prompt; undefined on dismissal aborts the whole import. */
	resolveCollision(label: string, connectionChanged: boolean): Promise<"overwrite" | "skip" | "rename" | undefined>;
	/** The rename input box; validate returns a localized error or undefined; undefined result aborts the import. */
	askRenamedLabel(suggested: string, validate: (candidate: string) => string | undefined): Promise<string | undefined>;
	/** The undo confirmation modal, stating the snapshot time; false on dismissal (silent abort). */
	confirmUndo(snapshotAt: string): Promise<boolean>;
	/** Toasts; every user-facing outcome goes through here so tests can record it. */
	notify(kind: "info" | "warning" | "error", message: string, actions?: readonly MessageAction[]): Promise<void>;
}

/** The flows' whole world: settings access, secret storage, dialogs, files, sync, and the English log. */
export interface SettingsTransferEnv {
	readonly settings: SettingsAccess;
	readonly prompts: SettingsTransferPrompts;
	readServerSecrets(label: string): Promise<StoredSecretsRecord>;
	/** Write one field; undefined deletes it. `owner` is the ownership stamp for a written value; see updateServerSecret. */
	updateServerSecret(
		label: string,
		field: SecretFieldId,
		value: string | undefined,
		owner: string | undefined
	): Promise<void>;
	deleteServerSecrets(label: string): Promise<void>;
	/** The one pre-import snapshot slot (SecretStorage; the snapshot is secret-capable whole). */
	readSnapshotSlot(): Promise<string | undefined>;
	writeSnapshotSlot(serialized: string): Promise<void>;
	clearSnapshotSlot(): Promise<void>;
	showSaveDialog(defaultUri: vscode.Uri): Promise<vscode.Uri | undefined>;
	showOpenDialog(): Promise<vscode.Uri | undefined>;
	fileSize(uri: vscode.Uri): Promise<number>;
	readFile(uri: vscode.Uri): Promise<Uint8Array>;
	writeFile(uri: vscode.Uri, contents: Uint8Array): Promise<void>;
	revealFile(uri: vscode.Uri): Promise<void>;
	homeDir(): string;
	readonly extensionVersion: string;
	requestServerSync(): void;
	/** English-only classification log; counts and classifications, never values, paths, or secret material. */
	log(message: string, data?: Record<string, unknown>): void;
}

/** Render the preview summary into the modal's detail text. */
function renderImportPreview(summary: ImportPreviewSummary): string {
	const lines: string[] = [];
	if (summary.settingCount > 0) {
		const keys = summary.settingKeys.join(", ") + (summary.settingCount > summary.settingKeys.length ? ", ..." : "");
		lines.push(
			summary.settingCount === 1
				? l10n.t("1 setting will be written: {0}", keys)
				: l10n.t("{0} settings will be written: {1}", summary.settingCount, keys)
		);
	}
	if (summary.serverCount > 0) {
		lines.push(
			summary.serverCount === 1
				? l10n.t("1 server will be imported.")
				: l10n.t("{0} servers will be imported.", summary.serverCount)
		);
	}
	if (summary.collisionCount > 0) {
		lines.push(
			summary.collisionCount === 1
				? l10n.t("1 label already exists; you will choose overwrite, skip, or rename.")
				: l10n.t("{0} labels already exist; you will choose overwrite, skip, or rename.", summary.collisionCount)
		);
	}
	if (summary.connectionChangedCount > 0) {
		lines.push(
			summary.connectionChangedCount === 1
				? l10n.t(
						"Overwriting 1 server changes its connection settings; its dashboard row will show the steps to reconnect."
					)
				: l10n.t(
						"Overwriting {0} servers changes their connection settings; their dashboard rows will show the steps to reconnect.",
						summary.connectionChangedCount
					)
		);
	}
	if (summary.secretFieldCount > 0) {
		lines.push(
			summary.secretFieldCount === 1
				? l10n.t("The file carries 1 secret value; imported secrets are stored in VS Code secret storage.")
				: l10n.t(
						"The file carries {0} secret values; imported secrets are stored in VS Code secret storage.",
						summary.secretFieldCount
					)
		);
	}
	if (summary.skippedKeyCount > 0) {
		lines.push(
			summary.skippedKeyCount === 1
				? l10n.t("1 setting has the wrong type and will be skipped.")
				: l10n.t("{0} settings have the wrong type and will be skipped.", summary.skippedKeyCount)
		);
	}
	if (summary.unknownKeyCount > 0) {
		lines.push(
			summary.unknownKeyCount === 1
				? l10n.t("1 unknown key will be ignored.")
				: l10n.t("{0} unknown keys will be ignored.", summary.unknownKeyCount)
		);
	}
	if (summary.skippedServerCount > 0) {
		lines.push(
			summary.skippedServerCount === 1
				? l10n.t("1 server entry cannot be imported and will be skipped.")
				: l10n.t("{0} server entries cannot be imported and will be skipped.", summary.skippedServerCount)
		);
	}
	if (summary.problemLines.length > 0) {
		lines.push(l10n.t("Entry problems:"));
		lines.push(...summary.problemLines);
		if (summary.problemCount > summary.problemLines.length) {
			lines.push("...");
		}
	}
	return lines.join("\n");
}

/** The real dialogs; l10n resolves at call time (no module-level localized constants). */
function createSettingsTransferPrompts(): SettingsTransferPrompts {
	return {
		confirmSecrets: async () => {
			const include = l10n.t("Include Secrets");
			const exclude = l10n.t("Exclude Secrets");
			const choice = await vscode.window.showWarningMessage(
				l10n.t("Include secret values in the exported file?"),
				{
					modal: true,
					detail: l10n.t(
						"Included secrets (API keys, client secrets, virtual key values) are written into the file in plaintext. Custom header values are exported as plain configuration either way."
					),
				},
				include,
				exclude
			);
			return choice === include ? "include" : choice === exclude ? "exclude" : undefined;
		},
		confirmImport: async (summary) => {
			const proceed = l10n.t("Import");
			const choice = await vscode.window.showInformationMessage(
				l10n.t("Import these LiteLLM settings?"),
				{ modal: true, detail: renderImportPreview(summary) },
				proceed
			);
			return choice === proceed;
		},
		resolveCollision: async (label, connectionChanged) => {
			const overwrite = l10n.t("Overwrite");
			const skip = l10n.t("Skip");
			const rename = l10n.t("Import Renamed");
			const choice = await vscode.window.showWarningMessage(
				l10n.t('A server named "{0}" already exists.', label),
				{
					modal: true,
					detail: connectionChanged
						? l10n.t(
								"Overwriting replaces the entry and its stored secrets, and changes its connection settings; the server's dashboard row will show the steps to reconnect."
							)
						: l10n.t("Overwriting replaces the entry and its stored secrets."),
				},
				overwrite,
				skip,
				rename
			);
			return choice === overwrite ? "overwrite" : choice === skip ? "skip" : choice === rename ? "rename" : undefined;
		},
		askRenamedLabel: async (suggested, validate) =>
			vscode.window.showInputBox({
				title: l10n.t("Import Server Renamed"),
				prompt: l10n.t("A new label for the imported server."),
				value: suggested,
				validateInput: (candidate) => validate(candidate) ?? null,
			}),
		confirmUndo: async (snapshotAt) => {
			const undo = l10n.t("Undo Import");
			// The recorded ISO instant, shown in the user's locale; an
			// unparseable timestamp shows as recorded rather than "Invalid Date".
			const recorded = new Date(snapshotAt);
			const when = Number.isNaN(recorded.getTime()) ? snapshotAt : recorded.toLocaleString();
			const choice = await vscode.window.showWarningMessage(
				l10n.t("Undo the last settings import?"),
				{
					modal: true,
					detail: l10n.t(
						"Settings and stored server secrets will be restored to their state from {0}. Changes made to them since then will be lost.",
						when
					),
				},
				undo
			);
			return choice === undo;
		},
		notify: (kind, message, actions = []) => showActionableMessage(kind, message, [...actions]),
	};
}

/** The real environment over the extension context, the sync engine, and the logger. */
export function createSettingsTransferEnv(
	context: vscode.ExtensionContext,
	syncEngine: Pick<ServerSyncEngine, "requestSync">,
	logger: Logger
): SettingsTransferEnv {
	return {
		settings: createSettingsAccess(),
		prompts: createSettingsTransferPrompts(),
		readServerSecrets: (label) => readServerSecretsRecord(context.secrets, label),
		updateServerSecret: (label, field, value, owner) => updateServerSecret(context.secrets, label, field, value, owner),
		deleteServerSecrets: (label) => deleteServerSecrets(context.secrets, label),
		readSnapshotSlot: async () => context.secrets.get(PRE_IMPORT_SNAPSHOT_SECRET),
		writeSnapshotSlot: async (serialized) => context.secrets.store(PRE_IMPORT_SNAPSHOT_SECRET, serialized),
		clearSnapshotSlot: async () => context.secrets.delete(PRE_IMPORT_SNAPSHOT_SECRET),
		showSaveDialog: async (defaultUri) => vscode.window.showSaveDialog({ defaultUri, filters: { JSON: ["json"] } }),
		showOpenDialog: async () => {
			const picks = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: { JSON: ["json"] },
			});
			return picks?.[0];
		},
		fileSize: async (uri) => (await vscode.workspace.fs.stat(uri)).size,
		readFile: async (uri) => vscode.workspace.fs.readFile(uri),
		writeFile: async (uri, contents) => vscode.workspace.fs.writeFile(uri, contents),
		revealFile: async (uri) => {
			await vscode.commands.executeCommand("revealFileInOS", uri);
		},
		homeDir: () => os.homedir(),
		extensionVersion: String(context.extension.packageJSON?.version ?? "unknown"),
		requestServerSync: () => syncEngine.requestSync(),
		log: (message, data) => logger.log(message, data),
	};
}

/** The toast action that runs the undo flow (same env, same behavior as the palette command). */
function undoImportAction(env: SettingsTransferEnv): MessageAction {
	return { label: l10n.t("Undo Import"), run: () => runUndoLastImportFlow(env) };
}

/** LiteLLM: Export Settings... - secrets modal, save dialog, tab-indented JSON write, counts toast. */
export async function runExportSettingsFlow(env: SettingsTransferEnv): Promise<void> {
	try {
		const probe = env.settings.snapshotReader();
		if (!ALL_SETTING_KEYS.some((key) => probe.inspect(key)?.globalValue !== undefined)) {
			await env.prompts.notify(
				"info",
				l10n.t("LiteLLM: No settings are configured in the user scope, so there is nothing to export.")
			);
			return;
		}
		const secretsChoice = await env.prompts.confirmSecrets();
		if (secretsChoice === undefined) {
			return;
		}
		const target = await env.showSaveDialog(
			vscode.Uri.joinPath(vscode.Uri.file(env.homeDir()), "litellm-settings.json")
		);
		if (target === undefined) {
			return;
		}
		// One snapshot for the whole build, so the file never mixes configuration versions.
		const reader = env.settings.snapshotReader();
		const result = await buildSettingsExport({
			readGlobalSetting: (key) => reader.inspect(key)?.globalValue,
			readServerSecrets: (label) => env.readServerSecrets(label),
			extensionVersion: env.extensionVersion,
			includeSecrets: secretsChoice === "include",
		});
		await env.writeFile(target, Buffer.from(`${JSON.stringify(result.envelope, null, "\t")}\n`, "utf8"));

		const settingsPart = result.settingCount === 1 ? l10n.t("1 setting") : l10n.t("{0} settings", result.settingCount);
		const notes: string[] = [
			result.serverCount > 0
				? l10n.t(
						"LiteLLM: Exported {0} and {1}.",
						settingsPart,
						result.serverCount === 1 ? l10n.t("1 server") : l10n.t("{0} servers", result.serverCount)
					)
				: l10n.t("LiteLLM: Exported {0}.", settingsPart),
		];
		if (secretsChoice === "include") {
			notes.push(l10n.t("The file contains secret values in plaintext; store and share it carefully."));
		}
		if (result.unmaterializedSecretCount > 0) {
			notes.push(
				result.unmaterializedSecretCount === 1
					? l10n.t("1 stored secret had no place in its entry and is not in the file.")
					: l10n.t(
							"{0} stored secrets had no place in their entries and are not in the file.",
							result.unmaterializedSecretCount
						)
			);
		}
		if (result.mismatchedSecretCount > 0) {
			notes.push(
				result.mismatchedSecretCount === 1
					? l10n.t("1 stored secret belongs to a different server address and is not in the file.")
					: l10n.t(
							"{0} stored secrets belong to different server addresses and are not in the file.",
							result.mismatchedSecretCount
						)
			);
		}
		if (result.omittedUnsanitizableCount > 0) {
			notes.push(
				result.omittedUnsanitizableCount === 1
					? l10n.t("1 unrecognized part of the servers setting was omitted because it cannot be checked for secrets.")
					: l10n.t(
							"{0} unrecognized parts of the servers setting were omitted because they cannot be checked for secrets.",
							result.omittedUnsanitizableCount
						)
			);
		}
		env.log("Settings export written", {
			settings: result.settingCount,
			servers: result.serverCount,
			includeSecrets: secretsChoice === "include",
			unmaterialized: result.unmaterializedSecretCount,
			mismatched: result.mismatchedSecretCount,
			omitted: result.omittedUnsanitizableCount,
		});
		await env.prompts.notify("info", notes.join(" "), [
			{ label: l10n.t("Reveal File"), run: () => env.revealFile(target) },
		]);
	} catch (error) {
		env.log("Settings export failed", { error: errorLabel(error) });
		await env.prompts.notify("error", l10n.t("LiteLLM: The settings export failed; the file was not written."));
	}
}

/** The localized parse-failure message for one ParseEnvelopeResult verdict. */
function parseFailureMessage(reason: "not-json" | "not-an-export" | "newer-version", exportedBy?: string): string {
	if (reason === "newer-version") {
		return exportedBy !== undefined
			? l10n.t(
					"LiteLLM: This file was exported by a newer version of the extension ({0}); update the extension to import it.",
					exportedBy
				)
			: l10n.t(
					"LiteLLM: This file was exported by a newer version of the extension; update the extension to import it."
				);
	}
	return l10n.t("LiteLLM: This file is not a LiteLLM settings export.");
}

/**
 * The apply step's servers unit, adopt-ordered: secret writes and stale-blob
 * clears per label first, the single servers array write LAST; on failure every
 * recorded secret value is restored, and a restore failure escalates.
 * `settingsLanded` says whether the non-servers writes committed, so a clean
 * rollback that changed nothing at all can offer no Undo.
 */
async function applyServersUnit(
	env: SettingsTransferEnv,
	serversValue: readonly unknown[],
	secretWrites: readonly {
		readonly label: string;
		readonly secrets: StoredServerSecrets;
		readonly owners: StoredSecretOwners;
	}[],
	settingsLanded: boolean
): Promise<"landed" | "rolled-back" | "rollback-failed"> {
	const overwritten: {
		label: string;
		field: SecretFieldId;
		previous: string | undefined;
		previousOwner: string | undefined;
	}[] = [];
	try {
		for (const write of secretWrites) {
			const storedBefore = await env.readServerSecrets(write.label);
			for (const field of SECRET_FIELD_IDS) {
				// An undefined value clears the field: one the imported entry does
				// not set is stale under this label.
				const value = write.secrets[field];
				if (value === undefined && storedBefore.values[field] === undefined) {
					continue;
				}
				await env.updateServerSecret(write.label, field, value, value !== undefined ? write.owners[field] : undefined);
				// Recorded only after the write landed: updateServerSecret's
				// read-modify-write leaves the blob untouched when it throws.
				overwritten.push({
					label: write.label,
					field,
					previous: storedBefore.values[field],
					previousOwner: storedBefore.owners[field],
				});
			}
		}
		await env.settings.writeGlobal(SERVERS_SETTING_KEY, serversValue);
		return "landed";
	} catch (error) {
		const unrestoredLabels = new Set<string>();
		for (const { label, field, previous, previousOwner } of [...overwritten].reverse()) {
			try {
				await env.updateServerSecret(label, field, previous, previousOwner);
			} catch {
				unrestoredLabels.add(label);
				env.log("Restoring a stored secret after a failed settings import also failed", { field });
			}
		}
		if (unrestoredLabels.size > 0) {
			env.log("Settings import failed and left a stored secret unrestored", { error: errorLabel(error) });
			// An unrestored secret is the IMPORTED credential, which belongs to
			// its entry in serversValue, while the live entries are still
			// pre-import (the servers write lands last). Withholding the wake
			// would only defer the hazard - activation force-syncs, and any
			// servers edit syncs too - so a credential whose live entry is not
			// its own is CLEARED, the same rule the abandoned undo applies. Both
			// values survive: the pre-import one in the snapshot slot this run
			// wrote, the imported one in the file the user chose.
			const clearFailures = await clearMismatchedBlobs(
				env,
				unrestoredLabels,
				serversValue,
				"Settings import: clearing an unrestored secret under an entry that is not its own failed"
			);
			if (clearFailures === 0) {
				env.requestServerSync();
			} else {
				env.log("Settings import: the sync request was withheld; an unrestored secret could not be cleared");
			}
			await env.prompts.notify(
				"error",
				`${l10n.t("LiteLLM: The settings import failed, and some stored server secrets could not be restored.")}\n${l10n.t(
					"Undo Import restores the pre-import state; alternatively, edit each affected server in the dashboard or use the Set Server Secret command."
				)}`,
				[undoImportAction(env)]
			);
			return "rollback-failed";
		}
		env.log("Settings import: the servers write failed; secret changes were rolled back", {
			error: errorLabel(error),
		});
		env.requestServerSync();
		const message = l10n.t(
			"LiteLLM: The settings import failed while writing the servers setting; server secret changes were rolled back."
		);
		await env.prompts.notify(
			"error",
			settingsLanded
				? `${message} ${l10n.t("Other settings from the file were already written; Undo Import restores the pre-import state.")}`
				: message,
			// With nothing landed there is nothing this run left to undo.
			settingsLanded ? [undoImportAction(env)] : []
		);
		return "rolled-back";
	}
}

/** LiteLLM: Import Settings... - open dialog, preview, collision prompts, snapshot, guarded apply, summary. */
export async function runImportSettingsFlow(env: SettingsTransferEnv): Promise<void> {
	try {
		const source = await env.showOpenDialog();
		if (source === undefined) {
			return;
		}
		const size = await env.fileSize(source);
		if (size > MAX_IMPORT_FILE_BYTES) {
			env.log("Settings import rejected: file exceeds the size cap", { size });
			await env.prompts.notify("error", l10n.t("LiteLLM: This file is too large to be a settings export (over 5 MB)."));
			return;
		}
		// A leading byte-order mark an editor may add on a round trip is not part
		// of the JSON grammar; a valid export must not read as "not an export".
		const text = Buffer.from(await env.readFile(source))
			.toString("utf8")
			.replace(/^\uFEFF/, "");
		const parsed = parseEnvelope(text);
		if (!parsed.ok) {
			env.log("Settings import rejected: the file did not parse as an export", { reason: parsed.reason });
			await env.prompts.notify(
				"error",
				parseFailureMessage(parsed.reason, parsed.reason === "newer-version" ? parsed.exportedBy : undefined)
			);
			return;
		}

		const currentServersRaw = env.settings.readGlobal(SERVERS_SETTING_KEY);
		// Plan twice: the first pass names the colliding labels, whose stored
		// blobs then let connectionChanged compare EFFECTIVE secret material -
		// through the ownership check, so a refused stored value is compared as
		// the absence the live entry actually resolves.
		const prePlan = planSettingsImport(parsed.settings, currentServersRaw);
		const storedSecrets: Record<string, StoredServerSecrets> = {};
		for (const collision of prePlan.collisions) {
			const record = await env.readServerSecrets(collision.label);
			const standing = acceptedEntry(currentServersRaw, collision.label)?.entry;
			// No accepted entry means nothing to pair against, so nothing
			// resolves - the same fail-closed default the save path's keep
			// sources apply (a rejected carrier resolves no secrets at sync time).
			storedSecrets[collision.label] = standing !== undefined ? resolveOwnedSecrets(standing, record).values : {};
		}
		const plan = planSettingsImport(parsed.settings, currentServersRaw, storedSecrets);

		const importableLabels = new Set<string>();
		for (const incoming of plan.incomingServers) {
			if (!incoming.skipped && incoming.report.label !== undefined) {
				importableLabels.add(incoming.report.label);
			}
		}
		// Everything beyond one entry per distinct label cannot land: unlabeled
		// or reserved-label entries, and shadowed same-label siblings alike.
		const unimportableServers = plan.incomingServers.length - importableLabels.size;
		if (plan.settingsWrites.length === 0 && importableLabels.size === 0) {
			await env.prompts.notify("info", l10n.t("LiteLLM: The file contains no importable settings."));
			return;
		}

		const problemLines: string[] = [];
		let problemCount = 0;
		for (const incoming of plan.incomingServers) {
			for (const problem of incoming.report.problems) {
				problemCount += 1;
				if (problemLines.length < PREVIEW_PROBLEM_CAP) {
					problemLines.push(`${incoming.report.label ?? `entry ${incoming.report.index + 1}`}: ${problem}`);
				}
			}
		}
		const summary: ImportPreviewSummary = {
			settingCount: plan.settingsWrites.length,
			settingKeys: plan.settingsWrites.slice(0, PREVIEW_KEY_CAP).map((write) => write.key),
			serverCount: importableLabels.size,
			collisionCount: plan.collisions.length,
			connectionChangedCount: plan.collisions.filter((collision) => collision.connectionChanged).length,
			secretFieldCount: plan.secretFieldCount,
			problemLines,
			problemCount,
			skippedKeyCount: plan.skippedKeys.length,
			unknownKeyCount: parsed.unknownKeys.length,
			skippedServerCount: unimportableServers,
		};
		if (!(await env.prompts.confirmImport(summary))) {
			return;
		}

		// Every collision needs a decision before anything is written: a
		// dismissed prompt aborts the whole import with zero writes.
		const decisions: Record<string, CollisionDecision> = {};
		const currentLabels = rawDeclaredLabels(currentServersRaw);
		const renameTargets = new Set<string>();
		for (const collision of plan.collisions) {
			const choice = await env.prompts.resolveCollision(collision.label, collision.connectionChanged);
			if (choice === undefined) {
				return;
			}
			if (choice !== "rename") {
				decisions[collision.label] = { action: choice };
				continue;
			}
			const taken = new Set<string>([...currentLabels, ...importableLabels, ...renameTargets]);
			const validate = (candidate: string): string | undefined => {
				const trimmed = candidate.trim();
				if (trimmed.length === 0) {
					return l10n.t("enter a label");
				}
				if (isUnsafeRecordKey(trimmed)) {
					return l10n.t("reserved name");
				}
				if (taken.has(trimmed)) {
					return l10n.t("this label is already in use");
				}
				return undefined;
			};
			const newLabel = await env.prompts.askRenamedLabel(suggestRenamedLabel(collision.label, taken), validate);
			if (newLabel === undefined) {
				return;
			}
			const trimmed = newLabel.trim();
			decisions[collision.label] = { action: "rename", newLabel: trimmed };
			renameTargets.add(trimmed);
		}

		const application = resolveImportPlan(plan, decisions);

		// The merged servers array was computed against the value read before the
		// prompts; a concurrent edit during those modals would be silently
		// overwritten by the stale merge, so a changed value aborts.
		if (
			application.serversValue !== undefined &&
			JSON.stringify(env.settings.readGlobal(SERVERS_SETTING_KEY)) !== JSON.stringify(currentServersRaw)
		) {
			env.log("Settings import cancelled: the servers setting changed while the prompts were open");
			await env.prompts.notify(
				"warning",
				l10n.t(
					"LiteLLM: The servers setting changed while the import was waiting for confirmation; nothing was changed. Run the import again."
				)
			);
			return;
		}

		// A run that will write nothing must not touch the slot: overwriting it
		// would destroy the only recovery path from the PREVIOUS import.
		const writesNothing = application.settingsWrites.length === 0 && application.serversValue === undefined;
		// The slot as it was before this run: a run that lands NOTHING puts it
		// back for the same reason.
		let previousSlot: string | undefined;
		const restorePreviousSlot = async () => {
			try {
				if (previousSlot === undefined) {
					await env.clearSnapshotSlot();
				} else {
					await env.writeSnapshotSlot(previousSlot);
				}
			} catch (error) {
				env.log("Restoring the previous undo snapshot after a landed-nothing import failed", {
					error: errorLabel(error),
				});
			}
		};
		if (!writesNothing) {
			previousSlot = await env.readSnapshotSlot();
			// Snapshot FIRST: the whole pre-import state into the one SecretStorage
			// slot. A failed snapshot write means nothing is applied.
			const snapReader = env.settings.snapshotReader();
			const snapshot = await buildPreImportSnapshot(
				(key) => snapReader.inspect(key)?.globalValue,
				(label) => env.readServerSecrets(label),
				application.touchedLabels
			);
			try {
				await env.writeSnapshotSlot(JSON.stringify(snapshot));
			} catch (error) {
				env.log("Settings import cancelled: the undo snapshot could not be saved", { error: errorLabel(error) });
				await env.prompts.notify(
					"error",
					l10n.t("LiteLLM: The import was cancelled because the undo snapshot could not be saved; nothing was changed.")
				);
				return;
			}
		}

		// Non-servers writes, per key: failures are collected, the rest attempted.
		const failedKeys: string[] = [];
		for (const write of application.settingsWrites) {
			try {
				await env.settings.writeGlobal(write.key, write.value);
			} catch {
				failedKeys.push(write.key);
			}
		}
		if (failedKeys.length > 0) {
			env.log("Settings import: some setting writes failed", { keys: failedKeys });
		}
		const writtenSettings = application.settingsWrites.length - failedKeys.length;

		if (application.serversValue !== undefined) {
			const outcome = await applyServersUnit(
				env,
				application.serversValue,
				application.secretWrites,
				writtenSettings > 0
			);
			if (outcome !== "landed") {
				// A clean rollback with no landed settings changed nothing, so the
				// previous import's recovery path comes back. A failed rollback left
				// secrets changed, so the fresh snapshot stays.
				if (outcome === "rolled-back" && writtenSettings === 0) {
					await restorePreviousSlot();
				}
				return;
			}
		}
		env.requestServerSync();

		// Nothing survived: same as a no-op run, the previous snapshot comes
		// back and there is nothing to undo.
		const landedAnything = writtenSettings > 0 || application.serversValue !== undefined;
		if (!writesNothing && !landedAnything) {
			await restorePreviousSlot();
		}

		const writtenKeys = application.settingsWrites.map((write) => write.key).filter((key) => !failedKeys.includes(key));
		if (application.serversValue !== undefined) {
			writtenKeys.push(SERVERS_SETTING_KEY);
		}
		const shadowedKeys = writtenKeys.filter((key) => {
			const inspection = env.settings.inspect(key);
			return inspection?.workspaceValue !== undefined || inspection?.workspaceFolderValue !== undefined;
		});

		const { counts } = application;
		const parts: string[] = [];
		if (writtenSettings > 0) {
			parts.push(writtenSettings === 1 ? l10n.t("1 setting written") : l10n.t("{0} settings written", writtenSettings));
		}
		if (counts.imported > 0) {
			parts.push(counts.imported === 1 ? l10n.t("1 server added") : l10n.t("{0} servers added", counts.imported));
		}
		if (counts.overwritten > 0) {
			parts.push(
				counts.overwritten === 1
					? l10n.t("1 server overwritten")
					: l10n.t("{0} servers overwritten", counts.overwritten)
			);
		}
		if (counts.renamed > 0) {
			parts.push(counts.renamed === 1 ? l10n.t("1 server renamed") : l10n.t("{0} servers renamed", counts.renamed));
		}
		if (counts.skipped > 0) {
			parts.push(counts.skipped === 1 ? l10n.t("1 server skipped") : l10n.t("{0} servers skipped", counts.skipped));
		}
		const notes: string[] = [
			parts.length > 0
				? l10n.t("LiteLLM: Settings import complete: {0}.", parts.join(", "))
				: l10n.t("LiteLLM: Settings import complete: nothing needed to change."),
		];
		if (failedKeys.length > 0) {
			notes.push(
				failedKeys.length === 1
					? l10n.t("1 setting could not be written: {0}.", failedKeys.join(", "))
					: l10n.t("{0} settings could not be written: {1}.", failedKeys.length, failedKeys.join(", "))
			);
		}
		if (shadowedKeys.length > 0) {
			notes.push(
				l10n.t(
					"Workspace settings override {0} in this window; the imported values take effect where no workspace override exists.",
					shadowedKeys.join(", ")
				)
			);
		}
		env.log("Settings import applied", {
			settings: writtenSettings,
			failedSettings: failedKeys.length,
			imported: counts.imported,
			overwritten: counts.overwritten,
			renamed: counts.renamed,
			skipped: counts.skipped,
			secretWrites: application.secretWrites.length,
		});
		// No snapshot guards a run that wrote nothing (or landed nothing), so it has no undo.
		await env.prompts.notify(
			failedKeys.length > 0 ? "warning" : "info",
			notes.join(" "),
			writesNothing || !landedAnything ? [] : [undoImportAction(env)]
		);
	} catch (error) {
		env.log("Settings import failed", { error: errorLabel(error) });
		await env.prompts.notify("error", l10n.t("LiteLLM: The settings import failed."));
	}
}

/**
 * Strict revalidation of the persisted snapshot slot: the slot is
 * extension-owned and only ever written by buildPreImportSnapshot, so ANY
 * deviation is corruption, and a corrupted snapshot must never drive settings
 * writes or blob deletions. Undefined means unusable.
 */
function parseSnapshotSlot(serialized: string): PreImportSnapshot | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.settings) || !isRecord(parsed.blobs) || typeof parsed.at !== "string") {
		return undefined;
	}
	const settings: Record<string, SnapshotEntry<unknown>> = {};
	for (const [key, entry] of Object.entries(parsed.settings)) {
		// The builder walks ALL_SETTING_KEYS exclusively; a key outside the
		// vocabulary would drive writeGlobal on a key VS Code does not know.
		if (!ALL_SETTING_KEYS.includes(key) || !isRecord(entry) || typeof entry.present !== "boolean") {
			return undefined;
		}
		// A present entry always carries its value and an absent one never does;
		// either mismatch would restore the opposite of what was recorded.
		if (entry.present !== "value" in entry) {
			return undefined;
		}
		settings[key] = entry.present ? { present: true, value: entry.value } : { present: false };
	}
	// The builder records EVERY vocabulary key; a partial record is corruption,
	// and restoring it would leave the missing keys at their import values.
	for (const key of ALL_SETTING_KEYS) {
		if (!Object.hasOwn(settings, key)) {
			return undefined;
		}
	}
	const blobs: Record<string, SnapshotBlobEntry> = {};
	for (const [label, entry] of Object.entries(parsed.blobs)) {
		// Real labels are always trimmed, non-empty, and non-reserved; anything
		// else would write a SecretStorage key no server entry can ever read.
		if (
			label.length === 0 ||
			label.trim() !== label ||
			isUnsafeRecordKey(label) ||
			!isRecord(entry) ||
			typeof entry.present !== "boolean"
		) {
			return undefined;
		}
		if (!entry.present) {
			// The absent record never carries a value; one riding along means
			// the flag cannot be trusted, and "absent" restores as a deletion.
			if ("value" in entry) {
				return undefined;
			}
			blobs[label] = { present: false };
			continue;
		}
		if (!isRecord(entry.value)) {
			return undefined;
		}
		// The builder only ever stores non-empty SECRET_FIELD_IDS strings and
		// records an empty blob as absent; anything else would restore a blob that
		// never existed.
		const fields = Object.entries(entry.value);
		if (fields.length === 0) {
			return undefined;
		}
		const blob: { -readonly [K in SecretFieldId]?: string } = {};
		for (const [field, value] of fields) {
			if (!(SECRET_FIELD_IDS as readonly string[]).includes(field) || typeof value !== "string" || value.length === 0) {
				return undefined;
			}
			blob[field as SecretFieldId] = value;
		}
		// Ownership stamps are optional (snapshots predating them carry none)
		// but when present must be the builder's shape: stamp strings ("" is a
		// real stamp) on fields the value record holds.
		let owners: { -readonly [K in SecretFieldId]?: string } | undefined;
		if ("owners" in entry && entry.owners !== undefined) {
			if (!isRecord(entry.owners)) {
				return undefined;
			}
			owners = {};
			for (const [field, owner] of Object.entries(entry.owners)) {
				if (
					!(SECRET_FIELD_IDS as readonly string[]).includes(field) ||
					typeof owner !== "string" ||
					blob[field as SecretFieldId] === undefined
				) {
					return undefined;
				}
				owners[field as SecretFieldId] = owner;
			}
		}
		blobs[label] = { present: true, value: blob, ...(owners !== undefined ? { owners } : {}) };
	}
	return { settings, blobs, at: parsed.at };
}

/** The kept-snapshot warning both partial-undo paths show; the retry finishes the job. */
async function notifyKeptSnapshot(env: SettingsTransferEnv, failures: number): Promise<void> {
	await env.prompts.notify(
		"warning",
		failures === 1
			? l10n.t(
					"LiteLLM: The undo could not restore everything (1 step failed); the snapshot was kept, so you can run Undo Last Settings Import again."
				)
			: l10n.t(
					"LiteLLM: The undo could not restore everything ({0} steps failed); the snapshot was kept, so you can run Undo Last Settings Import again.",
					failures
				)
	);
}

/** The raw servers-array items carrying `label`, trimmed as the setting's own label grammar trims. */
function rawEntriesOf(raw: unknown, label: string): unknown[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.filter((item) => isRecord(item) && typeof item.label === "string" && item.label.trim() === label);
}

/** The undo path's clearMismatchedBlobs failure line; both of its call sites report the same classification. */
const UNDO_CLEAR_FAILURE_LOG = "Undo import: re-clearing a restored secret under an unrestored entry failed";

/**
 * The rule both abandoned failure paths apply: a stored credential belongs
 * only under the entry it was recorded for, so while the live entry is some
 * OTHER configuration - an undo's still-imported entry, or an import rollback's
 * still-pre-import one - that credential would reach the wrong host, and it is
 * cleared. Withholding the sync request alone would not do: activation
 * force-syncs and any servers edit syncs too, so only removing the credential
 * closes the hazard rather than deferring it. Nothing unrecoverable is lost -
 * the pre-import value is in the snapshot slot and the imported one in the
 * user's file - and a failed write can leave a label half-restored, so success
 * is not tracked; the kept snapshot restores whatever this removes once a retry
 * lands the entries too. The compare is raw entry identity rather than the
 * connection fingerprint: only a byte-identical entry proves the credential is
 * under the entry it belongs to (a base URL compare alone would miss the other
 * routing fields, an OAuth token URL among them), and a needless clear is
 * recoverable while a served retired credential is not. The returned failure
 * count is what gates the caller's sync request.
 */
async function clearMismatchedBlobs(
	env: SettingsTransferEnv,
	labels: Iterable<string>,
	referenceServersRaw: unknown,
	failureLog: string
): Promise<number> {
	let failures = 0;
	const liveServersRaw = env.settings.readGlobal(SERVERS_SETTING_KEY);
	for (const label of new Set(labels)) {
		if (
			JSON.stringify(rawEntriesOf(liveServersRaw, label)) === JSON.stringify(rawEntriesOf(referenceServersRaw, label))
		) {
			continue;
		}
		try {
			await env.deleteServerSecrets(label);
		} catch (error) {
			failures += 1;
			env.log(failureLog, { error: errorLabel(error) });
		}
	}
	return failures;
}

/** LiteLLM: Undo Last Settings Import - the wholesale pre-import snapshot restore. */
export async function runUndoLastImportFlow(env: SettingsTransferEnv): Promise<void> {
	try {
		const slot = await env.readSnapshotSlot();
		if (slot === undefined) {
			await env.prompts.notify("info", l10n.t("LiteLLM: There is no settings import to undo."));
			return;
		}
		const snapshot = parseSnapshotSlot(slot);
		if (snapshot === undefined) {
			// A corrupt slot can never restore anything; keeping it would make
			// every future undo fail the same way, so it is cleared.
			env.log("Undo import: the stored snapshot could not be parsed; the slot was cleared");
			await env.clearSnapshotSlot();
			await env.prompts.notify(
				"error",
				l10n.t("LiteLLM: The stored undo snapshot could not be read, so nothing was restored.")
			);
			return;
		}
		const restore = planSnapshotRestore(snapshot);
		if (!(await env.prompts.confirmUndo(snapshot.at))) {
			return;
		}
		// What the restore reconnects, computed BEFORE anything changes. The host
		// group API is add-only, so a reverted connection change cannot be
		// reconciled by the trailing sync - the affected row shows the steps.
		const currentServersRaw = env.settings.readGlobal(SERVERS_SETTING_KEY);
		const serversEntry = snapshot.settings[SERVERS_SETTING_KEY];
		const targetServersRaw = serversEntry?.present === true ? serversEntry.value : undefined;
		// Both sides read through the same ownership resolution the import
		// preview's collision pass uses: no accepted entry resolves nothing, and
		// a stored field stamped for a different destination compares as the
		// absence its entry actually resolves - a dormant leftover value must
		// not count as a reconnect.
		const currentBlobs: Record<string, StoredServerSecrets> = {};
		const targetBlobs: Record<string, StoredServerSecrets> = {};
		for (const label of new Set([...rawDeclaredLabels(currentServersRaw), ...rawDeclaredLabels(targetServersRaw)])) {
			const record = await env.readServerSecrets(label);
			const snapshotBlob = Object.hasOwn(snapshot.blobs, label) ? snapshot.blobs[label] : undefined;
			const targetRecord =
				snapshotBlob === undefined
					? record
					: snapshotBlob.present
						? { values: snapshotBlob.value, owners: snapshotBlob.owners ?? {} }
						: { values: {}, owners: {} };
			const standing = acceptedEntry(currentServersRaw, label)?.entry;
			const target = acceptedEntry(targetServersRaw, label)?.entry;
			currentBlobs[label] = standing !== undefined ? resolveOwnedSecrets(standing, record).values : {};
			targetBlobs[label] = target !== undefined ? resolveOwnedSecrets(target, targetRecord).values : {};
		}
		const reconnectCount = connectionChangedLabels(
			currentServersRaw,
			currentBlobs,
			targetServersRaw,
			targetBlobs
		).length;

		let failures = 0;
		// Restore order mirrors the import's adopt ordering: SecretStorage writes
		// never wake the sync engine, the servers settings write does, so blobs
		// restore first and the engine wakes to a consistent pre-import state.
		for (const write of restore.blobWrites) {
			try {
				// Field by field, absent fields cleared, so the blob is restored
				// WHOLE - values and ownership stamps alike.
				for (const field of SECRET_FIELD_IDS) {
					await env.updateServerSecret(write.label, field, write.secrets[field], write.owners[field]);
				}
			} catch {
				failures += 1;
			}
		}
		for (const label of restore.blobRemovals) {
			try {
				await env.deleteServerSecrets(label);
			} catch {
				failures += 1;
			}
		}
		if (failures > 0) {
			// Stop before the settings phase: writing the servers setting now would
			// wake the sync engine against partially restored credentials. The slot
			// is kept, so a retry finishes the job.
			failures += await clearMismatchedBlobs(
				env,
				restore.blobWrites.map((write) => write.label),
				targetServersRaw,
				UNDO_CLEAR_FAILURE_LOG
			);
			env.log("Undo import: some blob restores failed; the settings phase was not started", { failures });
			await notifyKeptSnapshot(env, failures);
			return;
		}
		for (const write of restore.settingWrites) {
			try {
				await env.settings.writeGlobal(write.key, write.value);
			} catch {
				failures += 1;
			}
		}
		for (const key of restore.settingRemovals) {
			try {
				await env.settings.writeGlobal(key, undefined);
			} catch {
				failures += 1;
			}
		}
		if (failures > 0) {
			const clearFailures = await clearMismatchedBlobs(
				env,
				restore.blobWrites.map((write) => write.label),
				targetServersRaw,
				UNDO_CLEAR_FAILURE_LOG
			);
			failures += clearFailures;
			// Every credential whose live entry is not its own is gone by now, so
			// the only thing that still blocks the wake is a clear that failed and
			// left one in place. The kept slot lets a retry finish the job and
			// sync then.
			if (clearFailures === 0) {
				env.requestServerSync();
			} else {
				env.log("Undo import: the sync request was withheld; a mismatched credential could not be cleared");
			}
			// The slot is kept: what failed this time may succeed on a retry,
			// and clearing it would strand the un-restored remainder.
			env.log("Undo import: some restore steps failed; the snapshot was kept", { failures });
			await notifyKeptSnapshot(env, failures);
			return;
		}
		env.requestServerSync();
		await env.clearSnapshotSlot();
		env.log("Settings import undone", {
			settings: restore.settingWrites.length,
			removals: restore.settingRemovals.length,
			blobs: restore.blobWrites.length,
			blobRemovals: restore.blobRemovals.length,
			reconnects: reconnectCount,
		});
		const summary = [l10n.t("LiteLLM: Restored settings to their pre-import state.")];
		if (reconnectCount > 0) {
			summary.push(
				reconnectCount === 1
					? l10n.t(
							"The undo changed 1 server's connection settings; its dashboard row will show the steps to reconnect."
						)
					: l10n.t(
							"The undo changed {0} servers' connection settings; their dashboard rows will show the steps to reconnect.",
							reconnectCount
						)
			);
		}
		await env.prompts.notify("info", summary.join(" "));
	} catch (error) {
		env.log("Undo import failed", { error: errorLabel(error) });
		await env.prompts.notify("error", l10n.t("LiteLLM: The undo failed; the snapshot was kept."));
	}
}

export function registerSettingsTransferCommands(context: vscode.ExtensionContext, env: SettingsTransferEnv): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.exportSettings, () => runExportSettingsFlow(env)),
		vscode.commands.registerCommand(CMD.importSettings, () => runImportSettingsFlow(env)),
		vscode.commands.registerCommand(CMD.undoLastImport, () => runUndoLastImportFlow(env))
	);
}
