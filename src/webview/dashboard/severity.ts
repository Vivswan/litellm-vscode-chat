import * as l10n from "@vscode/l10n";

/**
 * The dashboard's ONE severity vocabulary: how much a problem costs the reader. The
 * server rows and the Diagnostics page rank by the same three tiers and share the sev-*
 * rules, this order, and the label table - two mechanisms would drift.
 */
export type DiagnosticSeverity = "blocking" | "degraded" | "advisory";

/** What a surface's problems are ABOUT, which decides how a tier is said in words (see severityLabel). */
export type SeveritySubject = "configuration" | "server";

/** Loudest first: problems are read top to bottom in the order they cost you something. */
export const SEVERITY_ORDER: Readonly<Record<DiagnosticSeverity, number>> = { blocking: 0, degraded: 1, advisory: 2 };

/**
 * The tier said in words, for assistive technology: on screen a tier rides hue, wash,
 * and rule weight, none of which a screen reader can report. Per-subject wording,
 * because a label is a claim about the sentence it prefixes - a budget overrun announced
 * as "Partly ignored:" contradicts its own headline. A new surface picks a subject; it
 * never mints words of its own.
 */
export function severityLabel(severity: DiagnosticSeverity, subject: SeveritySubject): string {
	switch (severity) {
		case "blocking":
			return subject === "configuration" ? l10n.t("Not applied at all:") : l10n.t("Serving nothing:");
		case "degraded":
			return subject === "configuration" ? l10n.t("Partly ignored:") : l10n.t("Action needed:");
		case "advisory":
			return l10n.t("Note:");
	}
}
