/**
 * The right-side slide-over the server forms open in: a scrim over the page,
 * a focus-trapped dialog panel, Esc and scrim-click to close. Closing is a
 * REQUEST: the section owning the form decides what it means (close, or ask
 * to confirm discarding edits) and renders the confirm bar through the
 * `confirming` props, so the keyboard path, the scrim, the X, and the form's
 * own Cancel all share one policy.
 */

import * as l10n from "@vscode/l10n";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { IconClose } from "./icons";

/** What can take focus inside the panel; disabled controls and tabindex -1 widgets (listbox options) drop out. */
const FOCUSABLE =
	"a[href], button:not([disabled]):not([tabindex='-1']), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

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
	children: ComponentChildren;
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
			panel?.querySelector<HTMLElement>("input, select, textarea") ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
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
		const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
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
			<button type="button" class="scrim" tabIndex={-1} aria-hidden="true" onClick={onRequestClose} />
			<div
				class="slide-over"
				role="dialog"
				aria-modal="true"
				aria-labelledby={labelledBy}
				ref={panelRef}
				onKeyDown={onKeyDown}
			>
				<button type="button" class="quiet slide-close" aria-label={l10n.t("Close")} onClick={onRequestClose}>
					<IconClose />
				</button>
				{children}
				{confirming ? (
					<div class="discard-confirm" role="alert">
						<span>{l10n.t("Discard unsaved changes?")}</span>
						<button type="button" onClick={onDiscard}>
							{l10n.t("Discard")}
						</button>
						<button type="button" class="secondary" onClick={onKeepEditing}>
							{l10n.t("Keep editing")}
						</button>
					</div>
				) : null}
			</div>
		</>
	);
}
