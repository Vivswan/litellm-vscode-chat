/**
 * The one assembler from an entry's flat credential fields to the nested
 * `auth` object serverSync's parser reads: the exact inverse of its grammar
 * (one form per entry, ranked oauth > apiKey > virtualKey, companions nested
 * per primacy). The save, adopt, and test-connection intents all assemble
 * through here, so a credential can never land in a shape the sync engine
 * does not read.
 *
 * Pairing is enforced before assembly - the same both-or-neither rules the
 * webview form applies. A combination that would leave a credential without a
 * legal home in the grammar (a lone OAuth piece, a virtual key value without
 * its header) fails instead of assembling, so no value is ever dropped
 * silently. Pairing reads PRESENCE, which for a secret field may be a value
 * resting in SecretStorage (`resolves`); assembly writes only the inline
 * values it was handed, so a secure-resting secret stays out of the settings
 * shape and resolves at group-args time like any stored value.
 */

import * as l10n from "@vscode/l10n";
import type { OptionalEntryFields, SecretFieldId } from "../../shared/serverEntry";

/**
 * Secret fields known to hold a value even when none rides inline (a
 * SecretStorage side, a directive that resolves): ORed with inline presence
 * for the pairing rules, never written into the assembled shape.
 */
export type SecretResolution = Readonly<Partial<Record<SecretFieldId, boolean>>>;

/** A cross-field pairing violation, named by the form field its message routes to. */
export type PairingFailure = "oauthTokenUrl" | "oauthClientId" | "virtualKeyValue" | "virtualKeyHeader";

/** assembleEntryAuth's outcome: the auth object (undefined when no field carries usable text), or the first pairing failure. */
export type AssembledEntryAuth =
	| { readonly auth: Readonly<Record<string, unknown>> | undefined; readonly failure?: undefined }
	| { readonly auth?: undefined; readonly failure: PairingFailure };

/** The parser's usable-text rule: only non-blank content counts, trimmed. */
function usable(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Assemble the auth object for `inline` (the values that belong in the
 * settings file), with `resolves` naming the secret fields whose value rests
 * in SecretStorage instead. Failures come in a fixed order: the OAuth unit
 * (token URL, then client ID), then the virtual key pair.
 */
export function assembleEntryAuth(inline: OptionalEntryFields, resolves: SecretResolution = {}): AssembledEntryAuth {
	const tokenUrl = usable(inline.oauthTokenUrl);
	const clientId = usable(inline.oauthClientId);
	const scopes = usable(inline.oauthScopes);
	const header = usable(inline.virtualKeyHeader);
	const apiKey = usable(inline.apiKey);
	const clientSecret = usable(inline.oauthClientSecret);
	const virtualKeyValue = usable(inline.virtualKeyValue);
	const secretPresent = (field: SecretFieldId, inlineValue: string | undefined): boolean =>
		inlineValue !== undefined || resolves[field] === true;

	// OAuth is one unit: anything OAuth-shaped requires the token URL and
	// client ID pair (the request path drops partial configurations silently).
	const oauthExtras = secretPresent("oauthClientSecret", clientSecret) || scopes !== undefined;
	if ((clientId !== undefined || oauthExtras) && tokenUrl === undefined) {
		return { failure: "oauthTokenUrl" };
	}
	if ((tokenUrl !== undefined || oauthExtras) && clientId === undefined) {
		return { failure: "oauthClientId" };
	}
	// The virtual key pair is both-or-neither.
	const virtualKeyPresent = secretPresent("virtualKeyValue", virtualKeyValue);
	if (header !== undefined && !virtualKeyPresent) {
		return { failure: "virtualKeyValue" };
	}
	if (header === undefined && virtualKeyPresent) {
		return { failure: "virtualKeyHeader" };
	}

	const virtualKey: Record<string, string> | undefined =
		header !== undefined ? { header, ...(virtualKeyValue !== undefined ? { value: virtualKeyValue } : {}) } : undefined;
	const auth: Record<string, unknown> = {};
	if (tokenUrl !== undefined && clientId !== undefined) {
		auth.oauth = {
			tokenUrl,
			clientId,
			...(clientSecret !== undefined ? { clientSecret } : {}),
			...(scopes !== undefined ? { scopes } : {}),
			...(apiKey !== undefined ? { apiKey } : {}),
			...(virtualKey !== undefined ? { virtualKey } : {}),
		};
	} else {
		if (apiKey !== undefined) {
			auth.apiKey = apiKey;
		}
		if (virtualKey !== undefined) {
			auth.virtualKey = virtualKey;
		}
	}
	return { auth: Object.keys(auth).length > 0 ? auth : undefined };
}

/**
 * The user-facing validation message for one pairing failure. The "fieldId:"
 * prefix stays an ASCII identifier outside the translation: sectionFailureText
 * routes the failure onto the right form section by it.
 */
export function pairingFailureMessage(failure: PairingFailure): string {
	switch (failure) {
		case "oauthTokenUrl":
			return `oauthTokenUrl: ${l10n.t("OAuth needs the token URL and client ID")}`;
		case "oauthClientId":
			return `oauthClientId: ${l10n.t("OAuth needs the token URL and client ID")}`;
		case "virtualKeyValue":
			return `virtualKeyValue: ${l10n.t("enter the key sent in this header")}`;
		case "virtualKeyHeader":
			return `virtualKeyHeader: ${l10n.t("name the header that carries the key")}`;
	}
}
