import { IconChevronRight } from "../icons";
import { cn } from "./cn";

/**
 * The disclosure state mark every row that opens shares: the server rows, the
 * model rows, and the hidden-groups line. Resting it points right, open it
 * points down - dashboard.css's .disclosure-chevron rules key the turn off
 * the disclosure button's own aria-expanded, so the mark can never disagree
 * with what the control announces. Decoration only (aria-expanded already
 * carries the state), so it is hidden from assistive tech. `className` seats
 * the mark in its surface's grid (.server-chevron, .model-chevron) and stays
 * the first class, which is how the row suites address the cells.
 */
export function DisclosureChevron({ className }: { className?: string }) {
	return (
		<span className={cn(className, "disclosure-chevron")} aria-hidden="true">
			<IconChevronRight />
		</span>
	);
}
