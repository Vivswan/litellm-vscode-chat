/**
 * The Usage tab with rows open: the labelled inventory a line expands onto,
 * over a fully reported server (prod) and two whose numbers are partly or
 * wholly missing (gateway's proxy serves no activity endpoint, locked-down's
 * key may not read its own usage). The point of the shot is the absence
 * rendering - a dim dash plus the reason in place, never a zero.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "usage" },
	],
	steps: [
		`(() => {
			const lines = Array.from(document.querySelectorAll(".usage-line"));
			for (const index of [0, 1, 4]) {
				lines[index]?.click();
			}
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 1100 },
};

export default fixture;
