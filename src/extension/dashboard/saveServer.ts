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
 * How one save lands in the servers setting, computed once so the pairing
 * checks, the guarded apply, and the cleanup agree on it. A rename copies the
 * old label's secret blob to the new label only when the old blob holds
 * anything (`willCopy`); an empty old blob wipes the new label's leftover
 * fields instead, so either way the new label ends up serving only the renamed
 * entry's own secrets. The same flag decides whether a failed write restores
 * the new label's blob wholesale or field by field.
 *
 * "upsert" is the add form saving onto a label that already has an entry (its
 * documented "saving replaces it"): it writes in place like an edit, but the
 * form showed a blank credential-less draft, so its secrets resolve like a
 * create's - see requireEntryShownByForm.
 */
type SaveMode =
	| { kind: "create" }
	| { kind: "upsert"; index: number }
	| { kind: "edit"; index: number; existing: DeclaredServer }
	| { kind: "rename"; index: number; existing: DeclaredServer; oldLabel: string; willCopy: boolean };

/**
 * The entry the form the user saved was showing, which is what every "keep"
 * directive means, and the one rule the save and the draft-connection test both
 * read so a directive cannot resolve differently on the two paths.
 *
 * Only a draft that identifies the entry it replaces (`replace`, which the
 * edit form always sends and the add form never does) may resolve that entry's
 * credentials - and only that entry's: its inline fields and its own label's
 * blob, never a blob already sitting under the draft's new label. A draft from
 * the blank add form showed every field as "none", so it resolves nothing -
 * whether its label is free (a create) or already taken (an upsert, replacing
 * the entry in place). Otherwise a retired label's leftover blob, or a replaced
 * entry's own key, would ride to whatever host the new draft names; the caller
 * wipes such leftovers for the same reason (the sync engine resolves a label's
 * blob unconditionally).
 *
 * The identity is verified, never assumed: a label alone can be spoofed by
 * time. An entry swapped in under the form's label while the form was open
 * (another window, a hand edit of settings.json) would otherwise hand ITS
 * credentials to the host the form displays - the probe would send the new
 * entry's key to the old host, and a save would write a mixed entry. Gone and
 * changed both refuse as validation failures: nothing durable happened, and
 * the form the refusal returns to still shows the state it was opened on.
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
 * Resolve every secret directive of a draft into its plan: what the field does
 * and where its value will live. Shared with the draft-connection test, so a
 * directive cannot mean two different values on the two paths. `existing` is
 * the entry the saved form was showing (requireEntryShownByForm) and
 * `storedShown` is
 * that entry's own label's blob (KeepSources.storedOld); an undefined entry
 * means the form showed no credentials at all, and "keep" then resolves
 * NOTHING - a label's leftover SecretStorage blob (removals keep blobs on
 * purpose) must not resurrect under an entry the form showed as
 * credential-less.
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
 * What "keep" directives resolve against for a draft that writes `label` over
 * the entry `targetLabel` names: the accepted entry being replaced (so a
 * rejected same-label sibling cannot shadow it) and the secure-side blobs
 * involved. Keeps resolve `storedOld` alone - the blob under the label the
 * form was showing, admitted through the ownership check against that entry
 * (a field stamped for a different destination resolves nothing, exactly as
 * the sync engine would refuse it and the dashboard displayed it as "none").
 * The raw records ride along only for the save's overwrite and rollback
 * bookkeeping: `storedNewRecord` is the blob already under the draft's label
 * (on a rename a retired label's leftover, which the save replaces via the
 * copy or wipes), `storedOldRecord` the shown label's blob as stored. Shared
 * with the draft-connection test, so "keep" cannot mean two different values
 * on the two paths.
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
	const storedOld =
		accepted !== undefined ? resolveOwnedSecrets(accepted.entry, storedOldRecord).values : storedOldRecord.values;
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
 * Apply one saveServerSetting intent in a failure-safe order: validate
 * everything up front, then run the guarded secret operations (set-secure
 * writes; a rename copies the blob to the new label; a save whose form never
 * showed the label's blob - a create, an upsert, or a rename with nothing to
 * copy - wipes the label's leftover blob fields) and the settings write
 * as one guarded unit, and only after the write lands run the destructive
 * cleanup (clears, dropping the stale secure copy behind an inline write,
 * deleting the old rename blob).
 *
 * The staged secrets are observable before the settings write lands (the
 * unit's steps await), which is by design, not a hole: each staged value
 * carries the ownership stamp of the entry being saved, so a sync pass that
 * reads the standing entry with the staged blob refuses the pairing
 * (resolveOwnedSecrets; serverSync.test.ts pins the window), and a stage for
 * an unchanged destination is the user's own credential going where they sent
 * it. The settings write itself lands on a FRESH read of the array with only
 * the target element replaced, refusing when the target drifted, so a
 * concurrent sibling edit is merged instead of silently reverted.
 *
 * If anything in the guarded unit throws, the entry in the setting is
 * unchanged and must keep resolving what it resolved before, so the secure
 * side is rolled back: a rename restores the new label's whole pre-copy blob,
 * otherwise each overwritten field gets its previous value back. When a
 * restore itself fails, the durable state changed after all, so the intent
 * fails as an operation-kind error instead of rethrowing the original as if
 * nothing landed.
 *
 * Cleanup failures after a landed write depend on what they leave behind. A
 * cleared secret that survives its deletion is still effective, so after one
 * retry the intent fails with an actionable message (retrying the save
 * converges). The stale secure copy behind a fresh inline value and the old
 * rename blob are dormant, so those failures log a classification and the
 * intent still succeeds.
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

	// Phases 1 and 2 as one guarded unit: the guarded secret operations, then
	// the settings write everything hinges on. Secure values those steps
	// overwrite or wipe are remembered (pre-write value AND ownership stamp)
	// for the rollback.
	// A leftover blob field under the saved label is wiped when no plan can
	// reference it: a create or upsert form showed no credentials, and a rename
	// form showed the SOURCE entry, whose copy replaces the target blob only
	// when the source holds anything (wiping after a copy would delete copied
	// fields, so the two are exclusive). The wipe precedes the settings write
	// and every wiped field is rollback-restored on a throw, so the gap's
	// failure direction is a briefly missing credential, never a leaked one.
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
				error: error instanceof Error ? error.name : typeof error,
			});
			// A sync is requested because the failed settings write fires no
			// configuration event (the clean-rollback rethrow below stays
			// sync-free, nothing durable changed there) - but ONLY when the entry
			// standing in the setting RIGHT NOW resolves the changed blob (it
			// carries the saved label) and still names every destination the
			// user was saving: the intended entry, parsed back like the sync
			// engine will parse the setting, compared over the whole non-secret
			// identity - a concurrent re-point of the host OR of the OAuth token
			// URL during the failed write must not route the stranded credential
			// there. A create or rename has no standing entry under the label,
			// so it skips too (the changed values sit unreferenced).
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

	// Phase 3, destructive cleanup, safe now that the write landed. A cleared
	// secret that survives its deletion is still effective, so the delete
	// retries once and a second failure fails the intent below; the stale
	// secure copy behind a fresh inline value (it would silently take over if
	// the inline value were later removed by hand) and the old rename blob are
	// dormant, so their failures are log-only.
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
