/**
 * The dashboard's ONE hover-reveal idiom, extracted so it cannot fork again:
 * an action that rests hidden and appears when the pointer or focus reaches
 * its named group. It forked twice before this existed - the settings rows
 * spelled it with `invisible` (visibility drops the button from the tab
 * order, so a row with no other focusable control had unreachable actions)
 * and the heading jump spelled it with opacity but its own clause list.
 *
 * Opacity, never visibility: the button stays in the tab order so its OWN
 * focus can reveal it (the group-focus-within clause covers that). The
 * wrapper carries the opacity rather than the Button because Button's
 * disabled:opacity-60 would outrank a bare opacity-0 on the same element.
 * The @max-[560px]/pane clause keeps the action painted where hover does not
 * exist (touch, narrow panes), keyed to the stylesheet's 560px tier, and the
 * transition stands down under reduced motion.
 */

import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * The group scopes a reveal can join, spelled as whole literals because
 * Tailwind compiles only the variants it can read whole in the source.
 */
const REVEAL_WITHIN = {
	/** A settings row (`group/setting` on the row wrapper). */
	setting: "group-hover/setting:opacity-100 group-focus-within/setting:opacity-100",
	/** A header line (`group/head` on the section head). */
	head: "group-hover/head:opacity-100 group-focus-within/head:opacity-100",
	/** A list row (`group/row` on the row element - the models list's rows). */
	row: "group-hover/row:opacity-100 group-focus-within/row:opacity-100",
} as const;

export function Reveal({
	within,
	className,
	children,
}: {
	within: keyof typeof REVEAL_WITHIN;
	className?: string | undefined;
	children: ReactNode;
}) {
	return (
		<span
			className={cn(
				"inline-flex opacity-0 transition-opacity duration-[120ms] ease-out @max-[560px]/pane:opacity-100 motion-reduce:transition-none",
				REVEAL_WITHIN[within],
				className
			)}
		>
			{children}
		</span>
	);
}
