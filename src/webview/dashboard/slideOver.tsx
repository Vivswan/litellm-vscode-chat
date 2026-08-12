/**
 * The right-side slide-over the server forms open in: a scrim over the page,
 * a focus-trapped dialog panel, Esc and scrim-click to close. Closing is a
 * REQUEST: the section owning the form decides what it means (close, or ask
 * to confirm discarding edits) and renders the confirm bar through the
 * `confirming` props, so the keyboard path, the scrim, the X, and the form's
 * own Cancel all share one policy.
 *
 * Radix Dialog supplies the parts that are hard to get right by hand - the
 * focus trap, the nesting-aware Esc layer stack, and aria-hidden on the rest
 * of the page - while this file keeps the policy Radix has no opinion about.
 * Two deliberate departures from the stock recipe, both forced by the webview:
 *
 * - No `Dialog.Overlay`. Overlay is the only place Radix mounts
 *   react-remove-scroll, which injects a <style> element the dashboard's CSP
 *   (style-src without any inline allowance) refuses. The scrim below is the
 *   backdrop instead, and scroll lock rides a body class in dashboard.css.
 * - No `Dialog.Portal`. The panel stays where it renders so it keeps its
 *   place in the section's DOM; nothing here depends on escaping a stacking
 *   context.
 *
 * `Dialog.Root` gets no `onOpenChange`: the section owns whether the form
 * exists at all, so Radix's open state is always true and every close travels
 * through onRequestClose below. Wiring onOpenChange as well would give a
 * dismissal two routes to the same request, and a doubled request reads as
 * Esc-then-keep-editing - the discard bar would appear and vanish in one key.
 */

import * as Dialog from "@radix-ui/react-dialog";
import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { IconClose } from "./icons";
import { Button } from "./ui/button";

export function SlideOver({
	labelledBy,
	fallbackFocusId,
	confirming,
	onRequestClose,
	onKeepEditing,
	onDiscard,
	children,
}: {
	/** The id of the heading naming this dialog (the form's own h3). */
	labelledBy: string;
	/** Where focus lands on close when the opener no longer exists (e.g. the guided start's CTA after the first save). */
	fallbackFocusId: string;
	/** Render the discard-confirm bar; Esc got a dirty form and the owner wants a decision. */
	confirming: boolean;
	onRequestClose: () => void;
	onKeepEditing: () => void;
	onDiscard: () => void;
	children: ReactNode;
}) {
	const panelRef = useRef<HTMLDivElement>(null);

	// Focus moves into the panel on open (the first field, not the X, so
	// typing can start immediately) and returns to the opener on close - or,
	// when the opener left the page with the form (the guided start's CTA
	// unmounts once a server exists), to the stable fallback element. Radix's
	// own open/close autofocus is declined below so this stays the one policy.
	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const panel = panelRef.current;
		panel?.querySelector<HTMLElement>("input, select, textarea")?.focus();
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
			{/* A pointer-only affordance, per the dialog pattern: keyboard users
			    have Esc and the Close button, so the scrim stays out of the Tab
			    order and out of the accessibility tree. It carries the close
			    request itself because Radix's outside-interaction dismissal is
			    declined below - routing both would fire the request twice and
			    toggle the discard bar straight back off. */}
			<button type="button" className="scrim" tabIndex={-1} aria-hidden="true" onClick={onRequestClose} />
			<Dialog.Content
				className="slide-over"
				// Radix leans on aria-hidden over the rest of the page rather than
				// this attribute, but assistive tech that reads one and not the
				// other should still get the modal semantics.
				aria-modal="true"
				aria-labelledby={labelledBy}
				aria-describedby={undefined}
				ref={panelRef}
				onOpenAutoFocus={(event) => event.preventDefault()}
				onCloseAutoFocus={(event) => event.preventDefault()}
				// Radix hears Esc on a document capture listener, which is too
				// early for this dashboard: the suggestion listbox inside a form
				// must swallow its own Esc before the panel sees it, and only a
				// bubble-phase handler can be overruled that way. So Radix's Esc
				// is declined outright and the policy lives in onKeyDown below.
				onEscapeKeyDown={(event) => event.preventDefault()}
				onInteractOutside={(event) => event.preventDefault()}
				onKeyDown={(event) => {
					if (event.key !== "Escape") {
						return;
					}
					event.preventDefault();
					// Panels can nest (the record editors' matcher overlay opens
					// above the server form's slide-over); the key must close only
					// the panel that received it, never the one beneath.
					event.stopPropagation();
					onRequestClose();
				}}
			>
				<Button variant="quiet" className="slide-close" aria-label={l10n.t("Close")} onClick={onRequestClose}>
					<IconClose />
				</Button>
				{children}
				{confirming ? (
					<div className="discard-confirm" role="alert">
						<span>{l10n.t("Discard unsaved changes?")}</span>
						<Button onClick={onDiscard}>{l10n.t("Discard")}</Button>
						<Button variant="secondary" onClick={onKeepEditing}>
							{l10n.t("Keep editing")}
						</Button>
					</div>
				) : null}
			</Dialog.Content>
		</Dialog.Root>
	);
}
