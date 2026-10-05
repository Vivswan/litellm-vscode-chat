/**
 * The one key for a React list row or an identity comparison built from user strings: a JSON array, never a joined
 * string, since labels, URLs, record keys, and model ids all carry the separators a join would use.
 */
export function tupleKey(...parts: readonly (string | number | undefined)[]): string {
	return JSON.stringify(parts);
}
