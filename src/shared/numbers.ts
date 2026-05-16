export function normalizePositiveNumber(value: unknown): number | undefined {
	const candidate =
		typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;

	return Number.isFinite(candidate) && Number.isInteger(candidate) && candidate > 0 ? candidate : undefined;
}
