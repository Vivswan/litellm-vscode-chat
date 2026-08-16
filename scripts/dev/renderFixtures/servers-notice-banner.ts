/**
 * The Servers page's two outcome surfaces that pad a compact Dismiss: the
 * post-hide guidance notice and a failure banner. Both size their numbers
 * against the Dismiss button's INK rather than its box, because the Button
 * primitive hands its horizontal padding back to the layout.
 *
 * The banner is delivered as the fail envelope a rejected save produces
 * (useIntentOutcome matches on the method, so the id needs no live request).
 * The notice is EARNED by arming and confirming Remove, because it renders only
 * once the hide intent's own requestId is acked and a synthetic id would never
 * match; the ack is dispatched from the request the page itself sent.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, EXTERNAL_SERVER, PROD_SERVER } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState({ servers: [PROD_SERVER, EXTERNAL_SERVER] }) },
		{ kind: "focusSection", section: "overview" },
		{
			kind: "fail",
			id: "render-1",
			method: "saveServerSetting",
			message:
				"The entry for prod could not be written: settings.json is open with unsaved edits that conflict with this change. Save or revert the file, then save the server again.",
			failureKind: "operation",
		},
	],
	steps: [
		// Arm Remove on the external row, then confirm: for an external group
		// that posts hideExternalServer. Two steps so React commits the arm
		// before the confirm control is queried.
		`(() => {
			const arm = Array.from(document.querySelectorAll(".server-actions button")).find(
				(candidate) => candidate.getAttribute("aria-label") === "Remove ${EXTERNAL_SERVER.label}"
			);
			if (!arm) { throw new Error("no Remove control on the external row"); }
			arm.click();
		})()`,
		`(() => {
			const confirm = Array.from(document.querySelectorAll(".server-actions button")).find(
				(candidate) => candidate.textContent?.trim() === "Confirm remove?"
			);
			if (!confirm) { throw new Error("arming Remove revealed no confirm control"); }
			confirm.click();
		})()`,
		// Ack the hide request the page just posted, by its own id: the notice
		// renders only when the ack's id matches the posted intent's.
		`(() => {
			const posted = (window.__posted ?? []).find((message) => message?.method === "hideExternalServer");
			if (!posted) { throw new Error("confirming Remove posted no hideExternalServer request"); }
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { kind: "ack", id: posted.id, method: "hideExternalServer" },
				})
			);
		})()`,
		// Throw rather than photograph a page missing either subject. The
		// SUBJECTS are counted, not just their containers: both surfaces exist
		// to photograph where the compact Dismiss's ink lands beside a
		// default-size neighbour or a padded edge, and a toolbar with one
		// button or a banner without its Dismiss would otherwise pass as a
		// large, green, successful screenshot of nothing.
		`(() => {
			const toolbarButtons = document.querySelectorAll('.notice .toolbar [data-slot="button"]');
			if (toolbarButtons.length !== 2) {
				throw new Error("expected the notice toolbar's button pair, found " + toolbarButtons.length);
			}
			const bannerButtons = document.querySelectorAll('.banner.banner-error [data-slot="button"]');
			if (bannerButtons.length !== 1) {
				throw new Error("expected the banner's one Dismiss, found " + bannerButtons.length);
			}
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 900 },
};

export default fixture;
