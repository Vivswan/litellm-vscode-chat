import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

/** The quiet outline chip beside names and counts (auth kind, "external", "declared", inactive notices). */
const badgeVariants = cva(
	"inline-block whitespace-nowrap rounded-xl border border-border bg-transparent px-1.5 text-[0.85em]",
	{
		variants: {
			variant: {
				default: "text-muted-foreground",
				warn: "text-warning",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	}
);

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
