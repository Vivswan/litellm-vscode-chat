/**
 * The adoptServer intent: resolving an external group's live credentials by
 * the opaque handle its dashboard row carried, and writing them as a new
 * declared entry. Values exist extension-side only; the webview names the
 * group and the storage locations, never the values.
 */

import * as vscode from "vscode";
import type { ServerModelsSnapshot } from "../../provider";
import type { GroupServer } from "../../provider/catalog/groupModels";
import type { OptionalEntryFields } from "../../shared/serverEntry";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { isUnsafeRecordKey } from "../../shared/util/json";
import type { DeclaredServerView } from "../servers/serverSync";
import { acceptedEntry } from "../servers/serverSync";
import { adoptSourceHandle } from "./adoptHandle";
import type { DashboardIntent } from "./intentSchema";
import type { IntentEnvironment } from "./intents";
import { DashboardOperationError, DashboardValidationError, rawServerEntries } from "./intents";
import type { SecretFieldId } from "./protocol";
import { NON_SECRET_OPTIONAL_FIELD_IDS, SECRET_FIELD_IDS } from "./protocol";
import { isUsableHttpUrl } from "./serverForm";
import { joinDeclared, labeledSnapshots } from "./state";

/**
 * A live group's connection material flattened to servers-setting field names,
 * for the adopt action. Values exist extension-side only: this shape is never
 * logged and never enters DashboardState.
 */
export type AdoptableGroupCredentials = OptionalEntryFields;

/**
 * Resolve the still-external snapshot a row handle names, bound to the
 * intent's base URL. Shared by the adopt intent's credential resolution and
 * the hide intent's identity resolution: both re-derive the external set at
 * intent time, so a forged or stale handle can only ever land on a group that
 * is genuinely external right now, and cannot re-point at another host.
 */
function resolveExternalSnapshot(
	snapshots: readonly ServerModelsSnapshot[],
	declared: readonly DeclaredServerView[],
	baseUrl: string,
	sourceHandle: string
): ServerModelsSnapshot | undefined {
	const labeled = labeledSnapshots(snapshots);
	const { unmatched } = joinDeclared(labeled, declared);
	return [...unmatched].find(
		(entry) =>
			adoptSourceHandle(entry.snapshot.status.serverId) === sourceHandle &&
			normalizeBaseUrl(entry.snapshot.status.baseUrl) === normalizeBaseUrl(baseUrl)
	)?.snapshot;
}

/**
 * The identity of the external group a hide intent names: the status label
 * and base URL the removal tombstone is keyed by. Same resolution rules as
 * resolveExternalSnapshot, plus one extra gate: the snapshot must be a
 * provider group (`isGroupSnapshot`). A legacy-registry row has no group the
 * tombstone could silence - the registry sweep would keep serving its models
 * - so "hiding" it would only make the dashboard lie; those servers are
 * removed through the legacy management flow instead.
 */
export function resolveExternalGroupIdentity(
	snapshots: readonly ServerModelsSnapshot[],
	declared: readonly DeclaredServerView[],
	baseUrl: string,
	sourceHandle: string,
	isGroupSnapshot: (serverId: string) => boolean
): { label: string; baseUrl: string } | undefined {
	const source = resolveExternalSnapshot(snapshots, declared, baseUrl, sourceHandle);
	if (source === undefined || !isGroupSnapshot(source.status.serverId)) {
		return undefined;
	}
	return { label: source.status.label, baseUrl: source.status.baseUrl };
}

/**
 * Resolve the group an adopt intent names back to its credentials, by the
 * opaque handle its external row carried. Resolution re-derives the external
 * set at intent time and binds the handle to the intent's base URL, so a
 * forged or stale intent cannot copy a DECLARED group's secure credential into
 * a settings entry, and cannot re-point a copied credential at another host.
 * Returns undefined when no still-external group at this URL matches or the
 * matching snapshot carries no group connection (a registry server); the
 * caller adopts the plain entry with a caveat in that case.
 */
export function resolveAdoptableCredentials(
	snapshots: readonly ServerModelsSnapshot[],
	declared: readonly DeclaredServerView[],
	baseUrl: string,
	sourceHandle: string,
	getGroupServer: (serverId: string) => GroupServer | undefined
): AdoptableGroupCredentials | undefined {
	const source = resolveExternalSnapshot(snapshots, declared, baseUrl, sourceHandle);
	if (source === undefined) {
		return undefined;
	}
	const server = getGroupServer(source.status.serverId);
	if (server === undefined) {
		return undefined;
	}
	return {
		...(server.apiKey.length > 0 ? { apiKey: server.apiKey } : {}),
		...(server.oauth !== undefined
			? {
					oauthTokenUrl: server.oauth.tokenUrl,
					oauthClientId: server.oauth.clientId,
					...(server.oauth.clientSecret.length > 0 ? { oauthClientSecret: server.oauth.clientSecret } : {}),
					...(server.oauth.scopes !== undefined ? { oauthScopes: server.oauth.scopes } : {}),
				}
			: {}),
		...(server.virtualKey !== undefined
			? { virtualKeyHeader: server.virtualKey.header, virtualKeyValue: server.virtualKey.value }
			: {}),
	};
}

/**
 * Apply one adoptServer intent: write the external group's configuration as a
 * new declared entry, with each resolved secret stored where the user chose.
 * The webview only ever names the group (by the opaque handle its row carried)
 * and the storage locations; the values come from the provider's in-memory
 * lookup here, extension-side, and only for a group that is still external. A
 * missing lookup (the group refreshed away, became declared, or the row was a
 * registry server) still writes the plain entry and reports the caveat through
 * the returned notice, because the user asked for the entry either way.
 *
 * Failure ordering mirrors applySaveServerSetting's guarded unit: secure
 * writes and stale-blob clears first, then the settings write; if any step
 * fails, secure values changed under this label are restored so the (absent)
 * entry resolves nothing new. The stale clears are safe before the write
 * because no entry exists under the label yet.
 */
export async function applyAdoptServer(
	intent: Extract<DashboardIntent, { type: "adoptServer" }>,
	env: IntentEnvironment
): Promise<string | undefined> {
	const label = intent.label.trim();
	if (label.length === 0) {
		// The "fieldId:" prefix stays an ASCII identifier outside the
		// translation: sectionFailureText matches it against the internal field
		// names to route the failure onto the right form section.
		throw new DashboardValidationError(`label: ${vscode.l10n.t("enter a label")}`);
	}
	if (isUnsafeRecordKey(label)) {
		throw new DashboardValidationError(`label: ${vscode.l10n.t("reserved name")}`);
	}
	const baseUrl = intent.baseUrl.trim();
	if (baseUrl.length === 0 || !isUsableHttpUrl(baseUrl)) {
		throw new DashboardValidationError(`baseUrl: ${vscode.l10n.t("not a usable http(s) URL")}`);
	}
	const entries = rawServerEntries(env.readServersSetting());
	if (acceptedEntry(entries, label) !== undefined) {
		throw new DashboardValidationError(`label: ${vscode.l10n.t("an entry with this label already exists")}`);
	}

	const credentials = env.resolveAdoptionCredentials(baseUrl, intent.sourceHandle);
	const newEntry: Record<string, string> = { label, baseUrl };
	for (const field of NON_SECRET_OPTIONAL_FIELD_IDS) {
		const value = credentials?.[field];
		if (value !== undefined) {
			newEntry[field] = value;
		}
	}

	const storedBefore = await env.readServerSecrets(label);
	const overwritten = new Map<SecretFieldId, string | undefined>();
	try {
		for (const field of SECRET_FIELD_IDS) {
			const value = credentials?.[field];
			if (value !== undefined && intent.secrets[field] === "secure") {
				overwritten.set(field, storedBefore[field]);
				await env.storeServerSecret(label, field, value);
				continue;
			}
			if (value !== undefined) {
				newEntry[field] = value;
			}
			// Blobs kept from removals must not leak into the adopted entry.
			if (storedBefore[field] !== undefined) {
				overwritten.set(field, storedBefore[field]);
				await env.storeServerSecret(label, field, undefined);
			}
		}
		await env.writeServersSetting([...entries, newEntry]);
	} catch (error) {
		let restoreFailed = false;
		for (const [field, previous] of overwritten) {
			try {
				await env.storeServerSecret(label, field, previous);
			} catch {
				restoreFailed = true;
				env.log("Restoring a secure value after a failed adoption also failed", { field });
			}
		}
		if (restoreFailed) {
			// A secure value under this label may no longer match its
			// pre-adoption state; see the save path's matching case for why
			// this must not read as "nothing landed".
			env.log("A failed adoption left a secure value unrestored", {
				error: error instanceof Error ? error.name : typeof error,
			});
			env.requestServerSync();
			throw new DashboardOperationError(
				// Not "Set Server Secret": that command lists declared entries
				// only, and this label's entry never landed. Re-adding the label
				// makes the entry editable, and the edit form's secret fields are
				// what fix the leftover state.
				`${vscode.l10n.t("The adoption failed, and this label's stored secrets could not be restored.")}\n${vscode.l10n.t(
					"Re-add a server under this label with the dashboard form, then edit the entry to set or remove the affected secrets."
				)}`
			);
		}
		throw error;
	}
	env.requestServerSync();
	return credentials === undefined
		? vscode.l10n.t("The live group's credentials could not be read, so none were copied; edit the server to set them.")
		: undefined;
}
