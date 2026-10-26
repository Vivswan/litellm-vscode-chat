/**
 * The saveServerSetting intent's apply path: how one save lands in the servers setting and the secret store, in a
 * failure-safe order. Split out of intents.ts for its size; executeDashboardIntent is the only caller.
 */

import { isDeepStrictEqual } from "node:util";
import * as l10n from "@vscode/l10n";
import type { ReplacedEntryIdentity, RequestPayload, SecretDirective } from "../../dashboard/endpoints";
import type { SecretFieldId, SecretOwner } from "../../shared/serverEntry";
import {
	parseSecretOwner,
	pickNonSecretOptionalFields,
	SECRET_FIELD_IDS,
	sameSecretDestination,
} from "../../shared/serverEntry";
import { canonicalBaseUrl, canonicalUrl } from "../../shared/util/baseUrl";
import { errorLabel } from "../../shared/util/errorLabel";
import { trimHttpWhitespace } from "../../shared/util/headers";
import { recordFromKeys } from "../../shared/util/json";
import type { StoredSecretsRecord } from "../servers/serverSync/secrets";
import {
	inlineSecretValues,
	resolveOwnedSecrets,
	secretDestination,
	secretLocations,
} from "../servers/serverSync/secrets";
import type { DeclaredServer } from "../servers/serverSync/setting";
import {
	acceptedEntry,
	declaredEntryLabel,
	nonSecretIdentityMatches,
	stillDeclaredIn,
} from "../servers/serverSync/setting";
import { rawServerEntries, writeServersSettingFrom } from "../settingsWriteTurn";
import { assembleEntryAuth, pairingFailureMessage } from "./entryAuth";
import type { IntentEnvironment } from "./intents";
import { DashboardOperationError, DashboardValidationError } from "./intents";
import { appendFree, replaceShown, requireLabelFree } from "./rowBoundWrite";

/** One secure field's value and ownership stamp, as a save's rollback reads and restores them. */
type StagedSecret = { readonly value: string | undefined; readonly owner: SecretOwner | undefined };

type SaveMode =
	| { kind: "create" }
	| { kind: "upsert"; index: number }
	| { kind: "edit"; index: number; existing: DeclaredServer }
	| { kind: "rename"; index: number; existing: DeclaredServer; oldLabel: string; willCopy: boolean };

/**
 * Only the entry the form was showing may resolve a "keep", because the sync engine resolves a label's blob
 * unconditionally and anything else would ride to whatever host the draft names. Verified, never assumed, since an
 * entry swapped in under the label while the form was open would hand ITS credentials to the host the form displays.
 */
export function requireEntryShownByForm(
	replace: ReplacedEntryIdentity | undefined,
	sources: KeepSources
): DeclaredServer | undefined {
	if (replace === undefined) {
		return undefined;
	}
	if (sources.accepted === undefined) {
		throw new DashboardValidationError(
			l10n.t("The entry being edited no longer exists in the servers setting; close the form and retry")
		);
	}
	const entry = sources.accepted.entry;
	// The identity the form displayed: the secret destinations, and where each credential lived. Locations compare
	// against the same derivation the dashboard's state push used, so an unchanged entry always passes; the values
	// behind "secure" locations are deliberately not part of the identity (the webview never sees them).
	const locations = secretLocations(entry, sources.storedOld);
	const unchanged =
		nonSecretIdentityMatches(entry, replace) &&
		SECRET_FIELD_IDS.every((field) => locations[field] === replace.secrets[field]);
	if (!unchanged) {
		throw new DashboardValidationError(
			l10n.t("The entry being edited changed in the servers setting while the form was open; close the form and retry")
		);
	}
	return entry;
}

/**
 * What one secret field does in this save, shared by the pairing checks, the guarded apply, and the cleanup. "cleared"
 * stays distinct from "absent": cleanup deletes the stored value only for cleared fields.
 */
export type SecretPlan =
	| { kind: "set-inline"; value: string }
	| { kind: "set-secure"; value: string }
	| { kind: "kept-inline"; value: string }
	| { kind: "stored" }
	| { kind: "cleared" }
	| { kind: "absent" };

/** Whether the field will hold a value once the plan is applied. */
export function planResolves(plan: SecretPlan): boolean {
	return plan.kind !== "cleared" && plan.kind !== "absent";
}

/**
 * Shared with the draft-connection test, so a directive cannot mean two values on the two paths. With no `existing`
 * "keep" resolves NOTHING, because removals keep blobs on purpose and a leftover must not resurrect under an entry
 * the form showed as credential-less.
 */
export function secretPlans(
	secrets: Readonly<Record<SecretFieldId, SecretDirective>>,
	existing: DeclaredServer | undefined,
	storedShown: Partial<Readonly<Record<SecretFieldId, string>>>
): Readonly<Record<SecretFieldId, SecretPlan>> {
	return recordFromKeys(SECRET_FIELD_IDS, (field): SecretPlan => {
		const directive = secrets[field];
		switch (directive.action) {
			case "set":
				return directive.location === "secure"
					? { kind: "set-secure", value: directive.value }
					: { kind: "set-inline", value: directive.value };
			case "clear":
				return { kind: "cleared" };
			case "keep": {
				if (existing === undefined) {
					return { kind: "absent" };
				}
				const kept = resolveKeptSecret(existing, storedShown, field);
				if (kept === undefined) {
					return { kind: "absent" };
				}
				return kept.location === "inline" ? { kind: "kept-inline", value: kept.value } : { kind: "stored" };
			}
		}
	});
}

/**
 * What "keep" directives resolve against for a draft writing `label` over the entry `targetLabel` names, shared
 * with the draft-connection test. A field stamped for another destination resolves nothing (resolveOwnedSecrets),
 * exactly as the sync engine refuses it and the dashboard displayed it as "none".
 */
export interface KeepSources {
	/** The entry being replaced, so a rejected same-label sibling cannot shadow it. */
	readonly accepted: { readonly index: number; readonly entry: DeclaredServer } | undefined;

	/** The shown label's blob, admitted field by field through the ownership check; keeps read this alone. */
	readonly storedOld: Partial<Readonly<Record<SecretFieldId, string>>>;

	/** That blob as stored, for the save's overwrite and rollback bookkeeping. */
	readonly storedOldRecord: StoredSecretsRecord;

	/** The blob already under the draft's label (on a rename, a retired label's leftover). */
	readonly storedNewRecord: StoredSecretsRecord;

	/** Whether a rename will copy the old label's blob (its owned view holds anything). */
	readonly willCopy: boolean;
}

export async function readKeepSources(
	entries: readonly unknown[],
	label: string,
	targetLabel: string,
	readServerSecrets: IntentEnvironment["readServerSecrets"]
): Promise<KeepSources> {
	const accepted = acceptedEntry(entries, targetLabel);
	const renaming = targetLabel !== label;
	const storedOldRecord = await readServerSecrets(targetLabel);
	const storedNewRecord = renaming ? await readServerSecrets(label) : storedOldRecord;
	// With no accepted entry there is nothing to pair against, so keeps resolve NOTHING - never the raw values, which
	// would hand back the one fail-open reading this module exists to prevent.
	const storedOld = accepted === undefined ? {} : resolveOwnedSecrets(accepted.entry, storedOldRecord).values;
	const willCopy = renaming && Object.keys(storedOld).length > 0;
	return { accepted, storedOld, storedOldRecord, storedNewRecord, willCopy };
}

/**
 * The value one "keep" directive resolves to, and where it lives: inline exactly when the sync engine reads it inline
 * (its own inlineSecretValues rule, never a re-derivation), the shown label's secure blob otherwise.
 */
function resolveKeptSecret(
	existing: DeclaredServer,
	storedShown: Partial<Readonly<Record<SecretFieldId, string>>>,
	field: SecretFieldId
): { readonly value: string; readonly location: "inline" | "secure" } | undefined {
	const inline = inlineSecretValues(existing)[field];
	if (inline !== undefined) {
		return { value: inline, location: "inline" };
	}
	const stored = storedShown[field];
	return stored === undefined ? undefined : { value: stored, location: "secure" };
}

/** The entry as the saveServerSetting payload carries it. */
type SavedServer = RequestPayload<"saveServerSetting">["server"];

/**
 * Which element an in-place save replaces and how, from the fresh array's target index: with no entry carrying the
 * label the save appends; with one it writes in place, as an edit or rename when the draft identified the entry it was
 * showing, as an upsert (the add form's documented "saving replaces it") when it did not.
 */
function saveModeFor(inputs: {
	readonly writeIndex: number;
	readonly showing: DeclaredServer | undefined;
	readonly renaming: boolean;
	readonly targetLabel: string;
	readonly willCopy: boolean;
}): SaveMode {
	const { writeIndex, showing, renaming, targetLabel, willCopy } = inputs;
	if (writeIndex === -1) {
		return { kind: "create" };
	}
	if (showing === undefined) {
		return { kind: "upsert", index: writeIndex };
	}
	if (renaming) {
		return { kind: "rename", index: writeIndex, existing: showing, oldLabel: targetLabel, willCopy };
	}
	return { kind: "edit", index: writeIndex, existing: showing };
}

/** The entry's `models` object, or undefined when both records are empty (the parser omits an empty record). */
function savedModelsField(server: SavedServer): Record<string, unknown> | undefined {
	const models: Record<string, unknown> = {};
	if (server.modelParameters !== undefined && Object.keys(server.modelParameters).length > 0) {
		models.parameters = server.modelParameters;
	}
	if (Object.keys(server.modelCapabilities).length > 0) {
		models.capabilities = server.modelCapabilities;
	}

	return Object.keys(models).length > 0 ? models : undefined;
}

/** The entry's `discovery` object, or undefined when the draft declares nothing; declared IDs are trimmed and deduplicated like the parser reads them. */
function savedDiscoveryField(server: SavedServer): Record<string, unknown> | undefined {
	const discovery: Record<string, unknown> = {};
	if (server.expectedFailures.length > 0) {
		discovery.expectedFailures = server.expectedFailures;
	}
	const declaredModels = [
		...new Set(server.declaredModels.map((id) => trimHttpWhitespace(id)).filter((id) => id.length > 0)),
	];
	if (declaredModels.length > 0) {
		discovery.declared = declaredModels;
	}
	if (server.includeModes.length > 0) {
		discovery.includeModes = server.includeModes;
	}

	return Object.keys(discovery).length > 0 ? discovery : undefined;
}

/**
 * The saved entry without its auth, rebuilt whole from the payload: any payload field not copied here is silently
 * DELETED by the save. "" is a real apiVersion (append nothing), so it is written and only absent (auto) omits the key.
 * `true` and `{ url }` are both real MCP opt-ins; only null omits that key.
 */
function savedEntryFields(server: SavedServer, label: string, baseUrl: string): Record<string, unknown> {
	const newEntry: Record<string, unknown> = { label, baseUrl };
	if (server.apiVersion !== undefined) {
		newEntry.apiVersion = trimHttpWhitespace(server.apiVersion);
	}
	const models = savedModelsField(server);
	if (models !== undefined) {
		newEntry.models = models;
	}
	const discovery = savedDiscoveryField(server);
	if (discovery !== undefined) {
		newEntry.discovery = discovery;
	}
	if (Object.keys(server.headers).length > 0) {
		newEntry.headers = server.headers;
	}
	if (server.budget !== null) {
		newEntry.budget = server.budget;
	}
	if (server.mcp !== null) {
		const mcpUrl = server.mcp === true ? undefined : canonicalUrl(server.mcp.url ?? "");
		newEntry.mcp = mcpUrl === undefined ? true : { url: mcpUrl };
	}

	return newEntry;
}

/**
 * The entry's auth object, assembled once by the shared assembler: pairing (OAuth as one unit, the virtual key pair
 * both-or-neither) is enforced against the resolved secrets - a value resting in SecretStorage counts as present -
 * while only the inline plan values enter the written shape, so secure values stay out of the setting and resolve at
 * sync time.
 */
function assembledSaveAuth(
	server: SavedServer,
	plans: Readonly<Record<SecretFieldId, SecretPlan>>
): Readonly<Record<string, unknown>> | undefined {
	const inlineValues: { -readonly [K in SecretFieldId]?: string } = {};
	for (const field of SECRET_FIELD_IDS) {
		const plan = plans[field];
		if (plan.kind === "set-inline" || plan.kind === "kept-inline") {
			inlineValues[field] = plan.value;
		}
	}
	const optionalFields = pickNonSecretOptionalFields(server);
	const tokenUrl = optionalFields.oauthTokenUrl === undefined ? undefined : canonicalUrl(optionalFields.oauthTokenUrl);
	const assembled = assembleEntryAuth(
		{ ...optionalFields, ...(tokenUrl === undefined ? {} : { oauthTokenUrl: tokenUrl }), ...inlineValues },
		recordFromKeys(SECRET_FIELD_IDS, (field) => planResolves(plans[field]))
	);
	if (assembled.failure !== undefined) {
		throw new DashboardValidationError(pairingFailureMessage(assembled.failure));
	}

	return assembled.auth;
}

/**
 * One secure write of the save, recorded once it landed: what the field held before the save first wrote it, and what
 * the save last wrote there, the stamp as the record reads it back.
 */
interface StagedWrite {
	readonly previous: StagedSecret;
	readonly written: StagedSecret;
}

interface SecretStaging {
	readonly env: IntentEnvironment;
	readonly label: string;
	readonly plans: Readonly<Record<SecretFieldId, SecretPlan>>;
	readonly mode: SaveMode;
	readonly sources: KeepSources;
	readonly destinationOf: (field: SecretFieldId) => SecretOwner;
	readonly wipesLeftovers: boolean;
	readonly staged: Map<SecretFieldId, StagedWrite>;
}

/** Write one secure field and record it in `staged` once it landed, keeping the first-seen previous value. */
async function stageWrite(
	staging: SecretStaging,
	field: SecretFieldId,
	previous: StagedSecret,
	written: StagedSecret
): Promise<void> {
	await staging.env.storeServerSecret(staging.label, field, written.value, written.owner);
	staging.staged.set(field, {
		previous: staging.staged.get(field)?.previous ?? previous,
		written: { value: written.value, owner: parseSecretOwner(written.owner, field) },
	});
}

/** What the draft's label already holds for a field (on a rename, a retired label's leftover). */
function heldByNew(sources: KeepSources, field: SecretFieldId): StagedSecret {
	return { value: sources.storedNewRecord.values[field], owner: sources.storedNewRecord.owners[field] };
}

/**
 * A rename's copy writes the SNAPSHOT the plans resolved from, field by field, never the source blob as it stands NOW:
 * a concurrent edit of the old label's blob between the read and this write must not ride to the new label under a
 * form that never showed it. Each copied field is stamped for the entry being written - the copy IS this save's
 * deliberate pairing.
 */
async function stageRenameCopy(staging: SecretStaging): Promise<void> {
	const { sources, destinationOf } = staging;
	for (const field of SECRET_FIELD_IDS) {
		const copied = sources.storedOld[field];
		// Fields the snapshot lacks are deleted when the target held them, so the new label's whole blob becomes the
		// snapshot; fields neither side held are skipped, since a no-op delete's failure could abort an otherwise clean
		// save.
		if (copied === undefined && sources.storedNewRecord.values[field] === undefined) {
			continue;
		}
		await stageWrite(staging, field, heldByNew(sources, field), {
			value: copied,
			owner: copied === undefined ? undefined : destinationOf(field),
		});
	}
}

/**
 * Stage each field's plan. A kept stored value under an edit that changed its destination (or one that predates
 * stamping) is re-stamped, value unchanged: the user saw the field as "stored in secure storage" and saved the entry
 * around it, which is exactly the deliberate pairing a stamp records.
 */
async function stageFieldPlans(staging: SecretStaging): Promise<void> {
	const { plans, mode, sources, destinationOf, wipesLeftovers } = staging;
	for (const field of SECRET_FIELD_IDS) {
		const plan = plans[field];
		const keptOwner = sources.storedOldRecord.owners[field];
		if (plan.kind === "set-secure") {
			await stageWrite(staging, field, heldByNew(sources, field), { value: plan.value, owner: destinationOf(field) });
		} else if (
			plan.kind === "stored" &&
			mode.kind === "edit" &&
			(keptOwner === undefined || !sameSecretDestination(keptOwner, destinationOf(field)))
		) {
			await stageWrite(
				staging,
				field,
				{ value: sources.storedOldRecord.values[field], owner: sources.storedOldRecord.owners[field] },
				{ value: sources.storedOld[field], owner: destinationOf(field) }
			);
		} else if (wipesLeftovers && sources.storedNewRecord.values[field] !== undefined) {
			await stageWrite(staging, field, heldByNew(sources, field), { value: undefined, owner: undefined });
		}
	}
}

/** Every secure write of the save, into `staged` as each lands, so a throw mid-way leaves the record the rollback undoes. */
async function stageSecretWrites(staging: SecretStaging): Promise<void> {
	if (staging.mode.kind === "rename" && staging.mode.willCopy) {
		await stageRenameCopy(staging);
	}
	await stageFieldPlans(staging);
}

/**
 * The setting still resolves what it resolved before, so the secure side must too: every staged field goes back to
 * what it held before this save, value and stamp alike (after a rename's copy, the new label's blob returns to its
 * pre-copy state). Returns the fields whose restore failed.
 */
async function rollbackStagedSecrets(
	env: IntentEnvironment,
	label: string,
	staged: ReadonlyMap<SecretFieldId, StagedWrite>
): Promise<SecretFieldId[]> {
	const restoreFailures: SecretFieldId[] = [];
	for (const [field, { previous, written }] of [...staged].reverse()) {
		try {
			// A field is restored only while it still holds what this save wrote: a writer that stored its own in
			// between owns it now.
			const live = await env.readServerSecrets(label);
			if (live.values[field] !== written.value || !isDeepStrictEqual(live.owners[field], written.owner)) {
				env.log("A secure value changed under a failed save's rollback; it was left as it stands", { field });
				continue;
			}
			await env.storeServerSecret(label, field, previous.value, previous.owner);
		} catch {
			restoreFailures.push(field);
			env.log("Restoring a secure value after a failed save also failed", { field });
		}
	}

	return restoreFailures;
}

/**
 * The refusal for a save whose rollback left a secure value changed. The durable state DID change: a freshly stored
 * secret survived the rollback and now resolves for the unchanged entry, so this must not surface as "nothing landed".
 * The detail line's field ids and label are webview-legal; neither reaches the log, which stays classification-only.
 */
function unrestoredSaveError(inputs: {
	readonly env: IntentEnvironment;
	readonly label: string;
	readonly newEntry: Record<string, unknown>;
	readonly restoreFailures: readonly SecretFieldId[];
	readonly error: unknown;
}): DashboardOperationError {
	const { env, label, newEntry, restoreFailures, error } = inputs;
	env.log("A failed save left a secure value unrestored", {
		error: errorLabel(error),
	});
	// A failed settings write fires no configuration event, so a sync is requested here, but ONLY while the standing
	// entry still names every destination the user was saving. A concurrent re-point of the host or the OAuth token
	// URL must not route the stranded credential there; a create or rename has no standing entry.
	const intended = acceptedEntry([newEntry], label);
	const standing = acceptedEntry(env.readServersSetting(), label);
	if (intended !== undefined && standing !== undefined && nonSecretIdentityMatches(standing.entry, intended.entry)) {
		env.requestServerSync();
	}
	return new DashboardOperationError(
		`${l10n.t(
			"The save failed and a stored secret may have been left changed. Check it with LiteLLM: Set Server Secret, then redo the edit."
		)}\n${l10n.t(
			'could not restore {0} for server "{1}"; the settings entry is unchanged (after a rename, the changed values sit under the new label)',
			restoreFailures.join(", "),
			label
		)}`
	);
}

/**
 * Remove a cleared secret; true when even the retry failed. The cleared secret is still effective if the delete fails,
 * so one retry, then the intent fails.
 */
async function removeClearedSecret(env: IntentEnvironment, label: string, field: SecretFieldId): Promise<boolean> {
	try {
		await env.storeServerSecret(label, field, undefined, undefined);
	} catch {
		try {
			await env.storeServerSecret(label, field, undefined, undefined);
		} catch {
			env.log("Removing a cleared secret failed; the stored value is still in effect", { field });
			return true;
		}
	}

	return false;
}

/**
 * Drop the stale secure copy behind an inline value; log-only, since the copy is dormant (it takes over only if the
 * inline value is later removed by hand).
 */
async function dropShadowedCopy(env: IntentEnvironment, label: string, field: SecretFieldId): Promise<void> {
	try {
		await env.storeServerSecret(label, field, undefined, undefined);
	} catch {
		env.log("Post-save secret cleanup failed; a dormant secure copy remains", { field });
	}
}

/**
 * Drop the old label's blob after a rename; log-only, since the leftover is dormant. Presence is re-checked at delete
 * time, not assumed from pass start: a concurrent save may have re-created an entry under the old label, and this blob
 * is then that entry's live credentials (kept exactly like a removal keeps blobs), so skipping errs toward keeping a
 * secret, never deleting a live one.
 */
async function dropRenamedBlob(env: IntentEnvironment, oldLabel: string): Promise<void> {
	if (stillDeclaredIn(env.readServersSetting())(oldLabel)) {
		env.log("Post-rename secret cleanup skipped; the old label was re-declared");
		return;
	}
	try {
		await env.deleteServerSecrets(oldLabel);
	} catch {
		env.log("Post-rename secret cleanup failed; the old label's blob remains");
	}
}

/** The destructive cleanup, safe once the write landed; true when a cleared secret could not be removed. */
async function cleanupAfterSave(
	env: IntentEnvironment,
	label: string,
	plans: Readonly<Record<SecretFieldId, SecretPlan>>,
	mode: SaveMode
): Promise<boolean> {
	let clearFailed = false;
	for (const field of SECRET_FIELD_IDS) {
		const plan = plans[field];
		if (plan.kind === "cleared") {
			clearFailed = (await removeClearedSecret(env, label, field)) || clearFailed;
		} else if (plan.kind === "set-inline") {
			await dropShadowedCopy(env, label, field);
		}
	}
	if (mode.kind === "rename") {
		await dropRenamedBlob(env, mode.oldLabel);
	}

	return clearFailed;
}

/**
 * The staged secrets are observable before the settings write lands (the unit's steps await), by design;
 * serverSync.test.ts pins the window.
 *
 *   stage for a changed destination    -> carries the saved entry's stamp,
 *                                         so a sync pass refuses the pairing (resolveOwnedSecrets)
 *   stage for an unchanged destination -> the user's own credential going where they sent it
 */
export async function applySaveServerSetting(
	intent: RequestPayload<"saveServerSetting">,
	env: IntentEnvironment
): Promise<void> {
	const label = trimHttpWhitespace(intent.server.label);
	// Trimmed like entry matching trims, so the secret-store operations below hit the same label the entry lookup
	// resolves.
	const targetLabel = trimHttpWhitespace(intent.replace?.label ?? label);
	const entries = rawServerEntries(env.readServersSetting());
	// The entry being edited is the one the dashboard row described, never a rejected same-label sibling sitting
	// earlier in the raw array. The same helper reads what the sync engine will read for this label after the save (see
	// KeepSources), so the pairing checks and the draft test share one "keep" truth.
	const sources = await readKeepSources(entries, label, targetLabel, (secretsLabel) =>
		env.readServerSecrets(secretsLabel)
	);
	// The entry this save's form was showing, verified against the identity the form displayed and refused when it is
	// gone or changed.
	const showing = requireEntryShownByForm(intent.replace, sources);
	const renaming = targetLabel !== label;
	// Raw labels count as taken (the webview's own rule): a parser-rejected entry still occupies its label, and a
	// rename beside it would land two entries under one label. The "fieldId:" prefix is what sectionFailureText
	// matches against the internal field names to route the failure onto the right form section, so it stays an ASCII
	// identifier outside the translation. Same rule for every field-prefixed message below.
	if (renaming) {
		requireLabelFree(entries, label);
	}

	// The one rule for WHICH element an in-place save replaces, read again at write time over the fresh array: the
	// accepted entry under the target label, or - the fallback that covers the parser-rejected carrier an acceptedEntry
	// lookup misses - the first raw carrier of the draft's label.
	const indexOfTarget = (list: readonly unknown[]): number =>
		acceptedEntry(list, targetLabel)?.index ?? list.findIndex((item) => declaredEntryLabel(item) === label);
	const mode = saveModeFor({
		writeIndex: indexOfTarget(entries),
		showing,
		renaming,
		targetLabel,
		willCopy: sources.willCopy,
	});
	const plans = secretPlans(intent.secrets, showing, sources.storedOld);

	// Written in the one spelling the parser reads back, so the stored text equals the text every reader uses; the
	// intent validation already refused anything canonicalUrl refuses, so this throw is unreachable by the wire.
	const baseUrl = canonicalBaseUrl(intent.server.baseUrl);
	if (baseUrl === undefined) {
		throw new DashboardValidationError(`baseUrl: ${l10n.t("not a usable http(s) URL")}`);
	}
	const newEntry = savedEntryFields(intent.server, label, baseUrl);
	const auth = assembledSaveAuth(intent.server, plans);
	if (auth !== undefined) {
		newEntry.auth = auth;
	}

	// The destination each secure value written by this save is being paired with: its ownership stamp. Derived from
	// the entry as the parser will read it back (the assembler emits only parser-accepted shapes); the raw-field
	// fallback covers the unreachable parse failure without ever stamping a wrong destination.
	const intendedEntry = acceptedEntry([newEntry], label)?.entry;
	const destinationOf = (field: SecretFieldId): SecretOwner => secretDestination(intendedEntry ?? { baseUrl }, field);
	// A leftover blob field under the saved label is wiped when no plan can reference it (wiping after a rename's
	// copy would delete the copied fields, so the two are exclusive).
	const wipesLeftovers = showing === undefined || (mode.kind === "rename" && !mode.willCopy);
	const staged = new Map<SecretFieldId, StagedWrite>();
	try {
		await stageSecretWrites({ env, label, plans, mode, sources, destinationOf, wipesLeftovers, staged });
		// Re-read at write time, after the awaited secret operations, so the pass-start array cannot revert a sibling
		// edited meanwhile. A refusal lands in the catch below, which rolls the staged secrets back; the write itself
		// stays last-write-wins across windows, since VS Code offers nothing smaller.
		//   create       -> the label must still be free
		//   edit, rename -> the target must still equal the element the plans resolved against
		await writeServersSettingFrom(env, (fresh) =>
			mode.kind === "create"
				? appendFree(fresh, label, newEntry)
				: replaceShown(fresh, indexOfTarget(fresh), entries[mode.index], newEntry, renaming ? label : undefined)
		);
	} catch (error) {
		const restoreFailures = await rollbackStagedSecrets(env, label, staged);
		if (restoreFailures.length > 0) {
			throw unrestoredSaveError({ env, label, newEntry, restoreFailures, error });
		}
		throw error;
	}

	const clearFailed = await cleanupAfterSave(env, label, plans, mode);
	env.requestServerSync();
	if (clearFailed) {
		throw new DashboardOperationError(
			l10n.t(
				"The server entry was saved, but removing the stored secret failed. Edit the server and retry, or use LiteLLM: Set Server Secret to remove it."
			)
		);
	}
}
