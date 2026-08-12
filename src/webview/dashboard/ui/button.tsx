import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * The dashboard's button, shadcn-shaped on the VS Code token theme. The
 * variants carry the host's explicit state colors (--primary-hover and
 * friends), never shadcn's alpha-blend hovers, so every theme - high contrast
 * included - keeps its native palette.
 *
 * Disabled overrides every variant's fill and text with the neutral disabled
 * pair: Tailwind emits the disabled variants after the hover ones, so disabled
 * wins on a hovered disabled button without an enabled-gate. The hovers stay
 * plain `hover:` for the same reason a caller's `hover:text-error` must win -
 * tailwind-merge only collapses a caller's override against a variant's when
 * the two carry the same modifier.
 *
 * The transition names opacity alongside the colors because the row-hover
 * icon actions fade in on opacity; a bare transition-colors would drop that
 * legacy transition on the floor.
 */
const buttonVariants = cva(
	"inline-flex cursor-pointer items-center justify-center gap-1 rounded-sm border transition-[color,background-color,border-color,outline-color,opacity] duration-[120ms] ease-out focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid disabled:cursor-default disabled:bg-disabled disabled:text-disabled-foreground disabled:opacity-50",
	{
		variants: {
			variant: {
				default: "border-button-border bg-primary px-3 py-1 text-primary-foreground hover:bg-primary-hover",
				secondary: "border-button-border bg-secondary px-3 py-1 text-secondary-foreground hover:bg-secondary-hover",
				quiet:
					"border-transparent bg-transparent px-1.5 py-0.5 text-muted-foreground hover:bg-ghost-hover hover:text-foreground",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	}
);

export function Button({
	className,
	variant,
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
			className={cn(buttonVariants({ variant }), className)}
			{...props}
		/>
	);
}
