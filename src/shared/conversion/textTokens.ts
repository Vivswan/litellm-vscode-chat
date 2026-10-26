/**
 * Text-token counting for the local budget estimates: one module-level mode that every text estimate reads. The
 * extension host installs the configured mode; tokenEstimation.ts prices all transmitted text through here.
 *
 *   Counting                                 -> is always synchronous and total
 *   a tokenizer                              -> arrives by a later setTextTokenCounting call once its rank data has
 *                                               loaded, never awaited on the request path
 *   a throwing tokenizer or detection trigger -> is contained
 */

/** The plain estimate's rate for Latin text; the two-band estimate prices the non-CJK remainder by it too. */
export const CHARS_PER_TOKEN = 4;

/** The CJK code point bands and the tokens each prices a character at; cjkTokenPrice says why these prices. */
const CJK_PRICE_BANDS: readonly (readonly [from: number, to: number, tokens: number])[] = [
	[0x4e00, 0x9fff, 1], // CJK unified ideographs
	[0x3000, 0x30ff, 1], // CJK punctuation, hiragana, katakana
	[0xac00, 0xd7af, 1], // Hangul syllables
	[0xff00, 0xffef, 2], // fullwidth and halfwidth forms
	[0x1100, 0x11ff, 3], // Hangul jamo
	[0x2e80, 0x2fff, 3], // CJK radicals, Kangxi radicals
	[0x3100, 0x33ff, 3], // bopomofo, compatibility jamo, kanbun, enclosed, compatibility
	[0x3400, 0x4dff, 3], // extension A, Yijing hexagrams
	[0xa960, 0xa97f, 3], // Hangul jamo extended-A
	[0xd7b0, 0xd7ff, 3], // Hangul jamo extended-B
	[0xf900, 0xfaff, 3], // CJK compatibility ideographs
	[0x20000, 0x3ffff, 4], // Han extensions B through H
];

export type TextTokenCounting =
	| { readonly kind: "heuristic" }
	| { readonly kind: "adaptive"; readonly onNonLatinDetected: () => void }
	| { readonly kind: "tokenizer"; readonly countTokens: (text: string) => number };

let counting: TextTokenCounting = { kind: "heuristic" };

export function setTextTokenCounting(next: TextTokenCounting): void {
	counting = next;
}

export function plainTextTokenEstimate(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Cheap range checks, not Unicode property lookups, because this runs per character on the request path.
 *
 *   common CJK                                  -> 1 token; a bytes bound would triple-price real Chinese
 *   fullwidth and halfwidth forms (U+FF00-FFEF) -> 2 tokens, measured; a bytes bound would triple-price Japanese
 *   rare CJK                                    -> the UTF-8 byte count; BPE merges only shorten, so no undercount
 */
function cjkTokenPrice(codePoint: number): number {
	for (const [from, to, tokens] of CJK_PRICE_BANDS) {
		if (from <= codePoint && codePoint <= to) {
			return tokens;
		}
	}
	return 0;
}

/**
 * Whether a code point counts toward detection: text the plain chars/4 rule badly underprices. Deliberately broader
 * than the two-band's CJK pricing.
 *
 *   The 0x2000-0x2E7F punctuation and symbol blocks stay out -> curly-quote-and-dash English prose cannot trip it
 */
function isNonLatinScript(codePoint: number): boolean {
	return (codePoint >= 0x0370 && codePoint <= 0x1fff) || codePoint >= 0x2e80;
}

interface TextScan {
	readonly codePoints: number;
	readonly nonLatin: number;
	readonly cjkTokens: number;
	readonly cjkUnits: number;
}

function scanText(text: string): TextScan {
	let codePoints = 0;
	let nonLatin = 0;
	let cjkTokens = 0;
	let cjkUnits = 0;
	for (let i = 0; i < text.length; ) {
		// codePointAt(i) with i inside the string never returns undefined.
		const codePoint = text.codePointAt(i) as number;
		const width = codePoint > 0xffff ? 2 : 1;
		codePoints += 1;
		if (isNonLatinScript(codePoint)) {
			nonLatin += 1;
		}
		const price = cjkTokenPrice(codePoint);
		if (price > 0) {
			cjkTokens += price;
			cjkUnits += width;
		}
		i += width;
	}
	return { codePoints, nonLatin, cjkTokens, cjkUnits };
}

function twoBandFromScan(text: string, scan: TextScan): number {
	return scan.cjkTokens + Math.ceil((text.length - scan.cjkUnits) / CHARS_PER_TOKEN);
}

/**
 * It errs toward overcounting CJK, the safer direction for a budget.
 *
 *   An interim, not a bound -> other tokenizers can price above it
 */
export function twoBandTextTokenEstimate(text: string): number {
	return twoBandFromScan(text, scanText(text));
}

/**
 * When adaptive counting reports a text as significantly non-Latin. The count floor keeps a stray glyph inside English
 * text from pulling megabytes of rank data into memory; the fraction keeps a long English prompt quoting one foreign
 * line from doing the same.
 */
const NON_LATIN_DETECTION_MIN_CHARS = 8;
const NON_LATIN_DETECTION_MIN_FRACTION = 0.05;

function meetsDetectionThreshold(scan: TextScan): boolean {
	return (
		scan.nonLatin >= NON_LATIN_DETECTION_MIN_CHARS &&
		scan.nonLatin >= scan.codePoints * NON_LATIN_DETECTION_MIN_FRACTION
	);
}

export function countTextTokens(text: string): number {
	if (counting.kind === "tokenizer") {
		try {
			return counting.countTokens(text);
		} catch {
			// gpt-tokenizer throws on disallowed special-token text; the loader permits them all, so this is a
			// backstop, priced by the safe band.
		}
		return twoBandTextTokenEstimate(text);
	}
	if (counting.kind === "heuristic") {
		return plainTextTokenEstimate(text);
	}
	const scan = scanText(text);
	if (meetsDetectionThreshold(scan)) {
		try {
			counting.onNonLatinDetected();
		} catch {
			// A throwing trigger must not break counting.
		}
	}
	// Deliberately the two-band figure even if the trigger just installed a cached tokenizer: the call that fired the
	// trigger keeps its metric.
	return twoBandFromScan(text, scan);
}
