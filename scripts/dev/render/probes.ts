/**
 * What the harness proves about a rendered page: the sideways-overflow
 * assertions (and their below-floor inverse), the pane-width search, and the
 * contrast probe.
 */
import { OVERFLOW_SIDEWAYS_MARKER } from "../overflowMarkers.ts";
import { type CdpConnection, evaluate, setWidth } from "./chrome.ts";

/**
 * Where a --pane-widths search starts, from each side of the rail's collapse.
 * Starting points only - the search corrects itself from what it measures.
 */
const NARROW_PROBE_WIDTH = 320;

const WIDE_PROBE_WIDTH = 1920;

/**
 * The page-level number is the whole claim, and the names under it are a diagnostic.
 * The two questions fail in opposite directions.
 * Boxes past the edge miss an unbreakable text run inside a block that stays in bounds.
 * Boxes overflowing THEMSELVES catch that run.
 * They also catch the min-width ancestor the deepest-offender filter drops.
 * The probe skips anything inside a scroller.
 * A deliberate overflow-x adds nothing to the document's own scroll.
 */
const OVERFLOW_PROBE = `(() => {
	const root = document.documentElement;
	const overflow = root.scrollWidth - root.clientWidth;
	if (overflow <= 0) {
		return null;
	}
	const scrolls = (node) => getComputedStyle(node).overflowX !== "visible";
	const inScroller = (node) => {
		for (let parent = node.parentElement; parent !== null && parent !== root; parent = parent.parentElement) {
			if (scrolls(parent)) {
				return true;
			}
		}
		return false;
	};
	const limit = root.clientWidth + 0.5;
	const past = [];
	const spilling = [];
	for (const node of document.querySelectorAll("body *")) {
		if (inScroller(node)) {
			continue;
		}
		const rect = node.getBoundingClientRect();
		if (rect.width > 0 && rect.right > limit) {
			past.push(node);
		}
		if (!scrolls(node) && node.scrollWidth - node.clientWidth > 0.5) {
			spilling.push(node);
		}
	}
	const name = (node, why) => {
		const classes = typeof node.className === "string" ? node.className.trim().split(/\\s+/).slice(0, 2) : [];
		const tag = node.tagName.toLowerCase() + (classes.length > 0 ? "." + classes.join(".") : "");
		return why === "past"
			? tag + " reaches to " + Math.round(node.getBoundingClientRect().right)
			: tag + " holds " + Math.round(node.scrollWidth - node.clientWidth) + "px it cannot show";
	};
	const deepest = past.filter((node) => !past.some((other) => other !== node && node.contains(other)));
	const culprits = [
		...deepest.slice(0, 4).map((node) => name(node, "past")),
		...spilling.slice(0, 4).map((node) => name(node, "spilling")),
	];
	return JSON.stringify({ overflow, clientWidth: root.clientWidth, culprits });
})()`;

/** Throws when the page scrolls sideways at the width it is currently set to. */
export async function assertNoHorizontalOverflow(cdp: CdpConnection, width: number): Promise<void> {
	const found = (await evaluate(cdp, OVERFLOW_PROBE)) as string | null;
	if (found === null) {
		return;
	}
	const { overflow, clientWidth, culprits } = JSON.parse(found) as {
		overflow: number;
		clientWidth: number;
		culprits: readonly string[];
	};
	// The marker is the machine channel check-overflow greps; the prose after
	// it is for humans and free to change.
	throw new Error(
		`${OVERFLOW_SIDEWAYS_MARKER} The page scrolls sideways at ${width}px: ` +
			`${overflow}px past a ${clientWidth}px viewport.\n  ${culprits.join("\n  ")}`
	);
}

/**
 * The belowFloor inversion: proves the width really sits under the shell's own
 * min-width floor, and that the sideways scroll is PRESENT - the state such a
 * fixture exists to photograph. A page that fits here means the floor moved or
 * the width was mistyped, and the fixture would guard a state not on screen.
 */
export async function assertBelowFloorSideways(cdp: CdpConnection, width: number): Promise<void> {
	const floor = (await evaluate(
		cdp,
		`(() => {
			const shell = document.querySelector(".shell");
			return shell === null ? null : parseFloat(getComputedStyle(shell).minWidth) || null;
		})()`
	)) as number | null;
	if (floor === null) {
		throw new Error("belowFloor: no .shell min-width to compare against; the floor this fixture undercuts is gone");
	}
	if (width >= floor) {
		throw new Error(
			`belowFloor: ${width}px is not under the shell's ${floor}px floor; re-point the fixture's viewport`
		);
	}
	const found = (await evaluate(cdp, OVERFLOW_PROBE)) as string | null;
	if (found === null) {
		throw new Error(
			`belowFloor: the page fits at ${width}px, under the ${floor}px floor where it scrolls sideways by design;` +
				" the below-floor scrollbar state this fixture guards is not on screen"
		);
	}
	// Bounded, not merely present: below the floor the shell's min-width is the
	// document's only legitimate widener, so a document wider than the floor
	// itself is a real overflow bug hiding behind the designed one - and it
	// carries the sideways marker, so the sweep counts it as a page that does
	// not fit rather than a fixture that never ran.
	const wide = (await evaluate(cdp, "document.documentElement.scrollWidth")) as number;
	if (wide > floor + 0.5) {
		throw new Error(
			`${OVERFLOW_SIDEWAYS_MARKER} belowFloor: the document measures ${wide}px, past the ${floor}px floor that` +
				" is the only designed overflow at this width; something overflows on its own"
		);
	}
}

/**
 * The pane's width as its container queries see it: the CONTENT box.
 * `container-type: inline-size` asks about the content box and the pane holds
 * 24px of padding on each side, so a border-box measurement would aim every
 * sweep 48px away from the breakpoint it meant to test.
 */
async function measurePane(cdp: CdpConnection): Promise<number> {
	const measured = await evaluate(
		cdp,
		`(() => {
			const pane = document.querySelector(".pane");
			if (pane === null) {
				return 0;
			}
			const style = getComputedStyle(pane);
			return Math.round(pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
		})()`
	);
	return typeof measured === "number" ? measured : 0;
}

/**
 * The breakpoints are container queries on the pane, not on the window.
 * A window set to a pane threshold therefore tests a width no breakpoint cares about.
 * Each target is SOLVED (set, measure, correct, repeat) rather than modelled from the layout.
 * The relation has slope one where uncapped, so it converges in a step or two.
 * Where capped or discontinuous it fails to converge, and the run reports that.
 * The rail's collapse takes about 170px of the offset with it, hiding some pane widths.
 * Solving from both ends reaches the widths only one side can produce.
 */
export async function windowWidthsForPanes(
	cdp: CdpConnection,
	panes: readonly number[],
	height: number,
	dpr: number
): Promise<{ readonly pane: number; readonly window: number; readonly landed: boolean }[]> {
	const resolved: { pane: number; window: number; landed: boolean }[] = [];
	for (const pane of panes) {
		const found = new Set<number>();
		for (const start of [NARROW_PROBE_WIDTH, WIDE_PROBE_WIDTH]) {
			let candidate = start;
			for (let attempt = 0; attempt < 5; attempt++) {
				await setWidth(cdp, candidate, height, dpr);
				const measured = await measurePane(cdp);
				if (measured === pane) {
					found.add(candidate);
					break;
				}
				const next = candidate + (pane - measured);
				if (next < 1 || next === candidate) {
					break;
				}
				candidate = next;
			}
		}
		for (const window of found) {
			resolved.push({ pane, window, landed: true });
		}
		if (found.size === 0) {
			resolved.push({ pane, window: 0, landed: false });
		}
	}
	return resolved;
}

/**
 * The in-page WCAG contrast probe behind --contrast: reads the element's
 * computed color and its EFFECTIVE background, compositing translucent
 * backgrounds up the ancestor chain until an opaque one. Colors are normalized
 * through a 1x1 canvas rather than a regex, because the theme derives its tones
 * with color-mix in oklab and a parser that only speaks rgb() would fail on
 * exactly those. Anything the probe cannot honestly composite is an error, not
 * a guess. One stated non-claim: pseudo-element overlays are invisible to every
 * element scan, so the occlusion guarantee covers elements only.
 */
export function contrastProbe(selector: string): string {
	return `(() => {
		const node = document.querySelector(${JSON.stringify(selector)});
		if (node === null) {
			return null;
		}
		const rect = node.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			return JSON.stringify({ error: "the element is zero-sized; nothing is painted" });
		}
		// visibility: hidden keeps its geometry, so the size check alone would
		// happily measure text no pixel shows. Computed visibility inherits, so
		// the node's own value covers a hidden ancestor too.
		if (getComputedStyle(node).visibility !== "visible") {
			return JSON.stringify({ error: "the element's computed visibility is not visible; nothing is painted" });
		}
		// The ancestor walk below sees only the element's OWN stacking context, so
		// a scrim or slide-over drawn over it is no ancestor. Hit-test the centre
		// instead: the point must be inside the viewport for hit-testing to see
		// it, and the top hit must be the element or something it contains.
		const probeX = rect.left + rect.width / 2;
		const probeY = rect.top + rect.height / 2;
		if (probeX < 0 || probeY < 0 || probeX >= window.innerWidth || probeY >= window.innerHeight) {
			return JSON.stringify({
				error:
					"the element's centre sits outside the viewport at (" + Math.round(probeX) + ", " + Math.round(probeY) +
					"), where hit-testing cannot see it; scroll it on screen or raise --height",
			});
		}
		const hit = document.elementFromPoint(probeX, probeY);
		if (hit !== node && (hit === null || !node.contains(hit))) {
			const describe = (candidate) => {
				if (candidate === null) { return "nothing"; }
				const classes = typeof candidate.className === "string" ? candidate.className.trim().split(/\\s+/) : [];
				return candidate.tagName.toLowerCase() + (classes[0] !== undefined && classes[0] !== "" ? "." + classes.slice(0, 2).join(".") : "");
			};
			return JSON.stringify({
				error:
					"the element is not the top hit at its own centre - " + describe(hit) +
					" covers it, and a ratio measured through an overlay would certify a contrast nobody sees",
			});
		}
		// Hit-testing is blind to pointer-events: none, and such an overlay can
		// still paint over the element. Over-reject on purpose rather than decide
		// whether it PAINTS: any such element overlapping the probe point that is
		// neither ancestor nor content fails, since an unprovable pixel is worth
		// less than no ratio. visibility: hidden and opacity: 0 are the only
		// exclusions, being proofs of not painting rather than guesses.
		for (const veil of document.querySelectorAll("*")) {
			const veilStyle = getComputedStyle(veil);
			if (veilStyle.pointerEvents !== "none") { continue; }
			if (veil === node || node.contains(veil) || veil.contains(node)) { continue; }
			if (veilStyle.visibility !== "visible" || Number(veilStyle.opacity) === 0) { continue; }
			const box = veil.getBoundingClientRect();
			if (probeX < box.left || probeX > box.right || probeY < box.top || probeY > box.bottom) { continue; }
			const classes = typeof veil.className === "string" ? veil.className.trim().split(/\\s+/) : [];
			return JSON.stringify({
				error:
					"a pointer-events-none element (" + veil.tagName.toLowerCase() +
					(classes[0] !== undefined && classes[0] !== "" ? "." + classes.slice(0, 2).join(".") : "") +
					") overlaps the probe point, where hit-testing cannot see it; the probe cannot prove whose pixel it measures",
			});
		}
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		const parse = (text) => {
			// An invalid color leaves fillStyle at its previous value, so parse
			// against two sentinels: only a real color lands on the same
			// serialization from both.
			context.fillStyle = "#000000";
			context.fillStyle = text;
			const fromBlack = context.fillStyle;
			context.fillStyle = "#ffffff";
			context.fillStyle = text;
			if (context.fillStyle !== fromBlack) {
				return null;
			}
			context.clearRect(0, 0, 1, 1);
			context.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
			return { r, g, b, a: a / 255 };
		};
		const layers = [];
		// Backgrounds are collected only until an opaque one, but the opacity
		// refusal runs on EVERY ancestor up to the root: opacity fades the whole
		// subtree, so a translucent ancestor above the opaque stop still changes
		// what the pixel shows.
		let opaqueFound = false;
		for (let element = node; element !== null; element = element.parentElement) {
			const style = getComputedStyle(element);
			if (Number(style.opacity) < 1) {
				return JSON.stringify({ error: element.tagName + " has opacity below 1; the probe cannot composite it" });
			}
			if (opaqueFound) {
				continue;
			}
			if (style.backgroundImage !== "none") {
				return JSON.stringify({ error: element.tagName + " paints a background-image; the probe cannot composite it" });
			}
			const background = parse(style.backgroundColor);
			if (background === null) {
				return JSON.stringify({ error: "unparseable background-color on " + element.tagName + ": " + style.backgroundColor });
			}
			if (background.a > 0) {
				layers.push(background);
			}
			if (background.a >= 1) {
				opaqueFound = true;
			}
		}
		// A stack still translucent at the root composites over the canvas default.
		if (layers.length === 0 || layers[layers.length - 1].a < 1) {
			layers.push({ r: 255, g: 255, b: 255, a: 1 });
		}
		const over = (top, bottom) => ({
			r: top.r * top.a + bottom.r * (1 - top.a),
			g: top.g * top.a + bottom.g * (1 - top.a),
			b: top.b * top.a + bottom.b * (1 - top.a),
			a: 1,
		});
		let background = layers[layers.length - 1];
		for (let i = layers.length - 2; i >= 0; i--) {
			background = over(layers[i], background);
		}
		const color = parse(getComputedStyle(node).color);
		if (color === null) {
			return JSON.stringify({ error: "unparseable color: " + getComputedStyle(node).color });
		}
		const foreground = color.a >= 1 ? { ...color } : over(color, background);
		const luminance = (paint) => {
			const channel = (value) => {
				const scaled = value / 255;
				return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
			};
			return 0.2126 * channel(paint.r) + 0.7152 * channel(paint.g) + 0.0722 * channel(paint.b);
		};
		const lighter = Math.max(luminance(foreground), luminance(background));
		const darker = Math.min(luminance(foreground), luminance(background));
		const show = (paint) => "rgb(" + Math.round(paint.r) + ", " + Math.round(paint.g) + ", " + Math.round(paint.b) + ")";
		return JSON.stringify({
			ratio: (lighter + 0.05) / (darker + 0.05),
			foreground: show(foreground),
			background: show(background),
		});
	})()`;
}
