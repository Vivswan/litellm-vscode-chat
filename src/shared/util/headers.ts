/**
 * The header validity rules every surface shares: the request path and the dashboard's header editor. Pure by
 * construction - this rides into the webview bundle, so nothing here may touch vscode or Node.
 */

export type HeaderScalar = string | number | boolean;

/**
 * The JSON schema types the headers contribution admits for a value, one per HeaderScalar member; the generated
 * manifest splices this list in. The code is deliberately stricter: isHeaderScalar refuses non-finite numbers, which
 * JSON cannot carry anyway.
 */
export const HEADER_SCALAR_TYPES = ["string", "number", "boolean"] as const;

export function isHeaderScalar(value: unknown): value is HeaderScalar {
	if (typeof value === "number") {
		// NaN/Infinity must keep failing validation instead of stringifying into a header.
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
 * Whether a string can travel as an HTTP header value: tab, visible ASCII, and RFC 9110 obs-text; no CR/LF/NUL or other
 * control octets. Empty is legal; callers for whom a value is a credential require non-empty separately.
 *
 *   Values that fail this -> must never reach the platform's Headers
 */
export function isValidHeaderValue(value: string): boolean {
	return /^[\t\x20-\x7e\x80-\xff]*$/.test(value);
}

/**
 * Edge HTTP whitespace (tab, space, CR, LF) is exactly what Headers itself strips, so trimming it repairs a pasted
 * trailing newline while a U+00A0 byte of a real key survives. The one trim rule for every credential position: the
 * form, the host boundary, and the request-path narrowing all read through it.
 */
export function trimHttpWhitespace(value: string): string {
	return value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
}

/**
 * A credential as it would travel, or undefined when no repair makes it sendable. Every API-key unit reads through
 * this, so the chat, usage, and draft-probe paths cannot disagree on which keys travel.
 */
export function sendableHeaderValue(value: string): string | undefined {
	const trimmed = trimHttpWhitespace(value);
	return isValidHeaderValue(trimmed) ? trimmed : undefined;
}

/**
 * A configured string as a usable field: present, HTTP-whitespace trimmed, and non-empty; anything else is absent. The
 * one usable-text rule for labels, URLs, header names, model IDs, and credentials alike, so a padded value spells the
 * same field on every surface and a U+00A0 inside or beside it is kept, never repaired.
 */
export function usableHttpText(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = trimHttpWhitespace(value);
	return trimmed.length > 0 ? trimmed : undefined;
}
