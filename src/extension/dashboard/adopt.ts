/**
 * The adoptServer intent: resolving an external group's live credentials by the opaque handle its dashboard row
 * carried, and writing them as a new declared entry. Values exist extension-side only; the webview names the group and
 * the storage locations, never the values.
 */

import { isDeepStrictEqual } from "node:util";
import * as l10n from "@vscode/l10n";
import type { RequestPayload } from "../../dashboard/endpoints";
import { isUsableHttpUrl } from "../../dashboard/serverForm";
import type { GroupServer } from "../../provider/catalog/groupModels";
import type { ServerModelsSnapshot } from "../../provider/catalog/statusWindow";
import type { OptionalEntryFieldId, OptionalEntryFields, SecretFieldId, SecretOwner } from "../../shared/serverEntry";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { errorLabel } from "../../shared/util/errorLabel";
import { trimHttpWhitespace } from "../../shared/util/headers";
import { isUnsafeRecordKey, recordFromKeys } from "../../shared/util/json";
import type { TombstoneIdentity } from "../servers/groupRemovals";
import type { DeclaredIdentities } from "../servers/serverSync/engine";
import { secretDestination } from "../servers/serverSync/secrets";
import { acceptedEntry } from "../servers/serverSync/setting";
import { rawServerEntries, writeServersSettingFrom } from "../settingsWriteTurn";
import { adoptSourceHandle } from "./adoptHandle";
import { labeledSnapshots, resolveGroupOwnership, secretValueHolders } from "./declaredJoin";
import { assembleEntryAuth, pairingFailureMessage } from "./entryAuth";
import type { IntentEnvironment } from "./intents";
import { DashboardOperationError, DashboardValidationError } from "./intents";
import { appendFree, requireLabelFree, requireSettingUnchanged } from "./rowBoundWrite";

/**
 * A live group's connection material flattened to servers-setting field names, for the adopt action. Values exist
 * extension-side only: this shape is never logged and never enters DashboardState.
 */
export type AdoptableGroupCredentials = OptionalEntryFields;

/**
 * What IntentEnvironment.resolveAdoptionCredentials answers: the source's credentials and the setting they were
 * judged against.
 */
export interface AdoptionResolution {
	/** The external group the handle names at this URL; undefined when nothing still external matches it. */
	readonly source: AdoptionSource | undefined;

	/** The raw servers setting value the resolution is consistent with (ServerSyncEngine.resolveDeclaredIdentities). */
	readonly setting: unknown;
}

/** The external group an adopt intent copies from; `credentials` is undefined when the group is registry-only. */
export interface AdoptionSource {
	readonly credentials: AdoptableGroupCredentials | undefined;
}

/**
 * What IntentEnvironment.resolveExternalGroup answers: the identity a hide tombstones and the setting it was judged
 * against.
 */
export interface ExternalGroupResolution {
	/** Undefined when nothing still-external matches the handle. */
	readonly identity: TombstoneIdentity | undefined;

	/** The raw servers setting value the resolution is consistent with (ServerSyncEngine.resolveDeclaredIdentities). */
	readonly setting: unknown;
}

export type LiveDeclaration = Pick<DeclaredIdentities, "identities" | "carriers" | "secretValues">;

/**
 * The external snapshot a row handle names, bound to the intent's base URL, under the one group ownership
 * (resolveGroupOwnership) over the engine's live declaration: a stale or forged handle cannot land on a group an
 * entry owns or a declared label left behind, and cannot re-point at another host.
 */
function resolveExternalSnapshot(
	snapshots: readonly ServerModelsSnapshot[],
	live: LiveDeclaration,
	baseUrl: string,
	sourceHandle: string,
	getGroupServer: (serverId: string) => GroupServer | undefined
): ServerModelsSnapshot | undefined {
	const { external } = resolveGroupOwnership({
		labeled: labeledSnapshots(snapshots),
		declared: live.identities,
		carriers: live.carriers,
		secretHolders: secretValueHolders(snapshots, getGroupServer, live.secretValues),
	});
	return external.find(
		(entry) =>
			adoptSourceHandle(entry.snapshot.status.serverId) === sourceHandle &&
			normalizeBaseUrl(entry.snapshot.status.baseUrl) === normalizeBaseUrl(baseUrl)
	)?.snapshot;
}

export function resolveExternalGroupIdentity(
	snapshots: readonly ServerModelsSnapshot[],
	live: LiveDeclaration,
	baseUrl: string,
	sourceHandle: string,
	getGroupServer: (serverId: string) => GroupServer | undefined
): TombstoneIdentity | undefined {
	const source = resolveExternalSnapshot(snapshots, live, baseUrl, sourceHandle, getGroupServer);
	if (source === undefined) {
		return undefined;
	}
	return { by: "group", groupId: source.status.serverId, label: source.status.label, baseUrl: source.status.baseUrl };
}

export function resolveAdoptableCredentials(
	snapshots: readonly ServerModelsSnapshot[],
	live: LiveDeclaration,
	baseUrl: string,
	sourceHandle: string,
	getGroupServer: (serverId: string) => GroupServer | undefined
): AdoptionSource | undefined {
	const source = resolveExternalSnapshot(snapshots, live, baseUrl, sourceHandle, getGroupServer);
	if (source === undefined) {
		return undefined;
	}
	const server = getGroupServer(source.status.serverId);
	if (server === undefined) {
		return { credentials: undefined };
	}
	const credentials: AdoptableGroupCredentials = {
		...(server.apiKey.length > 0 ? { apiKey: server.apiKey } : {}),
		...(server.oauth === undefined
			? {}
			: {
					oauthTokenUrl: server.oauth.tokenUrl,
					oauthClientId: server.oauth.clientId,
					...(server.oauth.clientSecret.length > 0 ? { oauthClientSecret: server.oauth.clientSecret } : {}),
					...(server.oauth.scopes === undefined ? {} : { oauthScopes: server.oauth.scopes }),
				}),
		...(server.virtualKey === undefined
			? {}
			: { virtualKeyHeader: server.virtualKey.header, virtualKeyValue: server.virtualKey.value }),
	};
	return { credentials };
}

function staleRowRefusal(): DashboardValidationError {
	return new DashboardValidationError(
		`${l10n.t("This row no longer matches an adoptable server - it may have just been declared or removed.")}\n${l10n.t(
			"The row did not resolve to an external VS Code provider group."
		)}`
	);
}

/** The adopted entry's identity as the intent names it, validated the way the save path validates a label and URL. */
function adoptedIdentity(intent: RequestPayload<"adoptServer">): { readonly label: string; readonly baseUrl: string } {
	const label = trimHttpWhitespace(intent.label);
	if (label.length === 0) {
		// The "fieldId:" prefix stays an ASCII identifier outside the translation: sectionFailureText routes the
		// failure onto the right form section by it.
		throw new DashboardValidationError(`label: ${l10n.t("enter a label")}`);
	}
	if (isUnsafeRecordKey(label)) {
		throw new DashboardValidationError(`label: ${l10n.t("reserved name")}`);
	}
	const baseUrl = trimHttpWhitespace(intent.baseUrl);
	if (baseUrl.length === 0 || !isUsableHttpUrl(baseUrl)) {
		throw new DashboardValidationError(`baseUrl: ${l10n.t("not a usable http(s) URL")}`);
	}

	return { label, baseUrl };
}

/** The source's credentials split by destination: inline fields for the entry, secure copies for SecretStorage. */
interface AdoptedCredentialSplit {
	readonly inlineFields: { -readonly [K in OptionalEntryFieldId]?: string | undefined };
	readonly secureCopies: ReadonlyMap<SecretFieldId, string>;
}

/**
 * Route each copied secret where the intent sends it. The adopted entry assembles through the shared assembler into
 * the NESTED auth object the sync engine parses: secrets the user routed to settings join the inline fields, and
 * secure-routed values stay out of the entry to land in SecretStorage. Writing any flat credential field would sync
 * credential-less.
 */
function splitAdoptedCredentials(
	credentials: AdoptableGroupCredentials | undefined,
	secrets: RequestPayload<"adoptServer">["secrets"]
): AdoptedCredentialSplit {
	const inlineFields: { -readonly [K in OptionalEntryFieldId]?: string | undefined } = {
		...pickNonSecretOptionalFields(credentials ?? {}),
	};
	const secureCopies = new Map<SecretFieldId, string>();
	for (const field of SECRET_FIELD_IDS) {
		const value = credentials?.[field];
		if (value === undefined) {
			continue;
		}
		if (secrets[field] === "secure") {
			secureCopies.set(field, value);
		} else {
			inlineFields[field] = value;
		}
	}

	return { inlineFields, secureCopies };
}

/** What a secure field held before the adoption first wrote it, for the rollback. */
interface OverwrittenSecret {
	readonly value: string | undefined;
	readonly owner: SecretOwner | undefined;
}

interface SecureCopyStaging {
	readonly env: IntentEnvironment;
	readonly label: string;
	readonly secureCopies: ReadonlyMap<SecretFieldId, string>;
	readonly destinationOf: (field: SecretFieldId) => SecretOwner;
	readonly storedBefore: Awaited<ReturnType<IntentEnvironment["readServerSecrets"]>>;
	readonly overwritten: Map<SecretFieldId, OverwrittenSecret>;
}

/**
 * Stage the secure copies under the new label, recording in `overwritten` what each field held before it was written,
 * so a throw mid-way leaves the record of everything written so far. A blob kept from a removal must not leak into the
 * adopted entry, so a field with no copy but a leftover value is cleared and recorded too.
 */
async function stageSecureCopies(staging: SecureCopyStaging): Promise<void> {
	const { env, label, secureCopies, destinationOf, storedBefore, overwritten } = staging;
	for (const field of SECRET_FIELD_IDS) {
		const copied = secureCopies.get(field);
		if (copied !== undefined) {
			overwritten.set(field, { value: storedBefore.values[field], owner: storedBefore.owners[field] });
			await env.storeServerSecret(label, field, copied, destinationOf(field));
			continue;
		}
		if (storedBefore.values[field] !== undefined) {
			overwritten.set(field, { value: storedBefore.values[field], owner: storedBefore.owners[field] });
			await env.storeServerSecret(label, field, undefined, undefined);
		}
	}
}

/** Put every overwritten field back; true when at least one restore failed (each failure is logged by field). */
async function restoreOverwrittenSecrets(
	env: IntentEnvironment,
	label: string,
	overwritten: ReadonlyMap<SecretFieldId, OverwrittenSecret>
): Promise<boolean> {
	let restoreFailed = false;
	for (const [field, previous] of overwritten) {
		try {
			await env.storeServerSecret(label, field, previous.value, previous.owner);
		} catch {
			restoreFailed = true;
			env.log("Restoring a secure value after a failed adoption also failed", { field });
		}
	}

	return restoreFailed;
}

export async function applyAdoptServer(
	intent: RequestPayload<"adoptServer">,
	env: IntentEnvironment
): Promise<string | undefined> {
	const { label, baseUrl } = adoptedIdentity(intent);
	requireLabelFree(rawServerEntries(env.readServersSetting()), label);

	const { source } = await env.resolveAdoptionCredentials(baseUrl, intent.sourceHandle);
	if (source === undefined) {
		throw staleRowRefusal();
	}
	const { credentials } = source;
	const { inlineFields, secureCopies } = splitAdoptedCredentials(credentials, intent.secrets);
	const assembled = assembleEntryAuth(
		inlineFields,
		recordFromKeys(SECRET_FIELD_IDS, (field) => credentials?.[field] !== undefined)
	);
	if (assembled.failure !== undefined) {
		// Unreachable for a live group's credentials (its OAuth and virtual-key units are complete by construction);
		// fail closed rather than adopt a partial form the parser would reject.
		throw new DashboardValidationError(pairingFailureMessage(assembled.failure));
	}
	const newEntry: Record<string, unknown> = {
		label,
		baseUrl,
		...(assembled.auth === undefined ? {} : { auth: assembled.auth }),
	};

	// The ownership stamp for each secure copy: the adopted entry's own destinations, derived from the entry as the
	// parser reads it back.
	const adoptedEntry = acceptedEntry([newEntry], label)?.entry;
	const destinationOf = (field: SecretFieldId): SecretOwner => secretDestination(adoptedEntry ?? { baseUrl }, field);

	const storedBefore = await env.readServerSecrets(label);
	const overwritten = new Map<SecretFieldId, OverwrittenSecret>();
	try {
		await stageSecureCopies({ env, label, secureCopies, destinationOf, storedBefore, overwritten });
		// Resolved again after the awaited staging: a source declared meanwhile is not copied, and the array written
		// is the one this resolution read.
		const again = await env.resolveAdoptionCredentials(baseUrl, intent.sourceHandle);
		if (again.source === undefined) {
			throw staleRowRefusal();
		}
		if (!isDeepStrictEqual(again.source.credentials, credentials)) {
			throw new DashboardValidationError(
				l10n.t(
					"The server this row described was declared in the servers setting while the adoption ran; nothing was copied"
				)
			);
		}
		await writeServersSettingFrom(env, (fresh) => {
			requireSettingUnchanged(env, again.setting);
			return appendFree(fresh, label, newEntry);
		});
	} catch (error) {
		if (await restoreOverwrittenSecrets(env, label, overwritten)) {
			// A secure value under this label may no longer match its pre-adoption state, so this must not read as
			// "nothing landed".
			env.log("A failed adoption left a secure value unrestored", {
				error: errorLabel(error),
			});
			env.requestServerSync();
			throw new DashboardOperationError(
				// Not "Set Server Secret": that command lists declared entries only, and this label's entry never
				// landed. Re-adding the label makes the entry editable, and its secret fields fix the leftover.
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
