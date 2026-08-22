/**
 * The dashboard's "?" help affordance. Native title tooltips do not reliably render inside
 * VS Code's webview host and never show on keyboard focus, so the ui/tip.tsx primitive
 * renders the tip, wired to the trigger button as its accessible description.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import type { DocsUrl } from "./docsLinks";
import { IconLinkExternal } from "./icons";
import { cn } from "./ui/cn";
import { TipBubble, useTip } from "./ui/tip";

/**
 * A "learn more" docs anchor. The href type admits only the docsLinks constants, so no call
 * site can pass a built string; the webview host opens plain anchors externally. The icon-only
 * form is marked so dashboard.css can seat it with the "?" glyph's rule (beside .help-wrap).
 */
export function DocsLink({ href, label, children }: { href: DocsUrl; label: string; children?: ReactNode }) {
	return (
		<a className={cn("docs-link", children === undefined && "glyph-only")} href={href} aria-label={label}>
			{children}
			<IconLinkExternal />
		</a>
	);
}

/**
 * Glues a trailing atomic inline (the "?" glyph, an icon-only link) to the word before it.
 * The NBSP rides INSIDE the nowrap span because Chrome breaks before an atomic inline even
 * directly after a no-break space, orphaning the glyph alone on the next line.
 */
export function NoBreakTail({ children }: { children: ReactNode }) {
	return (
		<span className="whitespace-nowrap">
			{"\u00a0"}
			{children}
		</span>
	);
}

/**
 * A tip over non-interactive inline content. The wrapper joins the Tab order and names the
 * tip as its accessible description, so keyboards and assistive tech reach what hover shows.
 */
export function HoverTip({ tip, children }: { tip: string; children: ReactNode }) {
	const bubble = useTip("above");
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: the wrapped content is non-interactive and the tip text renders nowhere else, so the tab stop is the keyboard's only route to it
		<span className="tip-wrap" tabIndex={0} aria-describedby={bubble.id} {...bubble.triggerProps}>
			{children}
			<TipBubble tip={bubble}>{tip}</TipBubble>
		</span>
	);
}

export function Help({ text, name, below }: { text: string; name?: string; below?: boolean }) {
	const bubble = useTip(below === true ? "below" : "above");
	return (
		<span className="help-wrap" {...bubble.triggerProps}>
			{/* hit-24 grows the pointer target around the 14px ring without growing
			    the ring; hover on the expanded area still reaches the wrapper's
			    handlers, since the pseudo hit-tests as the button inside it. */}
			<button type="button" className="help hit-24" aria-label={name ?? l10n.t("Help")} aria-describedby={bubble.id}>
				?
			</button>
			<TipBubble tip={bubble}>{text}</TipBubble>
		</span>
	);
}
