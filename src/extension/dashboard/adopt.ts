/**
 * The adoptServer intent: resolving an external group's live credentials by
 * the opaque handle its dashboard row carried, and writing them as a new
 * declared entry. Values exist extension-side only; the webview names the
 * group and the storage locations, never the values.
 */

import * as l10n from "@vscode/l10n";
import type { RequestPayload } from "../../dashboard/endpoints";
import { isUsableHttpUrl } from "../../dashboard/serverForm";
import type { GroupServer } from "../../provider/catalog/groupModels";
import type { ServerModelsSnapshot } from "../../provider/catalog/statusWindow";
import type { OptionalEntryFieldId, OptionalEntryFields, SecretFieldId } from "../../shared/serverEntry";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { isUnsafeRecordKey, recordFromKeys } from "../../shared/util/json";
import type { DeclaredServerView } from "../servers/serverSync";
import { secretDestination } from "../servers/serverSync/secrets";
import { acceptedEntry, rawDeclaredLabels } from "../servers/serverSync/setting";
import { adoptSourceHandle } from "./adoptHandle";
import { joinDeclared, labeledSnapshots } from "./declaredJoin";
import { assembleEntryAuth, pairingFailureMessage } from "./entryAuth";
import type { IntentEnvironment } from "./intents";
import { DashboardOperationError, DashboardValidationError, rawServerEntries } from "./intents";

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
 * intent time, so a forged or stale handle can only land on a group that is
 * genuinely external right now, and cannot re-point at another host.
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
 * resolveExternalSnapshot, plus one gate: the snapshot must be a provider
 * group. A snapshot without a group has none a tombstone could silence, so
 * "hiding" it would only make the dashboard lie.
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
 * Undefined when nothing still-external matches; the caller then adopts the
 * plain entry with a caveat.
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
 * new declared entry, each resolved secret stored where the user chose. The
 * webview names only the group (by the opaque handle its row carried) and the
 * storage locations; the values come from the provider's in-memory lookup
 * here, and only for a group that is still external. A missing lookup still
 * writes the plain entry and reports the caveat, because the user asked for
 * the entry either way.
 *
 * Failure ordering mirrors applySaveServerSetting's guarded unit: secure
 * writes and stale-blob clears first, then the settings write; if any step
 * fails, secure values changed under this label are restored. The stale
 * clears are safe before the write because no entry exists under the label yet.
 */
export async function applyAdoptServer(
	intent: RequestPayload<"adoptServer">,
	env: IntentEnvironment
): Promise<string | undefined> {
	const label = intent.label.trim();
	if (label.length === 0) {
		// The "fieldId:" prefix stays an ASCII identifier outside the translation:
		// sectionFailureText routes the failure onto the right form section by it.
		throw new DashboardValidationError(`label: ${l10n.t("enter a label")}`);
	}
	if (isUnsafeRecordKey(label)) {
		throw new DashboardValidationError(`label: ${l10n.t("reserved name")}`);
	}
	const baseUrl = intent.baseUrl.trim();
	if (baseUrl.length === 0 || !isUsableHttpUrl(baseUrl)) {
		throw new DashboardValidationError(`baseUrl: ${l10n.t("not a usable http(s) URL")}`);
	}
	const entries = rawServerEntries(env.readServersSetting());
	// Raw labels count as taken (the webview's own rule): adoption always
	// creates a new entry, and a parser-rejected sibling still occupies its
	// label, so appending beside it would land two entries under one label.
	if (rawDeclaredLabels(entries).has(label)) {
		throw new DashboardValidationError(`label: ${l10n.t("an entry with this label already exists")}`);
	}

	const credentials = env.resolveAdoptionCredentials(baseUrl, intent.sourceHandle);
	// The adopted entry assembles through the shared assembler into the NESTED
	// auth object the sync engine parses: secrets the user routed to settings
	// join the inline fields; secure-routed values stay out of the entry and
	// land in SecretStorage below. Writing any flat credential field here would
	// sync credential-less and escape the no-secrets export's auth-subtree strip.
	const inlineFields: { -readonly [K in OptionalEntryFieldId]?: string | undefined } = {
		...pickNonSecretOptionalFields(credentials ?? {}),
	};
	const secureCopies = new Map<SecretFieldId, string>();
	for (const field of SECRET_FIELD_IDS) {
		const value = credentials?.[field];
		if (value === undefined) {
			continue;
		}
		if (intent.secrets[field] === "secure") {
			secureCopies.set(field, value);
		} else {
			inlineFields[field] = value;
		}
	}
	const assembled = assembleEntryAuth(
		inlineFields,
		recordFromKeys(SECRET_FIELD_IDS, (field) => credentials?.[field] !== undefined)
	);
	if (assembled.failure !== undefined) {
		// Unreachable for a live group's credentials (its OAuth and virtual-key
		// units are complete by construction); fail closed rather than adopt a
		// partial form the parser would reject.
		throw new DashboardValidationError(pairingFailureMessage(assembled.failure));
	}
	const newEntry: Record<string, unknown> = {
		label,
		baseUrl,
		...(assembled.auth !== undefined ? { auth: assembled.auth } : {}),
	};

	// The ownership stamp for each secure copy: the adopted entry's own
	// destinations, derived from the entry as the parser reads it back.
	const adoptedEntry = acceptedEntry([newEntry], label)?.entry;
	const destinationOf = (field: SecretFieldId): string => secretDestination(adoptedEntry ?? { baseUrl }, field);

	const storedBefore = await env.readServerSecrets(label);
	const overwritten = new Map<SecretFieldId, { value: string | undefined; owner: string | undefined }>();
	try {
		for (const field of SECRET_FIELD_IDS) {
			const copied = secureCopies.get(field);
			if (copied !== undefined) {
				overwritten.set(field, { value: storedBefore.values[field], owner: storedBefore.owners[field] });
				await env.storeServerSecret(label, field, copied, destinationOf(field));
				continue;
			}
			// Blobs kept from removals must not leak into the adopted entry.
			if (storedBefore.values[field] !== undefined) {
				overwritten.set(field, { value: storedBefore.values[field], owner: storedBefore.owners[field] });
				await env.storeServerSecret(label, field, undefined, undefined);
			}
		}
		await env.writeServersSetting([...entries, newEntry]);
	} catch (error) {
		let restoreFailed = false;
		for (const [field, previous] of overwritten) {
			try {
				await env.storeServerSecret(label, field, previous.value, previous.owner);
			} catch {
				restoreFailed = true;
				env.log("Restoring a secure value after a failed adoption also failed", { field });
			}
		}
		if (restoreFailed) {
			// A secure value under this label may no longer match its
			// pre-adoption state, so this must not read as "nothing landed".
			env.log("A failed adoption left a secure value unrestored", {
				error: error instanceof Error ? error.name : typeof error,
			});
			env.requestServerSync();
			throw new DashboardOperationError(
				// Not "Set Server Secret": that command lists declared entries
				// only, and this label's entry never landed. Re-adding the label
				// makes the entry editable, and its secret fields fix the leftover.
				`${l10n.t("The adoption failed, and this label's stored secrets could not be restored.")}\n${l10n.t(
					"Re-add a server under this label with the dashboard form, then edit the entry to set or remove the affected secrets."
				)}`
			);
		}
		throw error;
	}
	env.requestServerSync();
	return credentials === undefined
		? l10n.t("The live group's credentials could not be read, so none were copied; edit the server to set them.")
		: undefined;
}
