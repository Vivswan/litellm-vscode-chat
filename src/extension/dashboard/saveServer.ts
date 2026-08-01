/**
 * The saveServerSetting intent's apply path: how one save lands in the
 * servers setting and the secret store, in a failure-safe order. Split out of
 * intents.ts for its size; executeDashboardIntent is the only caller.
 */

import { recordFromKeys } from "../../shared/util/json";
import type { DeclaredServer } from "../servers/serverSync";
import { acceptedEntry, inlineSecretValues } from "../servers/serverSync";
import type { DashboardIntent } from "./intentSchema";
import type { IntentEnvironment } from "./intents";
import { DashboardOperationError, DashboardValidationError, rawServerEntries } from "./intents";
import type { SecretFieldId } from "./protocol";
import { NON_SECRET_OPTIONAL_FIELD_IDS, SECRET_FIELD_IDS } from "./protocol";

/**
 * How one save lands in the servers setting, computed once so the pairing
 * checks, the guarded apply, and the cleanup agree on it: a brand-new entry,
 * an in-place edit of the accepted entry, or a rename. A rename copies the
 * old label's secret blob to the new label only when the old blob holds
 * anything (`willCopy`); that same flag decides whether a failed write
 * restores the new label's blob wholesale or field by field.
 */
type SaveMode =
	| { kind: "create" }
	| { kind: "edit"; index: number; existing: DeclaredServer }
	| { kind: "rename"; index: number; existing: DeclaredServer; oldLabel: string; willCopy: boolean };

/**
 * What one secret field does in this save, shared by the pairing checks, the
 * guarded apply, and the cleanup. "cleared" stays distinct from "absent" on
 * purpose: cleanup deletes the stored value (with a retry, failing the
 * intent if it sticks) only for cleared fields.
 */
type SecretPlan =
	| { kind: "set-inline"; value: string }
	| { kind: "set-secure"; value: string }
	| { kind: "kept-inline"; value: string }
	| { kind: "stored" }
	| { kind: "cleared" }
	| { kind: "absent" };

/** Whether the field will hold a value once the plan is applied. */
function planResolves(plan: SecretPlan): boolean {
	return plan.kind !== "cleared" && plan.kind !== "absent";
}

/**
 * What "keep" directives resolve against for a draft that writes `label` over
 * the entry `targetLabel` names: the accepted entry being replaced (resolved
 * through acceptedEntry, so a rejected same-label sibling cannot shadow it)
 * and the secure-side blobs involved. `storedEffective` is the blob the saved
 * entry's label will read afterwards: a rename copies the old label's blob
 * only when it holds anything, so an empty old blob leaves an orphan blob
 * already sitting under the new label serving. Shared by the save apply and
 * the draft-connection test (testDraftConnection.ts), so "keep" cannot mean
 * two different values on the two paths.
 */
export interface KeepSources {
	readonly accepted: { readonly index: number; readonly entry: DeclaredServer } | undefined;
	readonly storedOld: Partial<Readonly<Record<SecretFieldId, string>>>;
	readonly storedNew: Partial<Readonly<Record<SecretFieldId, string>>>;
	readonly storedEffective: Partial<Readonly<Record<SecretFieldId, string>>>;
	/** Whether a rename will copy the old label's blob (it holds anything). */
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
	const storedOld = await readServerSecrets(targetLabel);
	const storedNew = renaming ? await readServerSecrets(label) : storedOld;
	const willCopy = renaming && Object.keys(storedOld).length > 0;
	return { accepted, storedOld, storedNew, storedEffective: willCopy ? storedOld : storedNew, willCopy };
}

/**
 * The value one "keep" directive resolves to, and where it lives: inline
 * exactly when the sync engine reads it inline (the shared inlineSecretValues
 * rule, never a re-derivation), the effective secure blob otherwise,
 * undefined when the field holds nothing anywhere.
 */
export function resolveKeptSecret(
	existing: DeclaredServer | undefined,
	storedEffective: Partial<Readonly<Record<SecretFieldId, string>>>,
	field: SecretFieldId
): { readonly value: string; readonly location: "inline" | "secure" } | undefined {
	const inline = existing === undefined ? undefined : inlineSecretValues(existing)[field];
	if (inline !== undefined) {
		return { value: inline, location: "inline" };
	}
	const stored = storedEffective[field];
	return stored !== undefined ? { value: stored, location: "secure" } : undefined;
}

/**
 * Apply one saveServerSetting intent in a failure-safe order: validate
 * everything up front, then run the additive secret operations (set-secure
 * writes; a rename copies the blob to the new label) and the settings write as
 * one guarded unit, and only after the write lands run the destructive cleanup
 * (clears, dropping the stale secure copy behind an inline write, deleting the
 * old rename blob).
 *
 * If anything in the guarded unit throws, the entry in the setting is
 * unchanged and must keep resolving what it resolved before, so the secure
 * side is rolled back: a rename restores the new label's whole pre-copy blob
 * (which also revives an orphan blob the copy overwrote), otherwise each
 * overwritten field gets its previous value back. When any restore itself
 * fails, the durable state changed after all (a fresh secret survived the
 * rollback), so the intent fails as an operation-kind error instead of
 * rethrowing the original as if nothing landed.
 *
 * Cleanup failures after a landed write depend on what the failure leaves
 * behind. A cleared secret that survives its deletion is still effective (the
 * saved entry carries no inline value to outrank it), so after one retry the
 * intent fails with an actionable message; retrying the save converges, the
 * clear plan re-runs the delete. The stale secure copy behind a fresh
 * inline value and the old rename blob are dormant, so those failures log a
 * classification and the intent still succeeds.
 */
export async function applySaveServerSetting(
	intent: Extract<DashboardIntent, { type: "saveServerSetting" }>,
	env: IntentEnvironment
): Promise<void> {
	const label = intent.server.label.trim();
	// Trimmed like entry matching trims, so the secret-store operations below
	// hit the same label the entry lookup resolves.
	const targetLabel = (intent.replaceLabel ?? label).trim();
	const entries = rawServerEntries(env.readServersSetting());
	// Resolution agrees with the parsed world (acceptedEntry, via
	// readKeepSources): the entry being edited is the one the dashboard row
	// described, never a rejected same-label sibling sitting earlier in the raw
	// array. The same helper also reads what the sync engine will read for this
	// entry's label after the save (see KeepSources on the rename rules), so
	// the pairing checks and the draft-connection test share one "keep" truth.
	const { accepted, storedNew, storedEffective, willCopy } = await readKeepSources(
		entries,
		label,
		targetLabel,
		(secretsLabel) => env.readServerSecrets(secretsLabel)
	);
	if (intent.replaceLabel !== undefined && accepted === undefined) {
		throw new DashboardValidationError(
			"The entry being edited no longer exists in the servers setting; close the form and retry"
		);
	}
	const renaming = targetLabel !== label;
	if (renaming && acceptedEntry(entries, label) !== undefined) {
		throw new DashboardValidationError("label: an entry with this label already exists");
	}

	const mode: SaveMode =
		accepted === undefined
			? { kind: "create" }
			: renaming
				? {
						kind: "rename",
						index: accepted.index,
						existing: accepted.entry,
						oldLabel: targetLabel,
						willCopy,
					}
				: { kind: "edit", index: accepted.index, existing: accepted.entry };
	const existing = mode.kind === "create" ? undefined : mode.existing;

	const plans = recordFromKeys(SECRET_FIELD_IDS, (field): SecretPlan => {
		const directive = intent.secrets[field];
		switch (directive.action) {
			case "set":
				return directive.location === "secure"
					? { kind: "set-secure", value: directive.value }
					: { kind: "set-inline", value: directive.value };
			case "clear":
				return { kind: "cleared" };
			case "keep": {
				const kept = resolveKeptSecret(existing, storedEffective, field);
				if (kept === undefined) {
					return { kind: "absent" };
				}
				return kept.location === "inline" ? { kind: "kept-inline", value: kept.value } : { kind: "stored" };
			}
		}
	});

	// The final entry's non-secret fields, needed for the pairing checks below.
	const newEntry: Record<string, string | Readonly<Record<string, Readonly<Record<string, unknown>>>>> = {
		label,
		baseUrl: intent.server.baseUrl.trim(),
	};
	for (const field of NON_SECRET_OPTIONAL_FIELD_IDS) {
		const value = intent.server[field]?.trim();
		if (value !== undefined && value.length > 0) {
			newEntry[field] = value;
		}
	}
	// An empty record reads as absent everywhere (the parser omits it), so it
	// is not written either; the saved entry stays as clean as a hand-written
	// one.
	if (intent.server.modelParameters !== undefined && Object.keys(intent.server.modelParameters).length > 0) {
		newEntry.modelParameters = intent.server.modelParameters;
	}

	// OAuth is one unit, mirroring serverForm's exact rules: the request path
	// drops partial configurations silently, so anything OAuth-shaped (a token
	// URL, a client ID, scopes, or a client secret that would resolve) requires
	// the token URL and client ID pair.
	const oauthExtras = planResolves(plans.oauthClientSecret) || newEntry.oauthScopes !== undefined;
	if ((newEntry.oauthClientId !== undefined || oauthExtras) && newEntry.oauthTokenUrl === undefined) {
		throw new DashboardValidationError("oauthTokenUrl: OAuth needs the token URL and client ID");
	}
	if ((newEntry.oauthTokenUrl !== undefined || oauthExtras) && newEntry.oauthClientId === undefined) {
		throw new DashboardValidationError("oauthClientId: OAuth needs the token URL and client ID");
	}

	// The virtual key pair is both-or-neither, like the form enforces.
	const virtualKeyResolves = planResolves(plans.virtualKeyValue);
	if (newEntry.virtualKeyHeader !== undefined && !virtualKeyResolves) {
		throw new DashboardValidationError("virtualKeyValue: enter the key sent in this header");
	}
	if (newEntry.virtualKeyHeader === undefined && virtualKeyResolves) {
		throw new DashboardValidationError("virtualKeyHeader: name the header that carries the key");
	}

	// Phases 1 and 2 as one guarded unit: the additive secret operations (a
	// rename's blob copy, set-secure writes), then the settings write
	// everything hinges on. Secure values the additive steps overwrite are
	// remembered (pre-write state) for the rollback.
	const overwritten = new Map<SecretFieldId, string | undefined>();
	try {
		if (mode.kind === "rename") {
			await env.copyServerSecrets(mode.oldLabel, label);
		}
		for (const field of SECRET_FIELD_IDS) {
			const plan = plans[field];
			switch (plan.kind) {
				case "set-inline":
				case "kept-inline":
					newEntry[field] = plan.value;
					break;
				case "set-secure":
					overwritten.set(field, storedNew[field]);
					await env.storeServerSecret(label, field, plan.value);
					break;
				case "stored":
				case "cleared":
				case "absent":
					break;
			}
		}
		const next = [...entries];
		if (mode.kind === "create") {
			next.push(newEntry);
		} else {
			next[mode.index] = newEntry;
		}
		await env.writeServersSetting(next);
	} catch (error) {
		// The setting still resolves what it resolved before, so the secure side
		// must too. A rename's copy replaced the new label's whole blob, so that
		// blob is restored wholesale to its pre-copy state (deleting fields it
		// never held), which also undoes any set-secure write on top of the
		// copy; otherwise only the overwritten fields are touched.
		const restores: [SecretFieldId, string | undefined][] =
			mode.kind === "rename" && mode.willCopy
				? SECRET_FIELD_IDS.map((field) => [field, storedNew[field]])
				: [...overwritten];
		let restoreFailed = false;
		for (const [field, previous] of restores) {
			try {
				await env.storeServerSecret(label, field, previous);
			} catch {
				restoreFailed = true;
				env.log("Restoring a secure value after a failed save also failed", { field });
			}
		}
		if (restoreFailed) {
			// The durable state DID change: a freshly stored secret survived the
			// rollback and now resolves for the unchanged entry, so this must not
			// surface as "nothing landed" (which would reopen the form as if the
			// draft were still the truth). The original error's name is logged as
			// a classification before it is replaced. A sync is requested too: the
			// failed settings write fires no configuration event, and the changed
			// secure value must reach the provider group (the clean-rollback
			// rethrow below stays sync-free, nothing durable changed there).
			env.log("A failed save left a secure value unrestored", {
				error: error instanceof Error ? error.name : typeof error,
			});
			env.requestServerSync();
			throw new DashboardOperationError(
				"The save failed, and restoring a stored secret to its previous value also failed. Check the secret with LiteLLM: Set Server Secret."
			);
		}
		throw error;
	}

	// Phase 3, destructive cleanup, safe now that the write landed. What a
	// failure leaves behind decides the outcome: a cleared secret that survives
	// its deletion is still effective (the saved entry carries nothing inline
	// to outrank it), so the delete retries once and a second failure fails the
	// intent below; the stale secure copy behind a fresh inline value (a
	// lingering one would silently take over if the inline value were later
	// removed by hand) and the old rename blob are dormant, so their failures
	// are log-only.
	let clearFailed = false;
	for (const field of SECRET_FIELD_IDS) {
		const plan = plans[field];
		if (plan.kind === "cleared") {
			try {
				await env.storeServerSecret(label, field, undefined);
			} catch {
				try {
					await env.storeServerSecret(label, field, undefined);
				} catch {
					clearFailed = true;
					env.log("Removing a cleared secret failed; the stored value is still in effect", { field });
				}
			}
		} else if (plan.kind === "set-inline") {
			try {
				await env.storeServerSecret(label, field, undefined);
			} catch {
				env.log("Post-save secret cleanup failed; a dormant secure copy remains", { field });
			}
		}
	}
	if (mode.kind === "rename") {
		try {
			await env.deleteServerSecrets(mode.oldLabel);
		} catch {
			env.log("Post-rename secret cleanup failed; the old label's blob remains");
		}
	}
	env.requestServerSync();
	if (clearFailed) {
		throw new DashboardOperationError(
			"The server entry was saved, but removing the stored secret failed. Edit the server and retry, or use LiteLLM: Set Server Secret to remove it."
		);
	}
}
