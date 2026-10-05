import { parseDecimalText } from "./decimalText";
import { trimHttpWhitespace } from "./headers";

/**
 * A positive whole count from a JSON number or its decimal text (LiteLLM emits some limits as strings; a legacy token
 * setting was free text). Text passes the one decimal grammar after the one trim, so " 9000 " reads 9000 while a
 * U+00A0 or "0x10" reads as absent instead of a second number the user never spelled.
 */
export function normalizePositiveNumber(value: unknown): number | undefined {
	const candidate =
		typeof value === "number"
			? value
			: typeof value === "string"
				? (parseDecimalText(trimHttpWhitespace(value)) ?? Number.NaN)
				: Number.NaN;

	return Number.isFinite(candidate) && Number.isInteger(candidate) && candidate > 0 ? candidate : undefined;
}

/**
 * Costs are fractional and zero means a free model, so unlike normalizePositiveNumber this keeps non-integers and zero.
 * Numbers only: LiteLLM emits costs as JSON numbers, and anything else is a malformed entry that degrades to absent.
 */
export function normalizeCostPerToken(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	// -0 compares >= 0 but would leak a negative-signed cost to the host.
	return value === 0 ? 0 : value;
}
