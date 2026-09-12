/**
 * The saveServerSetting intent's apply path: how one save lands in the
 * servers setting and the secret store, in a failure-safe order. Split out of
 * intents.ts for its size; executeDashboardIntent is the only caller.
 */

import { isDeepStrictEqual } from "node:util";
import * as l10n from "@vscode/l10n";
import type { ReplacedEntryIdentity, RequestPayload, SecretDirective } from "../../dashboard/endpoints";
import type { SecretFieldId } from "../../shared/serverEntry";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { errorLabel } from "../../shared/util/errorLabel";
import { recordFromKeys } from "../../shared/util/json";
import type { DeclaredServer } from "../servers/serverSync";
import { acceptedEntry, inlineSecretValues, secretLocations } from "../servers/serverSync";
import type { StoredSecretsRecord } from "../servers/serverSync/secrets";
import { resolveOwnedSecrets, secretDestination } from "../servers/serverSync/secrets";
import {
	declaredEntryLabel,
	nonSecretIdentityMatches,
	rawDeclaredLabels,
	stillDeclaredIn,
} from "../servers/serverSync/setting";
import { assembleEntryAuth, pairingFailureMessage } from "./entryAuth";
import type { IntentEnvironment } from "./intents";
import { DashboardOperationError, DashboardValidationError, rawServerEntries } from "./intents";

/**
 * Computed once so the pairing checks, the guarded apply, and the cleanup agree on it. Either rename branch leaves
 * the new label serving only the renamed entry's own secrets.
 *
 *   rename, willCopy (the owned view holds values) -> the copy replaces the new label's blob; a failed write restores it wholesale
 *   rename, !willCopy                              -> the new label's leftover fields are wiped; a failed write restores them one by one
 *   upsert                                         -> the add form onto a taken label, in place, secrets resolving like a create's
 */
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
	// The identity the form displayed: the secret destinations, and where each
	// credential lived. Locations compare against the same derivation the
	// dashboard's state push used, so an unchanged entry always passes; the
	// values behind "secure" locations are deliberately not part of the
	// identity (the webview never sees them).
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
 * What one secret field does in this save, shared by the pairing checks, the
 * guarded apply, and the cleanup. "cleared" stays distinct from "absent":
 * cleanup deletes the stored value only for cleared fields.
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
 * with the draft-connection test. A field stamped for another destination resolves nothing, exactly as the sync
 * engine refuses it and the dashboard displayed it as "none".
 *
 *   accepted        -> the entry being replaced, so a rejected same-label sibling cannot shadow it
 *   storedOld       -> the shown label's blob, admitted field by field through the ownership check; keeps read this alone
 *   storedOldRecord -> that blob as stored, for the save's overwrite and rollback bookkeeping
 *   storedNewRecord -> the blob already under the draft's label (on a rename, a retired label's leftover)
 */
export interface KeepSources {
	readonly accepted: { readonly index: number; readonly entry: DeclaredServer } | undefined;
	readonly storedOld: Partial<Readonly<Record<SecretFieldId, string>>>;
	readonly storedOldRecord: StoredSecretsRecord;
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
	// With no accepted entry there is nothing to pair against, so keeps resolve
	// NOTHING - never the raw values, which would hand back the one fail-open
	// reading this module exists to prevent.
	const storedOld = accepted !== undefined ? resolveOwnedSecrets(accepted.entry, storedOldRecord).values : {};
	const willCopy = renaming && Object.keys(storedOld).length > 0;
	return { accepted, storedOld, storedOldRecord, storedNewRecord, willCopy };
}

/**
 * The value one "keep" directive resolves to, and where it lives: inline
 * exactly when the sync engine reads it inline (its own inlineSecretValues
 * rule, never a re-derivation), the shown label's secure blob otherwise.
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
	return stored !== undefined ? { value: stored, location: "secure" } : undefined;
}

/**
 * The staged secrets are observable before the settings write lands (the unit's steps await), by design;
 * serverSync.test.ts pins the window.
 *
 *   stage for a changed destination    -> carries the saved entry's stamp, so a sync pass refuses the pairing (resolveOwnedSecrets)
 *   stage for an unchanged destination -> the user's own credential going where they sent it
 */
export async function applySaveServerSetting(
	intent: RequestPayload<"saveServerSetting">,
	env: IntentEnvironment
): Promise<void> {
	const label = intent.server.label.trim();
	// Trimmed like entry matching trims, so the secret-store operations below
	// hit the same label the entry lookup resolves.
	const targetLabel = (intent.replace?.label ?? label).trim();
	const entries = rawServerEntries(env.readServersSetting());
	// The entry being edited is the one the dashboard row described, never a
	// rejected same-label sibling sitting earlier in the raw array. The same
	// helper reads what the sync engine will read for this label after the save
	// (see KeepSources), so the pairing checks and the draft test share one
	// "keep" truth.
	const sources = await readKeepSources(entries, label, targetLabel, (secretsLabel) =>
		env.readServerSecrets(secretsLabel)
	);
	const { storedOld, storedOldRecord, storedNewRecord, willCopy } = sources;
	// The entry this save's form was showing - verified against the identity
	// the form displayed, refused when it is gone or changed - and the mode
	// that follows from it: with no entry carrying the label the save appends,
	// and with one it writes in place - as an edit or rename when the draft
	// identified it, as an upsert (the add form's documented "saving replaces
	// it") when it did not.
	const showing = requireEntryShownByForm(intent.replace, sources);
	const renaming = targetLabel !== label;
	// Raw labels count as taken (the webview's own rule): a parser-rejected
	// entry still occupies its label, and a rename beside it would land two
	// entries under one label.
	if (renaming && rawDeclaredLabels(entries).has(label)) {
		// The "fieldId:" prefix is what sectionFailureText matches against the
		// internal field names to route the failure onto the right form section,
		// so it stays an ASCII identifier outside the translation. Same rule for
		// every field-prefixed message below.
		throw new DashboardValidationError(`label: ${l10n.t("an entry with this label already exists")}`);
	}

	// The one rule for WHICH element an in-place save replaces, read again at
	// write time over the fresh array: the accepted entry under the target
	// label, or - the fallback that covers the parser-rejected carrier an
	// acceptedEntry lookup misses - the first raw carrier of the draft's label.
	const indexOfTarget = (list: readonly unknown[]): number =>
		acceptedEntry(list, targetLabel)?.index ?? list.findIndex((item) => declaredEntryLabel(item) === label);
	const writeIndex = indexOfTarget(entries);
	const mode: SaveMode =
		writeIndex === -1
			? { kind: "create" }
			: showing === undefined
				? { kind: "upsert", index: writeIndex }
				: renaming
					? {
							kind: "rename",
							index: writeIndex,
							existing: showing,
							oldLabel: targetLabel,
							willCopy,
						}
					: { kind: "edit", index: writeIndex, existing: showing };

	const plans = secretPlans(intent.secrets, showing, storedOld);

	// The final entry, needed for the pairing checks below. This rebuild is
	// the whole entry: any payload field not copied here is silently DELETED
	// by the save. The settings shape is nested (auth/headers/models/discovery/
	// budget); the form still edits the flat credential fields, so this is
	// where they assemble into the entry's auth object.
	const newEntry: Record<string, unknown> = {
		label,
		baseUrl: intent.server.baseUrl.trim(),
	};
	// "" is a real apiVersion (append nothing), so it is written; only absent
	// (auto) omits the key. Trimmed like the setting parser reads it.
	if (intent.server.apiVersion !== undefined) {
		newEntry.apiVersion = intent.server.apiVersion.trim();
	}
	// An empty record reads as absent everywhere (the parser omits it), so it
	// is not written either.
	const models: Record<string, unknown> = {};
	if (intent.server.modelParameters !== undefined && Object.keys(intent.server.modelParameters).length > 0) {
		models.parameters = intent.server.modelParameters;
	}
	const capabilities = intent.server.modelCapabilities;
	if (Object.keys(capabilities).length > 0) {
		models.capabilities = capabilities;
	}
	if (Object.keys(models).length > 0) {
		newEntry.models = models;
	}
	const discovery: Record<string, unknown> = {};
	if (intent.server.expectedFailures.length > 0) {
		discovery.expectedFailures = intent.server.expectedFailures;
	}
	// Declared IDs are trimmed and deduplicated like the parser reads them.
	const declaredModels = [
		...new Set(intent.server.declaredModels.map((id) => id.trim()).filter((id) => id.length > 0)),
	];
	if (declaredModels.length > 0) {
		discovery.declared = declaredModels;
	}
	if (Object.keys(discovery).length > 0) {
		newEntry.discovery = discovery;
	}
	if (Object.keys(intent.server.headers).length > 0) {
		newEntry.headers = intent.server.headers;
	}
	if (intent.server.budget !== null) {
		newEntry.budget = intent.server.budget;
	}
	// `true` and `{ url }` are both real opt-ins; only null omits the key.
	if (intent.server.mcp !== null) {
		newEntry.mcp = intent.server.mcp;
	}

	// The entry's auth object, assembled once by the shared assembler: pairing
	// (OAuth as one unit, the virtual key pair both-or-neither) is enforced
	// against the resolved secrets - a value resting in SecretStorage counts as
	// present - while only the inline plan values enter the written shape, so
	// secure values stay out of the setting and resolve at sync time.
	const inlineValues: { -readonly [K in SecretFieldId]?: string } = {};
	for (const field of SECRET_FIELD_IDS) {
		const plan = plans[field];
		if (plan.kind === "set-inline" || plan.kind === "kept-inline") {
			inlineValues[field] = plan.value;
		}
	}
	const assembled = assembleEntryAuth(
		{ ...pickNonSecretOptionalFields(intent.server), ...inlineValues },
		recordFromKeys(SECRET_FIELD_IDS, (field) => planResolves(plans[field]))
	);
	if (assembled.failure !== undefined) {
		throw new DashboardValidationError(pairingFailureMessage(assembled.failure));
	}
	if (assembled.auth !== undefined) {
		newEntry.auth = assembled.auth;
	}

	// The destination each secure value written by this save is being paired
	// with: its ownership stamp. Derived from the entry as the parser will read
	// it back (the assembler emits only parser-accepted shapes); the raw-field
	// fallback covers the unreachable parse failure without ever stamping a
	// wrong destination.
	const intendedEntry = acceptedEntry([newEntry], label)?.entry;
	const destinationOf = (field: SecretFieldId): string =>
		secretDestination(intendedEntry ?? { baseUrl: intent.server.baseUrl.trim() }, field);

	// A leftover blob field under the saved label is wiped when no plan can reference it (wiping after a rename's
	// copy would delete the copied fields, so the two are exclusive). The wipe precedes the settings write and a
	// throw restores every wiped field, so the gap's failure direction is a briefly missing credential, never a leaked one.
	const wipesLeftovers = showing === undefined || (mode.kind === "rename" && !mode.willCopy);
	const overwritten = new Map<SecretFieldId, { value: string | undefined; owner: string | undefined }>();
	try {
		if (mode.kind === "rename" && mode.willCopy) {
			// The rename's copy writes the SNAPSHOT the plans resolved from, field
			// by field, never the source blob as it stands NOW: a concurrent edit
			// of the old label's blob between the read and this write must not
			// ride to the new label under a form that never showed it. Each copied
			// field is stamped for the entry being written - the copy IS this
			// save's deliberate pairing. Fields the snapshot lacks are deleted when
			// the target held them, so the new label's whole blob becomes the
			// snapshot; fields neither side held are skipped - touching them would
			// be a no-op delete whose failure could abort an otherwise clean save.
			for (const field of SECRET_FIELD_IDS) {
				if (storedOld[field] !== undefined || storedNewRecord.values[field] !== undefined) {
					await env.storeServerSecret(
						label,
						field,
						storedOld[field],
						storedOld[field] !== undefined ? destinationOf(field) : undefined
					);
				}
			}
		}
		for (const field of SECRET_FIELD_IDS) {
			const plan = plans[field];
			if (plan.kind === "set-secure") {
				overwritten.set(field, { value: storedNewRecord.values[field], owner: storedNewRecord.owners[field] });
				await env.storeServerSecret(label, field, plan.value, destinationOf(field));
			} else if (
				plan.kind === "stored" &&
				mode.kind === "edit" &&
				storedOldRecord.owners[field] !== destinationOf(field)
			) {
				// A kept stored value under an edit that changed its destination (or
				// one that predates stamping) is re-stamped: the user saw the field
				// as "stored in secure storage" and saved the entry around it, which
				// is exactly the deliberate pairing a stamp records. Value unchanged.
				overwritten.set(field, { value: storedOldRecord.values[field], owner: storedOldRecord.owners[field] });
				await env.storeServerSecret(label, field, storedOld[field], destinationOf(field));
			} else if (wipesLeftovers && storedNewRecord.values[field] !== undefined) {
				overwritten.set(field, { value: storedNewRecord.values[field], owner: storedNewRecord.owners[field] });
				await env.storeServerSecret(label, field, undefined, undefined);
			}
		}
		// The array is re-read at write time and the new entry lands in THAT
		// array: the guarded secret operations above await, so a sibling entry
		// edited concurrently (another window, a hand edit) would be silently
		// reverted by writing the pass-start snapshot. The TARGET element must
		// still be byte-identical to the one the plans resolved against - and a
		// create's label still free - or the save refuses inside the guarded
		// unit (the rollback above restores every staged secret). The window
		// that remains is the write itself: VS Code's configuration update is
		// last-write-wins across windows and offers nothing smaller.
		const freshEntries = rawServerEntries(env.readServersSetting());
		const next = [...freshEntries];
		if (mode.kind === "create") {
			if (rawDeclaredLabels(freshEntries).has(label)) {
				throw new DashboardValidationError(`label: ${l10n.t("an entry with this label already exists")}`);
			}
			next.push(newEntry);
		} else {
			if (mode.kind === "rename" && rawDeclaredLabels(freshEntries).has(label)) {
				throw new DashboardValidationError(`label: ${l10n.t("an entry with this label already exists")}`);
			}
			const freshIndex = indexOfTarget(freshEntries);
			if (freshIndex === -1 || !isDeepStrictEqual(freshEntries[freshIndex], entries[mode.index])) {
				throw new DashboardValidationError(
					l10n.t(
						"The entry being edited changed in the servers setting while the form was open; close the form and retry"
					)
				);
			}
			next[freshIndex] = newEntry;
		}
		await env.writeServersSetting(next);
	} catch (error) {
		// The setting still resolves what it resolved before, so the secure side
		// must too. A rename's copy replaced the new label's whole blob, so that
		// blob is restored to its pre-copy state (deleting fields it never
		// held), which also undoes any set-secure write on top of the copy;
		// otherwise only the overwritten fields are touched, values and stamps
		// alike. Fields no side ever held are skipped: "restoring" one is a
		// no-op delete whose failure must not report a secret as changed.
		const restores: [SecretFieldId, { value: string | undefined; owner: string | undefined }][] =
			mode.kind === "rename" && mode.willCopy
				? SECRET_FIELD_IDS.filter(
						(field) =>
							overwritten.has(field) || storedOld[field] !== undefined || storedNewRecord.values[field] !== undefined
					).map((field): [SecretFieldId, { value: string | undefined; owner: string | undefined }] => [
						field,
						{ value: storedNewRecord.values[field], owner: storedNewRecord.owners[field] },
					])
				: [...overwritten];
		const restoreFailures: SecretFieldId[] = [];
		for (const [field, previous] of restores) {
			try {
				await env.storeServerSecret(label, field, previous.value, previous.owner);
			} catch {
				restoreFailures.push(field);
				env.log("Restoring a secure value after a failed save also failed", { field });
			}
		}
		if (restoreFailures.length > 0) {
			// The durable state DID change: a freshly stored secret survived the
			// rollback and now resolves for the unchanged entry, so this must not
			// surface as "nothing landed". The detail line's field ids and label
			// are webview-legal; neither reaches the log, which stays
			// classification-only.
			env.log("A failed save left a secure value unrestored", {
				error: errorLabel(error),
			});
			// A failed settings write fires no configuration event, so a sync is requested here, but ONLY while the
			// standing entry still names every destination the user was saving. A concurrent re-point of the host or
			// the OAuth token URL must not route the stranded credential there; a create or rename has no standing entry.
			const intended = acceptedEntry([newEntry], label);
			const standing = acceptedEntry(env.readServersSetting(), label);
			if (
				intended !== undefined &&
				standing !== undefined &&
				nonSecretIdentityMatches(standing.entry, intended.entry)
			) {
				env.requestServerSync();
			}
			throw new DashboardOperationError(
				`${l10n.t(
					"The save failed and a stored secret may have been left changed. Check it with LiteLLM: Set Server Secret, then redo the edit."
				)}\n${l10n.t(
					'could not restore {0} for server "{1}"; the settings entry is unchanged (after a rename, the changed values sit under the new label)',
					restoreFailures.join(", "),
					label
				)}`
			);
		}
		throw error;
	}

	// The destructive cleanup, safe now that the write landed.
	//
	//   cleared secret                    -> still effective if the delete fails, so one retry, then the intent fails below
	//   stale copy behind an inline value -> dormant (it takes over only if the inline value is later removed by hand); log-only
	//   old rename blob                   -> dormant; log-only
	let clearFailed = false;
	for (const field of SECRET_FIELD_IDS) {
		const plan = plans[field];
		if (plan.kind === "cleared") {
			try {
				await env.storeServerSecret(label, field, undefined, undefined);
			} catch {
				try {
					await env.storeServerSecret(label, field, undefined, undefined);
				} catch {
					clearFailed = true;
					env.log("Removing a cleared secret failed; the stored value is still in effect", { field });
				}
			}
		} else if (plan.kind === "set-inline") {
			try {
				await env.storeServerSecret(label, field, undefined, undefined);
			} catch {
				env.log("Post-save secret cleanup failed; a dormant secure copy remains", { field });
			}
		}
	}
	if (mode.kind === "rename") {
		// Presence re-checked at delete time, not assumed from pass start: a
		// concurrent save may have re-created an entry under the old label, and
		// this blob is then that entry's live credentials (kept exactly like a
		// removal keeps blobs). The leftover blob is dormant, so skipping errs
		// toward keeping a secret, never deleting a live one.
		if (stillDeclaredIn(env.readServersSetting())(mode.oldLabel)) {
			env.log("Post-rename secret cleanup skipped; the old label was re-declared");
		} else {
			try {
				await env.deleteServerSecrets(mode.oldLabel);
			} catch {
				env.log("Post-rename secret cleanup failed; the old label's blob remains");
			}
		}
	}
	env.requestServerSync();
	if (clearFailed) {
		throw new DashboardOperationError(
			l10n.t(
				"The server entry was saved, but removing the stored secret failed. Edit the server and retry, or use LiteLLM: Set Server Secret to remove it."
			)
		);
	}
}
