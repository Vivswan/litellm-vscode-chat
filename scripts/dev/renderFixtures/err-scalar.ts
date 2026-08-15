/**
 * A refused scalar write, standing where placement puts it: in the posting
 * row's covered description slot. The steps drive the real flow - type a
 * value into the thresholds box, commit with Enter, read the posted request's
 * id off the harness stub, and answer it with a fail envelope quoting that id
 * - so the shot proves the id-to-row claim rather than photographing a
 * hand-placed line. The slot carries the framed headline only, over the
 * description it covers (the row keeps its height; the detail line stays off
 * this surface, the host notifier's toast rule).
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
		// The shot's own subject, asserted: the refusal must stand in the
		// thresholds row's covered description slot, or the render exits green
		// while photographing a page without the thing it exists to show. The
		// overlay is identified by NOT carrying the row's parse-error id: the
		// two share the slot and the .error class, and only the parse error is
		// pointed at by the inputs' aria-describedby. Asserting on the injected
		// message rather than the localized frame keeps the guard to this
		// fixture's own fail envelope and off the translated string.
		`(() => {
			const row = document.querySelector('.setting-row:has([id="setting-usage.alertThresholds-warning"])');
			const overlay = row === null ? null : row.querySelector(".setting-hint .setting-cover > span.error:not([id])");
			if (overlay === null || !overlay.textContent.includes("Alert thresholds must be above 0%")) {
				throw new Error("The refused write never rendered in the thresholds row's description slot");
			}
			const rest = row.querySelector(".setting-hint > .setting-rest");
			if (rest === null || !rest.classList.contains("invisible")) {
				throw new Error("The refused write did not cover the thresholds row's resting description flow");
			}
			if (overlay.textContent.includes("allowed range")) {
				throw new Error("The refused write's technical detail line leaked into the covered slot");
			}
			const glyph = row.querySelector(".setting-hint .setting-cover button.help");
			if (glyph === null || glyph.getBoundingClientRect().width <= 0) {
				throw new Error("The covered slot's help glyph is not painted at the overlay text's tail");
			}
		})()`,
	],
	viewport: { width: 1300, height: 900 },
	settleMs: 500,
};

export default fixture;
