/**
 * The class names a spend tone paints with. The tone itself comes from
 * src/dashboard/spendFormat.ts (shared with the status bar); only the CSS
 * embodiment lives webview-side.
 */

import type { SpendTone } from "../../dashboard/spendFormat";

/** The severity a tone paints text with; the meter fill reads the same scale. */
export const TONE_TEXT: Readonly<Record<SpendTone, string>> = {
	ok: "text-ok",
	warn: "text-warn",
	error: "text-err",
};

/**
 * The meter's fill takes the fill tier: a bar is a shape (3:1), a word must clear AA.
 * Both tiers move only on light surfaces, where the raw hues were tuned for a dark
 * editor (healthy green measured 2.0:1 on light). The `-fill` names are explicit on
 * purpose: `bg-ok` still compiles and would paint the meter in the text colour.
 */
export const TONE_FILL: Readonly<Record<SpendTone, string>> = {
	ok: "bg-ok-fill",
	warn: "bg-warn-fill",
	error: "bg-err-fill",
};
