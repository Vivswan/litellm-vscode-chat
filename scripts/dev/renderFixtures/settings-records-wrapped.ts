/**
 * The settings record editors at a width where their rows have to wrap. Two
 * things must be legible: no cell overlaps another, and every pencil sits the
 * same distance from the row's end rather than landing mid-line.
 *
 * 480px is the width where ALL SIX rows wrap under either rail width (216px
 * fixed leaves a 264px pane; the collapsed rail leaves 432px), which is what
 * the subject requires - the middle of the band is the trap, since a width
 * leaving some rows wrapped and some not photographs a muddle a reviewer cannot
 * read. A record row's floor is one chip's own min-content, so the rail's
 * collapse does not lift the rows out of wrapping; re-measure rather than reason
 * if the row's contents or the rail change again.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	viewport: { width: 480, height: 2000 },
};

export default fixture;
