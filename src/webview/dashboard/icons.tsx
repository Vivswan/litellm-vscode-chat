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
