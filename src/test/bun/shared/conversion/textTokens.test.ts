import { afterEach, describe, test } from "bun:test";
import * as assert from "node:assert";
import { countTokens as cl100kCountTokens } from "gpt-tokenizer/encoding/cl100k_base";
import { countTokens as o200kCountTokens } from "gpt-tokenizer/encoding/o200k_base";
import {
	CHARS_PER_TOKEN,
	countTextBytesTokens,
	countTextTokens,
	NON_LATIN_DETECTION_MIN_CHARS,
	NON_LATIN_DETECTION_MIN_FRACTION,
	plainTextTokenEstimate,
	setTextTokenCounting,
	twoBandTextTokenEstimate,
} from "../../../../shared/conversion/textTokens";

/**
 * A realistic Chinese chat message: 54 Han characters plus ASCII punctuation
 * and spaces (60 UTF-16 units in all). The plain chars/4 heuristic prices it
 * at 15 tokens while real tokenizers see 45 (o200k_base) and 58 (cl100k_base)
 * - the 3-4x undercount this module's modes exist to close.
 */
const CHINESE_FIXTURE =
	"请把这个函数重构成纯函数, 并为它补上完整的单元测试。注意保持原有的错误处理逻辑不变, 同时把所有网络调用移动到调用方。";

afterEach(() => {
	setTextTokenCounting({ kind: "heuristic" });
});

describe("shared/conversion/textTokens: the CJK undercount demonstration", () => {
	test("the plain heuristic undercounts the Chinese fixture 3-4x against real tokenizers", () => {
		const heuristic = plainTextTokenEstimate(CHINESE_FIXTURE);
		assert.strictEqual(heuristic, 15);
		// Frozen encodings, so the counts are stable: o200k_base packs common
		// Chinese tighter than cl100k_base, hence 3x against its 3.9x.
		assert.strictEqual(o200kCountTokens(CHINESE_FIXTURE), 45);
		assert.strictEqual(cl100kCountTokens(CHINESE_FIXTURE), 58);
		assert.ok(o200kCountTokens(CHINESE_FIXTURE) >= 3 * heuristic);
		assert.ok(cl100kCountTokens(CHINESE_FIXTURE) >= 3.8 * heuristic);
	});

	test("the two-band estimate never undercounts the fixture against o200k_base, the tokenizer auto loads", () => {
		const twoBand = twoBandTextTokenEstimate(CHINESE_FIXTURE);
		assert.strictEqual(twoBand, 57);
		assert.ok(twoBand >= o200kCountTokens(CHINESE_FIXTURE), `${twoBand} >= o200k`);
	});
});

describe("shared/conversion/textTokens: the two-band estimate", () => {
	test("pure ASCII stays exactly the plain chars/4 rule", () => {
		const text = "Refactor this function into a pure one.";
		assert.strictEqual(twoBandTextTokenEstimate(text), plainTextTokenEstimate(text));
		assert.strictEqual(twoBandTextTokenEstimate(text), Math.ceil(text.length / CHARS_PER_TOKEN));
	});

	test("common CJK code points price one token each, on top of the remainder's chars/4", () => {
		// 4 Han + 8 other UTF-16 units: 4 + ceil(8 / 4) = 6.
		assert.strictEqual(twoBandTextTokenEstimate("你好世界 abcdefg"), 6);
		assert.strictEqual(twoBandTextTokenEstimate("こんにちは"), 5);
		assert.strictEqual(twoBandTextTokenEstimate("안녕하세요"), 5);
	});

	test("rare CJK code points price their UTF-8 byte count, covering o200k's byte-fallback pricing", () => {
		// Extension A (BMP, 3 bytes): priced 3; o200k prices U+3400 at 3.
		const extA = "㐀".repeat(8);
		assert.strictEqual(twoBandTextTokenEstimate(extA), 24);
		assert.ok(twoBandTextTokenEstimate(extA) >= o200kCountTokens(extA));
		// Extension B (astral, 4 bytes): priced 4; o200k prices U+20000 at 3.
		const extB = "\u{20000}".repeat(8);
		assert.strictEqual(twoBandTextTokenEstimate(extB), 32);
		assert.ok(twoBandTextTokenEstimate(extB) >= o200kCountTokens(extB));
		// Extension G (astral, 4 bytes): priced 4; o200k prices U+30000 at exactly 4.
		const extG = "\u{30000}".repeat(8);
		assert.strictEqual(twoBandTextTokenEstimate(extG), 32);
		assert.ok(twoBandTextTokenEstimate(extG) >= o200kCountTokens(extG));
		// Halfwidth katakana (fullwidth/halfwidth block): priced 2; o200k prices
		// it just under 2 per character, so the 1-token band undercounted 2x.
		const halfwidth = "ｱｲｳｴｵｶｷｸ";
		assert.strictEqual(twoBandTextTokenEstimate(halfwidth), 16);
		assert.ok(twoBandTextTokenEstimate(halfwidth) >= o200kCountTokens(halfwidth));
	});

	test("fullwidth ASCII prices 2 per code point: over a fullwidth date, never under halfwidth kana", () => {
		// 7 fullwidth digits at 2 plus 3 Han at 1 = 17; o200k meters the date at
		// 8. The overcount is the accepted direction - the bytes bound (3) would
		// have made it 24 - while no single code point in the block meters
		// above 2, so the band cannot undercount.
		const date = "２０２６年８月１３日";
		assert.strictEqual(twoBandTextTokenEstimate(date), 17);
		assert.ok(twoBandTextTokenEstimate(date) >= o200kCountTokens(date));
	});

	test("the empty string prices zero", () => {
		assert.strictEqual(twoBandTextTokenEstimate(""), 0);
		assert.strictEqual(plainTextTokenEstimate(""), 0);
	});
});

describe("shared/conversion/textTokens: the installed counting mode", () => {
	test("the default mode is the plain heuristic", () => {
		assert.strictEqual(countTextTokens(CHINESE_FIXTURE), plainTextTokenEstimate(CHINESE_FIXTURE));
	});

	test("an installed tokenizer counts every text", () => {
		setTextTokenCounting({ kind: "tokenizer", countTokens: (text) => o200kCountTokens(text) });
		assert.strictEqual(countTextTokens(CHINESE_FIXTURE), o200kCountTokens(CHINESE_FIXTURE));
		assert.strictEqual(countTextTokens("hello"), o200kCountTokens("hello"));
	});

	test("a throwing tokenizer falls back to the two-band estimate instead of escaping", () => {
		// gpt-tokenizer's default options throw on special-token text; the
		// loader permits them, and this pins the backstop for anything else.
		setTextTokenCounting({
			kind: "tokenizer",
			countTokens: () => {
				throw new Error("Disallowed special token");
			},
		});
		assert.strictEqual(countTextTokens(CHINESE_FIXTURE), twoBandTextTokenEstimate(CHINESE_FIXTURE));
		assert.strictEqual(countTextTokens("<|endoftext|>"), twoBandTextTokenEstimate("<|endoftext|>"));
	});

	test("adaptive counting prices by the two-band estimate", () => {
		setTextTokenCounting({ kind: "adaptive", onNonLatinDetected: () => {} });
		assert.strictEqual(countTextTokens(CHINESE_FIXTURE), twoBandTextTokenEstimate(CHINESE_FIXTURE));
		assert.strictEqual(countTextTokens("plain english"), plainTextTokenEstimate("plain english"));
	});

	test("a throwing detection trigger never escapes into the count", () => {
		setTextTokenCounting({
			kind: "adaptive",
			onNonLatinDetected: () => {
				throw new Error("boom");
			},
		});
		assert.strictEqual(countTextTokens(CHINESE_FIXTURE), twoBandTextTokenEstimate(CHINESE_FIXTURE));
	});

	test("the call that fires the trigger returns the two-band figure even when the trigger installs a tokenizer", () => {
		setTextTokenCounting({
			kind: "adaptive",
			onNonLatinDetected: () => {
				setTextTokenCounting({ kind: "tokenizer", countTokens: () => 4242 });
			},
		});
		assert.strictEqual(countTextTokens(CHINESE_FIXTURE), twoBandTextTokenEstimate(CHINESE_FIXTURE));
		assert.strictEqual(countTextTokens(CHINESE_FIXTURE), 4242);
	});
});

describe("shared/conversion/textTokens: the non-Latin detection threshold", () => {
	function detections(text: string): number {
		let fired = 0;
		setTextTokenCounting({
			kind: "adaptive",
			onNonLatinDetected: () => {
				fired += 1;
			},
		});
		countTextTokens(text);
		return fired;
	}

	test("the threshold constants hold the documented values", () => {
		// The bounds below are exercised against exactly these numbers; a change
		// here must retune them (and reconsider what pulls megabytes of rank
		// data into memory).
		assert.strictEqual(NON_LATIN_DETECTION_MIN_CHARS, 8);
		assert.strictEqual(NON_LATIN_DETECTION_MIN_FRACTION, 0.05);
	});

	test("the absolute floor: 8 non-Latin code points fire, 7 stay quiet", () => {
		assert.strictEqual(detections("你好世界你好世"), 0);
		assert.strictEqual(detections("你好世界你好世界"), 1);
	});

	test("the fraction floor: 8 non-Latin code points diluted below 5% stay quiet", () => {
		const cjk = "你好世界你好世界";
		// 8 CJK in 208 code points is under 5%; in 108 it is over.
		assert.strictEqual(detections(cjk + "a".repeat(200)), 0);
		assert.strictEqual(detections(cjk + "a".repeat(100)), 1);
	});

	test("non-CJK non-Latin scripts fire too: Thai, Cyrillic, and extension-G Han", () => {
		assert.strictEqual(detections("ปรับโครงสร้างฟังก์ชันนี้"), 1);
		assert.strictEqual(detections("отрефакторите эту функцию"), 1);
		assert.strictEqual(detections("\u{30000}".repeat(8)), 1);
	});

	test("the deliberate breadth: emoji and Vietnamese fire, because chars/4 underprices both", () => {
		// o200k meters an emoji at 1-3 tokens and Vietnamese diacritics (Latin
		// Extended Additional) well above the plain rule; the load is accuracy,
		// not waste (see isNonLatinScript).
		assert.strictEqual(detections("🚀🎉🔥🌟💡🎯🚨😀"), 1);
		assert.strictEqual(
			detections(
				"Hãy viết lại hàm này thành hàm thuần khiết, giữ nguyên cách xử lý lỗi hiện tại và bổ sung kiểm thử đơn vị đầy đủ."
			),
			1
		);
	});

	test("Latin-script European text and typographic punctuation never fire", () => {
		assert.strictEqual(detections("a".repeat(4000)), 0);
		// Accented Latin (French) stays below the 0x0370 line.
		assert.strictEqual(detections("Réécrivez cette fonction en une fonction pure, s'il vous plaît déjà."), 0);
		// Curly quotes and dashes live in the excluded 0x2000-0x2E7F blocks
		// (escaped so the fixture itself passes the repo's typography gate).
		assert.strictEqual(detections("\u201Cquoted\u201D \u2014 \u2018more\u2019 \u2013 again".repeat(4)), 0);
	});

	test("each significantly non-Latin count fires the trigger once", () => {
		let fired = 0;
		setTextTokenCounting({
			kind: "adaptive",
			onNonLatinDetected: () => {
				fired += 1;
			},
		});
		countTextTokens(CHINESE_FIXTURE);
		countTextTokens(CHINESE_FIXTURE);
		assert.strictEqual(fired, 2);
	});
});

describe("shared/conversion/textTokens: text-form bytes", () => {
	test("the heuristic mode keeps the historical bytes/4 rule", () => {
		const bytes = new TextEncoder().encode(CHINESE_FIXTURE);
		assert.strictEqual(countTextBytesTokens(bytes), Math.ceil(bytes.length / CHARS_PER_TOKEN));
	});

	test("the other modes decode and count the characters", () => {
		const bytes = new TextEncoder().encode(CHINESE_FIXTURE);
		setTextTokenCounting({ kind: "adaptive", onNonLatinDetected: () => {} });
		assert.strictEqual(countTextBytesTokens(bytes), twoBandTextTokenEstimate(CHINESE_FIXTURE));
		setTextTokenCounting({ kind: "tokenizer", countTokens: (text) => o200kCountTokens(text) });
		assert.strictEqual(countTextBytesTokens(bytes), o200kCountTokens(CHINESE_FIXTURE));
	});
});
