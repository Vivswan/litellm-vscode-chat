/**
 * The one grammar a user's number text must pass before Number() reads it: ASCII digits, one optional dot, an optional
 * exponent, an optional sign, nothing else. Number() alone also reads Unicode whitespace, "0x10", "Infinity", and ""
 * (as 0), each a second reading of the text that no field asked for. The dot branches are explicit so a long digit run
 * with a stray suffix is refused in linear time (two adjacent `\d*` groups would backtrack quadratically). Pure by
 * construction - this rides into the webview bundle.
 *
 * Groups: 1 sign; 2 whole digits and 3 the fraction after their dot ("12.", "12.5"); 4 the fraction of a leading dot
 * (".5"); 5 the exponent.
 */
export const DECIMAL_TEXT_PATTERN = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i;

/** The finite number a decimal text spells, or undefined when the text is not decimal notation or overflows. */
export function parseDecimalText(text: string): number | undefined {
	if (!DECIMAL_TEXT_PATTERN.test(text)) {
		return undefined;
	}
	const value = Number(text);
	return Number.isFinite(value) ? value : undefined;
}
