/**
 * The one grammar a user's number text must pass before Number() reads it: ASCII digits, one optional dot, an optional
 * exponent, an optional sign, nothing else. Number() alone also reads Unicode whitespace, "0x10", "Infinity", and ""
 * (as 0), each a second reading of the text that no field asked for. Pure by construction - this rides into the webview
 * bundle.
 */
export const DECIMAL_TEXT_PATTERN = /^([+-]?)(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i;

/** The finite number a decimal text spells, or undefined when the text is not decimal notation or overflows. */
export function parseDecimalText(text: string): number | undefined {
	const match = DECIMAL_TEXT_PATTERN.exec(text);
	if (match === null || (match[2] === "" && match[3] === "")) {
		return undefined;
	}
	const value = Number(text);
	return Number.isFinite(value) ? value : undefined;
}
