import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * The quiet chip beside names and counts (auth kind, "external", "declared",
 * inactive notices). A soft fill rather than an outline: a server row can carry
 * four of these at once, and four hairline boxes read as structure the row does
 * not have, while a wash of the same color the rest of the dashboard uses for
 * severity reads as one texture.
 */
const badgeVariants = cva("inline-block whitespace-nowrap rounded-xl px-1.5 text-[0.85em]", {
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
