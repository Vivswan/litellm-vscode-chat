/**
 * The glyph-seat guard: the "?" help glyph and the icon-only docs link share one
 * seat (the glyph-seat rule beside dashboard.css's .help-wrap), ASSERTED rather
 * than photographed, because the two boxes drifted a descent apart per-site
 * before the rule existed and a screenshot cannot fail. The step measures every
 * adjacent pair at this fixture's OWN width, since the harness runs steps once,
 * before the width sweep. Pairs a layout wraps onto different lines stop being
 * adjacent and are skipped. Fail-closed: fewer than two measured pairs means the
 * page under the probe is not the page this fixture thinks it shows.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	steps: [
		`(() => {
			const centers = (node) => {
				const rect = node.getBoundingClientRect();
				return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2, rect };
			};
			const helps = [...document.querySelectorAll("button.help")].filter(
				(help) => help.getBoundingClientRect().width > 0
			);
			let measured = 0;
			const drifted = [];
			for (const link of document.querySelectorAll("a.docs-link.glyph-only")) {
				const linkBox = centers(link);
				if (linkBox.rect.width === 0) {
					continue;
				}
				for (const help of helps) {
					const helpBox = centers(help);
					// Adjacent means beside each other on one line: a near horizontal
					// gap and overlapping vertical extents. A pair a narrow width has
					// wrapped apart fails both and is skipped on purpose.
					const gap = Math.max(linkBox.rect.left - helpBox.rect.right, helpBox.rect.left - linkBox.rect.right);
					const overlap =
						Math.min(linkBox.rect.bottom, helpBox.rect.bottom) - Math.max(linkBox.rect.top, helpBox.rect.top);
					if (gap < 0 || gap > 24 || overlap < 7) {
						continue;
					}
					measured += 1;
					if (Math.abs(linkBox.y - helpBox.y) > 1) {
						drifted.push(
							"help center " + helpBox.y.toFixed(2) + "px vs docs-link center " + linkBox.y.toFixed(2) +
							"px near x=" + helpBox.rect.left.toFixed(0)
						);
					}
				}
			}
			if (measured < 2) {
				throw new Error("expected at least two adjacent help/docs-link glyph pairs on the settings page; found " + measured);
			}
			if (drifted.length > 0) {
				throw new Error("glyph pair off its shared centerline:\\n  " + drifted.join("\\n  "));
			}
		})()`,
	],
};

export default fixture;
