/**
 * The dashboard's one help affordance: a muted circled "?" whose native title
 * tooltip carries the long-form help from helpText.ts. Native on purpose - no
 * custom popover or positioning to maintain. A real button rather than a
 * decorated span so it is keyboard-focusable with correct semantics: focus
 * reaches it without a mouse, and assistive tech reads the same text via the
 * aria-label. It performs no action; the text is the whole point.
 */

export function Help({ text }: { text: string }) {
	return (
		<button type="button" class="help" title={text} aria-label={text}>
			?
		</button>
	);
}
