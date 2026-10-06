/**
 * Negative control for scripts/ci/user-text-readers.ts: every trim, number read, and coercion the scanner must refuse
 * beside the look-alikes it must ignore. Never imported; the test scans this path as a reader module with two allowlist
 * rows, the function `sanctioned` and the assigned arrow `assigned`, and reads the tags.
 *
 *   // refused <shape>          -> the scanner reports this line with that shape, at the line's first non-blank column
 *   // refused <shape> at <col>  -> the same, at that column (the read starts after a `return` or inside a callback)
 *   // seen                      -> judged and accepted: a non-text operand, or a read inside the allowed function
 *   untagged                     -> not a lib trim, number read, or coercion at all
 */
declare const text: string;
declare const maybeText: string | undefined;
// biome-ignore lint/suspicious/noExplicitAny: the unresolved-receiver shape
declare const loose: any;
declare const mystery: unknown;
declare function readVoid(): void;
declare const count: number;
declare const stamped: number & { readonly unit: "ms" };
declare const choose: boolean;
declare const big: bigint;
declare const flag: boolean;
declare const holder: { readonly label: string };
declare const own: { trim(): string };
declare const mapped: Record<"trim", () => number>;
declare const either: string | { trim(): string };
declare const scalar: string | number;
declare const stamp: string | Date;
declare const laterStamp: string | Date;

export function reads(): void {
	text.trim(); // refused .trim()
	text.trimStart(); // refused .trimStart()
	text.trimEnd(); // refused .trimEnd()
	text.trimLeft(); // refused .trimLeft()
	text.trimRight(); // refused .trimRight()
	maybeText?.trim(); // refused .trim()
	holder.label.trim(); // refused .trim()
	`${count}`.trim(); // refused .trim()
	"literal".trim(); // refused .trim()
	either.trim(); // refused .trim()
	// biome-ignore lint/complexity/useLiteralKeys: the computed-key call shape
	text["trim"](); // refused .trim()
	const key = "trimEnd";
	text[key](); // refused .trimEnd()
	text[choose ? "trimStart" : "trimEnd"](); // refused .trimEnd() or .trimStart()
	// biome-ignore format: the parenthesized-callee shape
	(text.trim)(); // refused .trim()
	// biome-ignore lint/style/noNonNullAssertion: the asserted-callee shape
	text.trim!(); // refused .trim()
	loose.trim(); // refused .trim() on an unresolved receiver
	[text].map((item) => item.trim()); // refused .trim() at 23
	Number(text); // refused Number()
	Number(maybeText); // refused Number()
	Number(mystery); // refused Number()
	Number(readVoid()); // refused Number()
	Number(loose); // refused Number()
	Number(count.toFixed(2)); // refused Number()
	parseFloat(text); // refused parseFloat()
	parseInt(text, 10); // refused parseInt()
	Number.parseFloat(text); // refused Number.parseFloat()
	Number.parseInt(text, 10); // refused Number.parseInt()
	globalThis.Number(text); // refused Number()
	globalThis.parseFloat(text); // refused parseFloat()
	const toNumber = Number;
	toNumber(text); // refused Number()
	new Number(text); // refused new Number()
	+text; // refused unary +
	+loose; // refused unary +
	loose * 1; // refused binary *
	2 / loose; // refused binary /
	loose - 1; // refused binary -
	loose % 2; // refused binary %
	loose ** 2; // refused binary **
	let total = 0;
	total *= loose; // refused binary *=
	total /= loose; // refused binary /=
	total -= loose; // refused binary -=
	total %= loose; // refused binary %=
	total **= loose; // refused binary **=
	+count; // seen
	count * 2; // seen
	big * 2n; // seen
	total -= 1; // seen
	-loose; // refused unary -
	~loose; // refused unary ~
	loose | 0; // refused binary |
	loose & 1; // refused binary &
	loose ^ 1; // refused binary ^
	loose << 1; // refused binary <<
	loose >> 1; // refused binary >>
	loose >>> 0; // refused binary >>>
	total |= loose; // refused binary |=
	total &= loose; // refused binary &=
	total ^= loose; // refused binary ^=
	total <<= loose; // refused binary <<=
	total >>= loose; // refused binary >>=
	total >>>= loose; // refused binary >>>=
	loose < 20; // refused binary <
	20 <= loose; // refused binary <=
	loose > 20; // refused binary >
	loose >= 20; // refused binary >=
	scalar < text; // refused binary <
	scalar <= text; // refused binary <=
	stamp < laterStamp; // refused binary <
	parseInt("10", loose); // refused parseInt()
	Number.parseInt("10", loose); // refused Number.parseInt()
	-count; // seen
	~count; // seen
	count | 0; // seen
	count < 20; // seen
	text < "a"; // seen
	parseInt("10", count); // seen
	void total;
	Number(count); // seen
	Number(stamped); // seen
	Number(big); // seen
	Number(flag); // seen
	Number("12"); // seen
	Number(); // seen
	parseFloat("1.5"); // seen
	own.trim();
	mapped.trim();
	Number.isFinite(count);
	count.toFixed(2);
	text.at(0);
	text.length.toString();
}

export function constrained<Text extends string>(value: Text): string {
	return value.trim(); // refused .trim() at 9
}

export function sanctioned(value: string): number {
	const trimmed = value.trim(); // seen
	[value].map((item) => item.trim()); // seen
	[value].map(function named(item) {
		return item.trim(); // refused .trim() at 10
	});
	const reader = {
		get normalized() {
			return value.trim(); // refused .trim() at 11
		},
		"quoted-name"() {
			return value.trim(); // refused .trim() at 11
		},
	};
	void reader;
	const bound = () => value.trim(); // refused .trim() at 22
	void bound;
	return parseFloat(trimmed); // seen
}

export const assigned = (value: string): string => value.trim(); // seen
