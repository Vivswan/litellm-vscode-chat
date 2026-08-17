/**
 * A refused scalar write, standing where placement puts it: in the posting row's
 * covered description slot. The steps drive the real flow - type a value, commit
 * with Enter, read the posted request's id off the harness stub, answer it with
 * a fail envelope that quotes the id to reach that request and names the row -
 * so the shot proves the named row places the notice rather than photographing
 * a hand-placed line. The slot carries the framed headline only, over the
 * description it covers.
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
						row: "usage.alertThresholds",
					},
				})
			);
			box.scrollIntoView({ block: "center" });
		})()`,
		// The shot's own subject, asserted, or the render exits green while
		// photographing a page without the thing it exists to show. The overlay is
		// identified by NOT carrying the row's parse-error id: the two share the
		// slot and the .error class, and only the parse error is pointed at by the
		// inputs' aria-describedby. Asserting on the injected message rather than
		// the localized frame keeps the guard off the translated string.
		`(() => {
			const row = document.querySelector('.setting-row:has([id="setting-usage.alertThresholds-warning"])');
			const overlay = row === null ? null : row.querySelector(".setting-hint .setting-cover > span.error:not([id])");
			if (overlay === null || !overlay.textContent.includes("Alert thresholds must be above 0%")) {
				throw new Error("The refused write never rendered in the thresholds row's description slot");
			}
			const twin = row.querySelector(".setting-hint .setting-twin .setting-desc");
			if (twin === null) {
				throw new Error("The refused write is not covering: no resting twin holds the description slot's box");
			}
			if (overlay.textContent.includes("allowed range")) {
				throw new Error("The refused write's technical detail line leaked into the covered slot");
			}
			const glyph = row.querySelector(".setting-hint .setting-live button.help");
			if (glyph === null || glyph.getBoundingClientRect().width <= 0) {
				throw new Error("The row's help glyph is not painted at the overlay text's tail");
			}
		})()`,
	],
	viewport: { width: 1300, height: 900 },
	settleMs: 500,
};

export default fixture;
