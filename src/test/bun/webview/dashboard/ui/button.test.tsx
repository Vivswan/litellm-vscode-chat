/**
 * The Button primitive's class resolution. The vocabulary is typographic -
 * rank in weight and color, the fill only under the cursor - so the contracts
 * worth pinning are the ones a screenshot cannot show: that no variant fills
 * at rest, that disabled never gains a fill, that danger is a variant rather
 * than a caller's className, and that a caller's override still wins when one
 * is passed.
 */
import { afterEach, expect, test } from "bun:test";
import { Button } from "../../../../../webview/dashboard/ui/button";
import { cleanup, mount } from "../../harness";

afterEach(cleanup);

const VARIANTS = ["default", "secondary", "danger", "quiet"] as const;

function classesOf(node: HTMLElement): readonly string[] {
	return [...(node.querySelector("button")?.classList ?? [])];
}

test("no variant carries a fill at rest: the fill belongs to hover", () => {
	// This is the whole vocabulary in one assertion. A background that is not
	// behind a state modifier would put a box back on the page, which is the
	// look the typographic set replaced.
	for (const variant of VARIANTS) {
		const resting = classesOf(mount(<Button variant={variant} />)).filter((name) => /^bg-/.test(name));
		expect(resting, variant).toEqual([]);
	}
});

test("every variant answers hover with a fill, so a text button still reads as a button", () => {
	for (const variant of VARIANTS) {
		const classes = classesOf(mount(<Button variant={variant} />));
		expect(
			classes.filter((name) => /^hover:bg-/.test(name)),
			variant
		).not.toEqual([]);
	}
});

test("disabled never gains a fill, in any variant", () => {
	// With nothing filled at rest, a disabled fill would be the loudest thing
	// on the row - the opposite of what disabled should say.
	for (const variant of VARIANTS) {
		const classes = classesOf(mount(<Button variant={variant} disabled={true} />));
		expect(
			classes.filter((name) => /(^|:)disabled:bg-/.test(name)),
			variant
		).toEqual(["disabled:bg-transparent"]);
		expect(classes, variant).toContain("disabled:text-disabled-foreground");
	}
});

test("danger is a variant, not a colour a caller paints on", () => {
	// It used to be className="text-error hover:text-error" at two call sites,
	// which meant the destructive treatment depended on tailwind-merge
	// resolving a caller override against the variant. Naming it removes the
	// dependency entirely.
	const classes = classesOf(mount(<Button variant="danger" />));
	expect(classes).toContain("hover:bg-err-wash");
	expect(classes).toContain("hover:text-err");
	// At rest it is an ordinary muted label: the warning arrives on approach.
	expect(classes).toContain("text-muted-foreground");
});

test("high contrast can still see the button: the outline token is on every variant", () => {
	// --control-outline is transparent in the ordinary themes and the host's
	// contrast border in HC, where a borderless control would vanish.
	for (const variant of VARIANTS) {
		expect(classesOf(mount(<Button variant={variant} />)), variant).toContain("border-control-outline");
	}
});

test("a caller's hover colour still replaces the variant's instead of stacking with it", () => {
	// No shipped call site needs this now that danger is a variant, but the
	// merge behaviour is what any future override rests on: both must carry the
	// same modifier, or two rules survive and source order picks the colour.
	const classes = classesOf(mount(<Button variant="secondary" className="hover:text-err" />));
	expect(classes.filter((name) => /(^|:)hover:text-/.test(name))).toEqual(["hover:text-err"]);
});
