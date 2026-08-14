/**
 * The page's confirm modal: a centered alertdialog over a scrim, for a
 * question a NAVIGATION raises (leaving a form with unsaved edits). It is
 * deliberately not the row-level inline "Confirm remove?" idiom - an in-place
 * action confirms in place, where the reader's eye already is; an interrupt
 * to "you are leaving" has no in-place anywhere, so it takes the center of
 * the screen and puts a scrim over everything the answer is about.
 *
 * Built from the page's two existing Esc-and-focus idioms rather than a
 * third. The trap machinery is slideOver.tsx's Radix recipe: no
 * `Dialog.Overlay` (Overlay is where Radix mounts react-remove-scroll, whose
 * injected <style> the CSP refuses - the plain scrim below is the backdrop),
 * no `Dialog.Portal` (nothing here needs to escape a stacking context), and
 * Radix's own document-capture Esc and outside-interaction dismissal both
 * declined so the component owns its one close path. The Esc handling is
 * tip.tsx's window-capture idiom, because while this dialog stands it is the
 * page's top layer NO MATTER WHAT else is open: a hover tip left under the
 * scrim still holds a capture listener of its own, and a bubble handler here
 * would let that tip eat the first press while the reader stares at the
 * question. Capture consumes the key for every surface below (stopPropagation
 * skips every later node, the shell's own navigation-guard Esc included),
 * while a lingering tip's same-node window listener still runs - so the tip
 * closes WITH the press that answers the question, never instead of it.
 *
 * The safe verb holds default focus, so Enter and Esc agree; only a
 * deliberate move reaches the danger verb. Unlike the slide-over's scrim,
 * this one dismisses nothing: an alertdialog asks for an explicit answer, and
 * a misclick beside it must not pick one.
 *
 * On cancel, focus returns to the control that had it when the question was
 * raised IF that control belongs to the surface the question is about (Esc
 * pressed in a form field goes back to the field); otherwise to the surface
 * itself (a rail click raised it, and handing focus back to the rail would
 * say "you left" to a reader who just said "stay"). On confirm the surface
 * unmounts with the dialog, so the cleanup stands down and the navigation
 * that raised the question decides where focus lands.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useRef } from "react";
import { Button } from "./button";

export function ConfirmDialog({
	question,
	confirmLabel,
	cancelLabel,
	surfaceId,
	onConfirm,
	onCancel,
}: {
	/** The one-line question naming the dialog; labels, not sentences. */
	question: string;
	/** The destructive verb; danger rank, reached only deliberately. */
	confirmLabel: string;
	/** The safe verb; default focus, so Enter and Esc are the same answer. */
	cancelLabel: string;
	/** The id of the element the question is about; focus returns into it on cancel. */
	surfaceId: string;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const questionId = useId();
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
			{/* A backdrop, not a control: it only keeps the page below out of
			    reach until the question is answered. Radix's modal layer zeroes
			    pointer events on <body>; the stylesheet's .scrim restores them
			    here so the div actually absorbs the clicks it exists to block. */}
			<div className="scrim confirm-scrim" aria-hidden="true" />
			<Dialog.Content
				className="confirm-dialog"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby={questionId}
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
				<div className="confirm-actions">
					<Button ref={cancelRef} onClick={onCancel}>
						{cancelLabel}
					</Button>
					<Button variant="danger" onClick={onConfirm}>
						{confirmLabel}
					</Button>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
}
