/**
 * The record editors' pure model: draft rows, their validation, and the
 * reassembly into the record a setSetting intent carries. DOM-free by
 * construction so the extension-host unit suite covers it; the webview
 * components render these rows and call nothing else.
 */

import type { HeaderScalar, ParsedJsonValue } from "./protocol";
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

export interface GroupProblems {
	readonly prefix: string | undefined;
	readonly params: readonly (string | undefined)[];
}

export function validateGroups(groups: readonly PrefixGroup[]): GroupProblems[] {
	const duplicatePrefixes = duplicates(groups.map((group) => group.prefix.trim()));
	return groups.map((group) => {
		const duplicateKeys = duplicates(group.params.map((param) => param.key.trim()));
		return {
			prefix: keyProblem(group.prefix.trim(), "model prefix", duplicatePrefixes),
			params: group.params.map((param) => {
				const problem = keyProblem(param.key.trim(), "parameter name", duplicateKeys);
				if (problem !== undefined) {
					return problem;
				}
				const parsed: ParsedJsonValue = parseJsonValue(param.valueText);
				return parsed.ok ? undefined : parsed.error;
			}),
		};
	});
}

export function hasGroupProblems(problems: readonly GroupProblems[]): boolean {
	return problems.some((group) => group.prefix !== undefined || group.params.some((param) => param !== undefined));
}

/** Reassemble validated groups into the modelParameters record. Call only when validateGroups is clean. */
export function assembleGroups(groups: readonly PrefixGroup[]): Record<string, Record<string, unknown>> {
	const result: Record<string, Record<string, unknown>> = Object.create(null) as Record<
		string,
		Record<string, unknown>
	>;
	for (const group of groups) {
		const params: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (const param of group.params) {
			const parsed = parseJsonValue(param.valueText);
			if (parsed.ok) {
				params[param.key.trim()] = parsed.value;
			}
		}
		result[group.prefix.trim()] = { ...params };
	}
	return { ...result };
}

export interface HeaderRow {
	readonly name: string;
	readonly valueText: string;
}

export function toHeaderRows(value: Readonly<Record<string, HeaderScalar>>): HeaderRow[] {
	return Object.entries(value).map(([name, headerValue]) => ({ name, valueText: formatHeaderValue(headerValue) }));
}

/**
 * Header rows must satisfy what the request path enforces (shared/settings
 * drops offenders silently at request time): RFC 9110 token names and values
 * without line breaks. Rejecting them here keeps Apply from "succeeding" on a
 * header that would never be sent.
 */
export function validateHeaderRows(rows: readonly HeaderRow[]): (string | undefined)[] {
	const duplicateNames = duplicates(rows.map((row) => row.name.trim()));
	return rows.map((row) => {
		const name = row.name.trim();
		const problem = keyProblem(name, "header name", duplicateNames);
		if (problem !== undefined) {
			return problem;
		}
		if (!isValidHeaderName(name)) {
			return "Not a valid HTTP header name";
		}
		const value = String(parseHeaderValue(row.valueText));
		if (value.includes("\r") || value.includes("\n")) {
			return "Header values cannot contain line breaks";
		}
		return undefined;
	});
}

/** Reassemble validated header rows into the headers record. Call only when validateHeaderRows is clean. */
export function assembleHeaderRows(rows: readonly HeaderRow[]): Record<string, HeaderScalar> {
	const headers: Record<string, HeaderScalar> = Object.create(null) as Record<string, HeaderScalar>;
	for (const row of rows) {
		headers[row.name.trim()] = parseHeaderValue(row.valueText);
	}
	return { ...headers };
}
