/**
 * The one assembler from an entry's flat credential fields to the nested `auth` object serverSync's parser reads: the
 * exact inverse of its grammar (one form per entry, ranked oauth > apiKey > virtualKey, companions nested per
 * primacy). Pairing is enforced before assembly - the same both-or-neither rules the webview form applies.
 *
 *   The save, adopt, and test-connection intents all assemble through here -> a credential can never land in a shape
 *     the sync engine does not read
 *   a combination that would leave a credential without a legal home in the grammar (a lone OAuth piece, a virtual
 *     key value without its header) -> fails instead of assembling, so no value is ever dropped silently
 *   Pairing -> reads PRESENCE, which for a secret field may be a value resting in SecretStorage (`resolves`)
 *   assembly writes only the inline values it was handed -> a secure-resting secret stays out of the settings shape
 *     and resolves at group-args time like any stored value
 */

import * as l10n from "@vscode/l10n";
import type { OptionalEntryFields, SecretFieldId } from "../../shared/serverEntry";
import { usableHttpText } from "../../shared/util/headers";

/**
 * Secret fields known to hold a value even when none rides inline (a SecretStorage side, a directive that resolves):
 * ORed with inline presence for the pairing rules, never written into the assembled shape.
 */
export type SecretResolution = Readonly<Partial<Record<SecretFieldId, boolean>>>;

/** A cross-field pairing violation, named by the form field its message routes to. */
export type PairingFailure = "oauthTokenUrl" | "oauthClientId" | "virtualKeyValue" | "virtualKeyHeader";

export type AssembledEntryAuth =
	| { readonly auth: Readonly<Record<string, unknown>> | undefined; readonly failure?: undefined }
	| { readonly auth?: undefined; readonly failure: PairingFailure };

/** The usable (trimmed, non-empty) inline credential fields an entry declares, by their roles in the grammar. */
interface InlineCredentialFields {
	readonly tokenUrl: string | undefined;
	readonly clientId: string | undefined;
	readonly scopes: string | undefined;
	readonly header: string | undefined;
	readonly apiKey: string | undefined;
	readonly clientSecret: string | undefined;
	readonly virtualKeyValue: string | undefined;
}

function usableInlineFields(inline: OptionalEntryFields): InlineCredentialFields {
	return {
		tokenUrl: usableHttpText(inline.oauthTokenUrl),
		clientId: usableHttpText(inline.oauthClientId),
		scopes: usableHttpText(inline.oauthScopes),
		header: usableHttpText(inline.virtualKeyHeader),
		apiKey: usableHttpText(inline.apiKey),
		clientSecret: usableHttpText(inline.oauthClientSecret),
		virtualKeyValue: usableHttpText(inline.virtualKeyValue),
	};
}

/**
 * The first pairing rule the fields break, in the fixed order (the OAuth unit, then the virtual key pair), or
 * undefined when every unit is whole. OAuth is one unit: anything OAuth-shaped requires the token URL and client ID
 * pair, because the request path drops partial configurations silently.
 */
function pairingFailureOf(fields: InlineCredentialFields, resolves: SecretResolution): PairingFailure | undefined {
	const secretPresent = (field: SecretFieldId, inlineValue: string | undefined): boolean =>
		inlineValue !== undefined || resolves[field] === true;
	const oauthExtras = secretPresent("oauthClientSecret", fields.clientSecret) || fields.scopes !== undefined;
	if ((fields.clientId !== undefined || oauthExtras) && fields.tokenUrl === undefined) {
		return "oauthTokenUrl";
	}
	if ((fields.tokenUrl !== undefined || oauthExtras) && fields.clientId === undefined) {
		return "oauthClientId";
	}

	const virtualKeyPresent = secretPresent("virtualKeyValue", fields.virtualKeyValue);
	if (fields.header !== undefined && !virtualKeyPresent) {
		return "virtualKeyValue";
	}
	if (fields.header === undefined && virtualKeyPresent) {
		return "virtualKeyHeader";
	}

	return undefined;
}

/** The virtual key unit as the grammar nests it, or undefined without a header. */
function virtualKeyUnit(fields: InlineCredentialFields): Record<string, string> | undefined {
	if (fields.header === undefined) {
		return undefined;
	}
	return { header: fields.header, ...(fields.virtualKeyValue === undefined ? {} : { value: fields.virtualKeyValue }) };
}

/** The OAuth unit with its companions nested under it, as the grammar ranks them. */
function oauthUnit(
	fields: InlineCredentialFields,
	pair: { readonly tokenUrl: string; readonly clientId: string },
	virtualKey: Record<string, string> | undefined
): Record<string, unknown> {
	return {
		tokenUrl: pair.tokenUrl,
		clientId: pair.clientId,
		...(fields.clientSecret === undefined ? {} : { clientSecret: fields.clientSecret }),
		...(fields.scopes === undefined ? {} : { scopes: fields.scopes }),
		...(fields.apiKey === undefined ? {} : { apiKey: fields.apiKey }),
		...(virtualKey === undefined ? {} : { virtualKey }),
	};
}

/** The nested `auth` object for already-paired fields, or undefined when no credential is declared inline. */
function assembledAuth(fields: InlineCredentialFields): Readonly<Record<string, unknown>> | undefined {
	const { tokenUrl, clientId } = fields;
	const virtualKey = virtualKeyUnit(fields);
	const auth: Record<string, unknown> = {};
	if (tokenUrl !== undefined && clientId !== undefined) {
		auth.oauth = oauthUnit(fields, { tokenUrl, clientId }, virtualKey);
	} else {
		if (fields.apiKey !== undefined) {
			auth.apiKey = fields.apiKey;
		}
		if (virtualKey !== undefined) {
			auth.virtualKey = virtualKey;
		}
	}

	return Object.keys(auth).length > 0 ? auth : undefined;
}

/** Failures come in a fixed order: the OAuth unit (token URL, then client ID), then the virtual key pair. */
export function assembleEntryAuth(inline: OptionalEntryFields, resolves: SecretResolution = {}): AssembledEntryAuth {
	const fields = usableInlineFields(inline);
	const failure = pairingFailureOf(fields, resolves);
	if (failure !== undefined) {
		return { failure };
	}

	return { auth: assembledAuth(fields) };
}

/**
 * The "fieldId:" prefix stays an ASCII identifier outside the translation: sectionFailureText routes the failure onto
 * the right form section by it.
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
