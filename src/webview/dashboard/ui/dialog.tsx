/**
 * The page's confirm modal, for a question an ACTION interrupts: the navigation
 * guard's discard question and the save flow's stale-key question - an
 * interrupt has no in-place anywhere, so it takes the center (unlike the
 * row-level "Confirm remove?" idiom). The trap machinery is slideOver.tsx's
 * Radix recipe (no Overlay, no Portal, Radix's Esc and outside dismissal
 * declined); the Esc handling is tip.tsx's window-capture idiom, because this
 * dialog is the page's top layer NO MATTER WHAT - a hover tip under the scrim
 * holds a capture listener of its own, and a bubble handler here would let it
 * eat the first press. Capture consumes the key for every surface below while
 * a lingering tip's same-node listener still runs, so the tip closes WITH the
 * answering press, never instead of it. The safe verb holds default focus
 * (Enter and Esc agree); the scrim dismisses nothing - an alertdialog wants an
 * explicit answer. On cancel, focus returns to the raising control if it
 * belongs to the surface the question is about, else to the surface itself; on
 * confirm (or the alternate verb) the raiser decides what happens to the
 * surface - the discard question unmounts it, the stale-key question may
 * return to it.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useRef } from "react";
import { Button } from "./button";

export function ConfirmDialog({
	question,
	detail,
	confirmLabel,
	alternateLabel,
	cancelLabel,
	surfaceId,
	onConfirm,
	onAlternate,
	onCancel,
}: {
	/** The one-line question naming the dialog; labels, not sentences. */
	question: string;
	/** An optional short fact under the question (1-2 sentences); part of the dialog's description. */
	detail?: string | undefined;
	/** The destructive verb; danger rank, reached only deliberately. */
	confirmLabel: string;
	/** An optional second affirmative verb between cancel and confirm; it takes the PRIMARY rank (the cancel steps down to secondary) while default focus stays on cancel. */
	alternateLabel?: string | undefined;
	/** The safe verb; default focus, so Enter and Esc are the same answer. */
	cancelLabel: string;
	/** The id of the element the question is about; focus returns into it on cancel. */
	surfaceId: string;
	onConfirm: () => void;
	onAlternate?: (() => void) | undefined;
	onCancel: () => void;
}) {
	const questionId = useId();
	const detailId = useId();
	const cancelRef = useRef<HTMLButtonElement>(null);

	// Capture-then-focus, in that order: the opener is whatever held focus
	// BEFORE the dialog took it. Radix's own open/close autofocus is declined
	// below so this stays the one focus policy (the slideOver.tsx pattern).
	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		cancelRef.current?.focus();
		return () => {
			const surface = document.getElementById(surfaceId);
			if (surface === null) {
				// The surface left with the answer (confirm unmounted the page);
				// the navigation that raised the question owns focus now.
				return;
			}
			if (opener?.isConnected === true && surface.contains(opener)) {
				opener.focus();
				return;
			}
			surface.focus();
		};
	}, [surfaceId]);

	// Esc anywhere answers "keep editing" while the question stands; window
	// capture, for the reasons the module note gives. Keyed on the callback so
	// the handler never closes over a stale one.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				onCancel();
			}
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [onCancel]);

	return (
		<Dialog.Root open={true} modal={true}>
			{/* A backdrop, not a control. Radix's modal layer zeroes pointer events on <body>; the
			    stylesheet's .scrim restores them so this div absorbs the clicks it exists to block. */}
			<div className="scrim confirm-scrim" aria-hidden="true" />
			<Dialog.Content
				className="confirm-dialog"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby={questionId}
				aria-describedby={detail !== undefined ? detailId : undefined}
				onOpenAutoFocus={(event) => event.preventDefault()}
				onCloseAutoFocus={(event) => event.preventDefault()}
				// Belt and braces behind the window-capture listener above: if the
				// key somehow reached Radix's own document-capture Esc, its close
				// would bypass onCancel; declined, so the one close path holds.
				onEscapeKeyDown={(event) => event.preventDefault()}
				onInteractOutside={(event) => event.preventDefault()}
			>
				<h3 className="confirm-question" id={questionId}>
					{question}
				</h3>
				{detail !== undefined ? (
					<p className="confirm-detail" id={detailId}>
						{detail}
					</p>
				) : null}
				<div className="confirm-actions">
					{/* With an alternate verb present it takes the primary rank and the
					    safe verb steps down to secondary - the affirmative answer reads
					    first-class while default focus (and Esc) stay on the way out. */}
					<Button ref={cancelRef} variant={alternateLabel !== undefined ? "secondary" : undefined} onClick={onCancel}>
						{cancelLabel}
					</Button>
					{alternateLabel !== undefined && onAlternate !== undefined ? (
						<Button onClick={onAlternate}>{alternateLabel}</Button>
					) : null}
					<Button variant="danger" onClick={onConfirm}>
						{confirmLabel}
					</Button>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
}
