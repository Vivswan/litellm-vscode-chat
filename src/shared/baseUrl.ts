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
