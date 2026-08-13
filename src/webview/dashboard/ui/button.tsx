import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * The dashboard's button. Two independent axes: `variant` is RANK - what kind
 * of action this is - and `size` is geometry. They were tangled before: a
 * "quiet" variant carried the muted color AND a smaller box, which meant an
 * icon-only destructive action had to choose between reading as destructive
 * and fitting its row. It also made two of the four variants identical in
 * color, so a Remove and an Edit were the same button with different labels.
 * Quiet was never a rank; it was `secondary` at `compact`, and says so now.
 *
 * Rank is carried by weight and color rather than by boxes: at rest every button is text, and the fill arrives under the cursor,
 * which is the one moment a text button has to prove it is a button. The
 * default rank takes the accent; danger takes a red wash instead of a red
 * word, so it warns as you reach for it rather than sitting in the layout as
 * a permanent alarm.
 *
 * Icons are the leading glyph rather than decoration - same size as the label,
 * colored with it - so a toolbar scans by shape while a table row stays quiet.
 *
 * The negative inline margin is deliberate: the hover pill needs padding to
 * exist, but the label has to line up with the text around it, so the padding
 * is handed back to the layout and only the fill overhangs.
 *
 * Two things the mockups could not show. High contrast outlines every control,
 * and a borderless button stops reading as one there, so --control-outline is
 * transparent everywhere and the contrast border in HC. And disabled keeps no
 * fill: when nothing is filled at rest, a disabled fill would be the loudest
 * thing on the row, so disabled reads through muted text and opacity alone.
 */
const buttonVariants = cva(
	"inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-sm border border-control-outline transition-[color,background-color,border-color,outline-color,opacity] duration-[120ms] ease-out focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid disabled:cursor-default disabled:bg-transparent disabled:text-disabled-foreground disabled:opacity-60",
	{
		variants: {
			variant: {
				default: "font-semibold text-accent-hue hover:bg-accent-soft",
				secondary: "text-muted-foreground hover:bg-ghost-hover hover:text-foreground",
				danger: "text-err-quiet hover:bg-err-wash hover:text-err-strong",
			},
			size: {
				default: "-mx-2.5 px-2.5 py-1",
				compact: "px-1.5 py-0.5",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	}
);

export function Button({
	className,
	variant,
	size,
	type,
	...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
	// data-slot and data-variant name the part and its design intent for
	// tests and inspection; the utility list alone says neither.
	return (
		<button
			type={type ?? "button"}
			data-slot="button"
			data-variant={variant ?? "default"}
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}
