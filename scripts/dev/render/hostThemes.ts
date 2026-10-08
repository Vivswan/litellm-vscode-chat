import { readFileSync } from "node:fs";
import path from "node:path";

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

/**
 * Every --vscode-* token the stylesheet reads must be defined by the ORDINARY themes: VS Code hands the real webview a
 * full token set, so a token omitted here falls back to whatever literal the stylesheet carries, and those literals
 * were written against dark. High contrast is exempt on purpose - the real HC themes leave those values null, so its
 * sparseness IS the fidelity - and contrast-only tokens are exempt everywhere, since the ordinary themes do not define
 * them and the stylesheet reads them behind a fallback.
 */
const CONTRAST_ONLY_TOKENS = new Set(["--vscode-contrastBorder", "--vscode-contrastActiveBorder"]);

export function assertThemeCoversStylesheet(stylesheet: string, tokensCss: string, hostTheme: string): void {
	const referenced = new Set([...stylesheet.matchAll(/var\((--vscode-[A-Za-z0-9-]+)/g)].map((match) => match[1]));
	const defined = new Set([...tokensCss.matchAll(/(--vscode-[A-Za-z0-9-]+)\s*:/g)].map((match) => match[1]));
	const missing = [...referenced].filter((token) => !defined.has(token) && !CONTRAST_ONLY_TOKENS.has(token)).sort();
	if (missing.length > 0) {
		throw new Error(
			`The ${hostTheme} token set omits ${missing.length} token(s) the stylesheet reads, so the render would` +
				` show the stylesheet's own fallbacks instead of the theme: ${missing.join(", ")}`
		);
	}
}

/**
 * Pinning the four font tokens pins the page only if every font-family resolves through them (or inherit), so this
 * fails closed otherwise.
 *
 *   a literal font stack or new utility class  -> silent platform divergence would return
 *   the font SHORTHAND, any value but inherit  -> it also sets the family
 *   failing it outright                        -> cheaper than a family parser
 *   .font-sans or .font-mono rule missing      -> the engagement check's utility legs would measure inherited font and
 *                                                 prove nothing
 */
export function assertPinCoversStylesheet(stylesheet: string): void {
	const pinnedSources = [
		"inherit",
		"var(--vscode-font-family",
		"var(--vscode-editor-font-family",
		"var(--font-sans",
		"var(--font-mono",
	];
	const unpinned = [
		...[...stylesheet.matchAll(/(?<![-\w])font-family\s*:\s*([^;}]+)/g)]
			.map((match) => (match[1] as string).trim())
			.filter((value) => !pinnedSources.some((source) => value.startsWith(source))),
		...[...stylesheet.matchAll(/(?<![-\w])font\s*:\s*([^;}]+)/g)]
			.map((match) => `font: ${(match[1] as string).trim()}`)
			.filter((value) => value !== "font: inherit"),
	];
	if (unpinned.length > 0) {
		throw new Error(
			`The stylesheet reads fonts outside the pinned tokens, so a measurement would depend on platform fonts:` +
				` ${[...new Set(unpinned)].join(", ")}`
		);
	}
	for (const utility of ["font-sans", "font-mono"]) {
		if (!new RegExp(String.raw`\.${utility}\s*\{`).test(stylesheet)) {
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
 */
export function inlineTokenStyle(tokensCss: string): string {
	const declarations = [...tokensCss.matchAll(/(--(?:vscode|font)-[A-Za-z0-9-]+):\s*([^;]+);/g)].map(
		(match) => `${match[1]}: ${match[2]?.trim()}`
	);
	if (declarations.length === 0) {
		throw new Error("The token set produced no token declarations; the render would show no theme at all");
	}
	return `${declarations.join("; ")};`;
}

/**
 * Repoints every font token at the pinned faces: the host pair (--vscode-font-family, --vscode-editor-font-family) and
 * the Tailwind pair (--font-sans, --font-mono) the stylesheet's font-sans/font-mono utilities read - the dashboard
 * reaches fonts only through these four tokens (plus inherit), so the swap covers every rule. All four ride the inline
 * token style, which outranks the stylesheet's theme layer where the Tailwind pair is normally defined; under
 * --no-theme there is no token set to rewrite, so the pin becomes the whole set.
 */
export function pinFontTokens(tokensCss: string): string {
	const tailwindPins = "--font-sans: geometry-pinned-sans; --font-mono: geometry-pinned-mono;";
	if (tokensCss === "") {
		return `:root { --vscode-font-family: geometry-pinned-sans; --vscode-editor-font-family: geometry-pinned-mono; ${tailwindPins} }`;
	}
	const pinned = tokensCss
		.replace(/--vscode-font-family:[^;]*;/, "--vscode-font-family: geometry-pinned-sans;")
		.replace(/--vscode-editor-font-family:[^;]*;/, "--vscode-editor-font-family: geometry-pinned-mono;");
	if (!pinned.includes("geometry-pinned-sans") || !pinned.includes("geometry-pinned-mono")) {
		throw new Error("The theme's token set lost its font tokens; the measurement font pin has nothing to rewrite");
	}
	return `${pinned}\n:root { ${tailwindPins} }`;
}
