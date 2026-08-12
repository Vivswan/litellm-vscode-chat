/**
 * The dashboard's rendering seam for the redesigned two-part error messages
 * (human headline, "\n", technical detail). Nothing in the webview styles
 * newlines (no pre-line containers), so rendering the raw string collapses
 * the parts into one run-on paragraph; this component splits them with the
 * same shared extraction the host notifier uses for its headline-only toasts
 * and renders the detail as its own dimmed line beneath.
 */

import { statusErrorDetail, statusErrorHeadline } from "../../shared/util/errorText";

export function FailureText({
	message,
	frame,
}: {
	/** The failure message as the extension sent it; may or may not carry a detail part. */
	message: string;
	/** Wraps the headline into the caller's localized sentence; the detail never rides inside it. */
	frame?: (headline: string) => string;
}) {
	const headline = statusErrorHeadline(message);
	const detail = statusErrorDetail(message);
	return (
		<>
			{frame !== undefined ? frame(headline) : headline}
			{detail !== undefined ? <span class="failure-detail">{detail}</span> : null}
		</>
	);
}
