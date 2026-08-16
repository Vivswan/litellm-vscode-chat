/**
 * The rendering seam for the two-part error messages (headline, "\n", detail):
 * nothing in the webview styles newlines, so this splits with the same shared
 * extraction the host notifier uses and renders the detail as its own dimmed line.
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
			{detail !== undefined ? <span className="failure-detail">{detail}</span> : null}
		</>
	);
}
