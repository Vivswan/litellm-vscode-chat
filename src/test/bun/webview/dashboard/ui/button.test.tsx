/**
 * The Button primitive's class resolution: the two places where a variant and
 * a caller (or a state) compete for the same property, and the cascade cannot
 * settle it because dashboard.css now sits below the utilities.
 */
import { afterEach, expect, test } from "bun:test";
import { Button } from "../../../../../webview/dashboard/ui/button";
import { cleanup, mount } from "../../harness";

afterEach(cleanup);

function classesOf(node: HTMLElement): readonly string[] {
	return [...(node.querySelector("button")?.classList ?? [])];
}

test("a caller's hover color replaces the variant's instead of stacking with it", () => {
	// The destructive actions pass hover:text-error over the quiet variant's
	// hover:text-foreground. Both must carry the same modifier so tailwind-merge
	// drops the variant's - two surviving rules would tie on specificity and let
	// source order pick the color. Matching on the modifier chain rather than a
	// literal name is what makes this fail for a variant-side `enabled:hover:`
	// too, which merges against nothing and outranks the caller.
	const classes = classesOf(mount(<Button variant="quiet" className="text-error hover:text-error" />));
	expect(classes.filter((name) => /(^|:)hover:text-/.test(name))).toEqual(["hover:text-error"]);
});

test("the disabled treatment rides on the component, not on a legacy rule", () => {
	// dashboard.css's button:disabled sits in the legacy layer, below the
	// utilities, so the neutral disabled pair has to come from the variants.
	for (const variant of ["default", "secondary", "quiet"] as const) {
		const classes = classesOf(mount(<Button variant={variant} disabled={true} />));
		expect(classes).toContain("disabled:bg-disabled");
		expect(classes).toContain("disabled:text-disabled-foreground");
	}
});
