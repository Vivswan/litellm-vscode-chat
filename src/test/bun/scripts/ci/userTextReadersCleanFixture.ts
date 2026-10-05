/**
 * Positive control for scripts/ci/user-text-readers.ts: a reader that takes a user's text only through the two homes
 * passes with no allowlist row. Never imported; the test scans this path as a reader module and reads the tags.
 *
 *   // seen    -> judged and accepted: not a text argument
 *   untagged  -> not a lib trim or number read at all
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
