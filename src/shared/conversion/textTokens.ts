/**
 * Text-token counting for the local budget estimates: one module-level
 * counting mode that every text estimate reads. Pure and vscode-free so the
 * bun tree can pin it; the extension host installs the configured mode here
 * (the chat.tokenEstimation reader and the gpt-tokenizer loader live
 * host-side in extension/tokenCounting.ts), and tokenEstimation.ts prices all
 * transmitted text through countTextTokens/countTextBytesTokens.
 *
 * Counting is always synchronous and total: a tokenizer arrives by a later
 * setTextTokenCounting call once its rank data has loaded, never awaited on
 * the request path, and a throwing tokenizer or detection trigger is
 * contained here (both pinned by textTokens.test.ts).
 */

export const CHARS_PER_TOKEN = 4;

/**
 * The installed counting mode.
 *
 * - "heuristic": the plain length/4 rule (and bytes/4 for undecoded text
 *   parts). The explicit chat.tokenEstimation "heuristic" setting, and the
 *   window while an explicitly picked encoding is still loading.
 * - "adaptive": the auto setting's interim - the script-aware two-band
 *   estimate (see twoBandTextTokenEstimate). Counting a significantly
 *   non-Latin text fires onNonLatinDetected, which the host uses to start
 *   the tokenizer load; the call that fired the trigger still returns the
 *   two-band figure even if the trigger installs a cached tokenizer
 *   synchronously (pinned by textTokens.test.ts), though later parts of the
 *   same estimate pass then count through the tokenizer.
 * - "tokenizer": a loaded gpt-tokenizer encoding counts exactly; a throw
 *   falls back to the two-band estimate for that text.
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
 * - COMMON CJK (main Han, kana, Hangul syllables, CJK punctuation): 1 token.
 *   o200k_base prices realistic text in these blocks well under that
 *   (0.5-0.85 per character measured on Chinese/Japanese/Korean sentences;
 *   textTokens.test.ts pins the Chinese fixture). Block pricing, not
 *   character pricing: an individually rare ideograph inside the main Han
 *   block can cost 2-3 tokens. Simplified-Chinese and Japanese prose absorbs
 *   that with margin, Traditional-Chinese prose sits near parity, and
 *   rare-ideograph-dense but ordinary text - written Cantonese, personal
 *   names, classical quotations - can undercount by up to about 2x until the
 *   tokenizer lands. The bytes bound is deliberately not applied here
 *   because it would triple-price every real Chinese sentence and turn the
 *   estimate's failure mode into pre-send over-refusal.
 * - RARE CJK (radicals, jamo, bopomofo, compatibility blocks, extension A,
 *   astral Han extensions): the code point's UTF-8 byte count (3 for BMP,
 *   4 for astral). BPE merges only ever shorten a byte sequence, so a rare
 *   code point can never cost more tokens than bytes - pricing it at bytes
 *   cannot undercount it, where the 1-token band demonstrably did (o200k
 *   prices U+20000 at 3 and U+30000 at 4; both pinned).
 * - FULLWIDTH AND HALFWIDTH FORMS (U+FF00-FFEF): 2 tokens. Measured, not the
 *   bytes bound: every code point in the block meters at most 2 in o200k
 *   (halfwidth katakana exactly 2, pinned), while pricing the block at bytes
 *   would triple-price the fullwidth digits and letters realistic Japanese
 *   text carries (a fullwidth date meters under 1 per character).
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
 * badly underprices, which real tokenizers meter at roughly 0.5-3 tokens per
 * character. Deliberately broader than the two-band's CJK pricing: the
 * 0x0370-0x1FFF stretch covers Greek/Cyrillic/Hebrew/Arabic/Thai/Devanagari
 * and also Latin Extended Additional (Vietnamese - equally underpriced), and
 * everything from the CJK blocks upward includes the astral symbol and emoji
 * planes (an emoji costs 1-3 tokens against the plain rule's 0.5). A
 * detection here buys accuracy, never waste: the tokenizer that loads is
 * exactly what prices these texts right. The 0x2000-0x2E7F punctuation and
 * symbol blocks stay out so curly-quote-and-dash English prose cannot trip
 * it, and the count/fraction floors below keep incidental glyphs from
 * pulling megabytes of rank data into memory (all pinned by tests).
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
 * The script-aware two-band estimate: CJK code points at their band price
 * (see cjkTokenPrice), everything else at chars/4. Against o200k_base (the
 * encoding the auto mode loads) this errs toward overcounting CJK text -
 * for the budget the safer direction, since an undercounted prompt is never
 * trimmed by the host and overflows server-side, while an overcount trims
 * early and, at the extreme, refuses a nearly-full conversation before send.
 * Non-CJK non-Latin scripts (Thai, Cyrillic, ...) stay on the chars/4 band -
 * still an undercount there - but they fire the detection below, so the
 * tokenizer takes over from the next estimate on. An interim, not a bound:
 * other tokenizers (cl100k_base, a model's own) can price slightly above it.
 */
export function twoBandTextTokenEstimate(text: string): number {
	return twoBandFromScan(text, scanText(text));
}

/**
 * When adaptive counting reports a text as significantly non-Latin: at least
 * NON_LATIN_DETECTION_MIN_CHARS non-Latin code points, and at least
 * NON_LATIN_DETECTION_MIN_FRACTION of the text's code points. The floor
 * keeps a stray glyph inside English text from pulling megabytes of rank
 * data into memory; the fraction keeps a long English prompt quoting one
 * foreign line from doing the same. Both bounds are pinned by tests
 * (textTokens.test.ts).
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
 * contained, so nothing here can throw into the request path (pinned by
 * textTokens.test.ts).
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

const utf8 = new TextDecoder();

/**
 * Count a text-form data part (bytes that conversion decodes onto the wire).
 * The heuristic mode keeps the historical bytes/4 rule; the other modes
 * decode first, because both the two-band scan and a tokenizer need the
 * characters (CJK UTF-8 runs three bytes per character, so bytes/4 undercounts
 * it even harder than chars/4 does).
 */
export function countTextBytesTokens(data: Uint8Array): number {
	if (counting.kind === "heuristic") {
		return Math.ceil(data.length / CHARS_PER_TOKEN);
	}
	return countTextTokens(utf8.decode(data));
}
