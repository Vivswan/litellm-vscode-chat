/**
 * A datum that is absent: a dim dash plus the reason, never a zero - a zero is
 * a measurement, and no measurement was taken. The dash alone reads as nothing
 * to a screen reader, so the words always ride along: screen-reader-only text
 * by default, or the caller's own visible node (the server facts' Why) in its
 * place. One embodiment on purpose - two hand-rolled copies of this shape drift
 * the moment one drops the aria-hidden, and no test notices a missing
 * attribute on a copy it does not know about.
 */
import * as l10n from "@vscode/l10n";
import type { ReactElement } from "react";

export function AbsentDatum({
	className,
	reason,
	children,
}: {
	/** The wrapper's register: the call site's muted class ("hint", "text-muted-foreground"). */
	className: string;
	/** Screen-reader-only reason text; "not reported" when omitted. Unused while children speak. */
	reason?: string | undefined;
	/** A visible reason rendered in place of the hidden text; an element, so a conditional `false` cannot silence the words. */
	children?: ReactElement | undefined;
}) {
	return (
		<span className={className}>
			<span aria-hidden="true">-</span>
			{children ?? <span className="visually-hidden">{reason ?? l10n.t("not reported")}</span>}
		</span>
	);
}
