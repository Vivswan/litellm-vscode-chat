/**
 * The emitted stylesheet's cascade contract, checked where the separately compiled sheets meet. The Tailwind entry
 * declares the layer order and each plain sheet wraps its rules in one named layer; two source files cannot share
 * one constant for the name, so the bundle holds the two halves together here. Lightning CSS parses each sheet and
 * decides what is a rule: comments are gone and a `content: "@layer x"` is a declaration value, not a mention.
 */
import { type Rule, transform } from "lightningcss";

/** The entry's own layers a plain sheet's layer must rank above: Tailwind's tokens and the hand-written reset. */
const FLOOR_LAYERS = ["theme", "base"] as const;

/**
 * The one layer a plain sheet's layer must rank below: a utility class beats a stylesheet rule's normal declarations.
 */
const CEILING_LAYER = "utilities";

/** One compiled sheet of the bundle, named by the source file it was compiled from. */
export interface CompiledSheet {
	readonly id: string;
	readonly css: string;
}

/**
 * A layer name as Lightning CSS decodes it: one segment per nesting level, so `a.b` is a sub-layer of `a` while an
 * identifier with an escaped dot stays one segment. Names compare segment by segment and join with dots only when
 * printed.
 */
type LayerName = readonly string[];

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
export function assertLayersOrdered(sheets: readonly CompiledSheet[]): void {
	const [entry, ...plain] = sheets;
	const rank = entry === undefined ? [] : layerOrder(entry);
	const rankOf = (name: LayerName): number =>
		rank.findIndex((ranked) => ranked.length === name.length && ranked.every((segment, i) => segment === name[i]));
	const order = `the Tailwind entry's layer order (${rank.map((name) => name.join(".")).join(", ")})`;
	const ceiling = rankOf([CEILING_LAYER]);
	if (ceiling === -1) {
		throw new Error(
			`[CSS_ERROR] ${entry?.id ?? "the Tailwind entry"} mentions no ${CEILING_LAYER} layer; the cascade contract has nothing to hold`
		);
	}
	for (const sheet of plain) {
		const rules = topLevelRules(sheet);
		const wraps = rules.filter((rule) => rule.type === "layer-block");
		const wrap = wraps[0];
		if (wrap === undefined || wraps.length !== 1) {
			throw new Error(
				`[CSS_ERROR] ${sheet.id} must wrap its rules in exactly one top-level @layer; found ${wraps.length}`
			);
		}
		if (wrap.value.name == null) {
			throw new Error(
				`[CSS_ERROR] ${sheet.id} wraps its rules in an anonymous @layer, which the Tailwind entry cannot order`
			);
		}
		const name = wrap.value.name.join(".");
		const outside = rules.filter((rule) => rule !== wrap);
		if (outside.length > 0) {
			throw new Error(
				`[CSS_ERROR] ${sheet.id} keeps every rule inside its @layer ${name} wrap; found ${outside.length} outside it, where unlayered rules outrank every layer: ${outside.map((rule) => prelude(sheet, rule)).join("; ")}`
			);
		}
		const nested = nestedLayer(wrap.value.rules);
		if (nested !== undefined) {
			throw new Error(
				`[CSS_ERROR] ${sheet.id} nests ${prelude(sheet, nested)} inside its @layer ${name} wrap, where it ranks below the wrap's own declarations`
			);
		}
		// A sub-layer ranks where its top-level parent does, so a dotted wrap is ordered by its first segment.
		const position = rankOf(wrap.value.name.slice(0, 1));
		if (position === -1 || position >= ceiling) {
			throw new Error(`[CSS_ERROR] ${sheet.id}: @layer ${name} does not rank below ${CEILING_LAYER} in ${order}`);
		}
		for (const floor of FLOOR_LAYERS) {
			const floorPosition = rankOf([floor]);
			if (floorPosition !== -1 && position <= floorPosition) {
				throw new Error(`[CSS_ERROR] ${sheet.id}: @layer ${name} does not rank above ${floor} in ${order}`);
			}
		}
	}
}

/**
 * The entry's layer names in first-mention order. A layer statement, a layer block, and an `@import` into a layer
 * each mention a name; a dotted name or a layer nested in an `@layer` block names a sub-layer, and the first mention
 * of `a.b` is also the first mention of `a`, so every ancestor it implies ranks there too. Inside an anonymous layer
 * nothing can be named from outside, so nothing there ranks a named layer. Any other enclosing rule, or a condition
 * on the import itself, refuses a FIRST mention, fail closed: under a media or supports query the order holds only
 * where it matches, under a container query it is settled per element, and a layer nested in a style rule orders
 * the entry from a place no reader looks. The entry declares its order at the top level, so none is lost.
 */
function layerOrder(entry: CompiledSheet): LayerName[] {
	const rank: LayerName[] = [];
	const mention = (name: LayerName, enclosing: Rule | undefined): void => {
		for (let depth = 1; depth <= name.length; depth++) {
			const layer = name.slice(0, depth);
			if (rank.some((ranked) => ranked.length === depth && ranked.every((segment, i) => segment === layer[i]))) {
				continue;
			}
			if (enclosing !== undefined) {
				throw new Error(
					`[CSS_ERROR] ${entry.id} first mentions @layer ${layer.join(".")} inside ${prelude(entry, enclosing)}; the layer order is declared at the top level, inside no other block`
				);
			}
			rank.push(layer);
		}
	};
	const walk = (rules: readonly Rule[], prefix: LayerName, enclosing: Rule | undefined): void => {
		for (const rule of rules) {
			if (rule.type === "layer-statement") {
				for (const name of rule.value.names) {
					mention([...prefix, ...name], enclosing);
				}
			} else if (rule.type === "import") {
				// An import qualified by a media or supports condition mentions its layer only where the condition holds.
				const conditional = rule.value.supports != null || (rule.value.media?.mediaQueries.length ?? 0) > 0;
				if (Array.isArray(rule.value.layer)) {
					mention([...prefix, ...rule.value.layer], enclosing ?? (conditional ? rule : undefined));
				}
			} else if (rule.type === "layer-block") {
				if (rule.value.name != null) {
					const name = [...prefix, ...rule.value.name];
					mention(name, enclosing);
					walk(rule.value.rules, name, enclosing);
				}
			} else {
				walk(childRules(rule), prefix, enclosing ?? rule);
			}
		}
	};
	walk(topLevelRules(entry), [], undefined);
	return rank;
}

/** The first `@layer` statement or block under `rules` at any depth, or undefined when there is none. */
function nestedLayer(rules: readonly Rule[]): Rule | undefined {
	for (const rule of rules) {
		if (rule.type === "layer-statement" || rule.type === "layer-block") {
			return rule;
		}
		const inner = nestedLayer(childRules(rule));
		if (inner !== undefined) {
			return inner;
		}
	}
	return undefined;
}

/** The rules a grouping or style rule encloses; empty for a rule that encloses none. */
function childRules(rule: Rule): readonly Rule[] {
	switch (rule.type) {
		case "media":
		case "supports":
		case "container":
		case "scope":
		case "starting-style":
		case "moz-document":
		case "layer-block":
			return rule.value.rules;
		case "style":
			return rule.value.rules ?? [];
		case "nesting":
			return rule.value.style.rules ?? [];
		default:
			return [];
	}
}

/** A sheet's top-level rules in source order, as Lightning CSS parsed them; a sheet that does not parse fails here. */
function topLevelRules(sheet: CompiledSheet): readonly Rule[] {
	let rules: readonly Rule[] = [];
	try {
		transform({
			filename: sheet.id,
			code: Buffer.from(sheet.css),
			visitor: {
				StyleSheet(stylesheet) {
					rules = stylesheet.rules;
				},
			},
		});
	} catch (error) {
		throw new Error(
			`[CSS_ERROR] ${sheet.id} does not parse: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	return rules;
}

/**
 * A rule's prelude as written in the sheet, for a failure message: the source line from where the parser places the
 * rule (a zero-based line counted over CSS newlines, so a lone carriage return or form feed ends a line too, and a
 * one-based column), cut at the first brace or semicolon. The cut is an excerpt, not a parse: a brace or semicolon
 * inside a quoted selector value shortens it, and the parser exposes no end offset.
 */
function prelude(sheet: CompiledSheet, rule: Rule): string {
	if (!("value" in rule) || rule.value === null || !("loc" in rule.value)) {
		return `a ${rule.type} rule`;
	}
	const { line, column } = rule.value.loc;
	const written = sheet.css.split(/\r\n|[\n\r\f]/)[line]?.slice(column - 1) ?? "";
	return `\`${(written.split(/[{;]/, 1)[0] ?? "").trim()}\``;
}
