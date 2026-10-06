/**
 * Blind control for scripts/ci/check-user-text-readers.ts: a reader with no trim, number, or coercion at all, so a
 * scan scoped to it alone sees nothing and must exit 1 instead of passing. Never imported.
 */
export function readLabel(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
