declare const normalizedBaseUrlBrand: unique symbol;

export type NormalizedBaseUrl = string & { readonly [normalizedBaseUrlBrand]: true };

/**
 * The one base URL identity every surface shares when matching servers: trailing slashes are insignificant; every
 * other difference of spelling is settled before a URL enters the program (canonicalBaseUrl below), so this stays a
 * byte-level rule. Byte-identical to `.replace(/\/+$/, "")` on purpose - no lowercasing, no trimming, no URL parsing -
 * because groupClientId embeds the output in group identities and older records hold spellings as typed.
 */
export function normalizeBaseUrl(baseUrl: string): NormalizedBaseUrl {
	return baseUrl.replace(/\/+$/, "") as NormalizedBaseUrl;
}

/**
 * The one spelling of a configured URL: the WHATWG serialization, applied where a URL enters the program (the servers
 * setting parser, the host's group configuration, the dashboard's writes) so every later reader compares and shows one
 * string. Undefined for text the parser refuses or that names no host, which nothing could connect to.
 *
 *   "HTTP://User:Pa ss@Host:4000/x" -> "http://User:Pa%20ss@host:4000/x"
 *   "http:user:pass@host"           -> "http://user:pass@host/"
 *   "http://user:pa/ss@host"        -> undefined ("pa" is not a port)
 *   "mailto:x@y", "localhost:4000"  -> undefined (no host)
 */
export function canonicalUrl(text: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		return undefined;
	}
	return parsed.host.length > 0 ? parsed.href : undefined;
}

/**
 * A base URL's one spelling: canonicalUrl under the identity rule above, so the stored text IS the identity text and
 * "http://host:4000/" and "http://host:4000" are one base URL. Endpoint URLs (an OAuth token URL, mcp.url) keep
 * canonicalUrl's trailing slash, because they are fetched exactly.
 */
export function canonicalBaseUrl(text: string): NormalizedBaseUrl | undefined {
	const url = canonicalUrl(text);
	return url === undefined ? undefined : normalizeBaseUrl(url);
}

/**
 * The one spelling of a base URL identity an older version stored through normalizeBaseUrl alone (a ledger entry, a
 * tombstone, a secret stamp). That rule stripped the typed text's trailing slashes, so the stored text can end in a
 * space that stood before one ("http://host/a /" -> "http://host/a "), which the URL parser would trim away; the
 * slash goes back first so the space reads as the entry now spells it, "http://host/a%20".
 */
export function canonicalStoredBaseUrl(stored: string): NormalizedBaseUrl | undefined {
	return canonicalBaseUrl(`${stored}/`);
}

export const DEFAULT_API_VERSION = "v1";

/**
 * A trailing version segment: v + digits, optionally staged Google-style (v1beta, v1alpha2). Lowercase only, so a /V1
 * that meant something else is not swallowed.
 */
const VERSION_SEGMENT_PATTERN = /\/v\d+(?:(?:alpha|beta)\d*)?$/;

function trailingVersionSegmentIndex(normalized: string): number | undefined {
	const match = VERSION_SEGMENT_PATTERN.exec(normalized);
	if (match === null || match.index === 0) {
		return undefined;
	}
	const before = normalized.charAt(match.index - 1);
	return before === "/" || before === ":" ? undefined : match.index;
}

/**
 * The OpenAI-compatible API root for a server: the entry's apiVersion wins when set ("" means the base URL already IS
 * the root, anything else is appended verbatim); otherwise a version segment already in the URL is kept and only a URL
 * without one gets /v1. Plain string, not NormalizedBaseUrl - a transport root, never a server identity.
 */
export function apiRootOf(baseUrl: string, apiVersion?: string): string {
	const normalized = normalizeBaseUrl(baseUrl);
	if (apiVersion !== undefined) {
		return apiVersion === "" ? normalized : `${normalized}/${apiVersion}`;
	}
	return trailingVersionSegmentIndex(normalized) === undefined ? `${normalized}/${DEFAULT_API_VERSION}` : normalized;
}

/**
 * A non-empty apiVersion means the base URL is already the server root; with "" or no override, a version segment the
 * user wrote into the URL is stripped so root endpoints do not land under it - "" changes what the API root is, not
 * where the server root sits.
 */
export function serverRootOf(baseUrl: string, apiVersion?: string): string {
	const normalized = normalizeBaseUrl(baseUrl);
	if (apiVersion !== undefined && apiVersion !== "") {
		return normalized;
	}
	const index = trailingVersionSegmentIndex(normalized);
	return index === undefined ? normalized : normalized.slice(0, index);
}

/**
 * Appending to the base URL as written is deliberate (a base ending in /v1 derives .../v1/mcp); an entry served
 * elsewhere names it. The MCP publisher and the server form's empty-field preview must give the SAME address, so one
 * rule lives in the module both trees share.
 */
export function mcpEndpointOf(baseUrl: string): string {
	return `${normalizeBaseUrl(baseUrl)}/mcp`;
}
