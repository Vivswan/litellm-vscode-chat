import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * A native checkbox with the theme's accent: geometry and checkmark stay the
 * platform widget's, the fill color follows the host theme. Label wiring stays
 * at the call site (the forms wrap their checkboxes in labels).
 *
 * m-0 because there is no preflight: Chrome's UA sheet gives a checkbox
 * `margin: 3px 3px 3px 4px`, which pushed every checkbox 4px right of the
 * column its siblings sit on. The reset lives on the primitive so every
 * checkbox on every page aligns, instead of each surface rediscovering the
 * UA margin with its own scoped rule.
 */
export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
	return (
		<input
			type="checkbox"
			data-slot="checkbox"
			className={cn(
				"m-0 accent-primary focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
				className
			)}
			{...props}
		/>
	);
}
