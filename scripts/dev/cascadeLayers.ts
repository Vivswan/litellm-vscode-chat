/**
 * The emitted stylesheet's cascade contract, checked where the separately compiled sheets meet: the Tailwind entry
 * declares the layer order, each plain sheet wraps its rules in one named layer, and two source files cannot share
 * one constant for the name. Lightning CSS parses the compiled sheets; a comment or a string is no rule to it.
 */
import { type Rule, transform } from "lightningcss";

/** A plain sheet's layer ranks above Tailwind's tokens and the hand-written reset, and below the utility classes. */
const FLOORS = ["theme", "base"] as const;
const CEILING = "utilities";

/** One compiled sheet of the bundle, named by the source file it was compiled from. */
type CompiledSheet = { readonly id: string; readonly css: string };

/**
 * CSS ranks layers by first mention and puts an unmentioned one last, so a renamed, reordered, or missing wrap
 * silently moves the whole dashboard sheet with every style suite green: above utilities, or below the base reset
 * whose `button { font-size: inherit }` then overwrites a dashboard button's own size. One wrap per plain sheet and
 * nothing else: an unlayered rule outranks every layer, a nested layer ranks below its parent's declarations, a
 * dotted name is a sub-layer these sheets never declare, and a layer mentioned under any other rule of the entry
 * orders the cascade from a place no reader looks.
 */
export function assertLayersOrdered(sheets: readonly CompiledSheet[]): void {
	const [entry = fail("no Tailwind entry was compiled; the cascade contract has nothing to hold"), ...plain] = sheets;
	const mentioned: string[] = [];
	for (const rule of topLevelRules(entry)) {
		const names = rule.type === "layer-statement" ? rule.value.names : [];
		mentioned.push(...(rule.type === "layer-block" ? [rule.value.name] : names).map((name) => flat(entry.id, name)));
		const hidden = descendants(rule).find(isLayer);
		if (hidden !== undefined) {
			fail(`${entry.id} mentions a layer (${where(hidden)}) under ${where(rule)}, not at the top level`);
		}
	}
	const rank = [...new Set(mentioned)];
	for (const sheet of plain) {
		const rules = topLevelRules(sheet);
		const [wrap] = rules;
		if (wrap === undefined || wrap.type !== "layer-block" || rules.length !== 1) {
			fail(`${sheet.id} must be exactly one top-level @layer block; found ${rules.map(where).join(", ") || "nothing"}`);
		}
		const name = flat(sheet.id, wrap.value.name);
		const nested = descendants(wrap).find(isLayer);
		if (nested !== undefined) {
			fail(`${sheet.id} nests a layer (${where(nested)}) inside its @layer ${name} wrap`);
		}
		const at = (layer: string): number => (rank.includes(layer) ? rank.indexOf(layer) : rank.length);
		const floor = FLOORS.find((layer) => at(name) <= at(layer));
		if (at(name) >= at(CEILING)) {
			fail(`${sheet.id}: @layer ${name} does not rank below ${CEILING} in the entry's order (${rank.join(", ")})`);
		}
		if (floor !== undefined) {
			fail(`${sheet.id}: @layer ${name} does not rank above ${floor} in the entry's order (${rank.join(", ")})`);
		}
	}
}

function fail(message: string): never {
	throw new Error(`[CSS_ERROR] ${message}`);
}

/** A layer name as one segment; the parser gives a dotted sub-layer name several segments and an anonymous one null. */
function flat(id: string, name: readonly string[] | null | undefined): string {
	const [segment, ...rest] = name ?? [];
	const single = rest.length === 0 ? segment : undefined;
	return single ?? fail(`${id}: @layer ${name?.join(".") ?? "(anonymous)"} is not one flat name`);
}

const isLayer = (rule: Rule): boolean => rule.type === "layer-statement" || rule.type === "layer-block";

/** Every rule under `rule` at any depth; the parser nests them under `value.rules` (`value.style.rules` in `@nest`). */
function descendants(rule: Rule): readonly Rule[] {
	const value = (rule as { value?: { rules?: unknown; style?: { rules?: unknown } } }).value;
	const inner = value?.rules ?? value?.style?.rules;
	return Array.isArray(inner) ? (inner as readonly Rule[]).flatMap((child) => [child, ...descendants(child)]) : [];
}

/** A rule for a message: its kind and its line; the parser counts `loc.line` from zero and gives every rule one. */
const where = (rule: Rule): string =>
	`${rule.type} at line ${((rule as { value?: { loc?: { line: number } } }).value?.loc?.line ?? -1) + 1}`;

/** A sheet's top-level rules in source order; a sheet the parser rejects fails here, named. */
function topLevelRules({ id, css }: CompiledSheet): readonly Rule[] {
	const rules: Rule[] = [];
	try {
		transform({ filename: id, code: Buffer.from(css), visitor: { StyleSheet: (s) => void rules.push(...s.rules) } });
	} catch (error) {
		fail(`${id} does not parse: ${error instanceof Error ? error.message : String(error)}`);
	}
	return rules;
}
