/**
 * The right-side slide-over the server forms open in: a scrim over the page,
 * a focus-trapped dialog panel, Esc and scrim-click to close. Closing is a
 * REQUEST: the section owning the form decides what it means (close, or ask
 * to confirm discarding edits) and renders the confirm bar through the
 * `confirming` props, so the keyboard path, the scrim, the X, and the form's
 * own Cancel all share one policy.
 */

import * as l10n from "@vscode/l10n";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { IconClose } from "./icons";
import { Button } from "./ui/button";

/** What can take focus inside the panel; disabled controls and tabindex -1 widgets (listbox options) drop out. */
const FOCUSABLE =
	"a[href], button:not([disabled]):not([tabindex='-1']), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary:not([tabindex='-1']), [tabindex]:not([tabindex='-1'])";

/**
 * The panel's tabbable controls in document order. A collapsed <details> hides
 * its content from the Tab order while its own summary stays reachable, so the
 * selector's matches are filtered: without this, a control inside a closed
 * disclosure (a record-path jump, say) would register as the trap's first or
 * last stop, and Tab at the real boundary would escape the dialog.
 */
function tabbables(panel: HTMLElement): HTMLElement[] {
	return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
		for (let node = element.parentElement; node !== null && node !== panel; node = node.parentElement) {
			if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open) {
				if (element.tagName !== "SUMMARY" || element.parentElement !== node) {
					return false;
				}
			}
		}
		return true;
	});
}

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
	// unmounts once a server exists), to the stable fallback element.
	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const panel = panelRef.current;
		const first =
			panel?.querySelector<HTMLElement>("input, select, textarea") ??
			(panel === null ? undefined : tabbables(panel)[0]);
		first?.focus();
		return () => {
			if (opener?.isConnected === true) {
				opener.focus();
				return;
			}
			document.getElementById(fallbackFocusId)?.focus();
		};
	}, [fallbackFocusId]);

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			// Panels can nest (the record editors' matcher overlay opens above
			// the server form's slide-over); the key must close only the panel
			// that received it, never the one beneath.
			event.stopPropagation();
			onRequestClose();
			return;
		}
		if (event.key !== "Tab") {
			return;
		}
		// Tab cycles inside the dialog: the page behind the scrim must stay
		// unreachable until the form closes. Stop propagation so an outer
		// nested panel's trap never re-handles the same keystroke.
		event.stopPropagation();
		const panel = panelRef.current;
		if (panel === null) {
			return;
		}
		const focusables = tabbables(panel);
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		if (first === undefined || last === undefined) {
			return;
		}
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	return (
		<>
			{/* A pointer-only affordance, per the dialog pattern: keyboard users
			    have Esc and the Close button, so the scrim stays out of the Tab
			    order and out of the accessibility tree. */}
			<button type="button" className="scrim" tabIndex={-1} aria-hidden="true" onClick={onRequestClose} />
			<div
				className="slide-over"
				role="dialog"
				aria-modal="true"
				aria-labelledby={labelledBy}
				ref={panelRef}
				onKeyDown={onKeyDown}
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
			</div>
		</>
	);
}
