/**
 * The header validity rules every surface shares: the request path (custom
 * headers, virtual keys, OAuth tokens) and the dashboard's header editor.
 * Pure by construction; the dashboard webview bundle imports these through
 * the dashboard protocol module, so nothing here may touch vscode or Node.
 */

/** A value legal in the headers setting: HTTP header values are scalars, stringified on the wire. */
export type HeaderScalar = string | number | boolean;

/** Narrow an unknown settings value to a header scalar. */
export function isHeaderScalar(value: unknown): value is HeaderScalar {
	if (typeof value === "number") {
		// Only finite numbers, matching what z.number() admitted before this
		// predicate existed: NaN/Infinity must keep failing validation instead
		// of stringifying into a header.
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
 * Whether a string can travel as an HTTP header value: tab, visible ASCII,
 * and RFC 9110 obs-text; no CR/LF/NUL or other control octets. Values that
 * fail this must never reach the platform's Headers, whose TypeError embeds
 * the full plaintext value.
 */
export function isValidHeaderValue(value: string): boolean {
	return value.length > 0 && /^[\t\x20-\x7e\x80-\xff]+$/.test(value);
}
