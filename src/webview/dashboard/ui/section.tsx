/**
 * A page section and its header line. Four surfaces spelled the same shape by
 * hand - a heading carrying the title, a Help glyph and a docs link, then a
 * separate strip of buttons underneath - which cost a row of vertical space per
 * section to say nothing, and drifted: some sections named themselves so they
 * could be jumped to and some did not.
 *
 * The actions move onto the header line, where the eye already is. `meta` is
 * for the quiet supporting fact a header wants to carry (a count, "showing 4 of
 * 4") without promoting it to a paragraph. The line only works because
 * `.section-head` is a flex row - the parts are siblings of the heading rather
 * than nested inside it, so without that rule they stack.
 *
 * `Section` owns `id`, `tabIndex`, `aria-labelledby` and the scroll margin
 * together because they are one contract, not four attributes: an in-page jump
 * names a section, moves focus to it, and must not park it under whatever is
 * stuck to the top of the viewport. One place decides all of that.
 *
 * A DOM id is document-wide, so a section's `id` names it across the whole
 * page, not per-surface. The dashboard's four panel names are taken; anything
 * else picks a name no other section uses.
 */
import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import type { DocsUrl } from "../docsLinks";
import { DocsLink, Help } from "../help";
import { cn } from "./cn";

export interface SectionHeaderProps {
	/** The id of the heading element, for the section's aria-labelledby. */
	titleId?: string;
	title: string;
	/**
	 * Heading level. A section heading is an h2; a sub-header inside a page
	 * whose section heading is already an h2 has to be an h3 or an h4, and the
	 * surfaces this replaces use all three. 5 is the server form's Companions
	 * sub-head, one step under its h4 sections.
	 */
	level?: 2 | 3 | 4 | 5;
	/** Help tip text; renders the "?" affordance when present. */
	help?: string;
	/** Place the tip below its trigger - for headers near the top, where above would clip. */
	helpBelow?: boolean;
	/** The docs link's target and accessible name. */
	docs?: { readonly href: DocsUrl; readonly label: string };
	/** A quiet fact belonging to the title, not to the body: counts, filter state. */
	meta?: ReactNode;
	/** Trailing actions, on the header line rather than a strip below it. */
	actions?: ReactNode;
	className?: string | undefined;
}

export function SectionHeader({
	titleId,
	title,
	level = 2,
	help,
	helpBelow,
	docs,
	meta,
	actions,
	className,
}: SectionHeaderProps) {
	const Heading = `h${level}` as const;
	return (
		<div className={cn("section-head", className)}>
			<Heading id={titleId} className="section-title">
				{title}
			</Heading>
			{/* Named for what it opens rather than for the section: "Servers"
			    would announce a button that performs no action. */}
			{help !== undefined ? (
				<Help text={help} name={l10n.t("Help: {0}", title)} {...(helpBelow === true ? { below: true } : {})} />
			) : null}
			{docs !== undefined ? <DocsLink href={docs.href} label={docs.label} /> : null}
			{meta !== undefined ? <span className="section-meta">{meta}</span> : null}
			{actions !== undefined ? <div className="section-actions">{actions}</div> : null}
		</div>
	);
}

export function Section({
	id,
	children,
	className,
	headerClassName,
	...header
}: Omit<SectionHeaderProps, "titleId" | "className"> & {
	/** Names the section: the element becomes `${id}-section` and its heading `${id}-title`. */
	id: string;
	children: ReactNode;
	className?: string | undefined;
	/** Reaches the header line, so a variant does not cost the caller the id contract. */
	headerClassName?: string | undefined;
}) {
	const titleId = `${id}-title`;
	return (
		// tabIndex -1 so an in-page jump can move focus here; never in the tab order.
		<section id={`${id}-section`} tabIndex={-1} aria-labelledby={titleId} className={cn("page-section", className)}>
			<SectionHeader titleId={titleId} className={headerClassName} {...header} />
			{children}
		</section>
	);
}
