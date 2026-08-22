/**
 * The features' shared log-safe error classifier. At the features/ root (like
 * gitApi.d.ts) because features may not import each other (Biome-enforced):
 * every feature's log boundary names failures through this ONE classifier
 * instead of carrying unpinnable copies.
 */

/** Terse label shape: one short printable-ASCII line, so multi-line or binary junk never reaches a log. */
const TERSE_LABEL = /^[\x20-\x7e]{1,120}$/;

/**
 * A log-safe name for a failed feature action: the error's own terse
 * logClassification when it carries one (MirroredError's
 * English-by-construction field), else the Error class name, else the value's
 * type. Total over hostile values - throwing getters included - and
 * shape-gated, so response-derived text has no path into the issue-report
 * buffer through this line.
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
