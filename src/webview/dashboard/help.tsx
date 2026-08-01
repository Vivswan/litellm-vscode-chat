/**
 * The dashboard's one help affordance: a muted circled "?" that reveals the
 * long-form help from helpText.ts in a tooltip the webview renders itself.
 * Native title tooltips do not reliably render inside VS Code's webview host
 * and never show on keyboard focus, so the tip is a real element toggled by
 * CSS (hover on the wrapper, focus-visible on the button). The trigger stays
 * a real button so focus reaches it without a mouse; it is named "Help" (a
 * caller with many glyphs on one page may pass a distinguishing `name`, e.g.
 * "Help: Request timeout", so a screen reader's button list is not a column
 * of identical entries) and the tip is wired to it as its accessible
 * description (aria-describedby on
 * the button, role="tooltip" on the tip), so assistive tech reads the same
 * text the tooltip shows. It performs no action; the text is the whole point.
 * `below` flips the tip under the trigger for triggers near the top of the
 * page, where the default above placement would clip.
 */

import type { ComponentChildren, CSSProperties, TargetedEvent } from "preact";
import { useId, useState } from "preact/hooks";
import type { DocsUrl } from "./docsLinks";
import { IconLinkExternal } from "./icons";

/**
 * Fixed-position coordinates for a tip, measured from its trigger when the
 * pointer or keyboard focus arrives. Tips render inside the tables' scroll
 * containers, whose overflow boxes clip an absolutely-positioned tip at
 * their edges; position: fixed escapes every ancestor clip. Anchoring the
 * tip's bottom (or its top, for `below`) to the trigger's edge keeps the
 * tip's unknown height out of the arithmetic, and the horizontal clamp
 * keeps its 320px max-width inside the viewport. Coordinates go stale if
 * the page scrolls while a tip is shown; leaving the trigger re-measures.
 */
function useTipCoords(below: boolean): {
	style: CSSProperties | undefined;
	place: (event: TargetedEvent<HTMLElement>) => void;
} {
	const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
	const place = (event: TargetedEvent<HTMLElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		// Clamp headroom is the tip's full box: 320px max-width plus its 20px
		// of padding, 2px of border, and an 8px viewport margin.
		const left = Math.max(8, Math.min(rect.left - 8, window.innerWidth - 350));
		setStyle(
			below
				? { position: "fixed", left: `${left}px`, top: `${rect.bottom + 6}px`, bottom: "auto", right: "auto" }
				: {
						position: "fixed",
						left: `${left}px`,
						bottom: `${window.innerHeight - rect.top + 6}px`,
						top: "auto",
						right: "auto",
					}
		);
	};
	return { style, place };
}

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
	const { style, place } = useTipCoords(false);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the handlers only measure for tip placement; the interactivity stays on CSS hover and the focusable content
		<span
			class="tip-wrap"
			tabIndex={focusable === true ? 0 : undefined}
			aria-describedby={focusable === true ? id : undefined}
			onMouseEnter={place}
			onFocusIn={place}
		>
			{children}
			<span class="help-tip" role="tooltip" id={id} style={style}>
				{tip}
			</span>
		</span>
	);
}

export function Help({ text, name, below }: { text: string; name?: string; below?: boolean }) {
	const id = useId();
	const { style, place } = useTipCoords(below === true);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the handlers only measure for tip placement; the interactivity stays on the inner Help button
		<span class={below === true ? "help-wrap below" : "help-wrap"} onMouseEnter={place} onFocusIn={place}>
			<button type="button" class="help" aria-label={name ?? "Help"} aria-describedby={id}>
				?
			</button>
			<span class="help-tip" role="tooltip" id={id} style={style}>
				{text}
			</span>
		</span>
	);
}
