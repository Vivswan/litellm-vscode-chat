/**
 * The claim, precisely: no second minter of THIS vocabulary. A band-like presentation under classes of its own (the
 * drawer notice is the one sanctioned instance) and host-side markup outside the scanned trees are design-review
 * territory, not this guard's.
 *
 *   three band presentations once coexisted on one Servers page
 *     -> the vocabulary now has ONE minter
 *   problemBand.tsx is the only source that may mint the band root class or a paint tier, and the compiled sheet may
 *   only paint tiers through the pipeline's own compound selectors
 *     -> a fourth variant has to edit the pipeline, where the mapping is one table
 *
 * The source leg is a grep guard, so a determined concatenation ("row-" + "diagnostic") can evade it; the compiled-CSS
 * leg still pins what such a class could paint, and honest code fails the source leg with the file to fix.
 */
import { expect, test } from "bun:test";
import { shippedSources } from "../../../sourceScan";
import { compileDashboard, rulesFor } from "./styles/compileStyles";
import { blocks } from "./styles/cssBlocks";

/** The one source allowed to mint the band vocabulary. */
const PIPELINE = "src/webview/dashboard/problemBand.tsx";

/** The webview bundle is built from these source trees, so a stray mint can only land in them. */
const WEBVIEW_BUNDLE_TREES = ["webview", "dashboard", "shared"] as const;

/** The band root class as its own token; its structural children (.row-diagnostic-headline and kin) stay mintable. */
const BAND_ROOT = /row-diagnostic(?![\w-])/;

/** A paint tier class as the compiled sheet spells it. */
const TIER_CLASS = /\btier-(?:error|warn|advisory)\b/;

/** What a source file writes to mint a tier: the literal class, or the pipeline's own `tier-${...}` template shape. */
const TIER_MINT = /\btier-(?:error|warn|advisory)\b|tier-\$\{/;

/** Class names of the retired band presentations, which must not creep back. */
const RETIRED = /\bsev-(?:blocking|degraded|advisory)\b|spend-error/;

test("only problemBand.tsx mints the band vocabulary", () => {
	const sources = shippedSources(WEBVIEW_BUNDLE_TREES);
	const offenders: string[] = [];
	for (const { file, text } of sources) {
		if (file === PIPELINE) {
			continue;
		}
		for (const [what, pattern] of [
			["the band root class", BAND_ROOT],
			["a paint tier class", TIER_MINT],
			["a retired band class", RETIRED],
		] as const) {
			if (pattern.test(text)) {
				// Comments count on purpose: a comment naming a retired class is rot.
				offenders.push(`${file} mints ${what} (comments count); render through problemBand.tsx instead`);
			}
		}
	}
	expect(offenders).toEqual([]);
	// The positive control: the pipeline itself still mints both halves of the vocabulary, so an empty scan above
	// cannot mean the vocabulary moved.
	const pipeline = sources.find((source) => source.file === PIPELINE);
	expect(pipeline).toBeDefined();
	expect(pipeline?.text).toMatch(BAND_ROOT);
	expect(pipeline?.text).toMatch(TIER_MINT);
});

test("the compiled sheet paints tiers only through the pipeline's compound selectors", async () => {
	const css = await compileDashboard();
	for (const block of blocks(css)) {
		if (block.prelude.startsWith("@")) {
			continue;
		}
		for (const part of block.prelude.split(",")) {
			const selector = part.trim();
			if (TIER_CLASS.test(selector)) {
				// A tier class may paint nothing but a band: a bare .tier-* rule is a second scale waiting to drift
				// apart from the pipeline's.
				expect(selector).toMatch(/\.row-diagnostic\.tier-(?:error|warn|advisory)(?![\w-])/);
			}
			expect(selector, "a retired band selector survives in the sheet").not.toMatch(RETIRED);
		}
	}
	// The positive control: the three tiers exist, each with exactly one unconditional paint rule.
	for (const tier of ["error", "warn", "advisory"]) {
		expect(rulesFor(css, `.row-diagnostic.tier-${tier}`).filter((rule) => rule.unconditional)).toHaveLength(1);
	}
});
