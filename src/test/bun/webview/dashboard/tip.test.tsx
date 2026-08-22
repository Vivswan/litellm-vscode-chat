/**
 * The tip primitive's WCAG 1.4.13 contract: hoverable, dismissible by Escape without moving focus (claiming
 * the key), persistent while pointer or focus holds it, plus the description wiring. happy-dom computes no
 * cascade, so these read data-open and inline coordinates.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { App } from "../../../../webview/dashboard/app";
import { Help, HoverTip } from "../../../../webview/dashboard/help";
import { TipBubble, useTip } from "../../../../webview/dashboard/ui/tip";
import { makeDeclaredServer, makeModel, makeState, statePush } from "../fixtures";
import {
	cleanup,
	fireBlur,
	fireClick,
	fireFocus,
	fireMouseEnter,
	fireMouseLeave,
	mount,
	pushToWebview,
	render,
	resetPosted,
	setViewport,
	stubBoundingRect,
} from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
	// happy-dom's default; the rail tests below collapse the window.
	setViewport(1024, 768);
});

function mountHoverTip(): { wrap: HTMLElement; bubble: HTMLElement } {
	const root = mount(
		<HoverTip tip="The whole story behind the badge">
			<span>badge</span>
		</HoverTip>
	);
	const wrap = root.querySelector(".tip-wrap") as HTMLElement;
	const bubble = root.querySelector(".tip-bubble") as HTMLElement;
	expect(wrap).not.toBeNull();
	expect(bubble).not.toBeNull();
	return { wrap, bubble };
}

const isOpen = (bubble: HTMLElement) => bubble.getAttribute("data-open") === "true";

function pressEscape(): { claimed: boolean } {
	let notPrevented = true;
	void act(() => {
		notPrevented = document.body.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
		);
	});
	return { claimed: !notPrevented };
}

test("hoverable: the pointer can travel from the trigger onto the tip without the tip closing", () => {
	const { wrap, bubble } = mountHoverTip();
	expect(isOpen(bubble)).toBe(false);

	fireMouseEnter(wrap);
	expect(isOpen(bubble)).toBe(true);

	// Pointer moves off the trigger content onto the bubble itself: the bubble
	// is a descendant of the hover boundary, so no leave is synthesized and
	// the tip persists - the reader can hover the text to select or magnify it.
	fireMouseLeave(wrap, bubble);
	expect(isOpen(bubble)).toBe(true);

	// Leaving the bubble outward is a real departure and closes the tip.
	fireMouseLeave(bubble);
	expect(isOpen(bubble)).toBe(false);
});

test("dismissible: Escape hides a hover-shown tip without moving focus, and consumes the key", () => {
	const { wrap, bubble } = mountHoverTip();
	// Focus rests somewhere unrelated: dismissal must not require focusing the tip.
	const outside = document.createElement("button");
	document.body.appendChild(outside);
	void act(() => {
		outside.focus();
	});

	fireMouseEnter(wrap);
	expect(isOpen(bubble)).toBe(true);

	// The page's Escape layers are bubble-phase and none re-check
	// defaultPrevented, so the tip must swallow the event first; this listener
	// stands in for them and must stay unheard.
	let heardBelow = 0;
	const below = () => {
		heardBelow += 1;
	};
	document.addEventListener("keydown", below);
	const { claimed } = pressEscape();
	document.removeEventListener("keydown", below);

	expect(isOpen(bubble)).toBe(false);
	expect(document.activeElement).toBe(outside);
	expect(claimed).toBe(true);
	expect(heardBelow).toBe(0);

	// Escape with nothing shown claims nothing and reaches the layers below.
	document.addEventListener("keydown", below);
	expect(pressEscape().claimed).toBe(false);
	document.removeEventListener("keydown", below);
	expect(heardBelow).toBe(1);

	// A fresh hover is fresh intent: leaving and returning re-reveals.
	fireMouseLeave(wrap);
	fireMouseEnter(wrap);
	expect(isOpen(bubble)).toBe(true);
	outside.remove();
});

test("focus-visible reveal: keyboard focus shows the tip, Escape dismisses in place, blur closes", () => {
	const { wrap, bubble } = mountHoverTip();
	void act(() => {
		wrap.focus();
	});
	expect(document.activeElement).toBe(wrap);
	expect(isOpen(bubble)).toBe(true);

	// Escape hides the tip and focus stays exactly where it was.
	pressEscape();
	expect(isOpen(bubble)).toBe(false);
	expect(document.activeElement).toBe(wrap);

	// Persistent until focus moves: refocusing reveals again, blur closes.
	fireFocus(wrap);
	expect(isOpen(bubble)).toBe(true);
	void act(() => {
		wrap.blur();
	});
	fireBlur(wrap);
	expect(isOpen(bubble)).toBe(false);
});

test("persistent: the tip stays open while pointer and focus each hold it, closing only when both let go", () => {
	const { wrap, bubble } = mountHoverTip();
	fireMouseEnter(wrap);
	void act(() => {
		wrap.focus();
	});
	expect(isOpen(bubble)).toBe(true);

	// The pointer leaves while focus remains: still shown.
	fireMouseLeave(wrap);
	expect(isOpen(bubble)).toBe(true);

	// Focus leaves too: closed.
	void act(() => {
		wrap.blur();
	});
	fireBlur(wrap);
	expect(isOpen(bubble)).toBe(false);
});

test("the visible tip text is the trigger's accessible description, not a duplicate announcement", () => {
	const { wrap, bubble } = mountHoverTip();
	// aria-describedby points at the bubble, whose aria-hidden keeps the text
	// out of the wrapper's name-from-contents: description-referenced nodes
	// are read even when hidden, so the text is announced once, as description.
	expect(wrap.getAttribute("aria-describedby")).toBe(bubble.id);
	expect(bubble.getAttribute("role")).toBe("tooltip");
	expect(bubble.getAttribute("aria-hidden")).toBe("true");
	expect(bubble.textContent).toBe("The whole story behind the badge");
	// The wrapper joins the Tab order: what hover shows, a keyboard reaches.
	expect(wrap.tabIndex).toBe(0);
});

test("the Help glyph shares the primitive: its button describes itself with the same bubble", () => {
	const root = mount(<Help text="What this setting changes, in one or two sentences." />);
	const wrap = root.querySelector(".help-wrap") as HTMLElement;
	const button = root.querySelector("button.help") as HTMLElement;
	const bubble = root.querySelector(".tip-bubble") as HTMLElement;
	expect(button.getAttribute("aria-describedby")).toBe(bubble.id);

	void act(() => {
		button.focus();
	});
	expect(isOpen(bubble)).toBe(true);
	pressEscape();
	expect(isOpen(bubble)).toBe(false);
	expect(document.activeElement).toBe(button);

	fireMouseEnter(wrap);
	expect(isOpen(bubble)).toBe(true);
	fireMouseLeave(wrap, bubble);
	expect(isOpen(bubble)).toBe(true);
});

/** The app at a collapsed-rail width, with enough state for counts and a synced verdict. */
function mountCollapsedApp() {
	setViewport(800, 700);
	const root = mount(<App />);
	pushToWebview(
		statePush(
			makeState({
				servers: [makeDeclaredServer({ servedModelCount: 2, lastChecked: new Date().toISOString() })],
				models: [makeModel(), makeModel({ id: "second", name: "Second" })],
			})
		)
	);
	return root;
}

test("collapsed rail controls carry paint-only tips: name echoes, hidden from assistive tech", () => {
	const root = mountCollapsedApp();
	const tabs = Array.from(root.querySelectorAll<HTMLElement>("[role='tab']"));
	expect(tabs.length).toBeGreaterThan(0);
	for (const tab of tabs) {
		const label = tab.querySelector(".rail-label")?.textContent ?? "";
		expect(label.length).toBeGreaterThan(0);
		const bubble = tab.querySelector(".tip-bubble") as HTMLElement;
		expect(bubble).not.toBeNull();
		expect(bubble.textContent).toContain(label);
		expect(bubble.getAttribute("data-placement")).toBe("beside");
		expect(bubble.getAttribute("aria-hidden")).toBe("true");
		// The tip text IS the control's accessible name, so it is not also its
		// description - that would announce the name twice.
		expect(tab.hasAttribute("aria-describedby")).toBe(false);
	}
	for (const action of Array.from(root.querySelectorAll<HTMLElement>(".rail-action"))) {
		const label = action.querySelector(".rail-action-label")?.textContent ?? "";
		expect(label.length).toBeGreaterThan(0);
		expect(action.querySelector(".tip-bubble")?.textContent).toBe(label);
	}
	// The verdict pill's tip is paint-only like the tabs': its word is already
	// the pill's own text and its time is the sync line below, so the tab stop's
	// description points at that line and each fact is announced once.
	const word = root.querySelector(".rail-word")?.textContent ?? "";
	expect(word.length).toBeGreaterThan(0);
	const pill = root.querySelector(".rail-status") as HTMLElement;
	const verdictBubble = pill.querySelector(".tip-bubble") as HTMLElement;
	expect(verdictBubble.textContent).toContain(word);
	expect(verdictBubble.textContent).toContain("last sync");
	const described = pill.getAttribute("aria-describedby") ?? "";
	expect(described).not.toBe(verdictBubble.id);
	expect(document.getElementById(described)?.className).toBe("rail-synced");
});

test("an icon rail tab names itself on hover AND on keyboard focus: the icon is the only other clue", () => {
	// On the collapsed rail a tab paints an icon and nothing else, so the tip IS
	// the route to its name for a sighted reader - by pointer and by Tab alike.
	// The pointer half is pinned above; this is the keyboard half, on the rail
	// rather than on the primitive, because only the rail hides the name in the
	// first place.
	const root = mountCollapsedApp();
	for (const tab of Array.from(root.querySelectorAll<HTMLElement>("[role='tab']"))) {
		const label = tab.querySelector(".rail-label")?.textContent ?? "";
		const bubble = tab.querySelector(".tip-bubble") as HTMLElement;
		expect(isOpen(bubble)).toBe(false);

		fireMouseEnter(tab);
		expect(isOpen(bubble)).toBe(true);
		fireMouseLeave(tab);
		expect(isOpen(bubble)).toBe(false);

		void act(() => {
			tab.focus();
		});
		expect(isOpen(bubble)).toBe(true);
		expect(bubble.textContent).toContain(label);
		void act(() => {
			tab.blur();
		});
		fireBlur(tab);
		expect(isOpen(bubble)).toBe(false);
	}
});

test("a never-synced verdict pill describes nothing: there is no second fact to add", () => {
	setViewport(800, 700);
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	const pill = root.querySelector(".rail-status") as HTMLElement;
	const word = root.querySelector(".rail-word")?.textContent ?? "";
	expect(pill.querySelector(".tip-bubble")?.textContent).toBe(word);
	expect(pill.hasAttribute("aria-describedby")).toBe(false);
	expect(root.querySelector(".rail-synced")).toBeNull();
});

test("clicking a tip bubble does not activate the control underneath", () => {
	// The bubble is hoverable by design and sits inside its trigger, so a
	// reader selecting the tip's text would otherwise press the button.
	const root = mountCollapsedApp();
	const inactive = Array.from(root.querySelectorAll<HTMLElement>("[role='tab']")).find(
		(tab) => tab.getAttribute("aria-selected") === "false"
	) as HTMLElement;
	fireMouseEnter(inactive);
	const bubble = inactive.querySelector(".tip-bubble") as HTMLElement;
	expect(isOpen(bubble)).toBe(true);
	fireClick(bubble);
	expect(inactive.getAttribute("aria-selected")).toBe("false");
});

test("at full width the rail renders no tip bubbles: the labels are painted right there", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	expect(root.querySelector(".rail .tip-bubble")).toBeNull();

	// And a full-width hover holds no invisible tip open: Escape stays with
	// the page (the shell's leave-edit, a panel) instead of a tip nobody sees.
	fireMouseEnter(root.querySelector("[role='tab']") as HTMLElement);
	expect(pressEscape().claimed).toBe(false);
});

test("the bubble is fixed-position in the stylesheet, which is what escapes every ancestor clip", () => {
	// happy-dom runs no cascade, so a tip renders identically whether it is fixed
	// or absolute: deleting `position: fixed` leaves every suite green while
	// every tip inside a scrollport gets clipped again. Read from the sheet.
	const sheet = readFileSync(join(import.meta.dir, "../../../../webview/dashboard/styles/dashboard.css"), "utf8");
	const block = /\.tip-bubble \{([^}]*)\}/.exec(sheet)?.[1];
	if (block === undefined) {
		throw new Error("no .tip-bubble rule in dashboard.css");
	}
	expect(block).toContain("position: fixed");
	// Hoverability's half of the same block: a tip the pointer cannot land on
	// fails 1.4.13 no matter what the component state does.
	expect(block).not.toContain("pointer-events: none");
});

/**
 * The `enabled` flip the rail performs at its collapse width, driven directly:
 * happy-dom's matchMedia fires `change` when a query starts matching but not
 * when it stops, so the rail's own collapse cannot be exercised both ways here.
 */
function EnabledProbe({ enabled }: { enabled: boolean }) {
	const tip = useTip("above", enabled);
	return (
		<span className="tip-wrap" {...tip.triggerProps}>
			<span>anchor</span>
			<TipBubble tip={tip}>enabled probe tip</TipBubble>
		</span>
	);
}

test("disabling a tip closes it and releases its claim on Escape; re-enabling honors a held hover", () => {
	const root = mount(<EnabledProbe enabled={true} />);
	const wrap = root.querySelector(".tip-wrap") as HTMLElement;
	const bubble = root.querySelector(".tip-bubble") as HTMLElement;
	fireMouseEnter(wrap);
	expect(isOpen(bubble)).toBe(true);

	render(<EnabledProbe enabled={false} />, root);
	expect(isOpen(bubble)).toBe(false);
	expect(pressEscape().claimed).toBe(false);

	// The pointer never left the trigger, so the flip back reveals the tip it
	// was owed - there is no new mouseover to ask again.
	render(<EnabledProbe enabled={true} />, root);
	expect(isOpen(bubble)).toBe(true);
});

test("a collapsed rail tip escapes the 48px rail: anchored beside the [data-tip-edge] box", () => {
	const root = mountCollapsedApp();
	const rail = root.querySelector("nav.rail") as HTMLElement;
	// The rail declares itself the shared x edge, so a column of controls of
	// different widths shows a column of tips at one x.
	expect(rail.hasAttribute("data-tip-edge")).toBe(true);
	const railRect = { left: 0, top: 0, right: 48, bottom: 700, width: 48, height: 700, x: 0, y: 0, toJSON: () => ({}) };
	rail.getBoundingClientRect = () => railRect as DOMRect;

	const tab = root.querySelector("[role='tab']") as HTMLElement;
	stubBoundingRect(tab, { left: 4, top: 100, bottom: 138 });
	fireMouseEnter(tab);

	const bubble = tab.querySelector(".tip-bubble") as HTMLElement;
	expect(isOpen(bubble)).toBe(true);
	// x clears the rail's right edge plus the 8px gap; y centers on the control.
	expect(bubble.style.left).toBe("56px");
	expect(bubble.style.top).toBe("119px");

	// A resize re-measures the shown tip: dragging a splitter moves the rail
	// under a hovered or focused control without any new pointer event.
	stubBoundingRect(tab, { left: 4, top: 200, bottom: 238 });
	void act(() => {
		window.dispatchEvent(new Event("resize"));
	});
	expect(bubble.style.top).toBe("219px");

	// So does a scroll, and it must be heard on capture: scroll does not
	// bubble, so a wheel over a table's scrollport or a panel would otherwise
	// leave the fixed bubble behind while its row moves.
	stubBoundingRect(tab, { left: 4, top: 300, bottom: 338 });
	void act(() => {
		(root.querySelector(".rail-inner") as HTMLElement).dispatchEvent(new Event("scroll"));
	});
	expect(bubble.style.top).toBe("319px");
});

test("the horizontal clamp measures the bubble, so a short tip stays beside a right-edge trigger", () => {
	// A worst-case (350px) clamp would shove a SHORT tip hundreds of pixels left
	// of a right-edge trigger, opening a gap no pointer could cross. happy-dom
	// lays nothing out, so offsetWidth is stubbed as a browser would report it.
	const root = mount(
		<HoverTip tip="short">
			<span>badge</span>
		</HoverTip>
	);
	const wrap = root.querySelector(".tip-wrap") as HTMLElement;
	const bubble = root.querySelector(".tip-bubble") as HTMLElement;
	Object.defineProperty(bubble, "offsetWidth", { configurable: true, value: 60 });

	const triggerLeft = window.innerWidth - 20;
	stubBoundingRect(wrap, { left: triggerLeft, top: 300, bottom: 320 });
	fireMouseEnter(wrap);

	// Both halves, and the worst-case clamp satisfied only the first: the whole
	// box stays on screen, AND its x range still reaches the trigger, so there
	// is a pointer path from one to the other.
	const left = Number.parseInt(bubble.style.left, 10);
	expect(left + 60).toBeLessThanOrEqual(window.innerWidth);
	expect(left).toBeLessThanOrEqual(triggerLeft);
	expect(left + 60).toBeGreaterThanOrEqual(triggerLeft);
	expect(left).toBeGreaterThan(window.innerWidth - 350);
});

test("Escape dismisses a focused rail tip without stealing the roving tabindex position", () => {
	const root = mountCollapsedApp();
	const tab = root.querySelector("[role='tab']") as HTMLElement;
	void act(() => {
		tab.focus();
	});
	const bubble = tab.querySelector(".tip-bubble") as HTMLElement;
	expect(isOpen(bubble)).toBe(true);
	pressEscape();
	expect(isOpen(bubble)).toBe(false);
	expect(document.activeElement).toBe(tab);
});
