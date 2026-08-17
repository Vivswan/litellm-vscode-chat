import { afterEach, expect, test } from "bun:test";
import { shouldFlipAbove, watchPopoverFlip } from "../../../../../webview/dashboard/ui/popoverFlip";

/**
 * The flip decision's pure cases, and the watcher's lifecycle with stubbed
 * layout. The oscillation-free property (the decision reads where the popover
 * WOULD hang below, so a flipped popover stays flipped) is pinned end to end
 * by recordEditors.test.tsx's PopoverShell suite and in a real viewport by the
 * record-popover-flip render fixture.
 */

test("shouldFlipAbove: fits below stays below, overflow flips only when above has more room", () => {
	// Plenty of room below: no flip.
	expect(shouldFlipAbove({ hostTop: 100, hostBottom: 140, popoverHeight: 120, gapPx: 4, viewportHeight: 600 })).toBe(
		false
	);
	// Would overflow below and above is roomier: flip.
	expect(shouldFlipAbove({ hostTop: 500, hostBottom: 540, popoverHeight: 120, gapPx: 4, viewportHeight: 600 })).toBe(
		true
	);
	// Overflows below but above is even tighter: stay below (flipping just
	// moves the clipped part).
	expect(shouldFlipAbove({ hostTop: 20, hostBottom: 60, popoverHeight: 590, gapPx: 4, viewportHeight: 600 })).toBe(
		false
	);
	// Exactly fitting below (bottom-if-below equals the viewport edge) is not
	// an overflow.
	expect(shouldFlipAbove({ hostTop: 400, hostBottom: 476, popoverHeight: 120, gapPx: 4, viewportHeight: 600 })).toBe(
		false
	);
});

const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
const heightDescriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");

afterEach(() => {
	if (observerDescriptor !== undefined) {
		Object.defineProperty(globalThis, "ResizeObserver", observerDescriptor);
	}
	if (heightDescriptor !== undefined) {
		Object.defineProperty(window, "innerHeight", heightDescriptor);
	}
});

test("watchPopoverFlip measures immediately, re-measures on its triggers, and unsubscribes whole", () => {
	const observed: Element[] = [];
	let disconnects = 0;
	let fire: (() => void) | undefined;
	globalThis.ResizeObserver = class {
		constructor(callback: () => void) {
			fire = callback;
		}
		observe(target: Element) {
			observed.push(target);
		}
		disconnect() {
			disconnects += 1;
		}
		unobserve() {
			// watchPopoverFlip never unobserves; disconnect covers teardown.
		}
	} as unknown as typeof ResizeObserver;
	Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });

	const host = document.createElement("div");
	const popover = document.createElement("div");
	host.appendChild(popover);
	document.body.appendChild(host);
	Object.defineProperty(popover, "offsetParent", { configurable: true, get: () => host });
	host.getBoundingClientRect = () => ({ top: 500, bottom: 540 }) as DOMRect;
	popover.getBoundingClientRect = () => ({ height: 120 }) as DOMRect;

	const verdicts: boolean[] = [];
	const stop = watchPopoverFlip(popover, 4, (above) => verdicts.push(above));
	// The immediate measurement, before any trigger.
	expect(verdicts).toEqual([true]);
	expect(observed).toEqual([popover]);

	// A resize trigger re-measures; more room below now, so the verdict drops.
	host.getBoundingClientRect = () => ({ top: 100, bottom: 140 }) as DOMRect;
	window.dispatchEvent(new Event("resize"));
	expect(verdicts).toEqual([true, false]);

	// The ResizeObserver trigger re-measures too.
	host.getBoundingClientRect = () => ({ top: 500, bottom: 540 }) as DOMRect;
	fire?.();
	expect(verdicts).toEqual([true, false, true]);

	// The capture-phase scroll leg, driven from a DESCENDANT scrollport: scroll
	// does not bubble, and the server form's panel scrolls itself, so only the
	// capture listener on window ever sees this event - a bubble-phase listener
	// (or no listener) would miss it and fail this expectation, which is what
	// makes the capture phase load-bearing here.
	host.getBoundingClientRect = () => ({ top: 100, bottom: 140 }) as DOMRect;
	host.dispatchEvent(new Event("scroll", { bubbles: false }));
	expect(verdicts).toEqual([true, false, true, false]);

	// After the unsubscribe nothing measures: no listener, no observer.
	stop();
	expect(disconnects).toBe(1);
	window.dispatchEvent(new Event("resize"));
	window.dispatchEvent(new Event("scroll"));
	host.dispatchEvent(new Event("scroll", { bubbles: false }));
	expect(verdicts).toEqual([true, false, true, false]);
	host.remove();
});

test("watchPopoverFlip without an offsetParent keeps watching and reports nothing", () => {
	// happy-dom's own default: no offsetParent means no measurement, never an
	// exception and never a stale verdict.
	globalThis.ResizeObserver = class {
		observe() {}
		disconnect() {}
		unobserve() {}
	} as unknown as typeof ResizeObserver;
	const popover = document.createElement("div");
	document.body.appendChild(popover);
	const verdicts: boolean[] = [];
	const stop = watchPopoverFlip(popover, 4, (above) => verdicts.push(above));
	window.dispatchEvent(new Event("resize"));
	expect(verdicts).toEqual([]);
	stop();
	popover.remove();
});
