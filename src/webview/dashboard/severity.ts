import * as l10n from "@vscode/l10n";

/**
 * The dashboard's ONE severity vocabulary: how much a problem costs the
 * reader, which is the only thing that should decide how loud it looks. The
 * server rows and the Diagnostics page rank their problems by the same three
 * tiers, read against each surface's own subject (each surface documents its
 * reading beside its diagnostics builder), and they share the sev-* rules,
 * this order, and the label table below - two mechanisms would drift the
 * moment either changed.
 */
export type DiagnosticSeverity = "blocking" | "degraded" | "advisory";

/** What a surface's problems are ABOUT, which decides how a tier is said in words (see severityLabel). */
export type SeveritySubject = "configuration" | "server";

/** Loudest first: problems are read top to bottom in the order they cost you something. */
export const SEVERITY_ORDER: Readonly<Record<DiagnosticSeverity, number>> = { blocking: 0, degraded: 1, advisory: 2 };

/**
 * The tier said in words, for assistive technology.
 *
 * On screen a tier rides hue, a wash, and the rule's weight and style - none
 * of which a screen reader can report, so without this, structurally
 * identical problem lines announce identically and the ranking is invisible
 * to the one reader who cannot see it. Visually hidden at every call site
 * rather than printed.
 *
 * One rank, said in the subject's own words: the tiers MEAN the same thing
 * everywhere (wholly lost / partly costing you / nobody has to act), but a
 * label is a claim about the sentence it prefixes, and the configuration
 * words are false in front of the server rows' sentences - a budget overrun
 * announced as "Partly ignored:" contradicts its own headline, which is
 * worse than no rank at all. So the two problem tiers take per-subject
 * wording from this one table, and the advisory tier shares its word, which
 * is true of both subjects. A new surface picks a subject; it never mints
 * words of its own.
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
