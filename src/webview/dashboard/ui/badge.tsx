import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * The quiet chip beside names and counts. A soft fill rather than an outline: a row can
 * carry four at once, and four hairline boxes read as structure. The chip radius, not
 * the near-pill: the capsule is the toggles' shape, and a passive label wearing it read
 * as one more filter pill under forced colors - shape is a channel every palette
 * leaves alone.
 */
const badgeVariants = cva("inline-block whitespace-nowrap rounded-(--radius-chip) px-1.5 text-[0.85em]", {
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
