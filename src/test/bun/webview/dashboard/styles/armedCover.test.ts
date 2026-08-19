import { expect, test } from "bun:test";
import { type Block, blocks, compileDashboard } from "./compileStyles";

/**
 * The armed Remove cover's alignment resets: an absolutely positioned grid child inherits the resting cluster's
 * self-alignment into its sizing, banding the cover mid-row or leaving the row's first characters beside it.
 * happy-dom runs no cascade, so the compiled sheet is what this suite can pin; the rendered claim lives in
 * check-geometry's armed-cover pairs, whose floor twin reaches the sub-400 tier through the paneWidth knob and
 * asserts the cover fills the row on both axes.
 *
 * The pin is cascade-aware without emulating one: it sweeps EVERY rule outside the width tiers whose subject
 * compound can target the cluster (any combinator context, any specificity, feature queries included) and
 * asserts each property family - longhands and their shorthands together, `all` banned outright - is declared
 * exactly where expected. A higher-specificity `.server-item .server-actions.armed { place-self: ... }` or an
 * `inset:` respelling lands in a family and fails the equality; the width tiers, which rewrite the cover on
 * purpose, are the one deferred scope and are check-geometry's to measure.
 */

/**
 * One selector list split at TOP-LEVEL commas only: a comma inside `:is(.a, .b)` does not cut the part, where a
 * naive split would strand `.b) > .server-actions` as a fragment whose subject reads as nothing.
 */
function selectorParts(prelude: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;
	for (const char of prelude) {
		if (char === "(" || char === "[") {
			depth += 1;
		} else if (char === ")" || char === "]") {
			depth -= 1;
		} else if (char === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * The last compound of one complex selector - what the rule actually targets - with the arguments of `:has()` and
 * `:not()` and the contents of attribute selectors blanked. The compound split walks nesting depth, so a
 * combinator or comma inside a functional pseudo does not cut the compound. The blanking is selective on purpose:
 * a `.server-actions` inside the subject's own `:is()`/`:where()` can BE the cluster and must keep the rule in
 * scope, while one inside `:has()`/`:not()` names a different element (or its absence) and must not claim it.
 */
function subjectOf(part: string): string {
	const compounds: string[] = [];
	let current = "";
	let depth = 0;
	for (const char of part.trim()) {
		if (char === "(" || char === "[") {
			depth += 1;
		} else if (char === ")" || char === "]") {
			depth -= 1;
		} else if (depth === 0 && /[\s>+~]/.test(char)) {
			if (current.length > 0) {
				compounds.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current.length > 0) {
		compounds.push(current);
	}
	const subject = compounds.at(-1) ?? "";
	// Blank what cannot make the subject the cluster: :has()/:not() arguments and [attr] contents.
	let blanked = "";
	let blankDepth = 0;
	for (const char of subject) {
		if (char === "(" || char === "[") {
			if (blankDepth > 0) {
				blankDepth += 1;
				continue;
			}
			if (char === "[" || /:(?:has|not)$/i.test(blanked)) {
				blankDepth = 1;
			}
			blanked += char;
			continue;
		}
		if (char === ")" || char === "]") {
			if (blankDepth > 0) {
				blankDepth -= 1;
				if (blankDepth === 0) {
					blanked += char;
				}
				continue;
			}
			blanked += char;
			continue;
		}
		if (blankDepth === 0) {
			blanked += char;
		}
	}
	return blanked;
}

const TARGETS_CLUSTER = /\.server-actions(?![\w-])/;

/** A width tier: the one scope this pin defers, because the tiers rewrite the cover deliberately. */
const WIDTH_SCOPED = /^@(?:container|media)\b[^{]*\bwidth\b/;

/**
 * Every compiled rule outside the width tiers whose selector subject targets the actions cluster. Feature
 * queries (forced-colors, reduced-motion) stay IN scope: check-geometry measures the width tiers but never
 * those, so excluding them would leave a place-self inside forced-colors caught by nothing.
 */
async function clusterRules(): Promise<readonly Block[]> {
	return blocks(await compileDashboard()).filter(
		(block) =>
			!block.prelude.startsWith("@") &&
			!block.context.some((prelude) => WIDTH_SCOPED.test(prelude)) &&
			selectorParts(block.prelude).some((part) => TARGETS_CLUSTER.test(subjectOf(part)))
	);
}

/**
 * Each family declaration across the rules, in cascade (source) order, tagged with the first cluster-targeting
 * selector part of its rule. Families bundle longhands with the shorthands that reset them, so `place-self`
 * cannot slip past an `align-self` pin.
 */
function familyDeclarations(rules: readonly Block[], family: RegExp): { selector: string; declaration: string }[] {
	return rules.flatMap((rule) => {
		const selector =
			selectorParts(rule.prelude)
				.map((part) => part.replace(/\s+/g, " "))
				.find((part) => TARGETS_CLUSTER.test(subjectOf(part))) ?? rule.prelude;
		return rule.body
			.split(";")
			.map((declaration) => declaration.replace(/\s+/g, " ").trim())
			.filter((declaration) => family.test(declaration))
			.map((declaration) => ({ selector, declaration }));
	});
}

const ALIGNMENT_FAMILY = /^(?:place-self|align-self|justify-self):/;
const POSITION_FAMILY = /^position:/;
/** The vertical box offsets and every shorthand that can set them; inset-inline stays horizontal. */
const INSET_FAMILY = /^(?:inset|inset-block|inset-block-start|inset-block-end|top|bottom):/;
/** `all` resets every family at once, so no cluster-targeting rule may declare it at all. */
const ALL_SHORTHAND = /^all:/;

test("the resting actions cluster still aligns itself, which is what the cover has to reset", async () => {
	// The premise of the cover's resets: if the cluster stops aligning itself, the reset rules become cargo. The
	// compiler collapses the cluster's align-self and justify-self into one place-self, which is what ships.
	const alignment = familyDeclarations(await clusterRules(), ALIGNMENT_FAMILY);
	expect(alignment[0]).toEqual({ selector: ".server-actions", declaration: "place-self: center end" });
});

test("the armed cover's resets are the only other self-alignment, position, and offset words in scope", async () => {
	// Exact equality over the whole scope: a third alignment declaration anywhere that can reach the cluster -
	// whatever its specificity, longhand or shorthand - shows up as an extra row here. Between the two pinned
	// rows, `.server-actions.armed`'s longhand outranks the resting shorthand by specificity, by construction.
	const rules = await clusterRules();
	expect(familyDeclarations(rules, ALIGNMENT_FAMILY)).toEqual([
		{ selector: ".server-actions", declaration: "place-self: center end" },
		{ selector: ".server-actions.armed", declaration: "align-self: stretch" },
	]);
	expect(familyDeclarations(rules, POSITION_FAMILY)).toEqual([
		{ selector: ".server-actions.armed", declaration: "position: absolute" },
	]);
	// inset-block: 0 as the compiler expands it.
	expect(familyDeclarations(rules, INSET_FAMILY)).toEqual([
		{ selector: ".server-actions.armed", declaration: "top: 0" },
		{ selector: ".server-actions.armed", declaration: "bottom: 0" },
	]);
	expect(familyDeclarations(rules, ALL_SHORTHAND)).toEqual([]);
});
