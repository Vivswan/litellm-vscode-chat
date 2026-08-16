import { IconChevronRight } from "../icons";
import { cn } from "./cn";

/**
 * The disclosure state mark every opening row shares. dashboard.css keys the turn off
 * the button's own aria-expanded, so the mark can never disagree with what the control
 * announces; decoration only, hidden from AT. `className` seats the mark in its grid
 * and stays the first class, which is how the row suites address the cells.
 */
export function DisclosureChevron({ className }: { className?: string }) {
	return (
		<span className={cn(className, "disclosure-chevron")} aria-hidden="true">
			<IconChevronRight />
		</span>
	);
}
