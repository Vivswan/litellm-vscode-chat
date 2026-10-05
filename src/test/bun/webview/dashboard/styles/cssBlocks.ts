/**
 * The brace walk the style suites and the bundle's cascade gate share: every block of a compiled sheet with the
 * at-rules around it. Free of import.meta on purpose - scripts/dev/bundle.mts type-checks it under CommonJS output,
 * which bans the meta-property (the same reason tailwindCliBin.ts anchors on Bun.main).
 */

/** One brace block of a compiled sheet: what opened it, and what is inside. */
export interface Block {
	readonly prelude: string;
	readonly body: string;
	readonly text: string;
	readonly context: readonly string[];
	/** Where the block's prelude starts in the sheet; source order settles equal-specificity arguments. */
	readonly start: number;
	/** Just past the closing brace; an offset between `start` and `end` lies inside this block. */
	readonly end: number;
}

/**
 * Every brace block in a compiled sheet, with the at-rules around it. Exported so a pin can scope a scan to one
 * layer's rules (the utility collision guard reads only `@layer utilities`).
 *
 *   a `content: "{"` would unbalance the stack -> comments and string literals are stepped over
 */
export function blocks(css: string): readonly Block[] {
	const found: Block[] = [];
	const open: {
		readonly prelude: string;
		readonly at: number;
		readonly bodyStart: number;
		readonly context: readonly string[];
	}[] = [];
	let preludeStart = 0;
	for (let i = 0; i < css.length; i++) {
		const char = css[i];
		if (char === "/" && css[i + 1] === "*") {
			const end = css.indexOf("*/", i + 2);
			// An unterminated comment swallows the rest of the sheet, which is
			// what a browser does with one too.
			i = end === -1 ? css.length : end + 1;
			continue;
		}
		if (char === '"' || char === "'") {
			for (i++; i < css.length && css[i] !== char; i++) {
				if (css[i] === "\\") {
					i++;
				}
			}
			continue;
		}
		if (char === "{") {
			// Comments out of the prelude TEXT too: the bundler puts a file banner ahead of the at-rule it opens, and a
			// prelude carrying one answers to no pattern - reporting a block nested in a width query as unconditional.
			const prelude = css
				.slice(preludeStart, i)
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.trim();
			open.push({ prelude, at: preludeStart, bodyStart: i + 1, context: open.map((entry) => entry.prelude) });
			preludeStart = i + 1;
		} else if (char === "}") {
			const closed = open.pop();
			preludeStart = i + 1;
			if (closed === undefined) {
				continue;
			}
			found.push({
				prelude: closed.prelude,
				body: css.slice(closed.bodyStart, i),
				text: css.slice(closed.at, i + 1).trim(),
				context: closed.context,
				start: closed.at,
				end: i + 1,
			});
		} else if (char === ";") {
			preludeStart = i + 1;
		}
	}
	return found;
}
