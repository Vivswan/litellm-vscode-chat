import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * The quiet chip beside names and counts (auth kind, "external", "declared",
 * inactive notices). A soft fill rather than an outline: a server row can carry
 * four of these at once, and four hairline boxes read as structure the row does
 * not have, while a wash of the same color the rest of the dashboard uses for
 * severity reads as one texture.
 *
 * The chip radius, not the near-pill: rounded-sm is the --radius-chip
 * arithmetic, and the capsule is the toggles' shape - a passive label wearing
 * it read as one more filter pill the moment forced colors flattened the fill
 * (the old rounded-xl sat within a pixel of the pill radius, a difference that
 * distinguished nothing). Shape is a channel every palette leaves alone.
 */
const badgeVariants = cva("inline-block whitespace-nowrap rounded-sm px-1.5 text-[0.85em]", {
	variants: {
		variant: {
			default: "bg-chip text-muted-foreground",
			warn: "bg-warn-chip text-warn-chip-foreground",
		},
	},
	defaultVariants: {
		variant: "default",
	},
});

export function Badge({ className, variant, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	return (
		<span
			data-slot="badge"
			data-variant={variant ?? "default"}
			className={cn(badgeVariants({ variant }), className)}
			{...props}
		/>
	);
}
