/**
 * The above/below flip for an anchored popover, extracted so the decision is a
 * pure function and the subscription a testable unit. The popover flips above
 * its anchor rather than hang past the viewport's bottom edge.
 */

/** Everything the flip decision reads, as plain numbers so tests need no layout. */
export interface FlipMeasurement {
	/** The anchor box's viewport top edge (the box the CSS positions against). */
	readonly hostTop: number;
	/** The anchor box's viewport bottom edge. */
	readonly hostBottom: number;
	/** The popover's own rendered height. */
	readonly popoverHeight: number;
	/** The offset the stylesheet leaves between popover and anchor, either side. */
	readonly gapPx: number;
	readonly viewportHeight: number;
}

/**
 * Whether the popover belongs ABOVE its anchor. Judged from where it WOULD end
 * up hanging below, not where it sits now: a flipped popover no longer
 * overflows, so measuring its current bottom would clear the flip the instant
 * it worked and leave the popover flicking over the edge and back on every
 * change. And only when there is more room the other way: flipping something
 * that overflows both edges just moves the clipped part.
 */
export function shouldFlipAbove(measured: FlipMeasurement): boolean {
	const bottomIfBelow = measured.hostBottom + measured.gapPx + measured.popoverHeight;
	return bottomIfBelow > measured.viewportHeight && measured.hostTop > measured.viewportHeight - measured.hostBottom;
}

/**
 * Measure now and on every change that can move `popover` relative to the viewport bottom.
 * Three things move it and none implies the others.
 * Its own content resizes, the reader scrolls, and the window resizes under all of it.
 * The scroll listener is in capture, because the server form's panel is its own scrollport.
 * That panel's scroll does not bubble.
 * The anchor is the popover's offsetParent, the box the CSS positions against.
 * Flipping therefore moves the popover to exactly its top edge.
 * Under happy-dom there is no offsetParent, a reason to measure nothing, not to stop watching.
 */
export function watchPopoverFlip(popover: HTMLElement, gapPx: number, onVerdict: (above: boolean) => void): () => void {
	const measure = () => {
		const host = popover.offsetParent;
		if (!(host instanceof HTMLElement)) {
			return;
		}
		const hostRect = host.getBoundingClientRect();
		const rect = popover.getBoundingClientRect();
		onVerdict(
			shouldFlipAbove({
				hostTop: hostRect.top,
				hostBottom: hostRect.bottom,
				popoverHeight: rect.height,
				gapPx,
				viewportHeight: window.innerHeight,
			})
		);
	};
	measure();
	const observer = new ResizeObserver(measure);
	observer.observe(popover);
	window.addEventListener("scroll", measure, { capture: true, passive: true });
	window.addEventListener("resize", measure, { passive: true });
	return () => {
		observer.disconnect();
		window.removeEventListener("scroll", measure, { capture: true });
		window.removeEventListener("resize", measure);
	};
}
