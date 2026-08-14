/**
 * The page's one tooltip primitive, WCAG 1.4.13 shaped: hoverable (the pointer
 * can travel from the trigger onto the tip - the stylesheet's bridge keeps the
 * path contiguous and the tip is a child of the trigger element, so React's
 * enter/leave boundary treats trigger and tip as one surface), dismissible
 * (Escape hides the tip without moving focus, consuming the key on capture so
 * the page's bubble-phase Escape layering - panels, listboxes - never hears
 * it), and persistent (the tip stays while the pointer or keyboard focus
 * remains).
 *
 * Visibility is component state rather than CSS :hover, because :hover cannot
 * express dismissal. The bubble stays mounted while hidden so an
 * aria-describedby pointing at it always resolves, and it is aria-hidden:
 * accessible-name computation excludes hidden descendants from the trigger's
 * name-from-contents but still reads a node referenced by aria-describedby,
 * so the tip text is announced exactly once, as the description. A consumer
 * whose tip merely repeats the trigger's accessible name (the collapsed rail)
 * skips the describedby wiring and the text stays paint-only.
 *
 * Coordinates are measured, fixed-position: tips render inside scroll
 * containers (the tables' overflow boxes, the rail's own scrolling column)
 * whose edges clip any absolutely-positioned child, and position: fixed
 * escapes every ancestor clip. That makes one demand of the page: no ancestor
 * of a trigger may establish a containing block for fixed descendants - a
 * transform, filter, perspective, backdrop-filter, will-change of those, or
 * contain: layout/paint/strict - because every such ancestor re-bases these
 * viewport coordinates onto itself. The pane's `container-type: inline-size`
 * is NOT one of them (inline-size containment does not imply layout
 * containment), which is why the tables' tips land where they are placed. Anchoring the tip's bottom (or top, below) to
 * the trigger's edge keeps the tip's unknown height out of the arithmetic;
 * "beside" anchors x to the nearest [data-tip-edge] ancestor so a column of
 * controls of different widths shares one tip x. The horizontal clamp measures
 * the bubble, so a SHORT tip near the right edge stays against its trigger
 * instead of being pushed left by a worst-case width it does not have - which
 * would open a gap no pointer could cross, and hoverability is the point.
 * A shown tip re-measures on window resize and on any scroll (capture, so
 * every scroll container counts): both move the trigger under a pointer or
 * focus that never fires another event of its own.
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
 * Reveal on keyboard focus but not on a pointer's click focus: a mouse user
 * already has hover, and a tip popping on every click reads as noise. An
 * engine without the selector falls back to revealing on any focus - the
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
 * The tip's box width for the horizontal clamp. The measured width once the
 * bubble has been laid out, and the worst case until then: the first reveal
 * measures before the bubble is displayed (it is display:none while closed, so
 * it has no width yet), and a tip that starts one clamp too far left and
 * corrects before paint is better than one that starts off-screen.
 * The worst case is the full box - 320px max-width plus 20px of padding, 2px
 * of border, and an 8px viewport margin.
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
 * `enabled` is for triggers whose tip only exists in one layout (the rail's
 * collapsed width): while false the tip never opens, so a hover or focus
 * cannot leave an invisible tip holding the page's Escape key. Hover and
 * focus are still tracked, so flipping enabled with the pointer already on
 * the trigger reveals the tip it was owed.
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
		// Only the anchor: the layout effect below places it in the same
		// pre-paint frame, and it is the pass that can measure a displayed
		// bubble. Placing here too would be one forced layout per hover for a
		// value that is overwritten - including on triggers whose tip is
		// disabled and will never open.
		anchor.current = trigger;
	};

	// Layout effect, not effect: this runs with the bubble already displayed,
	// so it is the pass whose clamp can measure a real width - and it lands
	// before paint, so neither that correction nor the enabled-flip reveal
	// (which no handler measured) shows a frame at the wrong coordinates.
	useLayoutEffect(() => {
		if (!open) {
			return undefined;
		}
		place();
		// Dismissal must not require focus: 1.4.13's Escape has to work while the
		// pointer rests on a trigger and focus sits anywhere else, so the
		// listener lives on the window rather than the trigger. Capture-phase,
		// and it swallows the event outright: this page's Escape policy is
		// bubble-phase layering where the innermost surface consumes the key
		// (slideOver.tsx declines Radix's document-capture Escape for that), and
		// an open tip is the innermost surface there is - one press peels the
		// tip, the next reaches the panel. stopPropagation still lets every
		// other open tip's own window listener run, so all tips close together.
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
