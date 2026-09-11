/**
 * The host themes a render can emulate: the approximated VS Code token sets, the
 * coverage assertions that keep them honest against the stylesheet, and the
 * token-CSS rewrites (inlining, font pinning) the page builder applies.
 */
/** Every host theme a render can emulate; the fixture field, page builder and flag parser all read this. */
export const HOST_THEMES = ["dark", "light", "high-contrast", "high-contrast-light", "forced-colors"] as const;

export type HostTheme = (typeof HOST_THEMES)[number];

/** The kinds of surface a host theme paints, which is what the wash scale keys off. */
export const LIGHT_HOST_THEMES: ReadonlySet<HostTheme> = new Set<HostTheme>(["light", "high-contrast-light"]);

/**
 * The VS Code Dark Modern theme tokens, approximated so a plain Chrome page
 * renders like the webview. Presentation aid only; --no-theme disables it.
 */
export function themeCss(): string {
	return `
	:root {
		--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif;
		--vscode-font-size: 13px;
		--vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
		--vscode-foreground: #cccccc;
		--vscode-descriptionForeground: #9d9d9d;
		--vscode-editor-background: #1f1f1f;
		--vscode-panel-background: #181818;
		--vscode-editorWidget-background: #202020;
		--vscode-widget-border: #313131;
		--vscode-widget-shadow: rgba(0, 0, 0, 0.36);
		--vscode-focusBorder: #0078d4;
		--vscode-errorForeground: #f85149;
		--vscode-editorWarning-foreground: #cca700;
		--vscode-notificationsWarningIcon-foreground: #cca700;
		--vscode-testing-iconPassed: #73c991;
		--vscode-charts-green: #89d185;
		--vscode-charts-yellow: #cca700;
		--vscode-list-hoverBackground: #2a2d2e;
		--vscode-toolbar-hoverBackground: #5a5d5e50;
		--vscode-textLink-foreground: #4daafc;
		--vscode-textLink-activeForeground: #4daafc;
		--vscode-textCodeBlock-background: #2b2b2b;
		--vscode-panelTitle-activeForeground: #cccccc;
		--vscode-panelTitle-inactiveForeground: #9d9d9d;
		--vscode-panelTitle-activeBorder: #0078d4;
		--vscode-input-background: #313131;
		--vscode-input-foreground: #cccccc;
		--vscode-input-border: #3c3c3c;
		--vscode-input-placeholderForeground: #989898;
		--vscode-inputValidation-errorBackground: #5a1d1d;
		--vscode-inputValidation-errorBorder: #be1100;
		--vscode-inputValidation-warningBackground: #352a05;
		--vscode-inputValidation-warningBorder: #b89500;
		--vscode-button-background: #0078d4;
		--vscode-button-foreground: #ffffff;
		--vscode-button-border: #ffffff1a;
		--vscode-button-hoverBackground: #026ec1;
		--vscode-button-secondaryBackground: #00000000;
		--vscode-button-secondaryForeground: #cccccc;
		--vscode-button-secondaryHoverBackground: #2b2b2b;
		--vscode-editorHoverWidget-background: #202020;
		--vscode-editorHoverWidget-foreground: #cccccc;
		--vscode-editorHoverWidget-border: #cccccc33;
		--vscode-notifications-background: #1f1f1f;
		--vscode-notifications-foreground: #cccccc;
		--vscode-notifications-border: #2b2b2b;
		--vscode-charts-red: #f14c4c;
		--vscode-disabledForeground: #cccccc80;
		--vscode-editorWidget-border: #cccccc33;
		--vscode-editorWidget-foreground: #cccccc;
		--vscode-list-hoverForeground: #cccccc;
		--vscode-panel-border: #2b2b2b;
		--vscode-progressBar-background: #0078d4;
		--vscode-statusBarItem-errorBackground: #b90f07;
		--vscode-statusBarItem-errorForeground: #ffffff;
		--vscode-textBlockQuote-background: #2b2b2b;
		--vscode-dropdown-background: #313131;
		--vscode-dropdown-foreground: #cccccc;
		--vscode-dropdown-border: #3c3c3c;
		--vscode-settings-modifiedItemIndicator: #bb800966;
		--vscode-scrollbarSlider-background: #79797966;
		--vscode-scrollbarSlider-hoverBackground: #646464b3;
		--vscode-scrollbarSlider-activeBackground: #bfbfbf66;
	}
	`;
}

/**
 * The VS Code Light Modern tokens, over the same key set as the dark tokens
 * above: a token one theme defines and the other omits would read as a design
 * difference when it is really a gap in this file.
 */
export function lightCss(): string {
	return `
	:root {
		--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif;
		--vscode-font-size: 13px;
		--vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
		--vscode-foreground: #3b3b3b;
		--vscode-descriptionForeground: #3b3b3b;
		--vscode-editor-background: #ffffff;
		--vscode-panel-background: #f8f8f8;
		--vscode-editorWidget-background: #f8f8f8;
		--vscode-widget-border: #e5e5e5;
		--vscode-widget-shadow: rgba(0, 0, 0, 0.16);
		--vscode-focusBorder: #005fb8;
		--vscode-errorForeground: #f85149;
		--vscode-editorWarning-foreground: #bf8803;
		--vscode-notificationsWarningIcon-foreground: #bf8803;
		--vscode-testing-iconPassed: #73c991;
		--vscode-charts-green: #388a34;
		--vscode-charts-yellow: #bf8803;
		--vscode-list-hoverBackground: #f2f2f2;
		--vscode-toolbar-hoverBackground: #b8b8b850;
		--vscode-textLink-foreground: #005fb8;
		--vscode-textLink-activeForeground: #005fb8;
		--vscode-textCodeBlock-background: #f8f8f8;
		--vscode-panelTitle-activeForeground: #3b3b3b;
		--vscode-panelTitle-inactiveForeground: #3b3b3b;
		--vscode-panelTitle-activeBorder: #005fb8;
		--vscode-input-background: #ffffff;
		--vscode-input-foreground: #3b3b3b;
		--vscode-input-border: #cecece;
		--vscode-input-placeholderForeground: #767676;
		--vscode-inputValidation-errorBackground: #f2dede;
		--vscode-inputValidation-errorBorder: #be1100;
		--vscode-inputValidation-warningBackground: #f6f5d2;
		--vscode-inputValidation-warningBorder: #b89500;
		--vscode-button-background: #005fb8;
		--vscode-button-foreground: #ffffff;
		--vscode-button-border: #0000001a;
		--vscode-button-hoverBackground: #0258a8;
		--vscode-button-secondaryBackground: #e5e5e5;
		--vscode-button-secondaryForeground: #3b3b3b;
		--vscode-button-secondaryHoverBackground: #cccccc;
		--vscode-editorHoverWidget-background: #f8f8f8;
		--vscode-editorHoverWidget-foreground: #3b3b3b;
		--vscode-editorHoverWidget-border: #3b3b3b33;
		--vscode-notifications-background: #ffffff;
		--vscode-notifications-foreground: #3b3b3b;
		--vscode-notifications-border: #e5e5e5;
		--vscode-charts-red: #e51400;
		--vscode-disabledForeground: #61616180;
		--vscode-editorWidget-border: #3b3b3b33;
		--vscode-editorWidget-foreground: #3b3b3b;
		--vscode-list-hoverForeground: #3b3b3b;
		--vscode-panel-border: #e5e5e5;
		--vscode-progressBar-background: #005fb8;
		--vscode-statusBarItem-errorBackground: #c72e0f;
		--vscode-statusBarItem-errorForeground: #ffffff;
		--vscode-textBlockQuote-background: #f8f8f8;
		--vscode-dropdown-background: #ffffff;
		--vscode-dropdown-foreground: #3b3b3b;
		--vscode-dropdown-border: #cecece;
		--vscode-settings-modifiedItemIndicator: #bb800966;
		--vscode-scrollbarSlider-background: #64646466;
		--vscode-scrollbarSlider-hoverBackground: #646464b3;
		--vscode-scrollbarSlider-activeBackground: #00000099;
	}
	`;
}

/**
 * The VS Code Dark High Contrast tokens, from the workbench color registry's
 * hcDark defaults. Deliberately sparse where the real theme is: secondary
 * backgrounds and list hover colors are genuinely null there, so the fallback
 * chains and theme.css's contrast overrides are what render. button.background
 * IS set - black, the whole reason theme.css cannot read an accent off it.
 */
export function highContrastCss(): string {
	return `
	:root {
		--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif;
		--vscode-font-size: 13px;
		--vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
		--vscode-foreground: #ffffff;
		--vscode-descriptionForeground: #ffffffb3;
		--vscode-disabledForeground: #a5a5a5;
		--vscode-editor-background: #000000;
		--vscode-panel-background: #000000;
		--vscode-editorWidget-background: #0c141f;
		--vscode-widget-border: #6fc3df;
		--vscode-contrastBorder: #6fc3df;
		--vscode-contrastActiveBorder: #f38518;
		--vscode-focusBorder: #f38518;
		--vscode-errorForeground: #f48771;
		--vscode-editorWarning-foreground: #ffd370;
		--vscode-testing-iconPassed: #73c991;
		--vscode-textLink-foreground: #21a6ff;
		--vscode-textLink-activeForeground: #21a6ff;
		--vscode-textCodeBlock-background: #000000;
		--vscode-panelTitle-activeForeground: #ffffff;
		--vscode-panelTitle-inactiveForeground: #ffffff;
		--vscode-panelTitle-activeBorder: #6fc3df;
		--vscode-input-background: #000000;
		--vscode-input-foreground: #ffffff;
		--vscode-input-border: #6fc3df;
		--vscode-input-placeholderForeground: #ffffffb3;
		--vscode-inputValidation-errorBackground: #000000;
		--vscode-inputValidation-errorBorder: #f48771;
		--vscode-button-background: #000000;
		--vscode-button-foreground: #ffffff;
		--vscode-button-border: #6fc3df;
		--vscode-editorHoverWidget-background: #0c141f;
		--vscode-editorHoverWidget-foreground: #ffffff;
		--vscode-editorHoverWidget-border: #6fc3df;
		--vscode-notifications-background: #000000;
		--vscode-notifications-foreground: #ffffff;
		--vscode-notifications-border: #6fc3df;
		--vscode-dropdown-background: #000000;
		--vscode-dropdown-foreground: #ffffff;
		--vscode-dropdown-border: #6fc3df;
		--vscode-scrollbarSlider-background: #6fc3df99;
		--vscode-scrollbarSlider-hoverBackground: #6fc3dfcc;
		--vscode-scrollbarSlider-activeBackground: #6fc3df;
	}
	`;
}

/**
 * The VS Code Light High Contrast tokens, from the registry's hcLight defaults.
 * Its own combination, and an unrenderable state is one nobody checks:
 * theme.css keys the wash scale off body.vscode-high-contrast-light, a class no
 * other render produces.
 */
export function highContrastLightCss(): string {
	return `
	:root {
		--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif;
		--vscode-font-size: 13px;
		--vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
		--vscode-foreground: #292929;
		--vscode-descriptionForeground: #292929b3;
		--vscode-disabledForeground: #7f7f7f;
		--vscode-editor-background: #ffffff;
		--vscode-panel-background: #ffffff;
		--vscode-editorWidget-background: #ffffff;
		--vscode-widget-border: #0f4a85;
		--vscode-contrastBorder: #0f4a85;
		--vscode-contrastActiveBorder: #006bbd;
		--vscode-focusBorder: #006bbd;
		--vscode-errorForeground: #b5200d;
		--vscode-editorWarning-foreground: #895503;
		--vscode-testing-iconPassed: #007100;
		--vscode-textLink-foreground: #0f4a85;
		--vscode-textLink-activeForeground: #0f4a85;
		--vscode-textCodeBlock-background: #f2f2f2;
		--vscode-panelTitle-activeForeground: #292929;
		--vscode-panelTitle-inactiveForeground: #292929;
		--vscode-panelTitle-activeBorder: #b5200d;
		--vscode-input-background: #ffffff;
		--vscode-input-foreground: #292929;
		--vscode-input-border: #0f4a85;
		--vscode-input-placeholderForeground: #292929b3;
		--vscode-inputValidation-errorBackground: #ffffff;
		--vscode-inputValidation-errorBorder: #0f4a85;
		--vscode-button-background: #0f4a85;
		--vscode-button-foreground: #ffffff;
		--vscode-button-border: #0f4a85;
		--vscode-editorHoverWidget-background: #ffffff;
		--vscode-editorHoverWidget-foreground: #292929;
		--vscode-editorHoverWidget-border: #0f4a85;
		--vscode-notifications-background: #ffffff;
		--vscode-notifications-foreground: #292929;
		--vscode-notifications-border: #0f4a85;
		--vscode-dropdown-background: #ffffff;
		--vscode-dropdown-foreground: #292929;
		--vscode-dropdown-border: #0f4a85;
		--vscode-scrollbarSlider-background: #0f4a8566;
		--vscode-scrollbarSlider-hoverBackground: #0f4a8599;
		--vscode-scrollbarSlider-activeBackground: #0f4a85;
	}
	`;
}

/**
 * Every --vscode-* token the stylesheet reads must be defined by the ORDINARY
 * themes: VS Code hands the real webview a full token set, so a token omitted
 * here falls back to whatever literal the stylesheet carries, and those
 * literals were written against dark. High contrast is exempt on purpose - the
 * real HC themes leave those values null, so its sparseness IS the fidelity -
 * and contrast-only tokens are exempt everywhere, since the ordinary themes do
 * not define them and the stylesheet reads them behind a fallback.
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
 * This guard fails closed.
 * Pinning the four font tokens pins the page only if every font-family resolves through them.
 * A utility class or literal font stack would reintroduce silent platform divergence.
 * The font SHORTHAND also sets the family, so any value there but inherit fails too.
 * Failing the shorthand outright is cheaper than a family parser.
 * The engagement check's utility legs measure .font-sans and .font-mono, so their absence fails.
 * A leg measuring inherited font would prove nothing.
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
 * The host's token delivery, reproduced exactly: VS Code writes --vscode-* one
 * by one onto the document element's inline style (webview/browser/pre/
 * index.html, applyStyles), not into a stylesheet. An inline declaration
 * outranks every author rule on the same element, so a stylesheet rule that
 * redefines a host token loses in the editor and would win here. The
 * measurement font pin's --font-* declarations ride the same delivery for the
 * same reason: inline is the one place the stylesheet's theme layer cannot
 * re-define them (the theme token sets themselves carry no --font-*).
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
 * Repoints every font token at the pinned faces: the host pair
 * (--vscode-font-family, --vscode-editor-font-family) and the Tailwind pair
 * (--font-sans, --font-mono) the stylesheet's font-sans/font-mono utilities
 * read - the dashboard reaches fonts only through these four tokens (plus
 * inherit), so the swap covers every rule. All four ride the inline token
 * style, which outranks the stylesheet's theme layer where the Tailwind pair
 * is normally defined; under --no-theme there is no token set to rewrite, so
 * the pin becomes the whole set.
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
