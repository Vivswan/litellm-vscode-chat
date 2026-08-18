/**
 * Text-token counting for the local budget estimates: one module-level mode
 * that every text estimate reads. The extension host installs the configured
 * mode; tokenEstimation.ts prices all transmitted text through here.
 *
 * Counting is always synchronous and total: a tokenizer arrives by a later
 * setTextTokenCounting call once its rank data has loaded, never awaited on the
 * request path, and a throwing tokenizer or detection trigger is contained.
 */

export const CHARS_PER_TOKEN = 4;

/**
 * The installed counting mode.
 *
 * - "heuristic": the plain length/4 rule (bytes/4 for undecoded text parts).
 *   The explicit setting, and the window while a picked encoding loads.
 * - "adaptive": the auto setting's interim two-band estimate. Counting a
 *   significantly non-Latin text fires onNonLatinDetected, which starts the
 *   tokenizer load; that call still returns the two-band figure.
 * - "tokenizer": a loaded gpt-tokenizer encoding counts exactly; a throw falls
 *   back to the two-band estimate for that text.
 */
export type TextTokenCounting =
	| { readonly kind: "heuristic" }
	| { readonly kind: "adaptive"; readonly onNonLatinDetected: () => void }
	| { readonly kind: "tokenizer"; readonly countTokens: (text: string) => number };

let counting: TextTokenCounting = { kind: "heuristic" };

export function setTextTokenCounting(next: TextTokenCounting): void {
	counting = next;
}

/** The plain chars/4 estimate, the explicit "heuristic" setting's rule. */
export function plainTextTokenEstimate(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * How the two-band estimate prices one code point. Cheap range checks, not
 * Unicode property lookups: this runs per character on the request path.
 *
 * - COMMON CJK (main Han, kana, Hangul syllables, CJK punctuation): 1 token,
 *   priced by block. The bytes bound is deliberately NOT applied here: it
 *   would triple-price every real Chinese sentence into pre-send over-refusal.
 * - RARE CJK (radicals, jamo, bopomofo, compatibility blocks, extension A,
 *   astral Han extensions): the code point's UTF-8 byte count. BPE merges only
 *   shorten a byte sequence, so bytes can never undercount.
 * - FULLWIDTH AND HALFWIDTH FORMS (U+FF00-FFEF): 2 tokens, measured rather
 *   than bounded by bytes, which would triple-price realistic Japanese text.
 * - Everything else: 0, meaning the caller's chars/4 remainder band.
 */
function cjkTokenPrice(codePoint: number): number {
	if (
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK unified ideographs
		(codePoint >= 0x3000 && codePoint <= 0x30ff) || // CJK punctuation, hiragana, katakana
		(codePoint >= 0xac00 && codePoint <= 0xd7af) // Hangul syllables
	) {
		return 1;
	}
	if (codePoint >= 0xff00 && codePoint <= 0xffef) {
		// fullwidth and halfwidth forms
		return 2;
	}
	if (
		(codePoint >= 0x1100 && codePoint <= 0x11ff) || // Hangul jamo
		(codePoint >= 0x2e80 && codePoint <= 0x2fff) || // CJK radicals, Kangxi radicals
		(codePoint >= 0x3100 && codePoint <= 0x33ff) || // bopomofo, compatibility jamo, kanbun, enclosed, compatibility
		(codePoint >= 0x3400 && codePoint <= 0x4dff) || // extension A, Yijing hexagrams
		(codePoint >= 0xa960 && codePoint <= 0xa97f) || // Hangul jamo extended-A
		(codePoint >= 0xd7b0 && codePoint <= 0xd7ff) || // Hangul jamo extended-B
		(codePoint >= 0xf900 && codePoint <= 0xfaff) // CJK compatibility ideographs
	) {
		return 3;
	}
	if (codePoint >= 0x20000 && codePoint <= 0x3ffff) {
		// Han extensions B through H
		return 4;
	}
	return 0;
}

/**
 * Whether a code point counts toward detection: text the plain chars/4 rule
 * badly underprices. Deliberately broader than the two-band's CJK pricing. The
 * 0x2000-0x2E7F punctuation and symbol blocks stay out so curly-quote-and-dash
 * English prose cannot trip it.
 */
function isNonLatinScript(codePoint: number): boolean {
	return (codePoint >= 0x0370 && codePoint <= 0x1fff) || codePoint >= 0x2e80;
}

interface TextScan {
	readonly codePoints: number;
	readonly nonLatin: number;
	/** The summed two-band price of the CJK code points. */
	readonly cjkTokens: number;
	/** The UTF-16 units those CJK code points occupy (excluded from the chars/4 remainder). */
	readonly cjkUnits: number;
}

/** One pass over the text: detection and pricing counts together. */
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

/** The two-band formula over a completed scan; see twoBandTextTokenEstimate. */
function twoBandFromScan(text: string, scan: TextScan): number {
	return scan.cjkTokens + Math.ceil((text.length - scan.cjkUnits) / CHARS_PER_TOKEN);
}

/**
 * The script-aware two-band estimate: CJK code points at their band price,
 * everything else at chars/4. It errs toward overcounting CJK, the safer
 * direction for a budget - an undercounted prompt is never trimmed by the host
 * and overflows server-side. Non-CJK non-Latin scripts stay on the chars/4
 * band, still an undercount, but they fire the detection below. An interim,
 * not a bound: other tokenizers can price above it.
 */
export function twoBandTextTokenEstimate(text: string): number {
	return twoBandFromScan(text, scanText(text));
}

/**
 * When adaptive counting reports a text as significantly non-Latin. The count
 * floor keeps a stray glyph inside English text from pulling megabytes of rank
 * data into memory; the fraction keeps a long English prompt quoting one
 * foreign line from doing the same.
 */
export const NON_LATIN_DETECTION_MIN_CHARS = 8;
export const NON_LATIN_DETECTION_MIN_FRACTION = 0.05;

function meetsDetectionThreshold(scan: TextScan): boolean {
	return (
		scan.nonLatin >= NON_LATIN_DETECTION_MIN_CHARS &&
		scan.nonLatin >= scan.codePoints * NON_LATIN_DETECTION_MIN_FRACTION
	);
}

/**
 * Count one transmitted text through the installed mode. Total by
 * construction: the adaptive trigger and the tokenizer call are both
 * contained, so nothing here can throw into the request path.
 */
export function countTextTokens(text: string): number {
	if (counting.kind === "tokenizer") {
		try {
			return counting.countTokens(text);
		} catch {
			// gpt-tokenizer throws on disallowed special-token text; the loader
			// permits them all, so this is a backstop, priced by the safe band.
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
			// The trigger only kicks off a background load; a throwing trigger
			// must not break counting.
		}
	}
	// Deliberately the two-band figure even if the trigger just installed a
	// cached tokenizer: the call that fired the trigger keeps its metric.
	return twoBandFromScan(text, scan);
}
