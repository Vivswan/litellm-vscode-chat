import { expect, test } from "bun:test";
import { blocks, compileDashboard } from "./compileStyles";

/**
 * The armed Remove cover's alignment resets, pinned in the compiled sheet.
 *
 * Arming a server row's Remove takes the confirm pair out of flow and paints
 * it over the row (.server-actions.armed), so nothing in the list moves under
 * the pointer about to confirm. The trap that idiom walks into twice is that
 * an absolutely positioned grid child carries the RESTING cluster's own
 * self-alignment into its sizing: `align-self: center` shrink-to-fit the block
 * axis into a button-high band parked mid-row, and `justify-self: end` did the
 * same on the inline axis at the floor tier, leaving the first character of
 * each of the row's lines standing in the gap beside the cover. Both read as
 * clipped row content rather than as a row held under a question, and both are
 * invisible to a state pair: the cover is out of flow, so it moves nothing.
 *
 * check-geometry's armed pairs assert the block axis at the wide and folded
 * tiers. The floor tier is out of their reach - a pair's steps run before the
 * harness's asserted width, and a platform minimum window hands back a
 * viewport far wider than 320px, so the tier never engages - and happy-dom
 * runs no cascade, which leaves the compiled stylesheet as the one place the
 * floor rule is checkable at all.
 */

const FLOOR_QUERY = "@container pane (width < 400px)";

/** The declarations of every rule whose selector list names exactly `selector`, addressed by the at-rules wrapping it. */
function declarationsFor(css: string, selector: string, within: string | undefined): readonly string[] {
	return blocks(css)
		.filter((block) => block.prelude.split(",").some((part) => part.trim() === selector))
		.filter((block) =>
			within === undefined
				? !block.context.some((prelude) => /^@(?:media|container|supports)\b/.test(prelude))
				: block.context.includes(within)
		)
		.flatMap((block) => block.body.split(";").map((declaration) => declaration.replace(/\s+/g, " ").trim()))
		.filter((declaration) => declaration.length > 0);
}

test("the resting actions cluster still aligns itself, which is what the cover has to reset", async () => {
	// The premise of both resets. If the cluster ever stops aligning itself,
	// the reset rules below become cargo and this suite says so first. The
	// compiler's spelling, not the source's: it collapses the cluster's
	// align-self and justify-self into one place-self, which is the shape the
	// browser is handed.
	const resting = declarationsFor(await compileDashboard(), ".server-actions", undefined);
	expect(resting).toContain("place-self: center end");
});

test("the armed cover resets align-self, so it fills the row's height rather than banding it", async () => {
	const armed = declarationsFor(await compileDashboard(), ".server-actions.armed", undefined);
	expect(armed).toContain("position: absolute");
	// inset-block: 0 as the compiler expands it.
	expect(armed).toContain("top: 0");
	expect(armed).toContain("bottom: 0");
	expect(armed).toContain("align-self: stretch");
});

test("the floor tier's cover resets justify-self and sizes from its insets, so it spans the whole row", async () => {
	// Four declarations that only work together: the grid-column moves the
	// containing block out to the row, the insets and the auto width size the
	// box from it, and justify-self: stretch is what lets an auto-sized box
	// fill instead of shrink-to-fitting at the row's right edge. Dropping any
	// one of them puts the row's first characters back beside the cover.
	const floor = declarationsFor(await compileDashboard(), ".server-actions.armed", FLOOR_QUERY);
	expect(floor).toContain("grid-column: 1 / -1");
	expect(floor).toContain("inset-inline: 0");
	expect(floor).toContain("width: auto");
	expect(floor).toContain("justify-self: stretch");
});
