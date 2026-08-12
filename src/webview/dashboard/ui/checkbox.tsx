import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * A native checkbox with the theme's accent: geometry and checkmark stay the
 * platform widget's, the fill color follows the host theme. Label wiring stays
 * at the call site (the forms wrap their checkboxes in labels).
 */
export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
	return (
		<input
			type="checkbox"
			data-slot="checkbox"
			className={cn(
				"accent-primary focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
				className
			)}
			{...props}
		/>
	);
}
