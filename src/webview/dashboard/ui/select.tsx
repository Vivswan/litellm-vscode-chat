import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * A native select on the VS Code dropdown tokens: the options popup stays the
 * platform widget, which is how the host's own dropdowns behave. The explicit
 * background also keeps the closed control from falling back to the native
 * light widget inside a dark theme.
 */
export function Select({ className, ...props }: ComponentProps<"select">) {
	return (
		<select
			data-slot="select"
			className={cn(
				"rounded-(--radius-field) border border-dropdown bg-dropdown-background px-1.5 py-[3px] text-dropdown-foreground focus:outline-1 focus:-outline-offset-1 focus:outline-ring focus:outline-solid",
				className
			)}
			{...props}
		/>
	);
}
