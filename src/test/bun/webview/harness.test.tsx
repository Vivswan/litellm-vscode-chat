/**
 * The harness's own a11y model, pinned where a drift is invisible to the
 * suites that lean on it: accessibleNameOf and accessibleDescriptionOf must
 * read the tree the same way - aria-hidden subtrees excluded - or a
 * description assertion silently passes on text assistive tech never hears.
 */
import { afterEach, expect, test } from "bun:test";
import { accessibleDescriptionOf, accessibleNameOf, cleanup, mount } from "./harness";

afterEach(() => {
	cleanup();
});

test("accessibleDescriptionOf excludes aria-hidden subtrees, exactly like accessibleNameOf", () => {
	mount(
		<>
			<span id="described-by-both">
				spoken <span aria-hidden="true">painted only</span>
			</span>
			<button type="button" aria-labelledby="described-by-both" aria-describedby="described-by-both" />
		</>
	);
	const button = document.querySelector("button") as HTMLElement;
	expect(accessibleNameOf(button)).toBe("spoken");
	expect(accessibleDescriptionOf(button)).toBe("spoken");
});

test("a directly referenced aria-hidden target is still read: the accname root-reference exception", () => {
	// The tooltip wiring (ui/tip.tsx TipBubble): the bubble is aria-hidden so
	// name-from-contents never doubles it, yet aria-describedby pointing AT it
	// must resolve to its text - the exception covers the referenced root,
	// never its own hidden descendants.
	mount(
		<>
			<span id="tip-bubble" role="tooltip" aria-hidden="true">
				tip text <span aria-hidden="true">still painted only</span>
			</span>
			<button type="button" aria-labelledby="tip-bubble" aria-describedby="tip-bubble" />
		</>
	);
	const button = document.querySelector("button") as HTMLElement;
	expect(accessibleNameOf(button)).toBe("tip text");
	expect(accessibleDescriptionOf(button)).toBe("tip text");
});
