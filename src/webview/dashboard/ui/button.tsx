import { cva, type VariantProps } from "class-variance-authority";
import { Children, type ComponentProps, isValidElement, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * The dashboard's button. Two independent axes: `variant` is RANK, `size` is geometry
 * (tangled, an icon-only destructive action had to choose between reading as destructive
 * and fitting its row). Rank is weight and colour, not boxes; danger is a red wash that
 * warns as you reach for it. Secondary carries a dotted underline at rest - without a
 * resting mark three quarters of the page's buttons read as prose - the same idiom as
 * button.count-link; decided in React (`hasTextLabel`) because the rule is "has words to
 * underline" and CSS cannot see text. The negative inline margin: each size hands its
 * padding back to the layout so labels align with text and only the fill overhangs. It
 * rides a custom property, not a margin utility, because the bordered modes must take
 * the hand-back away without zeroing every other inline margin (margin-inline writes
 * both longhands; the record matcher's pencil ms-auto pays for that) - theme.css zeroes
 * the PROPERTY once. Consequences: gaps and padding measure ink-to-ink; a call site
 * overriding padding restates the property ([--btn-mx:-0.25rem] beside px-1); a site
 * pinned to a box takes plain mx-0. --control-outline is transparent everywhere and the
 * contrast border in HC. Disabled keeps no fill (it would be the loudest thing on the
 * row); aria-disabled paints identically, for controls that must refuse a click WITHOUT
 * leaving the tab order - `disabled` drops focus to the body and takes the announcement
 * with it.
 */
const buttonVariants = cva(
	"inline-flex cursor-pointer items-center justify-center mx-(--btn-mx) gap-1.5 rounded-sm border border-control-outline transition-[color,background-color,border-color,outline-color,opacity] duration-[120ms] ease-out focus-visible:outline-(length:--ring-w) focus-visible:outline-offset-(--ring-offset) focus-visible:outline-ring focus-visible:outline-solid disabled:cursor-default disabled:bg-transparent disabled:text-disabled-foreground disabled:opacity-60 aria-disabled:cursor-default aria-disabled:bg-transparent aria-disabled:text-disabled-foreground aria-disabled:opacity-60",
	{
		variants: {
			variant: {
				// The readable accent tier, not the raw hue: --accent-hue is tuned to be seen as a fill
				// (3.64:1 on the dark page), not read as a word (text tier's worst case 5.06:1).
				default: "font-semibold text-accent-text hover:bg-accent-soft",
				secondary: "text-muted-foreground hover:bg-ghost-hover hover:text-foreground",
				danger: "text-err-quiet hover:bg-err-wash hover:text-err-strong",
			},
			size: {
				// The value is the size's own horizontal padding, negated: the
				// hand-back exists to cancel it exactly.
				default: "[--btn-mx:-0.625rem] px-2.5 py-1",
				compact: "[--btn-mx:-0.375rem] px-1.5 py-0.5",
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
				// currentColor, not tinted: the resting decoration must clear a graphical object's 3:1
				// (half the muted token measures 2.2:1 on Light Modern), and count-link uses
				// currentColor too, so the two spellings cannot drift. Hover does not clear it: a
				// transparent decoration COLOUR gets repainted by forced colours, and the background
				// fades over 120ms while a cleared line returns instantly.
				class: "underline decoration-dotted underline-offset-2",
			},
			{
				variant: "secondary",
				labelled: true,
				// No underline when disabled: an affordance saying "activate me" on a control that
				// refuses is worse than none. aria-disabled paints identically.
				class: "disabled:no-underline aria-disabled:no-underline",
			},
		],
		defaultVariants: {
			variant: "default",
			size: "default",
			// labelled has no default on purpose: Button always passes it, and absent, no compound
			// matches and the underline stays off - the safe direction if the prop ever goes missing.
		},
	}
);

/**
 * Whether a button has words to underline. CSS cannot answer it (:has counts ELEMENT
 * children), and Children.toArray flattens arrays but NOT fragments - several call sites
 * wrap a label beside its icon in a fragment - hence the recursion. A string child is
 * the label; JSX's inter-element space is a string too, so whitespace-only does not
 * count. Text rendered by a child COMPONENT is invisible here: such a button would
 * read as unlabelled and lose its underline (no call site does this).
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
