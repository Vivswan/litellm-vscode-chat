/**
 * The extension's one compact token-count rendering: "128k", not "128,000" - a line that is skimmed rather than read
 * should not carry four exact digits mid-sentence, and the exact figure belongs in the detail beside it.
 */

/**
 * The magnitude is picked AFTER rounding, not before: 999,999 rounds to 1000 thousands, and "1000k" is a unit that
 * should have been promoted.
 */
export function compactTokenCount(count: number): string {
	if (count < 1000) {
		return String(count);
	}
	const thousands = Math.round(count / 1000);
	if (thousands < 1000) {
		return `${String(thousands)}k`;
	}
	return `${String(Number((count / 1_000_000).toPrecision(3)))}M`;
}
