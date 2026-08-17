import { expect, test } from "bun:test";
import { blocks, compileDashboard } from "./compileStyles";

/**
 * The armed Remove cover's alignment resets: an absolutely positioned grid child inherits the resting cluster's
 * self-alignment into its sizing, banding the cover mid-row or leaving the row's first characters beside it.
 * happy-dom runs no cascade, so the compiled sheet is what this suite can pin; the rendered claim lives in
 * check-geometry's armed-cover pairs, whose floor twin reaches the sub-400 tier through the paneWidth knob and
 * asserts the cover fills the row on both axes.
 */

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
	// The premise of the cover's resets: if the cluster stops aligning itself, the reset rules become cargo. The
	// compiler collapses the cluster's align-self and justify-self into one place-self, which is what ships.
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
