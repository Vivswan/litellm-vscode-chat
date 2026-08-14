import { cva, type VariantProps } from "class-variance-authority";
import { Children, type ComponentProps, isValidElement, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * The dashboard's button. Two independent axes: `variant` is RANK - what kind
 * of action this is - and `size` is geometry. They were tangled before: a
 * "quiet" variant carried the muted color AND a smaller box, which meant an
 * icon-only destructive action had to choose between reading as destructive
 * and fitting its row. It also made two of the four variants identical in
 * color, so a Remove and an Edit were the same button with different labels.
 * Quiet was never a rank; it was `secondary` at `compact`, and says so now.
 *
 * Rank is carried by weight and colour rather than by boxes. The default rank
 * takes the accent; danger takes a red wash instead of a red word, so it warns
 * as you reach for it rather than sitting in the layout as a permanent alarm.
 *
 * Secondary carries a dotted underline at rest. It is roughly three quarters of
 * every button on the dashboard, and without a resting mark those buttons read
 * as prose until a pointer happens to sweep them - Export settings, Sync
 * models, Refresh now and Show in settings.json sitting indistinguishable from
 * the sentences beside them. The high-contrast themes are the demonstration:
 * they outline every control, and the same pages read as an interface there.
 *
 * The underline is the idiom already shipped rather than a new one -
 * `button.count-link` marks a server row's model count the same way - so the
 * dashboard has one spelling of "these words do something" instead of two. It
 * stays through hover, which only adds the fill.
 *
 * Which buttons get it is decided in React rather than CSS, because the rule is
 * "has words to underline" and CSS cannot see text; `hasTextLabel` below.
 *
 * Icons are the leading glyph rather than decoration - same size as the label,
 * coloured with it - so a toolbar scans by shape while a table row stays quiet.
 *
 * The negative inline margin is deliberate, and BOTH sizes carry it: the hover
 * pill needs padding to exist, but the label has to line up with the text
 * around it, so each size hands its own padding back to the layout and only
 * the fill overhangs. One consequence per party to it: a container's gap
 * always measures ink-to-ink whichever size it holds; a call site that
 * overrides the padding (px-1, px-0.5) must override the margin to match, or
 * its layout box parts from its ink; and the bordered modes - forced colors
 * and the two high-contrast themes, which draw every button's box at rest -
 * get the margins zeroed once in theme.css, because overhanging border boxes
 * merge adjacent buttons into one segmented control there.
 *
 * Two things the mockups could not show. High contrast outlines every control,
 * and a borderless button stops reading as one there, so --control-outline is
 * transparent everywhere and the contrast border in HC. And disabled keeps no
 * fill: when nothing is filled at rest, a disabled fill would be the loudest
 * thing on the row, so disabled reads through muted text and opacity alone.
 * aria-disabled paints identically, for the case where a control must refuse a
 * click WITHOUT leaving the tab order: the `disabled` attribute drops focus to
 * the body, which throws away the keyboard user's place at the moment they act
 * and takes the announcement with it, since that rides the focused element.
 */
const buttonVariants = cva(
	"inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-sm border border-control-outline transition-[color,background-color,border-color,outline-color,opacity] duration-[120ms] ease-out focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid disabled:cursor-default disabled:bg-transparent disabled:text-disabled-foreground disabled:opacity-60 aria-disabled:cursor-default aria-disabled:bg-transparent aria-disabled:text-disabled-foreground aria-disabled:opacity-60",
	{
		variants: {
			variant: {
				default: "font-semibold text-accent-hue hover:bg-accent-soft",
				secondary: "text-muted-foreground hover:bg-ghost-hover hover:text-foreground",
				danger: "text-err-quiet hover:bg-err-wash hover:text-err-strong",
			},
			size: {
				default: "-mx-2.5 px-2.5 py-1",
				compact: "-mx-1.5 px-1.5 py-0.5",
			},
			/** The resting affordance secondary carries, off for a button with no words under it. */
			labelled: {
				true: "",
				false: "",
			},
		},
		compoundVariants: [
			{
				variant: "secondary",
				labelled: true,
				// The decoration is left to currentColor rather than tinted: it
				// is the resting information that these words are a control, so
				// it has to clear the 3:1 a graphical object needs, and half the
				// muted token measures 2.2:1 on Light Modern and 2.6:1 on Dark.
				// currentColor is also what count-link uses, so the two
				// spellings of this idiom cannot drift apart.
				//
				// Hover does not clear it. Clearing can only be spelled as a
				// transparent decoration COLOUR, which forced colours repaint,
				// so it would not clear for those readers at all - and the
				// background fades over 120ms while a cleared line returns
				// instantly, so the two would desynchronise on the way out.
				class: "underline decoration-dotted underline-offset-2",
			},
			{
				variant: "secondary",
				labelled: true,
				// Disabled reads through muted text and opacity alone, which the
				// header states and an underline would contradict: an affordance
				// saying "activate me" on a control that refuses is worse than no
				// affordance. aria-disabled paints identically, for the controls
				// that must refuse a click without leaving the tab order.
				class: "disabled:no-underline aria-disabled:no-underline",
			},
		],
		defaultVariants: {
			variant: "default",
			size: "default",
			// labelled has no default on purpose: Button always passes it, and a
			// default of true would read as "a childless button underlines",
			// which is neither true nor what anyone wants if the prop ever goes
			// missing. Absent, no compound matches and the underline stays off.
		},
	}
);

/**
 * Whether a button has words to underline.
 *
 * Two things make this subtler than it looks, and both are about what counts as
 * a child. CSS cannot answer it at all: `:has(> svg:only-child)` counts ELEMENT
 * children, so a button holding an icon beside a label is indistinguishable
 * there from one holding an icon alone. And `Children.toArray` flattens arrays
 * but NOT fragments, so a label wrapped in a fragment arrives as a single
 * opaque node - which is the shape several call sites use: a label beside its
 * icon (serverEditPage's Test connection), a spinner label while an action runs
 * (settings, usage), and a matcher key inside a `<code>` (recordChain). Hence
 * the recursion.
 *
 * A string child is the label, and the space JSX puts between an icon and its
 * text is a string too, so whitespace-only does not count. Numbers and bigints
 * render as their digits and count.
 *
 * It cannot see text that a child COMPONENT renders, or `dangerouslySetInnerHTML`
 * content, since neither exists at this point. No call site uses either; one
 * that did would read as unlabelled and lose its underline.
 */
function hasTextLabel(children: ReactNode): boolean {
	return Children.toArray(children).some((child) => {
		if (typeof child === "string") {
			return child.trim().length > 0;
		}
		// bigint is in React 19's ReactNode and renders as its digits, so it is
		// a label exactly as a number is.
		if (typeof child === "number" || typeof child === "bigint") {
			return true;
		}
		if (isValidElement(child)) {
			const nested = (child.props as { children?: ReactNode }).children;
			return nested !== undefined && hasTextLabel(nested);
		}
		return false;
	});
}

export function Button({
	className,
	variant,
	size,
	type,
	children,
	...props
}: ComponentProps<"button"> & Omit<VariantProps<typeof buttonVariants>, "labelled">) {
	// data-slot and data-variant name the part and its design intent for
	// tests and inspection; the utility list alone says neither.
	return (
		<button
			type={type ?? "button"}
			data-slot="button"
			data-variant={variant ?? "default"}
			className={cn(buttonVariants({ variant, size, labelled: hasTextLabel(children) }), className)}
			{...props}
		>
			{children}
		</button>
	);
}
