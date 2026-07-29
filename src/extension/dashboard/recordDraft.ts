/**
 * The record editors' pure model: draft rows and their parse back into the
 * record a setSetting intent carries. Each parser validates and assembles in
 * one pass - it either yields the record or the per-row problems that block
 * it - so the two cannot diverge. DOM-free by construction so the
 * extension-host unit suite covers it; the webview components render these
 * rows and call nothing else.
 */

import type { HeaderScalar } from "./protocol";
import {
	formatHeaderValue,
	formatJsonValue,
	isUnsafeRecordKey,
	isValidHeaderName,
	parseHeaderValue,
	parseJsonValue,
} from "./protocol";

interface ParamRow {
	readonly key: string;
	readonly valueText: string;
}

export interface PrefixGroup {
	readonly prefix: string;
	readonly params: readonly ParamRow[];
}

export function toGroups(value: Readonly<Record<string, Readonly<Record<string, unknown>>>>): PrefixGroup[] {
	return Object.entries(value).map(([prefix, params]) => ({
		prefix,
		params: Object.entries(params).map(([key, paramValue]) => ({ key, valueText: formatJsonValue(paramValue) })),
	}));
}

function duplicates(values: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const dupes = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			dupes.add(value);
		}
		seen.add(value);
	}
	return dupes;
}

function keyProblem(key: string, noun: string, dupes: Set<string>): string | undefined {
	if (key.length === 0) {
		return `Enter a ${noun}`;
	}
	if (isUnsafeRecordKey(key)) {
		return `"${key}" is a reserved name and cannot be used`;
	}
	if (dupes.has(key)) {
		return `Duplicate ${noun}`;
	}
	return undefined;
}

interface GroupProblems {
	readonly prefix: string | undefined;
	readonly params: readonly (string | undefined)[];
}

export type GroupsParse =
	| { readonly ok: true; readonly value: Record<string, Record<string, unknown>> }
	| { readonly ok: false; readonly problems: readonly GroupProblems[] };

/**
 * Parse draft groups into the modelParameters record, or the row-aligned
 * problems that block it. Values are parsed exactly once, on the same pass
 * that judges them.
 */
export function parseGroups(groups: readonly PrefixGroup[]): GroupsParse {
	const duplicatePrefixes = duplicates(groups.map((group) => group.prefix.trim()));
	const problems: GroupProblems[] = [];
	let blocked = false;
	const value: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
	for (const group of groups) {
		const duplicateKeys = duplicates(group.params.map((param) => param.key.trim()));
		const prefixProblem = keyProblem(group.prefix.trim(), "model prefix", duplicatePrefixes);
		const params: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		const paramProblems = group.params.map((param) => {
			const problem = keyProblem(param.key.trim(), "parameter name", duplicateKeys);
			if (problem !== undefined) {
				return problem;
			}
			const parsed = parseJsonValue(param.valueText);
			if (!parsed.ok) {
				return parsed.error;
			}
			params[param.key.trim()] = parsed.value;
			return undefined;
		});
		blocked = blocked || prefixProblem !== undefined || paramProblems.some((problem) => problem !== undefined);
		problems.push({ prefix: prefixProblem, params: paramProblems });
		if (prefixProblem === undefined) {
			value[group.prefix.trim()] = { ...params };
		}
	}
	return blocked ? { ok: false, problems } : { ok: true, value: { ...value } };
}

export interface HeaderRow {
	readonly name: string;
	readonly valueText: string;
}

export function toHeaderRows(value: Readonly<Record<string, HeaderScalar>>): HeaderRow[] {
	return Object.entries(value).map(([name, headerValue]) => ({ name, valueText: formatHeaderValue(headerValue) }));
}

export type HeaderRowsParse =
	| { readonly ok: true; readonly value: Record<string, HeaderScalar> }
	| { readonly ok: false; readonly problems: readonly (string | undefined)[] };

/**
 * Parse draft header rows into the headers record, or the row-aligned
 * problems that block it. Rows must satisfy what the request path enforces
 * (shared/settings drops offenders silently at request time): RFC 9110 token
 * names and values without line breaks. Rejecting them here keeps Apply from
 * "succeeding" on a header that would never be sent.
 */
export function parseHeaderRows(rows: readonly HeaderRow[]): HeaderRowsParse {
	const duplicateNames = duplicates(rows.map((row) => row.name.trim()));
	const headers: Record<string, HeaderScalar> = Object.create(null) as Record<string, HeaderScalar>;
	const problems = rows.map((row) => {
		const name = row.name.trim();
		const problem = keyProblem(name, "header name", duplicateNames);
		if (problem !== undefined) {
			return problem;
		}
		if (!isValidHeaderName(name)) {
			return "Not a valid HTTP header name";
		}
		const value = parseHeaderValue(row.valueText);
		const text = String(value);
		if (text.includes("\r") || text.includes("\n")) {
			return "Header values cannot contain line breaks";
		}
		headers[name] = value;
		return undefined;
	});
	return problems.some((problem) => problem !== undefined)
		? { ok: false, problems }
		: { ok: true, value: { ...headers } };
}
