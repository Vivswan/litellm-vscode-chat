/**
 * Inline SVG icons, codicon-flavored: 16x16 viewBox filled with currentColor
 * so every theme tone applies. Inline on purpose - the packaged file list
 * admits no dist/ assets beyond the two bundles, and the codicon FONT would
 * need a font-src CSP grant - so the few icons the dashboard uses are drawn
 * here. Decorative always (aria-hidden); the owning control carries the
 * accessible name.
 */

function Svg({ path }: { path: string }) {
	return (
		<svg class="icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
			<path d={path} />
		</svg>
	);
}

export function IconClose() {
	return (
		<Svg path="M8 7.29l4.15-4.14.7.7L8.71 8l4.14 4.15-.7.7L8 8.71l-4.15 4.14-.7-.7L7.29 8 3.15 3.85l.7-.7L8 7.29z" />
	);
}

/** Rotated by CSS (.sort-arrow.desc) for the descending direction. */
export function IconArrowUp() {
	return <Svg path="M8 3l4 4-.71.71L8.5 5.12V13h-1V5.12L4.71 7.71 4 7l4-4z" />;
}

export function IconCopy() {
	return (
		<Svg path="M10 1H3.5L2 2.5V12h1V2.71l.71-.71H10V1zm2.5 2h-7L4 4.5v9L5.5 15h7l1.5-1.5v-9L12.5 3zM13 13.29l-.71.71H5.71L5 13.29V4.71L5.71 4h6.58l.71.71v8.58z" />
	);
}

export function IconCheck() {
	return <Svg path="M6.27 12.3L2.5 8.53l.94-.94 2.83 2.83 6.29-6.29.94.94-7.23 7.23z" />;
}

export function IconAdd() {
	return <Svg path="M8.5 3v4.5H13v1H8.5V13h-1V8.5H3v-1h4.5V3h1z" />;
}

/** Codicon link-external: marks anchors that leave the webview for GitHub. */
export function IconLinkExternal() {
	return (
		<Svg path="M1.5 1H6v1H2v12h12v-4h1v4.5l-.5.5h-13l-.5-.5v-13l.5-.5zM15 1.5V8h-1V2.707L7.243 9.465l-.707-.708L13.292 2H8V1h6.5l.5.5z" />
	);
}

export function IconTrash() {
	return (
		<Svg path="M6 2h4v1h4v1h-1v9.5L11.5 15h-7L3 13.5V4H2V3h4V2zm-2 2v9.09l.91.91h6.18l.91-.91V4H4zm2 2h1v6H6V6zm3 0h1v6H9V6z" />
	);
}
