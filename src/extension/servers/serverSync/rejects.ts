/**
 * The rejected servers-setting entries that still get a row: one per label nothing accepted holds. Kept apart from
 * the parser module because the verdict owner (syncFailureOverlay.ts) counts these for the webview-side vocabulary
 * suites too, and the parser module reaches the vscode host through the shared settings helpers.
 */

import type { DrawableReject, ServerEntryReport } from "./setting";

/**
 * The rejected entries that stand for a label nothing accepted holds, one per label in setting order. A reject sits
 * in the setting, so it must show somewhere; without a label and a base URL it has no identity to show under.
 *
 *   rejectsWithOwnRow               -> the Misconfigured rows the dashboard draws and the verdict counts, and
 *                                      Configuration diagnostics drop exactly the problems those rows state
 *   rowBoundWrite.ts carriersOfRow  -> the row a removal or declare acts for, when no accepted entry holds the label
 */
export function drawableRejects(
	entryReports: readonly ServerEntryReport[],
	acceptedLabels: ReadonlySet<string>
): readonly DrawableReject[] {
	const drawn = new Set<string>();
	const rows: DrawableReject[] = [];
	for (const report of entryReports) {
		if (
			report.accepted ||
			report.label === undefined ||
			report.baseUrl === undefined ||
			acceptedLabels.has(report.label) ||
			drawn.has(report.label)
		) {
			continue;
		}
		drawn.add(report.label);
		rows.push({ ...report, label: report.label, baseUrl: report.baseUrl });
	}
	return rows;
}

/** The rejected entries drawn as Misconfigured rows beside the accepted (declared) ones. */
export function rejectsWithOwnRow(
	entryReports: readonly ServerEntryReport[],
	declared: readonly { readonly label: string }[]
): readonly DrawableReject[] {
	return drawableRejects(entryReports, new Set(declared.map((view) => view.label)));
}
