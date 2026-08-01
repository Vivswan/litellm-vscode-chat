/**
 * The record editors' pure model: draft rows and their parse back into the
 * record a setSetting intent carries. Each parser validates and assembles in
 * one pass - it either yields the record or the per-row problems that block
 * it - so the two cannot diverge. DOM-free by construction so the
 * extension-host unit suite covers it; the webview components render these
 * rows and call nothing else.
 */

import { isHeaderScalar } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import type { HeaderScalar } from "./protocol";
import {
	formatHeaderValue,
	formatJsonValue,
	isUnsafeRecordKey,
	isValidHeaderName,
	isValidHeaderValue,
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

/** Row-aligned problems for one prefix group: the prefix's own and one slot per parameter row. */
export interface GroupProblems {
	readonly prefix: string | undefined;
	readonly params: readonly (RowFieldProblem | undefined)[];
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
		const paramProblems = group.params.map((param): RowFieldProblem | undefined => {
			const problem = keyProblem(param.key.trim(), "parameter name", duplicateKeys);
			if (problem !== undefined) {
				return { field: "name", message: problem };
			}
			const parsed = parseJsonValue(param.valueText);
			if (!parsed.ok) {
				return { field: "value", message: parsed.error };
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
 * One row-input problem, naming the field it belongs to (a row's key-side or
 * value-side input) so the editors mark only the offending input invalid.
 */
export interface RowFieldProblem {
	readonly field: "name" | "value";
	readonly message: string;
}

export type HeaderRowsDetailedParse =
	| { readonly ok: true; readonly value: Record<string, HeaderScalar> }
	| { readonly ok: false; readonly problems: readonly (RowFieldProblem | undefined)[] };

/**
 * Parse draft header rows into the headers record, or the row-aligned
 * problems that block it. Rows must satisfy what the request path enforces
 * (shared/config/settings drops offenders silently at request time): RFC 9110 token
 * names and values that pass the shared isValidHeaderValue predicate.
 * Rejecting them here keeps Apply from "succeeding" on a header that would
 * never be sent.
 */
export function parseHeaderRowsDetailed(rows: readonly HeaderRow[]): HeaderRowsDetailedParse {
	const duplicateNames = duplicates(rows.map((row) => row.name.trim()));
	const headers: Record<string, HeaderScalar> = Object.create(null) as Record<string, HeaderScalar>;
	const problems = rows.map((row): RowFieldProblem | undefined => {
		const name = row.name.trim();
		const problem = keyProblem(name, "header name", duplicateNames);
		if (problem !== undefined) {
			return { field: "name", message: problem };
		}
		if (!isValidHeaderName(name)) {
			return { field: "name", message: "Not a valid HTTP header name" };
		}
		const value = parseHeaderValue(row.valueText);
		if (!isValidHeaderValue(String(value))) {
			return { field: "value", message: "This value cannot be sent as an HTTP header" };
		}
		headers[name] = value;
		return undefined;
	});
	return problems.some((problem) => problem !== undefined)
		? { ok: false, problems }
		: { ok: true, value: { ...headers } };
}

/** parseHeaderRowsDetailed with the problems reduced to their messages; kept for callers that need no field. */
export function parseHeaderRows(rows: readonly HeaderRow[]): HeaderRowsParse {
	const parse = parseHeaderRowsDetailed(rows);
	return parse.ok ? parse : { ok: false, problems: parse.problems.map((problem) => problem?.message) };
}

/**
 * A JSON text draft parsed into the same rows the grid edits: either the rows
 * (which the caller then judges with the identical parseGroups /
 * parseHeaderRowsDetailed pass) or the one problem that blocks them. Problems
 * flatten to a single message because a textarea has no rows to align to.
 */
export type RecordJsonParse<Rows> =
	| { readonly ok: true; readonly rows: Rows }
	| { readonly ok: false; readonly problem: string };

function recordFromJsonText(
	text: string,
	example: string
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly problem: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return { ok: false, problem: "Not valid JSON." };
	}
	if (!isRecord(parsed)) {
		return { ok: false, problem: `Must be a JSON object, e.g. ${example}.` };
	}
	return { ok: true, value: parsed };
}

/** A blocked row's message with the offending key in front, when the key itself can carry that context. */
function withKey(key: string, message: string): string {
	return key.trim().length === 0 ? message : `"${key}": ${message}`;
}

function firstGroupProblem(groups: readonly PrefixGroup[], problems: readonly GroupProblems[]): string {
	for (const [index, group] of problems.entries()) {
		if (group.prefix !== undefined) {
			return withKey(groups[index]?.prefix ?? "", group.prefix);
		}
		const paramIndex = group.params.findIndex((problem) => problem !== undefined);
		if (paramIndex >= 0) {
			return withKey(groups[index]?.params[paramIndex]?.key ?? "", group.params[paramIndex]?.message ?? "");
		}
	}
	return "Invalid value.";
}

/**
 * Parse a pasted modelParameters record (JSON text) into draft groups. The
 * groups go through parseGroups here and again in the editor, so the JSON
 * side door can never be more lenient than row-by-row entry.
 */
export function groupsFromJsonText(text: string): RecordJsonParse<PrefixGroup[]> {
	const record = recordFromJsonText(text, '{"gpt-4": {"temperature": 0.2}}');
	if (!record.ok) {
		return record;
	}
	for (const [prefix, params] of Object.entries(record.value)) {
		if (!isRecord(params)) {
			return { ok: false, problem: withKey(prefix, 'Expected an object of parameters, e.g. {"temperature": 0.2}') };
		}
	}
	const groups = toGroups(record.value as Record<string, Record<string, unknown>>);
	const parse = parseGroups(groups);
	return parse.ok ? { ok: true, rows: groups } : { ok: false, problem: firstGroupProblem(groups, parse.problems) };
}

/** Parse a pasted headers record (JSON text) into draft rows; same double-judging as groupsFromJsonText. */
export function headerRowsFromJsonText(text: string): RecordJsonParse<HeaderRow[]> {
	const record = recordFromJsonText(text, '{"x-litellm-api-key": "sk-123"}');
	if (!record.ok) {
		return record;
	}
	for (const [name, value] of Object.entries(record.value)) {
		if (!isHeaderScalar(value)) {
			return { ok: false, problem: withKey(name, "Header values must be a string, number, or boolean") };
		}
	}
	const rows = toHeaderRows(record.value as Record<string, HeaderScalar>);
	const parse = parseHeaderRowsDetailed(rows);
	if (parse.ok) {
		return { ok: true, rows };
	}
	const index = parse.problems.findIndex((problem) => problem !== undefined);
	return { ok: false, problem: withKey(rows[index]?.name ?? "", parse.problems[index]?.message ?? "Invalid value.") };
}
