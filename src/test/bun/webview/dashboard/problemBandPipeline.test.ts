/**
 * The problem-band pipeline's minting guard, in the status-item slot registry's spirit:
 * three band presentations once coexisted on one Servers page because every surface
 * hand-rolled its own bar and text treatment, so the vocabulary now has ONE minter.
 * problemBand.tsx is the only source that may mint the band root class or a paint tier,
 * and the compiled sheet may only paint tiers through the pipeline's own compound
 * selectors - a fourth variant has to edit the pipeline, where the mapping is one table.
 *
 * The claim, precisely: no second minter of THIS vocabulary. A band-like presentation
 * under classes of its own (the drawer notice is the one sanctioned instance) and
 * host-side markup outside the scanned trees are design-review territory, not this
 * guard's.
 */
import { expect, test } from "bun:test";
import { shippedSources } from "../../../sourceScan";
import { blocks, compileDashboard, rulesFor } from "./styles/compileStyles";

const PIPELINE = "src/webview/dashboard/problemBand.tsx";

/** The trees the webview bundle is built from; the scanner walks only these. */
const WEBVIEW_BUNDLE_TREES = ["webview", "dashboard", "shared"] as const;

// The band root class as its own token: the structural children
// (.row-diagnostic-headline and friends) stay mintable where a surface seats
// its own content, but the CLASS that receives the tier paint may not be.
// A grep guard, so a determined concatenation ("row-" + "diagnostic") can
// evade it - the compiled-CSS leg below still pins what such a class could
// PAINT, and honest code fails here with the file to fix.
const BAND_ROOT = /row-diagnostic(?![\w-])/;
const TIER_CLASS = /\btier-(?:error|warn|advisory)\b/;
// What a SOURCE file writes to mint a tier: the literal class, or the pipeline's own
// template shape - an interpolated `tier-${...}` elsewhere would evade the literal scan.
const TIER_MINT = /\btier-(?:error|warn|advisory)\b|tier-\$\{/;
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
	// The positive control: the pipeline itself still mints both halves of the
	// vocabulary, so an empty scan above cannot mean the vocabulary moved.
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
				// A tier class may paint nothing but a band: a bare .tier-* rule is a
				// second scale waiting to drift apart from the pipeline's.
				expect(selector).toMatch(/\.row-diagnostic\.tier-(?:error|warn|advisory)(?![\w-])/);
			}
			expect(selector, "a retired band selector survives in the sheet").not.toMatch(RETIRED);
		}
	}
	// The positive control: the three tiers exist, each with exactly one
	// unconditional paint rule.
	for (const tier of ["error", "warn", "advisory"]) {
		expect(rulesFor(css, `.row-diagnostic.tier-${tier}`).filter((rule) => rule.unconditional)).toHaveLength(1);
	}
});
