import type { ComponentProps } from "react";
import { cn } from "./cn";

/** The dashboard's text-ish input on the VS Code input tokens; validation state rides aria-invalid. */
export function Input({ className, ...props }: ComponentProps<"input">) {
	return (
		<input
			data-slot="input"
			className={cn(
				"rounded-sm border border-input bg-input-background px-1.5 py-[3px] text-input-foreground placeholder:text-input-placeholder focus:outline-1 focus:-outline-offset-1 focus:outline-ring focus:outline-solid aria-invalid:border-input-invalid",
				className
			)}
			{...props}
		/>
	);
}
