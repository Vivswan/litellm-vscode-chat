/**
 * The Button primitive's class resolution: the contracts a screenshot cannot show. No variant fills at rest,
 * disabled never gains a fill, danger is a variant rather than a caller's className, a caller's override still
 * wins, and secondary alone carries the resting underline.
 */
import { afterEach, expect, test } from "bun:test";
import { Button } from "../../../../../webview/dashboard/ui/button";
import { cleanup, mount } from "../../harness";

afterEach(cleanup);

const VARIANTS = ["default", "secondary", "danger"] as const;

function classesOf(node: HTMLElement): readonly string[] {
	return [...(node.querySelector("button")?.classList ?? [])];
}

/** Stands in for any icon: what matters here is only that it renders no text of its own. */
function Icon() {
	return <svg viewBox="0 0 16 16" aria-hidden="true" />;
}

test("no variant carries a fill at rest: the fill belongs to hover", () => {
	// A background outside a state modifier puts a box back on the page, which is the look this set replaced.
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
	// With nothing filled at rest, a disabled fill would be the loudest thing on the row.
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
	// As a variant, the destructive treatment no longer depends on tailwind-merge resolving a caller's className
	// override against the variant's own classes.
	const classes = classesOf(mount(<Button variant="danger" />));
	expect(classes).toContain("hover:bg-err-wash");
	// The hovered colour is deliberately NOT --err: a red loses contrast on its
	// own wash, so hover strengthens away from the surface instead of toward
	// the hue.
	expect(classes).toContain("hover:text-err-strong");
	// Distinct AT REST too: a Remove sits beside an Edit, and on a broken row beside a Fix, so it has to be tellable
	// apart before the pointer arrives. text-muted-foreground is secondary's and quiet's resting colour.
	expect(classes).toContain("text-err-quiet");
	expect(classes).not.toContain("text-muted-foreground");
});

test("no variant rests on the same colour as another, so rank is legible before hover", () => {
	// Rank is weight and colour, and the fill belongs to hover: three variants sharing one resting colour is three
	// variants nobody can tell apart until they aim at them.
	const restingColour = (variant: (typeof VARIANTS)[number]): string => {
		const colour = classesOf(mount(<Button variant={variant} />)).find(
			(name) => name.startsWith("text-") && !name.includes(":")
		);
		if (colour === undefined) {
			throw new Error(`variant ${variant} rests on no colour at all`);
		}
		return colour;
	};
	const byColour = new Map<string, string[]>();
	for (const variant of VARIANTS) {
		const colour = restingColour(variant);
		byColour.set(colour, [...(byColour.get(colour) ?? []), variant]);
	}
	for (const variant of VARIANTS) {
		expect(byColour.get(restingColour(variant)), variant).toEqual([variant]);
	}
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

test("secondary's resting underline follows the LABEL, however deeply the label is wrapped", () => {
	// What counts as a label is what both obvious rules get wrong: `:has(> svg:only-child)` counts ELEMENT children,
	// so an icon beside a label looks like an icon alone; `Children.toArray` treats a fragment as one opaque node,
	// so a label inside one looks like no label. Every shape below is taken from a real call site.
	const underlined = (node: HTMLElement) => classesOf(node).includes("underline");

	// A plain string label (usage "Refresh now", settings "Export settings").
	expect(underlined(mount(<Button variant="secondary">Export settings</Button>))).toBe(true);
	// Icon beside a string (diagnostics "Test connection", the rail's Report a bug).
	expect(
		underlined(
			mount(
				<Button variant="secondary">
					<Icon /> Report a bug
				</Button>
			)
		)
	).toBe(true);
	// The label inside a fragment (serverEditPage "Test connection", and every
	// spinner branch: settings and usage while an action runs).
	expect(
		underlined(
			mount(
				<Button variant="secondary">
					{/* biome-ignore lint/complexity/noUselessFragments: the fragment IS the case - Children.toArray does not flatten it, which is the bug this pins, and unwrapping it here would leave the assertion passing while testing nothing */}
					<>
						<Icon /> Test connection
					</>
				</Button>
			)
		)
	).toBe(true);
	// The label inside an element (recordChain's matcher key in a <code>).
	expect(
		underlined(
			mount(
				<Button variant="secondary">
					<code>gpt-5*</code>
				</Button>
			)
		)
	).toBe(true);
	// A glyph alone still has nothing to underline, wrapped or not.
	expect(
		underlined(
			mount(
				<Button variant="secondary">
					<Icon />
				</Button>
			)
		)
	).toBe(false);
	expect(
		underlined(
			mount(
				<Button variant="secondary">
					{/* biome-ignore lint/complexity/noUselessFragments: the wrapper is the case again, and this one rules out the naive repair of the fragment bug - "a fragment has children, so call it labelled" - which the positive case above would happily accept */}
					<>
						<Icon />
					</>
				</Button>
			)
		)
	).toBe(false);
	// Whitespace is not a label: JSX puts a space between an icon and its text,
	// and that space must not make a glyph-only button look labelled.
	expect(underlined(mount(<Button variant="secondary"> </Button>))).toBe(false);
});

test("the underline is secondary's alone, and a disabled button does not wear it", () => {
	// default already reads as an action through the accent and the weight, danger through its own colour;
	// underlining them too would flatten the three ranks back into one.
	for (const variant of ["default", "danger"] as const) {
		expect(classesOf(mount(<Button variant={variant}>Label</Button>)), variant).not.toContain("underline");
	}
	// A resting affordance saying "activate me" on a control that refuses the click is worse than none. Both forms,
	// since aria-disabled refuses without leaving the tab order.
	const classes = classesOf(mount(<Button variant="secondary">Label</Button>));
	expect(classes).toContain("disabled:no-underline");
	expect(classes).toContain("aria-disabled:no-underline");
	// Left to currentColor, which count-link also uses, so the two cannot drift apart. As resting information that
	// the words are a control it must clear 3:1, and half the muted token measures 2.2:1 light and 2.6:1 dark.
	expect(classes).toContain("decoration-dotted");
	expect(classes.filter((name) => name.startsWith("decoration-"))).toEqual(["decoration-dotted"]);
	// It survives hover: clearing can only be spelled as a transparent decoration colour, which forced colours
	// repaint, and a cleared line returns instantly while the fill takes 120ms to fade.
	expect(classes.filter((name) => name.startsWith("hover:decoration-"))).toEqual([]);
});

test("a numeric label counts as a label, bigint included", () => {
	// React renders numbers and bigints as their digits and React 19's
	// ReactNode admits both, so a count rendered as `{n}` is as much a label as
	// a word.
	const underlined = (node: HTMLElement) => classesOf(node).includes("underline");
	expect(underlined(mount(<Button variant="secondary">{42}</Button>))).toBe(true);
	expect(underlined(mount(<Button variant="secondary">{9007199254740993n}</Button>))).toBe(true);
});
