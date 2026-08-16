/**
 * The page's one tooltip primitive, WCAG 1.4.13 shaped: hoverable (the tip is a child of
 * the trigger, so React treats the two as one surface), dismissible (Escape on capture,
 * so the page's bubble-phase Escape layering never hears it), persistent. Component
 * state, not :hover - :hover cannot express dismissal; the bubble stays mounted while
 * hidden so aria-describedby always resolves, and aria-hidden keeps the text out of the
 * trigger's name while the description still reads it (announced exactly once). A tip
 * that repeats the trigger's name skips the describedby and stays paint-only.
 * Coordinates are measured, position: fixed - it escapes every ancestor clip, at one
 * price: no ancestor of a trigger may establish a containing block for fixed
 * descendants (transform, filter, contain: layout/paint...); the pane's container-type:
 * inline-size is NOT one. Anchoring to the trigger's edge keeps the tip's unknown
 * height out of the arithmetic; "beside" anchors x to the nearest [data-tip-edge]
 * ancestor. The horizontal clamp measures the bubble, so a SHORT tip stays against its
 * trigger (a worst-case clamp would open a gap no pointer could cross). A shown tip
 * re-measures on resize and any capture-phase scroll.
 */

import type { CSSProperties, FocusEvent, MouseEvent, ReactNode, RefObject } from "react";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";

export type TipPlacement = "above" | "below" | "beside";

export interface TipHandle {
	/** The bubble's element id; point aria-describedby here when the tip describes its trigger. */
	readonly id: string;
	readonly open: boolean;
	readonly placement: TipPlacement;
	readonly style: CSSProperties | undefined;
	/** Attached by TipBubble, so the clamp can measure the box it is placing. */
	readonly bubbleRef: RefObject<HTMLElement | null>;
	/** Spread onto the element whose hover and focus own the tip; the bubble renders inside it. */
	readonly triggerProps: {
		readonly onMouseEnter: (event: MouseEvent<HTMLElement>) => void;
		readonly onMouseLeave: () => void;
		readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
		readonly onBlur: () => void;
	};
}

/**
 * Reveal on keyboard focus but not a pointer's click focus (a tip popping on every
 * click is noise); an engine without the selector reveals on any focus - the
 * accessible direction to fail in.
 */
function focusRevealed(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) {
		return false;
	}
	try {
		return target.matches(":focus-visible");
	} catch {
		return true;
	}
}

/**
 * The tip's box width for the clamp: measured once laid out, the worst case until then
 * (the bubble is display:none while closed, so it has no width on first reveal); a tip
 * that starts one clamp too far left and corrects before paint beats one off-screen.
 */
const WORST_CASE_TIP_BOX = 350;

function tipBox(bubble: HTMLElement | null): number {
	const measured = bubble?.offsetWidth ?? 0;
	return measured > 0 ? measured + 8 : WORST_CASE_TIP_BOX;
}

function coordinates(trigger: HTMLElement, placement: TipPlacement, bubble: HTMLElement | null): CSSProperties {
	const rect = trigger.getBoundingClientRect();
	if (placement === "beside") {
		// x from the shared edge, y from the control: measured from each
		// control's own right edge, a column of tips steps in and out as the
		// pointer moves down controls of different widths.
		const edge = trigger.closest("[data-tip-edge]")?.getBoundingClientRect().right ?? rect.right;
		return { left: `${edge + 8}px`, top: `${rect.top + rect.height / 2}px` };
	}
	const left = Math.max(8, Math.min(rect.left - 8, window.innerWidth - tipBox(bubble)));
	if (placement === "below") {
		return { left: `${left}px`, top: `${rect.bottom + 6}px` };
	}
	return { left: `${left}px`, bottom: `${window.innerHeight - rect.top + 6}px` };
}

/**
 * `enabled` is for triggers whose tip only exists in one layout: while false the tip
 * never opens, so it cannot hold the page's Escape key invisibly. Hover and focus are
 * still tracked, so flipping enabled with the pointer already there reveals the tip.
 */
export function useTip(placement: TipPlacement, enabled = true): TipHandle {
	const id = useId();
	const [shown, setShown] = useState({ hover: false, focus: false });
	const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
	// The control the coordinates belong to, kept across close/open so a tip
	// revealed WITHOUT a fresh pointer or focus event (a hover held across the
	// rail's collapse, where `enabled` flips true) still has a box to measure.
	const anchor = useRef<HTMLElement | null>(null);
	const bubbleRef = useRef<HTMLElement | null>(null);
	const open = enabled && (shown.hover || shown.focus);

	const place = useCallback(() => {
		if (anchor.current !== null) {
			setStyle(coordinates(anchor.current, placement, bubbleRef.current));
		}
	}, [placement]);

	const measure = (trigger: HTMLElement) => {
		// Only the anchor: the layout effect places it in the same pre-paint frame and can
		// measure a displayed bubble; placing here too would be one forced layout per hover.
		anchor.current = trigger;
	};

	// Layout effect, not effect: it runs with the bubble displayed (a measurable width) and
	// lands before paint, so no frame shows at the wrong coordinates.
	useLayoutEffect(() => {
		if (!open) {
			return undefined;
		}
		place();
		// Dismissal must not require focus (1.4.13), so the listener lives on the window.
		// Capture-phase and swallows the event: an open tip is the innermost surface of the
		// page's bubble-phase Escape layering - one press peels the tip, the next reaches the
		// panel. stopPropagation still lets every other tip's window listener run.
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setShown({ hover: false, focus: false });
			}
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		window.addEventListener("resize", place);
		// Capture, because scroll does not bubble: a wheel scroll that keeps the
		// pointer on one trigger fires no boundary event, and the tip is fixed
		// while the row under it moves - inside a table's scrollport or a panel.
		window.addEventListener("scroll", place, { capture: true });
		return () => {
			window.removeEventListener("keydown", onKeyDown, { capture: true });
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, { capture: true });
		};
	}, [open, place]);

	return {
		id,
		open,
		placement,
		style,
		bubbleRef,
		triggerProps: {
			onMouseEnter: (event: MouseEvent<HTMLElement>) => {
				measure(event.currentTarget);
				setShown((state) => ({ ...state, hover: true }));
			},
			onMouseLeave: () => {
				setShown((state) => ({ ...state, hover: false }));
			},
			onFocus: (event: FocusEvent<HTMLElement>) => {
				if (focusRevealed(event.target)) {
					measure(event.currentTarget);
					setShown((state) => ({ ...state, focus: true }));
				}
			},
			onBlur: () => {
				setShown((state) => ({ ...state, focus: false }));
			},
		},
	};
}

/** The tip's bubble; render it inside the element carrying the handle's triggerProps. */
export function TipBubble({ tip, children }: { tip: TipHandle; children: ReactNode }) {
	return (
		<span
			className="tip-bubble"
			ref={tip.bubbleRef as RefObject<HTMLSpanElement | null>}
			role="tooltip"
			id={tip.id}
			aria-hidden="true"
			data-placement={tip.placement}
			data-open={tip.open ? "true" : undefined}
			style={tip.style}
			// Hoverable means clickable-by-accident: the bubble sits inside its
			// trigger, and a reader selecting the tip's text must not press the
			// button underneath.
			onClick={(event) => event.stopPropagation()}
		>
			{children}
		</span>
	);
}
