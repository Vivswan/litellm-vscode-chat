/** Terse label shape: one short printable-ASCII line, so multi-line or binary junk never reaches a log. */
const TERSE_LABEL = /^[\x20-\x7e]{1,120}$/;

/**
 * A log-safe name for a failed feature action: the error's own terse logClassification when it carries one. Total
 * over hostile values - throwing getters included.
 */
export function errorLabel(error: unknown): string {
	try {
		if (typeof error === "object" && error !== null) {
			const classification = (error as { logClassification?: unknown }).logClassification;
			if (typeof classification === "string" && TERSE_LABEL.test(classification)) {
				return classification;
			}
			if (error instanceof Error && TERSE_LABEL.test(error.name)) {
				return error.name;
			}
		}
		return typeof error;
	} catch {
		return "unreadable-error";
	}
}
