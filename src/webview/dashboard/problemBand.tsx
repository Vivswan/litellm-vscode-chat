import type { ReactNode } from "react";
import { type DiagnosticSeverity, type SeveritySubject, severityLabel } from "./severity";

/**
 * The paint tiers a problem band can wear. Severity RANKS a problem (order, pill,
 * attention count, the hidden tier word); the tier is only how the band is painted, and
 * one second scale may lift it: the spend scale's error tier paints a degraded budget
 * line as an error because error-tier money reads red everywhere it renders (USER-RULED
 * 2026-08-17). The lift applies to degraded alone - blocking is already error-tier, and
 * an advisory means nothing is wrong, so a stray tone cannot louden it.
 */
type BandTier = "error" | "warn" | "advisory";

function bandTier(severity: DiagnosticSeverity, tone: "error" | undefined): BandTier {
	switch (severity) {
		case "blocking":
			return "error";
		case "degraded":
			return tone === "error" ? "error" : "warn";
		case "advisory":
			return "advisory";
	}
}

/**
 * The ONE renderer for a problem band - the severity-ruled block under a server row and
 * behind a configuration problem. Tier in, presentation out: the stylesheet's
 * `.row-diagnostic.tier-*` rules key off the class this component mints, and nothing
 * else may mint it (problemBandPipeline.test.ts fails any second minter), so a band
 * cannot fork its own bar or text treatment the way three presentations once coexisted
 * on one page. In color modes the tier rides hue and headline text on one 2px bar; the
 * bordered modes re-rank by stroke geometry (dashboard.css `.row-diagnostic`).
 */
export function ProblemBand({
	as: Tag = "div",
	severity,
	subject,
	tone,
	headline,
	where,
	details,
	actions,
}: {
	readonly as?: "div" | "li";
	readonly severity: DiagnosticSeverity;
	readonly subject: SeveritySubject;
	/** The spend scale's one override: lifts a DEGRADED band's paint to the error tier (inert elsewhere, see bandTier). */
	readonly tone?: "error" | undefined;
	readonly headline: ReactNode;
	/** Where the problem lives (the Diagnostics page's location badges), between headline and detail. */
	readonly where?: ReactNode;
	readonly details?: readonly string[] | undefined;
	/** The caller's action cluster, rendered last; the band does not restyle it. */
	readonly actions?: ReactNode;
}) {
	return (
		<Tag className={`row-diagnostic tier-${bandTier(severity, tone)}`}>
			<p className="row-diagnostic-headline">
				{/* Bar and hue never reach a screen reader, so the tier leads in words. */}
				<span className="visually-hidden">{severityLabel(severity, subject)} </span>
				{headline}
			</p>
			{where}
			{(details ?? []).map((detail) => (
				// Keyed by the line itself (Biome bans index keys); callers keep detail lines distinct.
				<p key={detail} className="row-diagnostic-detail">
					{detail}
				</p>
			))}
			{actions}
		</Tag>
	);
}
