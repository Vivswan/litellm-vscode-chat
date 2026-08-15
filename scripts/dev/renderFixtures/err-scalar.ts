/**
 * A refused scalar write, standing where placement puts it: under the row
 * that posted it. The steps drive the real flow - type a value into the
 * thresholds box, commit with Enter, read the posted request's id off the
 * harness stub, and answer it with a fail envelope quoting that id - so the
 * shot proves the id-to-row claim rather than photographing a hand-placed
 * line. The two-part message keeps its rendering: the localized frame
 * carries the headline, the technical detail renders as its own dimmed line
 * beneath.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	steps: [
		`(() => {
			const box = document.getElementById("setting-usage.alertThresholds-warning");
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
			setter.call(box, "70%");
			box.dispatchEvent(new Event("input", { bubbles: true }));
			box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			const posted = window.__posted.filter((m) => m.method === "setUsageAlertThresholds").pop();
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						kind: "fail",
						id: posted.id,
						method: "setUsageAlertThresholds",
						message:
							"Alert thresholds must be above 0% and at most 100% - enter values like 80% or 0.8.\\nsetting litellm-vscode-chat.usage.alertThresholds: allowed range 0 < value <= 1",
						failureKind: "validation",
					},
				})
			);
			box.scrollIntoView({ block: "center" });
		})()`,
		// The shot's own subject, asserted: the refused write's failure block
		// must stand under the thresholds row, or the render exits green while
		// photographing a page without the thing it exists to show.
		`(() => {
			const row = document.querySelector('.setting-row:has([id="setting-usage.alertThresholds-warning"])');
			const headline = row === null ? null : row.querySelector(".row-diagnostic.sev-blocking .row-diagnostic-headline");
			if (headline === null || headline.textContent.length === 0) {
				throw new Error("The refused write's failure block never rendered under the thresholds row");
			}
		})()`,
	],
	viewport: { width: 1300, height: 900 },
	settleMs: 500,
};

export default fixture;
