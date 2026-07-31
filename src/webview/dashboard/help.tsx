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

import { useId } from "preact/hooks";

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
