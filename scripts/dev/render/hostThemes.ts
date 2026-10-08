import { readFileSync } from "node:fs";
import path from "node:path";
import { type CustomProperty, type Declaration, transform } from "lightningcss";

export const HOST_THEMES = ["dark", "light", "high-contrast", "high-contrast-light", "forced-colors"] as const;

export type HostTheme = (typeof HOST_THEMES)[number];

export const LIGHT_HOST_THEMES: ReadonlySet<HostTheme> = new Set<HostTheme>(["light", "high-contrast-light"]);

/**
 * VS Code's theme tokens, approximated so a plain Chrome page renders like the webview. Presentation aid only;
 * --no-theme disables it.
 */
function hostThemeTokens(stylesheet: string): string {
	return readFileSync(path.join(__dirname, "hostThemes", stylesheet), "utf8");
}

export function themeCss(): string {
	return hostThemeTokens("dark.css");
}

export function lightCss(): string {
	return hostThemeTokens("light.css");
}

export function highContrastCss(): string {
	return hostThemeTokens("high-contrast.css");
}

export function highContrastLightCss(): string {
	return hostThemeTokens("high-contrast-light.css");
}

const isHostToken = (declaration: Declaration): boolean =>
	declaration.property === "custom" &&
	(declaration.value.name.startsWith("--vscode-") || declaration.value.name.startsWith("--font-"));

/**
 * Every --vscode-* token the stylesheet reads must be defined by the ORDINARY themes: VS Code hands the real webview a
 * full token set, so a token omitted here falls back to whatever literal the stylesheet carries, and those literals
 * were written against dark. High contrast is exempt on purpose - the real HC themes leave those values null, so its
 * sparseness IS the fidelity - and contrast-only tokens are exempt everywhere, since the ordinary themes do not define
 * them and the stylesheet reads them behind a fallback.
 */
const CONTRAST_ONLY_TOKENS = new Set(["--vscode-contrastBorder", "--vscode-contrastActiveBorder"]);

export function assertThemeCoversStylesheet(stylesheet: string, tokensCss: string, hostTheme: string): void {
	const referenced = new Set<string>();
	transform({
		filename: "dashboard.css",
		code: Buffer.from(stylesheet),
		visitor: {
			Variable: (variable) => {
				if (variable.name.ident.startsWith("--vscode-")) {
					referenced.add(variable.name.ident);
				}
			},
		},
	});
	const defined = new Set<string>();
	transform({
		filename: "tokens.css",
		code: Buffer.from(tokensCss),
		visitor: { Declaration: { custom: (declaration) => void defined.add(declaration.name) } },
	});
	const missing = [...referenced].filter((token) => !defined.has(token) && !CONTRAST_ONLY_TOKENS.has(token)).sort();
	if (missing.length > 0) {
		throw new Error(
			`The ${hostTheme} token set omits ${missing.length} token(s) the stylesheet reads, so the render would` +
				` show the stylesheet's own fallbacks instead of the theme: ${missing.join(", ")}`
		);
	}
}

const PINNED_FACE_TOKENS = new Set([
	"--vscode-font-family",
	"--vscode-editor-font-family",
	"--font-sans",
	"--font-mono",
]);

type Unparsed = Extract<Declaration, { property: "unparsed" }>;

const isInheritToken = (declaration: Unparsed): boolean => {
	const [only, ...rest] = declaration.value.value;
	return rest.length === 0 && only?.type === "token" && only.value.type === "ident" && only.value.value === "inherit";
};

const isInheritFamily = (declaration: Declaration): boolean =>
	declaration.property === "font-family" && declaration.value.length === 1 && declaration.value[0] === "inherit";

/** A `font-family` or `font` declaration whose value a pinned token does not decide; `inherit` leaves the pin in charge. */
function leavesFontToPlatform(declaration: Declaration): boolean {
	switch (declaration.property) {
		case "font-family":
			return !isInheritFamily(declaration);
		case "font":
			return true;
		case "unparsed": {
			const [first] = declaration.value.value;
			switch (declaration.value.propertyId.property) {
				case "font-family":
					return (
						!isInheritToken(declaration) && !(first?.type === "var" && PINNED_FACE_TOKENS.has(first.value.name.ident))
					);
				case "font":
					return !isInheritToken(declaration);
				default:
					return false;
			}
		}
		default:
			return false;
	}
}

/**
 * The JS AST gives the keyword `inherit` and a family NAMED "inherit" (Tailwind's `font-['inherit']`) one shape, and
 * only the printer keeps the quotes: the print is read back with the property renamed to a custom one, whose token
 * list tells a string from an ident. A comment or an at-rule prelude in the print is no declaration to that read.
 */
function printsQuotedInherit(printed: string): boolean {
	let quoted = false;
	transform({
		filename: "inherit.css",
		code: Buffer.from(printed.replaceAll("font-family:", "--font-family:")),
		visitor: {
			Declaration: {
				custom: {
					"--font-family": (declaration) => {
						quoted ||= declaration.value.some((token) => token.type === "token" && token.value.type === "string");
					},
				},
			},
		},
	});
	return quoted;
}

/**
 * Pinning the four font tokens pins the page only if every font-family resolves through them (or inherit), so this
 * fails closed otherwise. A declaration is reported under the rule entered last: the visitor enters a rule, then its
 * own declarations, then its nested rules, and declarations after a nested rule are a rule of their own. The sheet is
 * printed with every declaration but the `inherit` families removed, for printsQuotedInherit.
 *
 *   a literal font stack or new utility class  -> silent platform divergence would return
 *   the font SHORTHAND, any value but inherit  -> it also sets the family
 *   .font-sans or .font-mono rule missing      -> the engagement check's utility legs would measure inherited font and
 *                                                 prove nothing
 */
export function assertPinCoversStylesheet(stylesheet: string): void {
	const lines = stylesheet.split("\n");
	const utilities = new Set<string>();
	const unpinned: string[] = [];
	const inheritFamilies: string[] = [];
	let entered = "";
	const { code } = transform({
		filename: "dashboard.css",
		code: Buffer.from(stylesheet),
		minify: true,
		visitor: {
			Rule: (rule) => {
				const line = (rule as { value?: { loc?: { line: number } } }).value?.loc?.line;
				entered = line === undefined ? rule.type : `${lines[line]?.trim()} (compiled line ${line + 1})`;
				if (rule.type === "style") {
					for (const [only, ...rest] of rule.value.selectors) {
						if (rest.length === 0 && only?.type === "class") {
							utilities.add(only.name);
						}
					}
				}
			},
			Declaration: (declaration) => {
				if (leavesFontToPlatform(declaration)) {
					const property =
						declaration.property === "unparsed" ? declaration.value.propertyId.property : declaration.property;
					unpinned.push(`${property} under ${entered}`);
				}
				if (!isInheritFamily(declaration)) {
					return [];
				}
				inheritFamilies.push(entered);
				return undefined;
			},
		},
	});
	if (printsQuotedInherit(code.toString())) {
		unpinned.push(`a quoted family named "inherit" under one of: ${inheritFamilies.join(", ")}`);
	}
	if (unpinned.length > 0) {
		throw new Error(
			`The stylesheet reads fonts outside the pinned tokens, so a measurement would depend on platform fonts:` +
				` ${unpinned.join("; ")}`
		);
	}
	for (const utility of ["font-sans", "font-mono"]) {
		if (!utilities.has(utility)) {
			throw new Error(
				`The stylesheet no longer carries the .${utility} utility the pin-engagement check measures;` +
					` update the check's utility legs together with this guard`
			);
		}
	}
}

/**
 * The host's token delivery, reproduced exactly: VS Code writes --vscode-* one by one onto the document element's
 * inline style (webview/browser/pre/index.html, applyStyles), not into a stylesheet. An inline declaration outranks
 * every author rule on the same element, so a stylesheet rule that redefines a host token loses in the editor and would
 * win here.
 *
 *   inline is the one place the stylesheet's theme layer cannot re-define them (the theme token sets themselves carry
 *   no --font-*) -> The measurement font pin's --font-* declarations ride the same delivery
 *
 * Stylesheet printing emits a rule, so the validated single rule is unwrapped.
 */
export function inlineTokenStyle(tokensCss: string): string {
	const rules: string[] = [];
	let tokens = 0;
	const { code } = transform({
		filename: "tokens.css",
		code: Buffer.from(tokensCss),
		minify: true,
		visitor: {
			Rule: (rule) => void rules.push(rule.type),
			Declaration: (declaration) => {
				if (!isHostToken(declaration)) {
					return [];
				}
				tokens += 1;
				return undefined;
			},
		},
	});
	if (rules.length !== 1 || rules[0] !== "style") {
		throw new Error(
			`A token set is one flat rule, as the host delivers it; this one holds ${rules.join(", ") || "none"}`
		);
	}
	if (tokens === 0) {
		throw new Error("The token set produced no token declarations; the render would show no theme at all");
	}
	const printed = code.toString();
	return printed.slice(printed.indexOf("{") + 1, printed.lastIndexOf("}"));
}

/**
 * Repoints every font token at the pinned faces: the host pair (--vscode-font-family, --vscode-editor-font-family) and
 * the Tailwind pair (--font-sans, --font-mono) the stylesheet's font-sans/font-mono utilities read - the dashboard
 * reaches fonts only through these four tokens (plus inherit), so the swap covers every rule. All four ride the inline
 * token style, which outranks the stylesheet's theme layer where the Tailwind pair is normally defined; under
 * --no-theme there is no token set to rewrite, so the pin becomes the whole set. Each Tailwind pin is written beside
 * the host token it mirrors, so the set stays the one rule inlineTokenStyle requires.
 */
export function pinFontTokens(tokensCss: string): string {
	if (tokensCss === "") {
		return (
			":root { --vscode-font-family: geometry-pinned-sans; --font-sans: geometry-pinned-sans;" +
			" --vscode-editor-font-family: geometry-pinned-mono; --font-mono: geometry-pinned-mono; }"
		);
	}
	const pinned = new Set<string>();
	const pin =
		(tailwindToken: string, face: string) =>
		(declaration: CustomProperty): Declaration[] => {
			pinned.add(declaration.name);
			return [declaration.name, tailwindToken].map((name) => ({
				property: "custom",
				value: { name, value: [{ type: "token", value: { type: "ident", value: face } }] },
			}));
		};
	const { code } = transform({
		filename: "tokens.css",
		code: Buffer.from(tokensCss),
		visitor: {
			Declaration: {
				custom: {
					"--vscode-font-family": pin("--font-sans", "geometry-pinned-sans"),
					"--vscode-editor-font-family": pin("--font-mono", "geometry-pinned-mono"),
				},
			},
		},
	});
	if (pinned.size !== 2) {
		throw new Error("The theme's token set lost its font tokens; the measurement font pin has nothing to rewrite");
	}
	return code.toString();
}
