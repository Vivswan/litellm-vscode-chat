import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * A native radio with the theme's accent, the checkbox's twin: geometry and
 * the dot stay the platform widget's, the fill follows the host theme. Label
 * wiring stays at the call site (the forms wrap their radios in labels).
 */
export function Radio({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
	return (
		<input
			type="radio"
			data-slot="radio"
			className={cn(
				"accent-primary focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
				className
			)}
			{...props}
		/>
	);
}
