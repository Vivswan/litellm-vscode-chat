/**
 * The right-side slide-over the dashboard's overlay panels open in (the model
 * inspector, the record editors' matcher overlay): a scrim over the page, a
 * focus-trapped dialog panel, Esc and scrim-click to close. Closing is a
 * REQUEST: the section owning the panel decides what it means, so the
 * keyboard path, the scrim, and the X all share one policy.
 *
 * Radix Dialog supplies the parts that are hard to get right by hand - the
 * focus trap, the nesting-aware Esc layer stack, and aria-hidden on the rest
 * of the page - while this file keeps the policy Radix has no opinion about.
 * Two deliberate departures from the stock recipe, both forced by the webview:
 *
 * - No `Dialog.Overlay`. Overlay is the only place Radix mounts
 *   react-remove-scroll, which injects a <style> element the dashboard's CSP
 *   (style-src without any inline allowance) refuses. The scrim below is the
 *   backdrop instead. The dashboard has never locked body scroll and still
 *   does not; if it ever should, a body class in dashboard.css buys it
 *   without reopening the policy.
 * - No `Dialog.Portal`. The panel stays where it renders so it keeps its
 *   place in the section's DOM; nothing here depends on escaping a stacking
 *   context.
 *
 * `Dialog.Root` gets no `onOpenChange`: the section owns whether the panel
 * exists at all, so Radix's open state is always true and every close travels
 * through onRequestClose below. Wiring onOpenChange as well would give a
 * dismissal two routes to the same request.
 */

import * as Dialog from "@radix-ui/react-dialog";
import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { IconClose } from "./icons";
import { Button } from "./ui/button";

/**
 * Where initial focus lands when the panel has no field to type into. Radix
 * owns the Tab trap now, so this only has to name a sensible first stop.
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

	// Focus moves into the panel on open (the first field, not the X, so
	// typing can start immediately) and returns to the opener on close - or,
	// when the opener no longer exists (the panel's own action may have
	// removed the row that opened it), to the stable fallback element. Radix's
	// own open/close autofocus is declined below so this stays the one policy,
	// which makes the fallback load-bearing: a panel with no field at all (the
	// model inspector) would otherwise strand focus on the opener the dialog
	// just hid from assistive tech, and Esc - handled on the panel - would
	// never reach anything.
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
			{/* A pointer-only affordance, per the dialog pattern: keyboard users
			    have Esc and the Close button, so the scrim stays out of the Tab
			    order and out of the accessibility tree. It carries the close
			    request itself because Radix's outside-interaction dismissal is
			    declined below - routing both would fire the request twice. */}
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
					className="slide-close"
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
