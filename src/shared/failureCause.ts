/**
 * Why a server's models are not served, as one closed union of keys, and the one renderer that turns a key into text.
 * A status never carries rendered text: the status bar, the notifier, the dashboard rows, the paste line, the agent
 * tools, and the persisted status store all hold a FailureCause and render it here at display time, in the current
 * locale. So a cause written under one locale reads in another, and a new cause does not compile until it joins the
 * union and this renderer, where its text is written exactly once (display plus the English mirror).
 */

import * as l10n from "@vscode/l10n";
import type { TransportErrorClassification } from "./errorClassification";
import type { RejectedCredentialField } from "./serverEntry";
import { displayUrl } from "./util/displayUrl";

/**
 * The sync engine's failure classes (serverSync/engine.ts syncFailureOf): why a declared entry's provider group is not
 * in step with its entry.
 */
export const SYNC_ERROR_CLASSES = [
	"upsertFailed",
	"blocked",
	"secretsUnreadable",
	"secretsMismatched",
	"saltUnavailable",
	"credentialsRefused",
] as const;
export type SyncErrorClass = (typeof SYNC_ERROR_CLASSES)[number];

/**
 * Why a declared entry's credentials did not resolve at serve or request time: the engine's own skip reasons
 * (secretsUnreadable, secretsMismatched), a configuration the group parser refuses (unusable), or an entry the setting
 * still carries in a shape the parser rejects (misconfigured). A refusal of header-borne values is its own arm, since
 * its text names the fields.
 */
export const CREDENTIALS_UNAVAILABLE_REASONS = [
	"secretsUnreadable",
	"secretsMismatched",
	"unusable",
	"misconfigured",
] as const;
type CredentialsUnavailableReason = (typeof CREDENTIALS_UNAVAILABLE_REASONS)[number];

export type FailureCause =
	| { readonly kind: "transport"; readonly classification: TransportErrorClassification }
	| { readonly kind: "sync"; readonly failureClass: SyncErrorClass }
	| { readonly kind: "credentials"; readonly reason: CredentialsUnavailableReason }
	| {
			readonly kind: "credentialsRefused";
			readonly fields: readonly [RejectedCredentialField, ...RejectedCredentialField[]];
	  }
	/** A servers-setting entry the parser refused: not used until its configuration is fixed. */
	| { readonly kind: "misconfiguredEntry" }
	/** A failure nothing classified: the output log carries its classification (the status's logSafeError). */
	| { readonly kind: "unclassified" };

/** The transport classification a cause carries, for the surfaces that act on it (setup hints, docs actions). */
export function failureClassification(cause: FailureCause): TransportErrorClassification | undefined {
	return cause.kind === "transport" ? cause.classification : undefined;
}

export interface FailureTexts {
	/** Localized, for the surfaces the user reads. */
	readonly display: string;
	/** The English mirror, for the paste line, the agent tools, and the issue report. */
	readonly english: string;
}

/**
 * The classified upsert-failure text. The host's raw error message is never stored, displayed, or logged: the command
 * was called with fully resolved secrets, and the log buffer feeds public issue reports.
 */
const GROUP_UPSERT_FAILED_MESSAGE = "The host rejected the provider group upsert";

/**
 * That covers an entry whose configuration changed after its group was created AND a brand-new entry under a name the
 * host already uses, so the text must not assert that anything changed. VS Code's group commands are strictly additive
 * and no update or removal command exists (pinned by hostGroupCommand.test.ts).
 */
const GROUP_UPDATE_UNAVAILABLE_MESSAGE =
	"A VS Code provider group already uses this name, and VS Code cannot update an existing group. " +
	"If the group does not match this entry, delete it in Manage Language Models (or remove its object from the models file, chatLanguageModels.json, and reload the window), " +
	"then run Sync Models Now.";

/**
 * The classified text for an entry whose stored secrets could not be read this pass. The entry is skipped, not failed
 * permanently: the next pass (or Sync Models Now) reads again.
 */
const SECRETS_READ_FAILED_MESSAGE =
	"Reading this entry's stored secrets failed, so it was not synced. Run Sync Models Now to retry.";

/**
 * The classified text for an entry whose stored secret is stamped for a different destination (see
 * resolveOwnedSecrets).
 *
 *   the host is add-only     -> the entry is skipped, not synced without the credential
 *   Re-pairing is deliberate -> the user re-enters or removes the stored value
 */
const SECRET_OWNERSHIP_MISMATCH_MESSAGE =
	"A stored secret for this entry was saved for a different server address, so the entry was not synced. Set the secret again (edit the server in the dashboard, or run LiteLLM: Set Server Secret), or remove the stored value.";

/**
 * The classified text for a pass skipped because the fingerprint salt could not be confirmed durable (see
 * ServerSyncEnv.confirmFingerprintsDurable). Entries are skipped, not failed: the live groups keep serving, and the
 * next session (with the stored salt back) syncs normally.
 */
const SALT_UNAVAILABLE_MESSAGE =
	"VS Code secret storage could not be confirmed this session, so this entry was not synced. Syncing resumes on the next VS Code session.";

/** A parser-refused entry's row text, English by the issue-report policy. */
export const MISCONFIGURED_ENTRY_TEXT = "misconfigured entry; not used until its configuration is fixed";

const REJECTED_FIELD_KIND: Readonly<
	Record<RejectedCredentialField, { readonly display: () => string; readonly english: string }>
> = {
	apiKey: { display: () => l10n.t("API key"), english: "API key" },
	virtualKeyValue: { display: () => l10n.t("virtual key"), english: "virtual key" },
};

/**
 * The refused fields as every refusal text names them ("API key", "virtual key"), localized and in English, so the
 * provider, the one-shot features, and the usage surfaces spell the field the same way and none spells the value.
 */
export function rejectedCredentialKinds(fields: readonly RejectedCredentialField[]): FailureTexts {
	const kinds = fields.map((field) => REJECTED_FIELD_KIND[field]);
	return {
		display: kinds.map((kind) => kind.display()).join(", "),
		english: kinds.map((kind) => kind.english).join(", "),
	};
}

/** Each display string is an l10n literal resolved at call time; the English constant is the mirror. */
function syncFailureTexts(failureClass: SyncErrorClass): FailureTexts {
	switch (failureClass) {
		case "upsertFailed":
			return { display: l10n.t("The host rejected the provider group upsert"), english: GROUP_UPSERT_FAILED_MESSAGE };
		case "blocked":
			return {
				display: `${l10n.t("A VS Code provider group already uses this name, and VS Code cannot update an existing group.")} ${l10n.t(
					"If the group does not match this entry, delete it in Manage Language Models (or remove its object from the models file, chatLanguageModels.json, and reload the window), then run Sync Models Now."
				)}`,
				english: GROUP_UPDATE_UNAVAILABLE_MESSAGE,
			};
		case "secretsUnreadable":
			return {
				display: l10n.t(
					"Reading this entry's stored secrets failed, so it was not synced. Run Sync Models Now to retry."
				),
				english: SECRETS_READ_FAILED_MESSAGE,
			};
		case "secretsMismatched":
			return {
				display: l10n.t(
					"A stored secret for this entry was saved for a different server address, so the entry was not synced. Set the secret again (edit the server in the dashboard, or run LiteLLM: Set Server Secret), or remove the stored value."
				),
				english: SECRET_OWNERSHIP_MISMATCH_MESSAGE,
			};
		case "saltUnavailable":
			return {
				display: l10n.t(
					"VS Code secret storage could not be confirmed this session, so this entry was not synced. Syncing resumes on the next VS Code session."
				),
				english: SALT_UNAVAILABLE_MESSAGE,
			};
		case "credentialsRefused":
			return {
				display: l10n.t(
					"A configured API key or virtual key for this entry cannot be sent as an HTTP header, so requests to it are refused. See the Diagnostics tab for the field, then enter the value again."
				),
				english:
					"A configured API key or virtual key for this entry cannot be sent as an HTTP header, so requests to it are refused. See the Diagnostics tab for the field, then enter the value again.",
			};
	}
}

/** One sentence per reason, so a new reason does not compile until it says what happened and what to do. */
function credentialsTexts(reason: CredentialsUnavailableReason): FailureTexts {
	switch (reason) {
		case "secretsUnreadable":
			return {
				display: l10n.t(
					"This server entry's stored secrets could not be read, so its stored copy in VS Code was not used. Check the server row on the dashboard, then run LiteLLM: Sync Models Now."
				),
				english:
					"This server entry's stored secrets could not be read, so its stored copy in VS Code was not used. Check the server row on the dashboard, then run LiteLLM: Sync Models Now.",
			};
		case "secretsMismatched":
			return {
				display: l10n.t(
					"A stored secret for this server entry was saved for a different server address, so its stored copy in VS Code was not used. Set the secret again from the server row on the dashboard."
				),
				english:
					"A stored secret for this server entry was saved for a different server address, so its stored copy in VS Code was not used. Set the secret again from the server row on the dashboard.",
			};
		case "unusable":
			return {
				display: l10n.t(
					"This server entry's configuration resolves to no usable credentials, so its stored copy in VS Code was not used. Check the server row on the dashboard, then run LiteLLM: Sync Models Now."
				),
				english:
					"This server entry's configuration resolves to no usable credentials, so its stored copy in VS Code was not used. Check the server row on the dashboard, then run LiteLLM: Sync Models Now.",
			};
		case "misconfigured":
			return {
				display: l10n.t(
					"This server entry is misconfigured, so its stored copy in VS Code was not used. Fix the entry on the dashboard, then run LiteLLM: Sync Models Now."
				),
				english:
					"This server entry is misconfigured, so its stored copy in VS Code was not used. Fix the entry on the dashboard, then run LiteLLM: Sync Models Now.",
			};
		default: {
			const exhaustive: never = reason;
			throw new Error(`unrendered credentials reason: ${String(exhaustive)}`);
		}
	}
}

function transportFailureTexts(classification: TransportErrorClassification, baseUrl: string): FailureTexts {
	const url = displayUrl(baseUrl);
	switch (classification.kind) {
		case "auth":
			return { display: l10n.t("Authentication failed for {0}", url), english: `Authentication failed for ${url}` };
		case "http":
			if (classification.unsupportedEndpoint === "modelListing") {
				// Discovery proved the shape (the server answers; its listing does not): the text carries the one fix.
				return {
					display: l10n.t(
						'The server at {0} answers, but its models listing failed. If it never serves the models listing, declare "expectedFailures": ["modelListing"] on its entry, with model IDs in "discovery.declared".',
						url
					),
					english: `The server at ${url} answers, but its models listing failed. If it never serves the models listing, declare "expectedFailures": ["modelListing"] on its entry, with model IDs in "discovery.declared".`,
				};
			}
			return classification.status === undefined
				? {
						display: l10n.t("The server at {0} answered with an error", url),
						english: `The server at ${url} answered with an error`,
					}
				: {
						display: l10n.t("The server at {0} answered {1}", url, classification.status),
						english: `The server at ${url} answered ${classification.status}`,
					};
		case "certificate":
			return {
				display: l10n.t("The TLS certificate of {0} was not accepted", url),
				english: `The TLS certificate of ${url} was not accepted`,
			};
		case "connection":
		case "network":
			return { display: l10n.t("Could not connect to {0}", url), english: `Could not connect to ${url}` };
		case "timeout":
			return { display: l10n.t("The request to {0} timed out", url), english: `The request to ${url} timed out` };
		case "aborted":
			return {
				display: l10n.t("The request to {0} was cancelled", url),
				english: `The request to ${url} was cancelled`,
			};
	}
}

/** The one rendering of a cause, in the current locale and in English, with the server's URL where the text names it. */
export function failureTexts(cause: FailureCause, baseUrl: string): FailureTexts {
	switch (cause.kind) {
		case "transport":
			return transportFailureTexts(cause.classification, baseUrl);
		case "sync":
			return syncFailureTexts(cause.failureClass);
		case "credentials":
			return credentialsTexts(cause.reason);
		case "credentialsRefused": {
			const kinds = rejectedCredentialKinds(cause.fields);
			return {
				display: l10n.t(
					"This server entry's {0} cannot be sent as an HTTP header, so no request was made. Enter the value again from the server row on the dashboard.",
					kinds.display
				),
				english: `This server entry's ${kinds.english} cannot be sent as an HTTP header, so no request was made. Enter the value again from the server row on the dashboard.`,
			};
		}
		case "misconfiguredEntry":
			return {
				display: l10n.t("A servers entry is misconfigured and is not used until its configuration is fixed"),
				english: MISCONFIGURED_ENTRY_TEXT,
			};
		case "unclassified":
			return {
				display: l10n.t("Model discovery failed; the output log has the details"),
				english: "Model discovery failed; the output log has the details",
			};
		default: {
			const exhaustive: never = cause;
			throw new Error(`unrendered failure cause: ${String(exhaustive)}`);
		}
	}
}
