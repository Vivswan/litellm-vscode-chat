export function normalizePositiveNumber(value: unknown): number | undefined {
	const candidate =
		typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;

	return Number.isFinite(candidate) && Number.isInteger(candidate) && candidate > 0 ? candidate : undefined;
}

/**
 * Narrow a per-token cost read from a lenient discovery payload. Costs are
 * fractional and zero means a free model, so unlike normalizePositiveNumber
 * this keeps non-integers and zero (negative zero canonicalizes to zero). It
 * also accepts numbers only: LiteLLM emits costs as JSON numbers, and
 * anything else (a string, a negative, a non-finite value) is a malformed
 * entry that degrades to absent rather than reaching the model picker.
 */
export function normalizeCostPerToken(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	// -0 compares >= 0 but would leak a negative-signed cost to the host.
	return value === 0 ? 0 : value;
}
