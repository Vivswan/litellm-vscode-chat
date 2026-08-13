/**
 * The settings record editors at a width where their rows have to wrap.
 *
 * The shot exists because the row's cells were being squeezed rather than
 * wrapped. `.chip-list` is the flexible cell, and with a zero floor the flex
 * algorithm shrank its box below the width of a single chip - which a chip
 * cannot match, so the chips overflowed and painted over the inherit summary
 * and the pencil beside them, running "force" and "inherits nothing" together
 * into one unreadable word. Measured before the fix, at a comparable pane: the
 * content overran its box by 39 to 223 pixels, on every row.
 *
 * Two things are meant to be legible here, and they are the two the fix is
 * answerable for: no cell overlaps another, and every pencil sits the same
 * distance from the row's end rather than landing mid-line wherever its row
 * happened to break.
 *
 * The width is chosen to survive the rail, which is the part worth explaining.
 * Today the rail is a fixed 216px, so this viewport leaves a 264px pane;
 * wp-narrow's held work collapses it to 48px below a 1000px window, which would
 * leave 432px. The rows wrap in both, measured both ways - a record row's floor
 * is one chip's own min-content, so it keeps wrapping until the pane clears
 * roughly 500px, and under the collapsed rail the wrapping only stops somewhere
 * between a 560px and a 640px viewport. A width that only worked under today's
 * rail would have been a fixture with a known expiry, quietly photographing the
 * unwrapped case the moment the rail landed and still passing.
 *
 * Expect the PNG to come out wider than the viewport. That same min-content
 * floor means a long field name plus its value overflows the pane horizontally
 * here, and a full-page capture is as wide as the document. The dead strip on
 * the right is the overflow being honest, not the harness misbehaving.
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
