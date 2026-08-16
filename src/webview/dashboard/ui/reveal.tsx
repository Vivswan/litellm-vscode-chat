/**
 * The dashboard's ONE hover-reveal idiom, extracted so it cannot fork again. Opacity,
 * never visibility: the button stays in the tab order so its OWN focus can reveal it;
 * the wrapper carries the opacity because Button's disabled:opacity-60 would outrank a
 * bare opacity-0 on the same element. The @max-[560px]/pane clause keeps the action
 * painted where hover does not exist; the transition stands down under reduced motion.
 * The bordered modes refuse the quietness trade outright (every control's box draws at
 * rest, so a resting-invisible action is bare boxes flickering): those clauses live in
 * theme.css against the data-slot below, because opacity-0 is a utility and only an
 * unlayered rule reliably beats one; theme.test.ts pins them.
 */

import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * The group scopes a reveal can join, spelled as whole literals because Tailwind
 * compiles only variants it can read whole in the source.
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
			data-slot="reveal"
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
