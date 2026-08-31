/** Narrow an unknown value to a plain object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys that must never be copied into a plain object as data: bracket
 * assignment under them mutates or shadows the prototype instead of storing a
 * value. Record-shaped settings drop them; the dashboard's editors reject them
 * with a visible error.
 */
export function isUnsafeRecordKey(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype";
}

/** A fully populated record over a closed key list: the one place the fill-every-key pattern asserts totality. */
export function recordFromKeys<K extends string, V>(keys: readonly K[], value: (key: K) => V): Record<K, V> {
	return Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, V>;
}

/**
 * Validate a stored label-to-string map at its trust boundary: anything not a
 * plain record reads as empty, and non-string values or reserved
 * (prototype-mutating) keys are dropped field by field, so consumers can
 * assign the surviving keys into plain records unguarded.
 */
export function validatedStringRecord(stored: unknown): Record<string, string> {
	if (!isRecord(stored)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(stored).filter(
			(field): field is [string, string] => typeof field[1] === "string" && !isUnsafeRecordKey(field[0])
		)
	);
}

/** Try to parse a JSON object from a string. */
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
