/**
 * Negative control for scripts/ci/user-text-readers.ts: every trim and number read the scanner must refuse beside the
 * look-alikes it must ignore. Never imported; the test scans this path as a reader module with `sanctioned` as its one
 * allowed function and reads the tags.
 *
 *   // refused <shape>  -> the scanner reports this line with that shape
 *   // seen             -> judged and accepted: a non-text argument, or a read inside the allowed function
 *   untagged            -> not a lib trim or number read at all
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

export function reads(): void {
	text.trim(); // refused .trim()
	text.trimStart(); // refused .trimStart()
	text.trimEnd(); // refused .trimEnd()
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
	[text].map((item) => item.trim()); // refused .trim()
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
	return value.trim(); // refused .trim()
}

export function sanctioned(value: string): number {
	const trimmed = value.trim(); // seen
	[value].map((item) => item.trim()); // seen
	[value].map(function named(item) {
		return item.trim(); // refused .trim()
	});
	const reader = {
		get normalized() {
			return value.trim(); // refused .trim()
		},
		"quoted-name"() {
			return value.trim(); // refused .trim()
		},
	};
	void reader;
	return parseFloat(trimmed); // seen
}
