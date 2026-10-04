/**
 * The emitted stylesheet's cascade contract, checked where the separately compiled sheets meet. The Tailwind entry
 * declares the layer order and each plain sheet wraps its rules in one named layer; the sheets cannot share the
 * name, so the bundle holds the two halves together here. Free of import.meta on purpose, like cssBlocks.ts: the
 * scripts tsconfig type-checks under CommonJS output, which bans the meta-property.
 */
import { type Block, blocks } from "../../src/test/bun/webview/dashboard/styles/cssBlocks";

/** The entry's own layers a plain sheet's layer must rank above: Tailwind's tokens and the hand-written reset. */
const FLOOR_LAYERS = ["theme", "base"] as const;

/** The one layer a plain sheet's layer must rank below: a utility class beats a stylesheet rule's normal declarations. */
const CEILING_LAYER = "utilities";

/** A `@layer` block's prelude; the name is absent for an anonymous `@layer {`. */
const LAYER_PRELUDE = /^@layer(?:\s+([^\s{]+))?$/;

/**
 * For normal declarations, a utility class beats a dashboard rule and a dashboard rule beats the entry's theme
 * tokens and base reset (`!important` inverts layer order, which the base `[hidden]` rule relies on). CSS ranks
 * layers by first mention and puts an unmentioned one last, so a renamed, reordered, or missing wrap silently moves
 * the whole dashboard sheet with every style suite green: above utilities, or below the base element rules that
 * then overwrite a dashboard button's own font size with the inherited one. This gate is what fails instead.
 * Exactly one wrap per plain sheet, nothing outside it, and no layer nested inside it: the dashboard sheet settles
 * its equal-specificity arguments by source order inside one flat layer, an unlayered rule would outrank every
 * layer, and a nested layer ranks below its parent's own declarations.
 */
export function assertLayersOrdered(pieces: readonly string[]): void {
	const [first = "", ...rest] = pieces;
	// One text for both scans, so a statement's offset and a block's offset compare: string literals emptied first
	// (a `content: "@layer x;"` is not a mention), then comments out.
	const entry = first.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""').replace(/\/\*[\s\S]*?\*\//g, "");
	const entryBlocks = blocks(entry);
	const mentions: { readonly name: string; readonly at: number; readonly condition: string | undefined }[] = [];
	// A dotted name or a mention inside an `@layer` block names a sub-layer, and the first mention of `a.b` is also
	// the first mention of `a`: every ancestor it implies ranks at that offset (parents pushed first, and the sort
	// below is stable). A grouping rule (`@media`, `@supports`, `@container`) opens no layer but makes the mention
	// conditional: the order a media or supports query establishes holds only where it matches, and a container query
	// is settled per element, so the entry declares its order at the top level and a first mention under one fails.
	const mention = (names: string, enclosing: readonly string[], at: number): void => {
		const prefix: string[] = [];
		let condition: string | undefined;
		for (const prelude of enclosing) {
			const match = LAYER_PRELUDE.exec(prelude);
			if (match === null) {
				condition ??= prelude;
				continue;
			}
			if (match[1] === undefined) {
				// Inside an anonymous layer nothing can be named from outside, so nothing here ranks a named layer.
				return;
			}
			prefix.push(match[1]);
		}
		for (const name of names.split(",")) {
			const segments = [...prefix, ...name.trim().split(".")];
			for (let depth = 1; depth <= segments.length; depth++) {
				mentions.push({ name: segments.slice(0, depth).join("."), at, condition });
			}
		}
	};
	for (const block of entryBlocks) {
		const name = LAYER_PRELUDE.exec(block.prelude)?.[1];
		if (name !== undefined) {
			mention(name, block.context, block.start);
		}
	}
	for (const match of entry.matchAll(/@layer\s+([^{;]+);/g)) {
		mention(match[1] ?? "", enclosingChain(entryBlocks, match.index), match.index);
	}
	const rank: string[] = [];
	for (const item of mentions.sort((a, b) => a.at - b.at)) {
		if (rank.includes(item.name)) {
			continue;
		}
		if (item.condition !== undefined) {
			throw new Error(
				`[CSS_ERROR] the Tailwind entry first mentions @layer ${item.name} inside \`${item.condition}\`; the layer order is declared at the top level, outside every grouping rule`
			);
		}
		rank.push(item.name);
	}
	const order = `the Tailwind entry's layer order (${rank.join(", ")})`;
	const ceiling = rank.indexOf(CEILING_LAYER);
	if (ceiling === -1) {
		throw new Error(
			`[CSS_ERROR] the Tailwind entry mentions no ${CEILING_LAYER} layer; the cascade contract has nothing to hold`
		);
	}
	for (const piece of rest) {
		const wraps = blocks(piece).filter((block) => LAYER_PRELUDE.test(block.prelude));
		const wrap = wraps[0];
		if (wrap === undefined || wraps.length !== 1 || wrap.context.length !== 0) {
			throw new Error(
				`[CSS_ERROR] a plain stylesheet must wrap its rules in exactly one top-level @layer; found ${wraps.length}`
			);
		}
		const name = LAYER_PRELUDE.exec(wrap.prelude)?.[1];
		if (name === undefined) {
			throw new Error(
				"[CSS_ERROR] a plain stylesheet's @layer wrap is anonymous, so the Tailwind entry cannot order it"
			);
		}
		const outside = blocks(piece).filter((block) => block.context.length === 0 && block.start !== wrap.start);
		if (outside.length > 0) {
			throw new Error(
				`[CSS_ERROR] a plain stylesheet keeps every rule inside its @layer ${name} wrap; found ${outside.length} outside it, where unlayered rules outrank every layer: ${outside.map((block) => block.prelude).join("; ")}`
			);
		}
		// A sub-layer ranks where its top-level parent does, so a dotted wrap is ordered by its first segment.
		const position = rank.indexOf(name.split(".")[0] ?? name);
		if (position === -1 || position >= ceiling) {
			throw new Error(`[CSS_ERROR] @layer ${name} does not rank below ${CEILING_LAYER} in ${order}`);
		}
		for (const floor of FLOOR_LAYERS) {
			const floorPosition = rank.indexOf(floor);
			if (floorPosition !== -1 && position <= floorPosition) {
				throw new Error(`[CSS_ERROR] @layer ${name} does not rank above ${floor} in ${order}`);
			}
		}
	}
}

/** The preludes of the blocks around offset `at`, outermost first; empty at the top level. */
function enclosingChain(all: readonly Block[], at: number): readonly string[] {
	const innermost = all
		.filter((block) => block.start <= at && at < block.end)
		.reduce<Block | undefined>(
			(inner, block) => (inner === undefined || block.start > inner.start ? block : inner),
			undefined
		);
	return innermost === undefined ? [] : [...innermost.context, innermost.prelude];
}
