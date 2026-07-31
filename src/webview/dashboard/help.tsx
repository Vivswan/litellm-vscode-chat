/**
 * The dashboard's one help affordance: a muted circled "?" that reveals the
 * long-form help from helpText.ts in a tooltip the webview renders itself.
 * Native title tooltips do not reliably render inside VS Code's webview host
 * and never show on keyboard focus, so the tip is a real element toggled by
 * CSS (hover on the wrapper, focus-visible on the button). The trigger stays
 * a real button so focus reaches it without a mouse; it is named "Help" and
 * the tip is wired to it as its accessible description (aria-describedby on
 * the button, role="tooltip" on the tip), so assistive tech reads the same
 * text the tooltip shows. It performs no action; the text is the whole point.
 * `below` flips the tip under the trigger for triggers near the top of the
 * page, where the default above placement would clip.
 */

import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import type { DocsUrl } from "./docsLinks";
import { IconLinkExternal } from "./icons";

/**
 * A quiet "learn more" anchor beside a section title or inside a notice,
 * pointing at a docs page on GitHub. The href type admits only the docsLinks
 * constants, so no call site can pass a built string. The webview host opens
 * plain anchors externally, so no message plumbing and no CSP grant are
 * involved. Icon-only unless children supply visible text; the aria-label
 * carries the destination either way.
 */
export function DocsLink({ href, label, children }: { href: DocsUrl; label: string; children?: ComponentChildren }) {
	return (
		<a class="docs-link" href={href} aria-label={label}>
			{children}
			<IconLinkExternal />
		</a>
	);
}

/**
 * A hover tip over non-interactive inline content (badges, table cells),
 * drawn with the same .help-tip element the "?" affordance uses. Plain tips
 * are for extra detail whose substance also renders as visible text
 * somewhere. A tip whose content exists nowhere else must be `focusable`:
 * the wrapper joins the Tab order and names the tip as its accessible
 * description, so keyboards and assistive tech reach what hover shows.
 */
export function HoverTip({
	tip,
	focusable,
	children,
}: {
	tip: string;
	focusable?: boolean;
	children: ComponentChildren;
}) {
	const id = useId();
	return (
		<span
			class="tip-wrap"
			tabIndex={focusable === true ? 0 : undefined}
			aria-describedby={focusable === true ? id : undefined}
		>
			{children}
			<span class="help-tip" role="tooltip" id={id}>
				{tip}
			</span>
		</span>
	);
}

export function Help({ text, below }: { text: string; below?: boolean }) {
	const id = useId();
	return (
		<span class={below === true ? "help-wrap below" : "help-wrap"}>
			<button type="button" class="help" aria-label="Help" aria-describedby={id}>
				?
			</button>
			<span class="help-tip" role="tooltip" id={id}>
				{text}
			</span>
		</span>
	);
}
