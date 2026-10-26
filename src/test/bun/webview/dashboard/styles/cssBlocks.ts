/**
 * The brace walk the style suites and the bundle's cascade gate share: every block of a compiled sheet with the
 * at-rules around it. Free of import.meta on purpose - scripts/dev/bundle.mts type-checks it under CommonJS output,
 * which bans the meta-property (the same reason tailwindCliBin.ts anchors on Bun.main).
 */

/**
 * One brace block of a compiled sheet: what opened it, and what is inside. `start` is where the prelude starts in the
 * sheet, and source order settles equal-specificity arguments; `end` is just past the closing brace, so an offset
 * between the two lies inside this block.
 */
export interface Block {
	readonly prelude: string;
	readonly body: string;
	readonly text: string;
	readonly context: readonly string[];
	readonly start: number;
	readonly end: number;
}

/** A block entered and not yet closed: its prelude, the prelude's start, the body's start, and its wrappers. */
interface OpenBlock {
	readonly prelude: string;
	readonly at: number;
	readonly bodyStart: number;
	readonly context: readonly string[];
}

/** The index of the `/` closing the comment opened at `i`; the sheet's end when it never closes, as in a browser. */
function commentClose(css: string, i: number): number {
	const end = css.indexOf("*/", i + 2);
	return end === -1 ? css.length : end + 1;
}

/** The index of the quote closing the string opened at `i`, escapes stepped over; past the sheet's end if unclosed. */
function stringClose(css: string, i: number): number {
	const quote = css[i];
	let j = i + 1;
	for (; j < css.length && css[j] !== quote; j++) {
		if (css[j] === "\\") {
			j++;
		}
	}
	return j;
}

/** Records the innermost open block as closed by the brace at `close`; a stray brace with nothing open is ignored. */
function closeInnermost(css: string, open: OpenBlock[], close: number, found: Block[]): void {
	const opened = open.pop();
	if (opened === undefined) {
		return;
	}
	found.push({
		prelude: opened.prelude,
		body: css.slice(opened.bodyStart, close),
		text: css.slice(opened.at, close + 1).trim(),
		context: opened.context,
		start: opened.at,
		end: close + 1,
	});
}

/**
 * Every brace block in a compiled sheet, with the at-rules around it. Exported so a pin can scope a scan to one
 * layer's rules (the utility collision guard reads only `@layer utilities`).
 *
 *   a `content: "{"` would unbalance the stack -> comments and string literals are stepped over
 */
export function blocks(css: string): readonly Block[] {
	const found: Block[] = [];
	const open: OpenBlock[] = [];
	let preludeStart = 0;
	for (let i = 0; i < css.length; i++) {
		const char = css[i];
		if (char === "/" && css[i + 1] === "*") {
			i = commentClose(css, i);
		} else if (char === '"' || char === "'") {
			i = stringClose(css, i);
		} else if (char === "{") {
			// Comments out of the prelude text too: the bundler puts a file banner ahead of the at-rule it opens, and a
			// prelude carrying one answers to no pattern, reporting a block nested in a width query as unconditional.
			const prelude = css
				.slice(preludeStart, i)
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.trim();
			open.push({ prelude, at: preludeStart, bodyStart: i + 1, context: open.map((entry) => entry.prelude) });
			preludeStart = i + 1;
		} else if (char === "}") {
			closeInnermost(css, open, i, found);
			preludeStart = i + 1;
		} else if (char === ";") {
			preludeStart = i + 1;
		}
	}
	return found;
}
