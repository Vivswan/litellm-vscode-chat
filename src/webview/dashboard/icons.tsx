/**
 * Inline SVG icons, codicon-flavored: 16x16 viewBox filled with currentColor
 * so every theme tone applies. Inline on purpose - the packaged file list
 * admits no dist/ assets beyond the two bundles, and the codicon FONT would
 * need a font-src CSP grant - so the few icons the dashboard uses are drawn
 * here. Decorative always (aria-hidden); the owning control carries the
 * accessible name.
 */

import type { ReactNode } from "react";

function Svg({ path }: { path: string }) {
	return (
		<svg className="icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
			<path d={path} />
		</svg>
	);
}

/**
 * The line-art sibling, for the rail's destination icons.
 *
 * Those five are the only icons on the page seen as a SET, side by side and
 * carrying navigation on their own once the rail collapses, so they are drawn
 * at one stroke weight rather than as filled silhouettes: at 18px a filled
 * glyph reads as a blob, and a blob is a poor destination.
 */
function StrokeSvg({ children }: { children: ReactNode }) {
	return (
		<svg
			className="icon"
			viewBox="0 0 16 16"
			width="14"
			height="14"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.1}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

/** Two stacked units: the Servers destination. */
export function IconServers() {
	return (
		<StrokeSvg>
			<rect x="2.2" y="3.2" width="11.6" height="4.2" rx="1.2" />
			<rect x="2.2" y="8.8" width="11.6" height="4.2" rx="1.2" />
			<path d="M4.6 5.3h1.8M4.6 10.9h1.8" />
		</StrokeSvg>
	);
}

/** A stack of plates: the Models catalogue. */
export function IconModels() {
	return (
		<StrokeSvg>
			<path d="M8 1.9l5.9 2.9L8 7.7 2.1 4.8 8 1.9z" />
			<path d="M2.1 8l5.9 2.9L13.9 8" />
			<path d="M2.1 11.2l5.9 2.9 5.9-2.9" />
		</StrokeSvg>
	);
}

/** A pulse trace: the Diagnostics destination. */
export function IconPulse() {
	return (
		<StrokeSvg>
			<path d="M1.6 8.4h3l1.7-4.3 2.5 7.7 1.5-3.4h4.1" />
		</StrokeSvg>
	);
}

/** A gear: the Settings destination. */
export function IconGear() {
	return (
		<StrokeSvg>
			<circle cx="8" cy="8" r="2.9" />
			<path d="M11.7 8h1.6M8 11.7v1.6M4.3 8H2.7M8 4.3V2.7M10.6 10.6l1.1 1.1M5.4 10.6l-1.1 1.1M5.4 5.4L4.3 4.3M10.6 5.4l1.1-1.1" />
		</StrokeSvg>
	);
}

/** Circular arrows: the rail's Sync models action. */
export function IconSync() {
	return (
		<StrokeSvg>
			<path d="M3.2 8a4.8 4.8 0 0 1 8.2-3.4" />
			<path d="M11.4 4.6H8.9M11.4 4.6V2.1" />
			<path d="M12.8 8a4.8 4.8 0 0 1-8.2 3.4" />
			<path d="M4.6 11.4h2.5M4.6 11.4v2.5" />
		</StrokeSvg>
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

/** A disclosure's resting state; rotated by CSS (.disclosure-chevron under an expanded button) to point down. */
export function IconChevronRight() {
	return <Svg path="M5.7 3.3L10.4 8l-4.7 4.7-.7-.7L9 8 5 4l.7-.7z" />;
}

/** The trail back out of a destination. */
export function IconArrowLeft() {
	return <Svg path="M10.5 3.5L6 8l4.5 4.5-.7.7L4.6 8l5.2-5.2.7.7z" />;
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

/** Codicon edit (pencil): the record tables' per-matcher full-editor action. */
export function IconEdit() {
	return (
		<Svg path="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z" />
	);
}

/** Codicon link-external: marks anchors that leave the webview (GitHub, the Marketplace). */
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

/** Codicon bug: the Report-a-bug actions. */
export function IconBug() {
	return (
		<Svg path="M14.5 8H13V6C13 5.63 12.898 5.283 12.722 4.985L13.853 3.854C14.048 3.659 14.048 3.342 13.853 3.147C13.658 2.952 13.341 2.952 13.146 3.147L12.015 4.278C11.717 4.102 11.37 4 11 4C11 2.346 9.654 1 8 1C6.346 1 5 2.346 5 4C4.63 4 4.283 4.102 3.985 4.278L2.854 3.147C2.659 2.952 2.342 2.952 2.147 3.147C1.952 3.342 1.952 3.659 2.147 3.854L3.278 4.985C3.102 5.283 3 5.63 3 6V8H1.5C1.224 8 1 8.224 1 8.5C1 8.776 1.224 9 1.5 9H3C3 10.199 3.424 11.3 4.13 12.163L2.396 13.897C2.201 14.092 2.201 14.409 2.396 14.604C2.494 14.702 2.622 14.75 2.75 14.75C2.878 14.75 3.006 14.701 3.104 14.604L4.838 12.87C5.7 13.576 6.802 14 8.001 14C9.2 14 10.301 13.576 11.164 12.87L12.898 14.604C12.996 14.702 13.124 14.75 13.252 14.75C13.38 14.75 13.508 14.701 13.606 14.604C13.801 14.409 13.801 14.092 13.606 13.897L11.872 12.163C12.578 11.301 13.002 10.199 13.002 9H14.502C14.778 9 15.002 8.776 15.002 8.5C15.002 8.224 14.778 8 14.502 8H14.5ZM8 2C9.103 2 10 2.897 10 4H6C6 2.897 6.897 2 8 2ZM12 9C12 11.206 10.206 13 8 13C5.794 13 4 11.206 4 9V6C4 5.449 4.448 5 5 5H11C11.552 5 12 5.449 12 6V9Z" />
	);
}

/** Codicon lightbulb: the feature-request row. */
export function IconLightbulb() {
	return (
		<Svg path="M8 1C5.419 1 2.75 2.964 2.75 6.25C2.75 8.167 3.637 9.184 4.224 9.856C4.408 10.067 4.598 10.285 4.628 10.398L5.568 13.889C5.744 14.543 6.34 14.999 7.017 14.999H8.984C9.662 14.999 10.257 14.542 10.432 13.889L11.372 10.397C11.402 10.285 11.593 10.067 11.776 9.856C12.363 9.183 13.25 8.167 13.25 6.25C13.25 3.355 10.895 1 8 1ZM9.467 13.63C9.408 13.848 9.209 14 8.984 14H7.017C6.791 14 6.593 13.848 6.534 13.63L6.095 12H9.906L9.467 13.63ZM11.022 9.199C10.741 9.522 10.497 9.802 10.407 10.137L10.175 10.999H5.826L5.594 10.138C5.503 9.801 5.26 9.522 4.977 9.199C4.43 8.572 3.75 7.792 3.75 6.25C3.75 3.59 5.911 2 8 2C10.344 2 12.25 3.907 12.25 6.25C12.25 7.792 11.569 8.572 11.022 9.199Z" />
	);
}

/** Codicon star-empty: the rate row. */
export function IconStar() {
	return (
		<Svg path="M11.928 15C11.774 15 11.625 14.962 11.484 14.889L8 13.056L4.516 14.888C4.132 15.092 3.623 14.99 3.339 14.656C3.157 14.438 3.084 14.164 3.131 13.883L3.797 10.003L0.978 7.25499C0.713 6.99699 0.623 6.63199 0.736 6.27899C0.852 5.92399 1.139 5.68099 1.506 5.62699L5.402 5.06099L7.144 1.53099C7.472 0.864994 8.527 0.864994 8.855 1.53099L10.597 5.06099L14.493 5.62699C14.861 5.68099 15.148 5.92299 15.263 6.27499C15.377 6.63099 15.286 6.99599 15.022 7.25399L12.203 10.002L12.869 13.882C12.917 14.164 12.844 14.437 12.664 14.653C12.479 14.871 12.204 15 11.928 15ZM7.959 1.97399L6.066 5.97499L1.65 6.61599L4.871 9.65299L4.117 14.05L8 11.925L11.892 13.972L11.129 9.65299L14.324 6.53799L9.934 5.97499L7.959 1.97399Z" />
	);
}

/** Codicon book: the documentation row. */
export function IconBook() {
	return (
		<Svg path="M2.5 2C1.67157 2 1 2.67157 1 3.5V12.5C1 13.3284 1.67157 14 2.5 14H6C6.8178 14 7.54389 13.6073 8 13.0002C8.45612 13.6073 9.1822 14 10 14H13.5C14.3284 14 15 13.3284 15 12.5V3.5C15 2.67157 14.3284 2 13.5 2H10C9.1822 2 8.45612 2.39267 8 2.99976C7.54389 2.39267 6.8178 2 6 2H2.5ZM7.5 4.5V11.5C7.5 12.3284 6.82843 13 6 13H2.5C2.22386 13 2 12.7761 2 12.5V3.5C2 3.22386 2.22386 3 2.5 3H6C6.82843 3 7.5 3.67157 7.5 4.5ZM8.5 11.5V4.5C8.5 3.67157 9.17157 3 10 3H13.5C13.7761 3 14 3.22386 14 3.5V12.5C14 12.7761 13.7761 13 13.5 13H10C9.17157 13 8.5 12.3284 8.5 11.5Z" />
	);
}

/** Codicon repo: the repository row. */
export function IconRepo() {
	return (
		<Svg path="M12.5 12C12.776 12 13 11.776 13 11.5V3C13 1.895 12.105 1 11 1H5C3.895 1 3 1.895 3 3V13C3 14.105 3.895 15 5 15V15.5C5 15.702 5.122 15.885 5.309 15.962C5.495 16.039 5.711 15.997 5.854 15.854L6.5 15.208L7.146 15.854C7.242 15.95 7.37 16 7.5 16C7.564 16 7.63 15.987 7.691 15.962C7.878 15.885 8 15.702 8 15.5V15H12.5C12.776 15 13 14.776 13 14.5C13 14.224 12.776 14 12.5 14H8V13.5C8 13.224 7.776 13 7.5 13H5.5C5.224 13 5 13.224 5 13.5V14C4.448 14 4 13.552 4 13V12H12.5ZM4 3C4 2.448 4.448 2 5 2H11C11.552 2 12 2.448 12 3V11H4V3Z" />
	);
}

/** Codicon plug: the Test connection action. */
export function IconPlug() {
	return (
		<Svg path="M10.723 4H10V1.5C10 1.224 9.776 1 9.5 1C9.224 1 9 1.224 9 1.5V4H7V1.5C7 1.224 6.776 1 6.5 1C6.224 1 6 1.224 6 1.5V4H5.277C4.573 4 4 4.573 4 5.278V8C4 10.036 5.529 11.722 7.5 11.969V14.5C7.5 14.776 7.724 15 8 15C8.276 15 8.5 14.776 8.5 14.5V11.969C10.471 11.722 12 10.037 12 8V5.278C12 4.573 11.427 4 10.723 4ZM11 8C11 9.654 9.654 11 8 11C6.346 11 5 9.654 5 8V5.278C5 5.125 5.124 5 5.277 5H10.722C10.875 5 10.999 5.125 10.999 5.278V8H11Z" />
	);
}

/** Log lines: the Diagnostics tab's Open-output-log action. */
export function IconOutput() {
	return <Svg path="M2 3h12v1H2V3zm0 3h12v1H2V6zm0 3h12v1H2V9zm0 3h7v1H2v-1z" />;
}

/** Codicon bracket (curly-brace pair): the settings.json jump actions. */
export function IconBraces() {
	return (
		<Svg path="M6 2.984V2h-.09c-.313 0-.616.062-.909.185a2.33 2.33 0 0 0-.775.53 2.23 2.23 0 0 0-.493.753v.001a3.542 3.542 0 0 0-.198.83v.002a6.08 6.08 0 0 0-.024.863c.012.29.018.58.018.869 0 .203-.04.393-.117.572v.001a1.504 1.504 0 0 1-.765.787 1.376 1.376 0 0 1-.558.115H2v.984h.09c.195 0 .38.04.556.121l.001.001c.178.078.329.184.455.318l.002.002c.13.13.233.285.307.465l.001.002c.078.18.117.368.117.566 0 .29-.006.58-.018.869-.012.296-.004.585.024.87v.001c.033.283.099.558.198.824v.001c.106.273.271.524.493.75.223.23.482.407.775.53.293.123.596.185.91.185H6v-.984h-.09c-.2 0-.387-.038-.563-.115a1.613 1.613 0 0 1-.457-.32 1.659 1.659 0 0 1-.309-.467c-.074-.18-.11-.37-.11-.573 0-.228.003-.453.01-.673.007-.228.004-.45-.01-.665a4.639 4.639 0 0 0-.086-.627 2.037 2.037 0 0 0-.24-.6 2.202 2.202 0 0 0-.438-.52 2.582 2.582 0 0 0-.671-.407c.253-.107.478-.243.673-.41.194-.166.34-.343.437-.53.1-.187.18-.387.24-.6.06-.213.089-.42.086-.622a9.09 9.09 0 0 0-.01-.669c-.007-.22-.01-.445-.01-.673a1.447 1.447 0 0 1 .42-1.035c.136-.135.29-.242.462-.32a1.4 1.4 0 0 1 .563-.11H6zm4 10.032V14h.09c.313 0 .616-.062.909-.185.293-.123.552-.3.775-.53.222-.226.387-.477.493-.75v-.001c.1-.266.165-.543.198-.83v-.002c.028-.28.036-.567.024-.863-.012-.29-.018-.58-.018-.869 0-.203.04-.393.117-.572v-.001a1.502 1.502 0 0 1 .765-.787 1.38 1.38 0 0 1 .558-.115H14v-.984h-.09c-.196 0-.381-.04-.557-.121l-.001-.001a1.376 1.376 0 0 1-.455-.318l-.002-.002a1.415 1.415 0 0 1-.307-.465v-.002a1.405 1.405 0 0 1-.118-.566c0-.29.006-.58.018-.869.012-.296.004-.585-.024-.87v-.001a3.548 3.548 0 0 0-.198-.824v-.001a2.23 2.23 0 0 0-.493-.75 2.33 2.33 0 0 0-.775-.53 2.325 2.325 0 0 0-.91-.185H10v.984h.09c.2 0 .387.038.563.115.174.082.326.188.457.32.127.134.23.29.309.467.074.18.11.37.11.573 0 .228-.003.453-.01.673-.007.228-.004.45.01.665.007.213.036.422.086.627.06.208.14.408.24.6.104.194.25.367.438.52.19.156.413.292.671.407a2.526 2.526 0 0 0-.673.41c-.194.166-.34.343-.437.53-.1.187-.18.387-.24.6-.06.213-.089.42-.086.622.003.22.006.443.01.669.007.22.01.445.01.673 0 .203-.037.393-.11.573a1.447 1.447 0 0 1-.771.787c-.176.077-.363.115-.563.115H10z" />
	);
}
