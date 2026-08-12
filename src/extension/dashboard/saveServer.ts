/**
 * The saveServerSetting intent's apply path: how one save lands in the
 * servers setting and the secret store, in a failure-safe order. Split out of
 * intents.ts for its size; executeDashboardIntent is the only caller.
 */

import * as vscode from "vscode";
import type { SecretFieldId } from "../../dashboard/protocol";
import { SECRET_FIELD_IDS } from "../../dashboard/protocol";
import { recordFromKeys } from "../../shared/util/json";
import type { DeclaredServer } from "../servers/serverSync";
import { acceptedEntry, inlineSecretValues } from "../servers/serverSync";
import type { DashboardIntent } from "./intentSchema";
import type { IntentEnvironment } from "./intents";
import { DashboardOperationError, DashboardValidationError, rawServerEntries } from "./intents";

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
	const { accepted, storedOld, storedNew, storedEffective, willCopy } = await readKeepSources(
		entries,
		label,
		targetLabel,
		(secretsLabel) => env.readServerSecrets(secretsLabel)
	);
	if (intent.replaceLabel !== undefined && accepted === undefined) {
		throw new DashboardValidationError(
			vscode.l10n.t("The entry being edited no longer exists in the servers setting; close the form and retry")
		);
	}
	const renaming = targetLabel !== label;
	if (renaming && acceptedEntry(entries, label) !== undefined) {
		// The "fieldId:" prefix is what sectionFailureText matches against the
		// internal field names to route the failure onto the right form section,
		// so it stays an ASCII identifier outside the translation; only the body
		// localizes. Same rule for every field-prefixed message below.
		throw new DashboardValidationError(`label: ${vscode.l10n.t("an entry with this label already exists")}`);
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

	// The final entry, needed for the pairing checks below. This rebuild is
	// the whole entry: any payload field not copied here is silently DELETED
	// by the save (panelIntegration pins the round trip). The settings shape
	// is nested (auth/headers/models/discovery/budget); the form still edits
	// the flat credential fields, so this is where they assemble into the
	// entry's auth object.
	const newEntry: Record<string, unknown> = {
		label,
		baseUrl: intent.server.baseUrl.trim(),
	};
	// "" is a real apiVersion (append nothing), so it is written; only absent
	// (auto) omits the key. Trimmed like the setting parser reads it.
	if (intent.server.apiVersion !== undefined) {
		newEntry.apiVersion = intent.server.apiVersion.trim();
	}
	const usable = (value: string | undefined): string | undefined => {
		const trimmed = value?.trim();
		return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
	};
	const oauthTokenUrl = usable(intent.server.oauthTokenUrl);
	const oauthClientId = usable(intent.server.oauthClientId);
	const oauthScopes = usable(intent.server.oauthScopes);
	const virtualKeyHeader = usable(intent.server.virtualKeyHeader);
	// An empty record reads as absent everywhere (the parser omits it), so it
	// is not written either; the saved entry stays as clean as a hand-written
	// one.
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

	// OAuth is one unit, mirroring serverForm's exact rules: the request path
	// drops partial configurations silently, so anything OAuth-shaped (a token
	// URL, a client ID, scopes, or a client secret that would resolve) requires
	// the token URL and client ID pair.
	const oauthExtras = planResolves(plans.oauthClientSecret) || oauthScopes !== undefined;
	if ((oauthClientId !== undefined || oauthExtras) && oauthTokenUrl === undefined) {
		throw new DashboardValidationError(`oauthTokenUrl: ${vscode.l10n.t("OAuth needs the token URL and client ID")}`);
	}
	if ((oauthTokenUrl !== undefined || oauthExtras) && oauthClientId === undefined) {
		throw new DashboardValidationError(`oauthClientId: ${vscode.l10n.t("OAuth needs the token URL and client ID")}`);
	}

	// The virtual key pair is both-or-neither, like the form enforces.
	const virtualKeyResolves = planResolves(plans.virtualKeyValue);
	if (virtualKeyHeader !== undefined && !virtualKeyResolves) {
		throw new DashboardValidationError(`virtualKeyValue: ${vscode.l10n.t("enter the key sent in this header")}`);
	}
	if (virtualKeyHeader === undefined && virtualKeyResolves) {
		throw new DashboardValidationError(`virtualKeyHeader: ${vscode.l10n.t("name the header that carries the key")}`);
	}

	/**
	 * Assemble the entry's auth object from the flat fields once the plans'
	 * inline values are known. Inline values are written into the nested
	 * shape; values resting in secret storage stay omitted (the parser's
	 * stored-slot resolution finds them at sync time). With oauth configured
	 * the other credentials nest inside it as companions; without it an
	 * apiKey and a virtualKey are the apiKey form and its sibling companion
	 * (forms rank oauth > apiKey > virtualKey).
	 */
	const applyAuth = (inline: Partial<Record<SecretFieldId, string>>): void => {
		const virtualKey: Record<string, string> | undefined =
			virtualKeyHeader !== undefined
				? {
						header: virtualKeyHeader,
						...(inline.virtualKeyValue !== undefined ? { value: inline.virtualKeyValue } : {}),
					}
				: undefined;
		const auth: Record<string, unknown> = {};
		if (oauthTokenUrl !== undefined && oauthClientId !== undefined) {
			auth.oauth = {
				tokenUrl: oauthTokenUrl,
				clientId: oauthClientId,
				...(inline.oauthClientSecret !== undefined ? { clientSecret: inline.oauthClientSecret } : {}),
				...(oauthScopes !== undefined ? { scopes: oauthScopes } : {}),
				...(inline.apiKey !== undefined ? { apiKey: inline.apiKey } : {}),
				...(virtualKey !== undefined ? { virtualKey } : {}),
			};
		} else {
			if (inline.apiKey !== undefined) {
				auth.apiKey = inline.apiKey;
			}
			if (virtualKey !== undefined) {
				auth.virtualKey = virtualKey;
			}
		}
		if (Object.keys(auth).length > 0) {
			newEntry.auth = auth;
		}
	};

	// Phases 1 and 2 as one guarded unit: the additive secret operations (a
	// rename's blob copy, set-secure writes), then the settings write
	// everything hinges on. Secure values the additive steps overwrite are
	// remembered (pre-write state) for the rollback.
	const overwritten = new Map<SecretFieldId, string | undefined>();
	try {
		if (mode.kind === "rename") {
			await env.copyServerSecrets(mode.oldLabel, label);
		}
		const inlineValues: { -readonly [K in SecretFieldId]?: string } = {};
		for (const field of SECRET_FIELD_IDS) {
			const plan = plans[field];
			switch (plan.kind) {
				case "set-inline":
				case "kept-inline":
					inlineValues[field] = plan.value;
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
		applyAuth(inlineValues);
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
		// blob is restored to its pre-copy state (deleting fields it never
		// held), which also undoes any set-secure write on top of the copy;
		// otherwise only the overwritten fields are touched. Fields no side
		// ever held are skipped: neither the copy nor a write touched them, so
		// "restoring" one is a no-op delete whose failure must not report a
		// secret as changed.
		const restores: [SecretFieldId, string | undefined][] =
			mode.kind === "rename" && mode.willCopy
				? SECRET_FIELD_IDS.filter(
						(field) => overwritten.has(field) || storedOld[field] !== undefined || storedNew[field] !== undefined
					).map((field): [SecretFieldId, string | undefined] => [field, storedNew[field]])
				: [...overwritten];
		const restoreFailures: SecretFieldId[] = [];
		for (const [field, previous] of restores) {
			try {
				await env.storeServerSecret(label, field, previous);
			} catch {
				restoreFailures.push(field);
				env.log("Restoring a secure value after a failed save also failed", { field });
			}
		}
		if (restoreFailures.length > 0) {
			// The durable state DID change: a freshly stored secret survived the
			// rollback and now resolves for the unchanged entry, so this must not
			// surface as "nothing landed" (which would reopen the form as if the
			// draft were still the truth). The original error's name is logged as
			// a classification before it is replaced. A sync is requested too: the
			// failed settings write fires no configuration event, and the changed
			// secure value must reach the provider group (the clean-rollback
			// rethrow below stays sync-free, nothing durable changed there).
			// The detail line's field ids are structural configuration and the
			// label is the user's own text - both webview-legal; neither reaches
			// the log, which stays classification-only.
			env.log("A failed save left a secure value unrestored", {
				error: error instanceof Error ? error.name : typeof error,
			});
			env.requestServerSync();
			throw new DashboardOperationError(
				`${vscode.l10n.t(
					"The save failed and a stored secret may have been left changed. Check it with LiteLLM: Set Server Secret, then redo the edit."
				)}\n${vscode.l10n.t(
					'could not restore {0} for server "{1}"; the settings entry is unchanged (after a rename, the changed values sit under the new label)',
					restoreFailures.join(", "),
					label
				)}`
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
			vscode.l10n.t(
				"The server entry was saved, but removing the stored secret failed. Edit the server and retry, or use LiteLLM: Set Server Secret to remove it."
			)
		);
	}
}
