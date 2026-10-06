/**
 * Positive control for scripts/lint/userTextReaders.ts: a reader that takes a user's text only through the two homes
 * passes with no allow row. Never imported; the test replays this file through RuleTester and expects no report. The
 * tags are for the reader, nothing reads them.
 *
 *   // seen    -> judged and accepted: not a text operand
 *   untagged  -> not a lib trim, number read, or coercion at all
 */
import { parseDecimalText } from "../../../../shared/util/decimalText";
import { usableHttpText } from "../../../../shared/util/headers";

declare const own: { trim(): string };

export function readLabel(value: unknown): string | undefined {
	return usableHttpText(value);
}

export function readTimeout(value: unknown): number | undefined {
	return typeof value === "string" ? parseDecimalText(value) : undefined;
}

export function readWhole(value: number): number {
	return Number(Math.round(value)); // seen
}

export function readSeconds(value: number): number {
	return value * 1000; // seen
}

export function readBelowFloor(value: number): boolean {
	return value < 1000; // seen
}

export function readFlag(value: boolean): number {
	return Number(value); // seen
}

export function readBase(value: bigint): number {
	return Number(value); // seen
}

export function readLiteral(): number {
	return parseFloat("1.5"); // seen
}

export function readOwn(): string {
	return own.trim();
}
