/**
 * The one base URL identity every surface shares when matching servers:
 * trailing slashes are insignificant, nothing else is. Byte-identical to
 * `.replace(/\/+$/, "")` on purpose - no lowercasing, no trimming, no URL
 * parsing - because groupClientId embeds the output in group identities, so
 * any semantic change here would silently re-mint every group ID.
 */
export function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}
