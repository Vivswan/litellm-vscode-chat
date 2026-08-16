/**
 * The right-side slide-over the dashboard's overlay panels open in. Closing is a REQUEST:
 * the owning section decides what it means, so keyboard, scrim, and X share one policy.
 * Radix Dialog supplies the focus trap, the nesting-aware Esc stack, and aria-hidden on
 * the page; two departures forced by the webview: no Dialog.Overlay (the only place
 * Radix mounts react-remove-scroll, whose injected <style> the CSP refuses - the scrim
 * is the backdrop, and body scroll was never locked) and no Dialog.Portal (the panel
 * keeps its place in the section's DOM). Dialog.Root gets no onOpenChange: open is
 * always true and every close travels through onRequestClose, or a dismissal would have
 * two routes to one request.
 */

import * as Dialog from "@radix-ui/react-dialog";
import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { IconClose } from "./icons";
import { Button } from "./ui/button";

/**
 * Where initial focus lands when the panel has no field to type into; Radix owns the Tab
 * trap, so this only names a sensible first stop.
 */
const FOCUSABLE =
	"a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function SlideOver({
	labelledBy,
	fallbackFocusId,
	onRequestClose,
	children,
}: {
	/** The id of the heading naming this dialog (the panel's own h3). */
	labelledBy: string;
	/** Where focus lands on close when the opener no longer exists (e.g. a matcher row the editor itself removed). */
	fallbackFocusId: string;
	onRequestClose: () => void;
	children: ReactNode;
}) {
	const panelRef = useRef<HTMLDivElement>(null);

	// Focus moves in on open (the first field, so typing starts immediately) and returns to
	// the opener on close - or to the stable fallback when the panel's own action removed
	// the opener. Radix's autofocus is declined so this stays the one policy, making the
	// fallback load-bearing: a field-less panel would otherwise strand focus on an element
	// the dialog just hid from assistive tech.
	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const panel = panelRef.current;
		const target =
			panel?.querySelector<HTMLElement>("input, select, textarea") ??
			panel?.querySelector<HTMLElement>(FOCUSABLE) ??
			panel;
		target?.focus();
		return () => {
			if (opener?.isConnected === true) {
				opener.focus();
				return;
			}
			document.getElementById(fallbackFocusId)?.focus();
		};
	}, [fallbackFocusId]);

	return (
		<Dialog.Root open={true} modal={true}>
			{/* A pointer-only affordance: keyboard users have Esc and Close, so the scrim stays out
			    of the Tab order and the accessibility tree. It carries the close request itself
			    because Radix's outside-interaction dismissal is declined - both would fire twice. */}
			<button type="button" className="scrim" tabIndex={-1} aria-hidden="true" onClick={onRequestClose} />
			<Dialog.Content
				className="slide-over"
				// Radix leans on aria-hidden over the rest of the page rather than
				// this attribute, but assistive tech that reads one and not the
				// other should still get the modal semantics.
				aria-modal="true"
				aria-labelledby={labelledBy}
				ref={panelRef}
				onOpenAutoFocus={(event) => event.preventDefault()}
				onCloseAutoFocus={(event) => event.preventDefault()}
				// Radix hears Esc on a document capture listener - too early: the suggestion listbox
				// must swallow its own Esc first, and only a bubble-phase handler can be overruled that
				// way. So Radix's Esc is declined and the policy lives in onKeyDown below.
				onEscapeKeyDown={(event) => event.preventDefault()}
				onInteractOutside={(event) => event.preventDefault()}
				onKeyDown={(event) => {
					if (event.key !== "Escape") {
						return;
					}
					event.preventDefault();
					// Nothing nests slide-overs today, but the key still stops
					// here so an Esc that closed this panel can never also reach
					// an ancestor's handler and close something beneath it.
					event.stopPropagation();
					onRequestClose();
				}}
			>
				<Button
					variant="secondary"
					size="compact"
					// mx-0, the same pin the server form's reveal toggle takes: absolutely positioned, so
					// the primitive's layout hand-back would slide the box past the `right: 12px` its rule
					// states.
					className="slide-close mx-0"
					aria-label={l10n.t("Close")}
					onClick={onRequestClose}
				>
					<IconClose />
				</Button>
				{children}
			</Dialog.Content>
		</Dialog.Root>
	);
}
