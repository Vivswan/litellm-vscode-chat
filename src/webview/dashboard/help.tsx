/**
 * The dashboard's one help affordance: a muted circled "?" that reveals the
 * long-form help from helpText.ts in a tooltip the webview renders itself.
 * Native title tooltips do not reliably render inside VS Code's webview host
 * and never show on keyboard focus, so the tip is the ui/tip.tsx primitive:
 * hover or keyboard focus reveals it, Escape dismisses it, and the pointer can
 * rest on the tip itself. The trigger stays a real button so focus reaches it
 * without a mouse; it is named "Help" (a caller with many glyphs on one page
 * may pass a distinguishing `name`, e.g. "Help: Request timeout", so a screen
 * reader's button list is not a column of identical entries) and the tip is
 * wired to it as its accessible description (aria-describedby on the button),
 * so assistive tech reads the same text the tooltip shows. It performs no
 * action; the text is the whole point. `below` flips the tip under the trigger
 * for triggers near the top of the page, where the default above placement
 * would clip.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import type { DocsUrl } from "./docsLinks";
import { IconLinkExternal } from "./icons";
import { TipBubble, useTip } from "./ui/tip";

/**
 * A quiet "learn more" anchor beside a section title or inside a notice,
 * pointing at a docs page on GitHub. The href type admits only the docsLinks
 * constants, so no call site can pass a built string. The webview host opens
 * plain anchors externally, so no message plumbing and no CSP grant are
 * involved. Icon-only unless children supply visible text; the aria-label
 * carries the destination either way.
 */
export function DocsLink({ href, label, children }: { href: DocsUrl; label: string; children?: ReactNode }) {
	return (
		<a className="docs-link" href={href} aria-label={label}>
			{children}
			<IconLinkExternal />
		</a>
	);
}

/**
 * A tip over non-interactive inline content (badges, table cells), for extra
 * detail or for content that renders nowhere else. The wrapper joins the Tab
 * order and names the tip as its accessible description, so keyboards and
 * assistive tech always reach what hover shows - the tip primitive keeps the
 * bubble out of the wrapper's accessible name.
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
			<button type="button" className="help" aria-label={name ?? l10n.t("Help")} aria-describedby={bubble.id}>
				?
			</button>
			<TipBubble tip={bubble}>{text}</TipBubble>
		</span>
	);
}
