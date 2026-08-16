/**
 * The header validity rules every surface shares: the request path and the
 * dashboard's header editor. Pure by construction - this rides into the
 * webview bundle, so nothing here may touch vscode or Node.
 */

/** A value legal in the headers setting: HTTP header values are scalars, stringified on the wire. */
export type HeaderScalar = string | number | boolean;

/**
 * The JSON schema types the headers contribution admits for a value, one per
 * HeaderScalar member; settingSpec.test.ts pins package.json against this
 * list. The code is deliberately stricter: isHeaderScalar refuses non-finite
 * numbers, which JSON cannot carry anyway.
 */
export const HEADER_SCALAR_TYPES = ["string", "number", "boolean"] as const;

/** Narrow an unknown settings value to a header scalar. */
export function isHeaderScalar(value: unknown): value is HeaderScalar {
	if (typeof value === "number") {
		// NaN/Infinity must keep failing validation instead of stringifying
		// into a header.
		return Number.isFinite(value);
	}
	return typeof value === "string" || typeof value === "boolean";
}

/** RFC 9110 header-name token; anything else would make the transport throw at request time. */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isValidHeaderName(name: string): boolean {
	return HEADER_NAME_PATTERN.test(name);
}

/**
 * Whether a string can travel as an HTTP header value: tab, visible ASCII, and
 * RFC 9110 obs-text; no CR/LF/NUL or other control octets. Empty is legal;
 * callers for whom a value is a credential require non-empty separately.
 * Values that fail this must never reach the platform's Headers, whose
 * TypeError embeds the full plaintext value.
 */
export function isValidHeaderValue(value: string): boolean {
	return /^[\t\x20-\x7e\x80-\xff]*$/.test(value);
}
