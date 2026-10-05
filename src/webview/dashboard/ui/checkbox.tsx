import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * A native checkbox with the theme's accent: geometry and checkmark stay the platform widget's, the fill color follows
 * the host theme. The UA-margin reset lives in theme.css's base layer with the other preflight-lite rules.
 *
 *   the forms wrap their checkboxes in labels -> Label wiring stays at the call site
 */
export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
	return (
		<input
			type="checkbox"
			data-slot="checkbox"
			className={cn(
				"accent-primary focus-visible:outline-(length:--ring-w) focus-visible:outline-offset-(--ring-offset) focus-visible:outline-ring focus-visible:outline-solid",
				className
			)}
			{...props}
		/>
	);
}
