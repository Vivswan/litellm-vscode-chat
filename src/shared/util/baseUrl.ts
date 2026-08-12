declare const normalizedBaseUrlBrand: unique symbol;

/**
 * A base URL that went through normalizeBaseUrl. Identity-bearing surfaces
 * (group client IDs, status-map keys, server-matching comparisons) require
 * this type, so an unnormalized URL - say, the verbatim string from a host
 * round trip - cannot enter a comparison and split one server into two.
 */
export type NormalizedBaseUrl = string & { readonly [normalizedBaseUrlBrand]: true };

/**
 * The one base URL identity every surface shares when matching servers:
 * trailing slashes are insignificant, nothing else is. Byte-identical to
 * `.replace(/\/+$/, "")` on purpose - no lowercasing, no trimming, no URL
 * parsing - because groupClientId embeds the output in group identities, so
 * any semantic change here would silently re-mint every group ID.
 */
export function normalizeBaseUrl(baseUrl: string): NormalizedBaseUrl {
	return baseUrl.replace(/\/+$/, "") as NormalizedBaseUrl;
}

/** Appended to the API root when neither the entry's apiVersion nor the base URL supplies a version segment. */
export const DEFAULT_API_VERSION = "v1";

/**
 * A trailing version segment: v + digits, optionally staged Google-style
 * (v1beta, v1alpha2). Lowercase only - OpenAI-compatible API paths are
 * lowercase, and a /V1 that meant something else must not be swallowed.
 */
const VERSION_SEGMENT_PATTERN = /\/v\d+(?:(?:alpha|beta)\d*)?$/;

/**
 * Where the trailing version segment starts, or undefined when the URL does
 * not end in one. The preceding-character guard keeps the match inside a real
 * path: a bare host that merely looks like a version (http://v1) or a scheme
 * separator hit (http://host//v1) is not a version segment.
 */
function trailingVersionSegmentIndex(normalized: string): number | undefined {
	const match = VERSION_SEGMENT_PATTERN.exec(normalized);
	if (match === null || match.index === 0) {
		return undefined;
	}
	const before = normalized.charAt(match.index - 1);
	return before === "/" || before === ":" ? undefined : match.index;
}

/**
 * The OpenAI-compatible API root for a server: the entry's apiVersion wins
 * when set ("" means the base URL already IS the root, anything else is
 * appended verbatim); otherwise a version segment already in the URL is kept
 * as-is, and only a URL with no version gets /v1 appended. Returns a plain
 * string, not NormalizedBaseUrl - this is a transport root, never a server
 * identity.
 */
export function apiRootOf(baseUrl: string, apiVersion?: string): string {
	const normalized = normalizeBaseUrl(baseUrl);
	if (apiVersion !== undefined) {
		return apiVersion === "" ? normalized : `${normalized}/${apiVersion}`;
	}
	return trailingVersionSegmentIndex(normalized) === undefined ? `${normalized}/${DEFAULT_API_VERSION}` : normalized;
}

/**
 * The server root for root-relative endpoints (/key/info and friends): the
 * inverse of apiRootOf. A non-empty apiVersion means the base URL is already
 * the server root (the version is appended, never part of the base); with ""
 * or no override, a version segment the user wrote into the URL is stripped
 * so root endpoints do not land under it - "" changes what the API root is,
 * not where the server root sits. Plain string, same as apiRootOf.
 */
export function serverRootOf(baseUrl: string, apiVersion?: string): string {
	const normalized = normalizeBaseUrl(baseUrl);
	if (apiVersion !== undefined && apiVersion !== "") {
		return normalized;
	}
	const index = trailingVersionSegmentIndex(normalized);
	return index === undefined ? normalized : normalized.slice(0, index);
}
