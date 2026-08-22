import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * The dashboard's textarea on the same VS Code input tokens as Input, so the
 * multiline fields (commit prompt, declared models, the record editors' JSON
 * side doors) share ONE chrome instead of four copies; validation state rides
 * aria-invalid like the Input's.
 */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"rounded-(--radius-field) border border-input bg-input-background px-1.5 py-[3px] text-input-foreground placeholder:text-input-placeholder focus:outline-(length:--ring-w) focus:outline-offset-(--ring-offset-inset) focus:outline-ring focus:outline-solid aria-invalid:border-input-invalid",
				className
			)}
			{...props}
		/>
	);
}
