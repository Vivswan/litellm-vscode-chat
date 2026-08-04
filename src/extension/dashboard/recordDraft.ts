/**
 * The record editors' pure model: draft rows and their parse back into the
 * record a setSetting intent carries. Each parser validates and assembles in
 * one pass - it either yields the record or the per-row problems that block
 * it - so the two cannot diverge. DOM-free by construction so the
 * extension-host unit suite covers it; the webview components render these
 * rows and call nothing else.
 */

import * as l10n from "@vscode/l10n";
import { isHeaderScalar } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import type { CapabilityFieldName, ExpectedFailureCategory, HeaderScalar } from "./protocol";
import {
	CAPABILITY_FIELDS,
	DECLARE_DIRECTIVE,
	EXPECTED_FAILURE_CATEGORIES,
	formatHeaderValue,
	formatJsonValue,
	isUnsafeRecordKey,
	isValidHeaderName,
	isValidHeaderValue,
	OPENROUTER_MODEL_DIRECTIVE,
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

/**
 * The per-catalog halves of a key's problem message. Passed in as already
 * localized literals from each call site (never composed from a noun) so
 * l10n extraction sees whole sentences and translations need not inflect.
 */
interface KeyProblemMessages {
	readonly empty: string;
	readonly duplicate: string;
}

function keyProblem(key: string, messages: KeyProblemMessages, dupes: Set<string>): string | undefined {
	if (key.length === 0) {
		return messages.empty;
	}
	if (isUnsafeRecordKey(key)) {
		return l10n.t('"{0}" is a reserved name and cannot be used', key);
	}
	if (dupes.has(key)) {
		return messages.duplicate;
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
		const prefixProblem = keyProblem(
			group.prefix.trim(),
			{ empty: l10n.t("Enter a model prefix"), duplicate: l10n.t("Duplicate model prefix") },
			duplicatePrefixes
		);
		const params: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		const paramProblems = group.params.map((param): RowFieldProblem | undefined => {
			const problem = keyProblem(
				param.key.trim(),
				{ empty: l10n.t("Enter a parameter name"), duplicate: l10n.t("Duplicate parameter name") },
				duplicateKeys
			);
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
		const problem = keyProblem(
			name,
			{ empty: l10n.t("Enter a header name"), duplicate: l10n.t("Duplicate header name") },
			duplicateNames
		);
		if (problem !== undefined) {
			return { field: "name", message: problem };
		}
		if (!isValidHeaderName(name)) {
			return { field: "name", message: l10n.t("Not a valid HTTP header name") };
		}
		const value = parseHeaderValue(row.valueText);
		if (!isValidHeaderValue(String(value))) {
			return { field: "value", message: l10n.t("This value cannot be sent as an HTTP header") };
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
		return { ok: false, problem: l10n.t("Not valid JSON.") };
	}
	if (!isRecord(parsed)) {
		return { ok: false, problem: l10n.t("Must be a JSON object, e.g. {0}.", example) };
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
	return l10n.t("Invalid value.");
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
			return {
				ok: false,
				problem: withKey(prefix, l10n.t('Expected an object of parameters, e.g. {"temperature": 0.2}')),
			};
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
			return { ok: false, problem: withKey(name, l10n.t("Header values must be a string, number, or boolean")) };
		}
	}
	const rows = toHeaderRows(record.value as Record<string, HeaderScalar>);
	const parse = parseHeaderRowsDetailed(rows);
	if (parse.ok) {
		return { ok: true, rows };
	}
	const index = parse.problems.findIndex((problem) => problem !== undefined);
	return {
		ok: false,
		problem: withKey(rows[index]?.name ?? "", parse.problems[index]?.message ?? l10n.t("Invalid value.")),
	};
}

/**
 * A modelCapabilities record rendered into the same prefix-group rows the
 * parameters editor uses. Values render through formatJsonValue, except the
 * `_openrouter_model` directive, whose catalog ID renders bare (and parses
 * back leniently), so users type plain IDs instead of quoted JSON.
 */
export function toCapabilityGroups(value: Readonly<Record<string, Readonly<Record<string, unknown>>>>): PrefixGroup[] {
	return Object.entries(value).map(([prefix, fields]) => ({
		prefix,
		params: Object.entries(fields).map(([key, fieldValue]) => ({
			key,
			valueText:
				key === OPENROUTER_MODEL_DIRECTIVE && typeof fieldValue === "string" ? fieldValue : formatJsonValue(fieldValue),
		})),
	}));
}

/**
 * One capability row's verdicts: an optional blocking problem (aligned to the
 * offending input, like RowFieldProblem everywhere else) plus an optional
 * non-blocking hint. Hints exist because the capability vocabulary is closed
 * but the setting is lenient: an unknown key survives a save (and is
 * diagnosed at resolution), so the editor flags it without refusing it.
 */
interface CapabilityRowIssue {
	readonly problem?: RowFieldProblem | undefined;
	readonly hint?: string | undefined;
}

/** Row-aligned issues for one capability prefix group: the prefix's own problem and one issue slot per row. */
export interface CapabilityGroupIssues {
	readonly prefix: string | undefined;
	readonly rows: readonly CapabilityRowIssue[];
}

export type CapabilityGroupsParse =
	| {
			readonly ok: true;
			readonly value: Record<string, Record<string, unknown>>;
			/** Hints only (nothing blocks on an ok parse); row-aligned like the blocked branch. */
			readonly issues: readonly CapabilityGroupIssues[];
	  }
	| { readonly ok: false; readonly issues: readonly CapabilityGroupIssues[] };

function isCapabilityFieldName(key: string): key is CapabilityFieldName {
	return Object.hasOwn(CAPABILITY_FIELDS, key);
}

/** A draft's boolean reading: bare or JSON true/false, nothing else. */
function parseBooleanText(text: string): boolean | undefined {
	const trimmed = text.trim();
	return trimmed === "true" ? true : trimmed === "false" ? false : undefined;
}

/**
 * A catalog-ID draft: bare text, with a pasted JSON string unquoted so a
 * copied formatJsonValue rendering round-trips. Empty means no ID.
 */
export function parseCatalogIdText(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === "string") {
			return parsed.trim().length > 0 ? parsed.trim() : undefined;
		}
	} catch {
		// Bare text is the normal case.
	}
	return trimmed;
}

/**
 * Parse capability draft groups into the modelCapabilities record, or the
 * row-aligned issues that block it. Value typing follows the resolver's
 * vocabulary (capabilityResolution's parseCapabilityRecord): number fields
 * take positive integers, boolean fields and `_declare` take true/false,
 * `_openrouter_model` takes a catalog ID, other underscore keys pass through
 * as JSON (reserved for future directives), and unknown keys get a
 * non-blocking hint - the setting keeps them, resolution diagnoses them.
 */
export function parseCapabilityGroups(groups: readonly PrefixGroup[]): CapabilityGroupsParse {
	const duplicatePrefixes = duplicates(groups.map((group) => group.prefix.trim()));
	const issues: CapabilityGroupIssues[] = [];
	let blocked = false;
	const value: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
	for (const group of groups) {
		const duplicateKeys = duplicates(group.params.map((param) => param.key.trim()));
		const prefixProblem = keyProblem(
			group.prefix.trim(),
			{ empty: l10n.t("Enter a model ID or prefix"), duplicate: l10n.t("Duplicate model prefix") },
			duplicatePrefixes
		);
		const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		const rows = group.params.map((param): CapabilityRowIssue => {
			const key = param.key.trim();
			const problem = keyProblem(
				key,
				{ empty: l10n.t("Enter a capability or directive"), duplicate: l10n.t("Duplicate capability name") },
				duplicateKeys
			);
			if (problem !== undefined) {
				return { problem: { field: "name", message: problem } };
			}
			if (key === DECLARE_DIRECTIVE) {
				const parsed = parseBooleanText(param.valueText);
				if (parsed === undefined) {
					return { problem: { field: "value", message: l10n.t("Enter true or false") } };
				}
				fields[key] = parsed;
				return {};
			}
			if (key === OPENROUTER_MODEL_DIRECTIVE) {
				const id = parseCatalogIdText(param.valueText);
				if (id === undefined) {
					return { problem: { field: "value", message: l10n.t("Enter an OpenRouter model ID, e.g. openai/gpt-4o") } };
				}
				fields[key] = id;
				return {};
			}
			if (isCapabilityFieldName(key)) {
				if (CAPABILITY_FIELDS[key] === "number") {
					const parsed = parseJsonValue(param.valueText);
					if (!parsed.ok || typeof parsed.value !== "number" || !Number.isInteger(parsed.value) || parsed.value <= 0) {
						return { problem: { field: "value", message: l10n.t("Enter a positive whole number of tokens") } };
					}
					fields[key] = parsed.value;
					return {};
				}
				const parsed = parseBooleanText(param.valueText);
				if (parsed === undefined) {
					return { problem: { field: "value", message: l10n.t("Enter true or false") } };
				}
				fields[key] = parsed;
				return {};
			}
			// Underscore keys are reserved for future directives and pass
			// silently; anything else is outside the closed vocabulary, kept but
			// hinted (resolution will diagnose it the same way).
			const parsed = parseJsonValue(param.valueText);
			if (!parsed.ok) {
				return { problem: { field: "value", message: parsed.error } };
			}
			fields[key] = parsed.value;
			return key.startsWith("_")
				? {}
				: { hint: l10n.t('"{0}" is not a known capability field; the extension ignores it', key) };
		});
		blocked = blocked || prefixProblem !== undefined || rows.some((row) => row.problem !== undefined);
		issues.push({ prefix: prefixProblem, rows });
		if (prefixProblem === undefined) {
			value[group.prefix.trim()] = { ...fields };
		}
	}
	return blocked ? { ok: false, issues } : { ok: true, value: { ...value }, issues };
}

/**
 * Toggle one expected-failure category in the checkbox set's draft list.
 * Always returns the canonical category order, so two drafts that mean the
 * same set serialize identically.
 */
export function toggleExpectedFailure(
	current: readonly ExpectedFailureCategory[],
	category: ExpectedFailureCategory,
	enabled: boolean
): ExpectedFailureCategory[] {
	return EXPECTED_FAILURE_CATEGORIES.filter((candidate) =>
		candidate === category ? enabled : current.includes(candidate)
	);
}
