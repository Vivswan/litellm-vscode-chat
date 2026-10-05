export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The path of the first non-finite number under `root`, or undefined when there is none: JSON.parse reads an
 * overflowing literal ("1e999") as Infinity, which JSON.stringify then writes as null, so the refusal names where.
 * Dotted keys and bracketed indices ("models.parameters.gpt-4.temperature", "stop[2]"); the root itself is "".
 * Whatever JSON.parse accepted must pass through here, a value 5000 deep or 200000 members wide included.
 */
export function nonFiniteNumberPath(root: unknown): string | undefined {
	const pending: { value: unknown; path: string }[] = [{ value: root, path: "" }];
	while (pending.length > 0) {
		const next = pending.pop();
		if (next === undefined) {
			break;
		}
		const { value, path } = next;
		if (typeof value === "number" && !Number.isFinite(value)) {
			return path;
		}
		if (Array.isArray(value)) {
			for (let index = value.length - 1; index >= 0; index -= 1) {
				pending.push({ value: value[index], path: `${path}[${index}]` });
			}
		} else if (isRecord(value)) {
			for (const [key, item] of Object.entries(value).reverse()) {
				pending.push({ value: item, path: path === "" ? key : `${path}.${key}` });
			}
		}
	}
	return undefined;
}

/** the dashboard's editors -> reject them with a visible error */
export function isUnsafeRecordKey(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype";
}

/** A fully populated record over a closed key list: the one place the fill-every-key pattern asserts totality. */
export function recordFromKeys<K extends string, V>(keys: readonly K[], value: (key: K) => V): Record<K, V> {
	return Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, V>;
}

/** Validate a stored label-to-string map at its trust boundary. */
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
