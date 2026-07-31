/** Narrow an unknown value to a plain object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys that must never be copied into a plain object as data: bracket
 * assignment under them mutates or shadows the prototype instead of storing
 * a value. Record-shaped settings drop such keys when normalized, and the
 * dashboard's editors reject them with a visible error.
 */
export function isUnsafeRecordKey(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype";
}

/**
 * A fully populated record over a closed key list: the one place the
 * fill-every-key pattern asserts totality, so schema shapes and settings
 * builders stop casting empty objects into total records themselves.
 */
export function recordFromKeys<K extends string, V>(keys: readonly K[], value: (key: K) => V): Record<K, V> {
	return Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, V>;
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (isRecord(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}
