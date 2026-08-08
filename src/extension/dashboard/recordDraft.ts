/**
 * The record editors' pure model: draft rows and their parse back into the
 * record a setSetting intent carries. Each parser validates and assembles in
 * one pass - it either yields the record or the per-row problems that block
 * it - so the two cannot diverge. DOM-free by construction so the
 * extension-host unit suite covers it; the webview components render these
 * rows and call nothing else.
 */

import * as l10n from "@vscode/l10n";
import { isRecord } from "../../shared/util/json";
import type { CapabilityFieldName, ExpectedFailureCategory, HeaderScalar } from "./protocol";
import {
	CAPABILITY_FIELDS,
	EXPECTED_FAILURE_CATEGORIES,
	FALLBACK_DIRECTIVE,
	FORCE_DIRECTIVE,
	formatHeaderValue,
	formatJsonValue,
	INHERIT_FROM_DIRECTIVE,
	INHERITABLE_DIRECTIVE,
	isForceableParameter,
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

/**
 * Row-aligned non-blocking notes for one prefix group: the `_force` row's
 * semantic warnings (an unforceable or unset name in the list). The setting
 * keeps such rows and the resolver diagnoses them at request time, so the
 * editor flags without refusing - the capability editor's hint idiom.
 */
export interface GroupHints {
	readonly params: readonly (string | undefined)[];
}

/**
 * A directive draft's reading: strict JSON `true`/`false` or an array of
 * strings, nothing else. The shared value shape of the `_fallback`, `_force`,
 * `_inheritable`, and `_inherit_from` rows; the parsers judge those rows
 * through this one reading, and the checkbox helpers below derive membership
 * from it.
 */
function parseDirectiveListText(text: string): { ok: true; value: boolean | string[] } | { ok: false } {
	const parsed = parseJsonValue(text);
	if (!parsed.ok) {
		return { ok: false };
	}
	if (typeof parsed.value === "boolean") {
		return { ok: true, value: parsed.value };
	}
	if (Array.isArray(parsed.value) && parsed.value.every((entry): entry is string => typeof entry === "string")) {
		return { ok: true, value: parsed.value };
	}
	return { ok: false };
}

/**
 * The `_inheritable` row's verdict, shared by both editors: the value must
 * read as true, false, or a list of the group's own field names; a listed
 * name the group does not set is the resolver's invalid-directive diagnostic
 * at request time, so it hints without blocking.
 */
function judgeInheritableRow(
	valueText: string,
	groupKeys: ReadonlySet<string>
): { problem?: string; hint?: string; value?: boolean | string[] } {
	const parsed = parseDirectiveListText(valueText);
	if (!parsed.ok) {
		return { problem: l10n.t('Enter true or a list of field names, e.g. ["temperature"]') };
	}
	if (Array.isArray(parsed.value)) {
		const unset = parsed.value.find((name) => !groupKeys.has(name));
		if (unset !== undefined) {
			return {
				value: parsed.value,
				hint: l10n.t('"{0}" is not a field this record sets; its inheritable mark is ignored', unset),
			};
		}
	}
	return { value: parsed.value };
}

/**
 * The `_inherit_from` row's verdict, shared by both editors: true, false, or
 * a list of record keys. A named key absent from the draft's own prefixes
 * gets the non-blocking hint docs/models.md promises: the resolver skips the
 * name and applies the rest of the list.
 */
function judgeInheritFromRow(
	valueText: string,
	prefixes: ReadonlySet<string>
): { problem?: string; hint?: string; value?: boolean | string[] } {
	const parsed = parseDirectiveListText(valueText);
	if (!parsed.ok) {
		return { problem: l10n.t('Enter true, false, or a list of record keys, e.g. ["gpt-5*"]') };
	}
	if (Array.isArray(parsed.value)) {
		const unknown = parsed.value.find((name) => !prefixes.has(name));
		if (unknown !== undefined) {
			return {
				value: parsed.value,
				hint: l10n.t('"{0}" is not a record key here; that name is skipped and the rest still applies', unknown),
			};
		}
	}
	return { value: parsed.value };
}

export type GroupsParse =
	| {
			readonly ok: true;
			readonly value: Record<string, Record<string, unknown>>;
			/** Hints only (nothing blocks on an ok parse); row-aligned like the blocked branch. */
			readonly hints: readonly GroupHints[];
	  }
	| { readonly ok: false; readonly problems: readonly GroupProblems[]; readonly hints: readonly GroupHints[] };

/**
 * Parse draft groups into the modelParameters record, or the row-aligned
 * problems that block it. Values are parsed exactly once, on the same pass
 * that judges them.
 */
export function parseGroups(groups: readonly PrefixGroup[]): GroupsParse {
	const duplicatePrefixes = duplicates(groups.map((group) => group.prefix.trim()));
	const prefixes: ReadonlySet<string> = new Set(groups.map((group) => group.prefix.trim()));
	const problems: GroupProblems[] = [];
	const hints: GroupHints[] = [];
	let blocked = false;
	const value: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
	for (const group of groups) {
		const duplicateKeys = duplicates(group.params.map((param) => param.key.trim()));
		const groupKeys: ReadonlySet<string> = new Set(group.params.map((param) => param.key.trim()));
		const params: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		const paramHints: (string | undefined)[] = group.params.map(() => undefined);
		const prefixProblem = keyProblem(
			group.prefix.trim(),
			{ empty: l10n.t("Enter a model matcher"), duplicate: l10n.t("Duplicate matcher key") },
			duplicatePrefixes
		);
		const paramProblems = group.params.map((param, index): RowFieldProblem | undefined => {
			const problem = keyProblem(
				param.key.trim(),
				{ empty: l10n.t("Enter a parameter name"), duplicate: l10n.t("Duplicate parameter name") },
				duplicateKeys
			);
			if (problem !== undefined) {
				return { field: "name", message: problem };
			}
			// The `_force` directive row is typed where plain rows are open JSON:
			// its value must read as true, false, or a list of parameter names, or
			// the resolver would diagnose and ignore it at request time. List
			// entries that would only be diagnosed there (an unforceable or unset
			// name) hint without blocking, like the capability editor's rows.
			if (param.key.trim() === FORCE_DIRECTIVE) {
				const parsed = parseDirectiveListText(param.valueText);
				if (!parsed.ok) {
					return {
						field: "value",
						message: l10n.t('Enter true or a list of parameter names, e.g. ["temperature"]'),
					};
				}
				params[FORCE_DIRECTIVE] = parsed.value;
				if (Array.isArray(parsed.value)) {
					const unforceable = parsed.value.find((name) => !isForceableParameter(name));
					const unset = parsed.value.find((name) => !groupKeys.has(name));
					paramHints[index] =
						unforceable !== undefined
							? l10n.t('"{0}" cannot be forced: provider-owned fields and _ keys stay extension-owned', unforceable)
							: unset !== undefined
								? l10n.t('"{0}" is not a parameter this record sets; its force mark is ignored', unset)
								: undefined;
				}
				return undefined;
			}
			// The shared inheritance directives get the same typed treatment in
			// both editors: judged once, hints non-blocking.
			if (param.key.trim() === INHERITABLE_DIRECTIVE) {
				const judged = judgeInheritableRow(param.valueText, groupKeys);
				if (judged.problem !== undefined) {
					return { field: "value", message: judged.problem };
				}
				params[INHERITABLE_DIRECTIVE] = judged.value;
				paramHints[index] = judged.hint;
				return undefined;
			}
			if (param.key.trim() === INHERIT_FROM_DIRECTIVE) {
				const judged = judgeInheritFromRow(param.valueText, prefixes);
				if (judged.problem !== undefined) {
					return { field: "value", message: judged.problem };
				}
				params[INHERIT_FROM_DIRECTIVE] = judged.value;
				paramHints[index] = judged.hint;
				return undefined;
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
		hints.push({ params: paramHints });
		if (prefixProblem === undefined) {
			value[group.prefix.trim()] = { ...params };
		}
	}
	return blocked ? { ok: false, problems, hints } : { ok: true, value: { ...value }, hints };
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
interface RowFieldProblem {
	readonly field: "name" | "value";
	readonly message: string;
}

type HeaderRowsDetailedParse =
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
function parseHeaderRowsDetailed(rows: readonly HeaderRow[]): HeaderRowsDetailedParse {
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

/** The first blocking capability issue as one message, for the JSON side door's single error line. */
function firstCapabilityProblem(groups: readonly PrefixGroup[], issues: readonly CapabilityGroupIssues[]): string {
	for (const [index, group] of issues.entries()) {
		if (group.prefix !== undefined) {
			return withKey(groups[index]?.prefix ?? "", group.prefix);
		}
		const rowIndex = group.rows.findIndex((row) => row.problem !== undefined);
		if (rowIndex >= 0) {
			return withKey(groups[index]?.params[rowIndex]?.key ?? "", group.rows[rowIndex]?.problem?.message ?? "");
		}
	}
	return l10n.t("Invalid value.");
}

/**
 * The capability editor's JSON side door, groupsFromJsonText's typed sibling:
 * the pasted record goes through parseCapabilityGroups here and again in the
 * editor, so it can never be more lenient than row-by-row entry.
 */
export function capabilityGroupsFromJsonText(text: string): RecordJsonParse<PrefixGroup[]> {
	const record = recordFromJsonText(text, '{"gpt-4": {"context_length": 128000}}');
	if (!record.ok) {
		return record;
	}
	for (const [prefix, fields] of Object.entries(record.value)) {
		if (!isRecord(fields)) {
			return {
				ok: false,
				problem: withKey(prefix, l10n.t('Expected an object of capability fields, e.g. {"context_length": 128000}')),
			};
		}
	}
	const groups = toCapabilityGroups(record.value as Record<string, Record<string, unknown>>);
	const parse = parseCapabilityGroups(groups);
	return parse.ok ? { ok: true, rows: groups } : { ok: false, problem: firstCapabilityProblem(groups, parse.issues) };
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
 * take positive integers, boolean fields take true/false,
 * `_openrouter_model` takes a catalog ID, other underscore keys pass through
 * as JSON (reserved for future directives), and unknown keys get a
 * non-blocking hint - the setting keeps them, resolution diagnoses them.
 */
export function parseCapabilityGroups(groups: readonly PrefixGroup[]): CapabilityGroupsParse {
	const duplicatePrefixes = duplicates(groups.map((group) => group.prefix.trim()));
	const prefixes: ReadonlySet<string> = new Set(groups.map((group) => group.prefix.trim()));
	const issues: CapabilityGroupIssues[] = [];
	let blocked = false;
	const value: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
	for (const group of groups) {
		const duplicateKeys = duplicates(group.params.map((param) => param.key.trim()));
		// The `_fallback` and `_inheritable` hints' context: the capability
		// fields this group's own rows set.
		const groupFieldKeys: ReadonlySet<string> = new Set(
			group.params.map((param) => param.key.trim()).filter(isCapabilityFieldName)
		);
		const prefixProblem = keyProblem(
			group.prefix.trim(),
			{ empty: l10n.t("Enter a model ID or matcher"), duplicate: l10n.t("Duplicate matcher key") },
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
			if (key === OPENROUTER_MODEL_DIRECTIVE) {
				const id = parseCatalogIdText(param.valueText);
				if (id === undefined) {
					return { problem: { field: "value", message: l10n.t("Enter an OpenRouter model ID, e.g. openai/gpt-4o") } };
				}
				fields[key] = id;
				return {};
			}
			if (key === FALLBACK_DIRECTIVE) {
				const parsed = parseDirectiveListText(param.valueText);
				if (!parsed.ok) {
					return {
						problem: {
							field: "value",
							message: l10n.t('Enter true or a list of capability fields, e.g. ["context_length"]'),
						},
					};
				}
				fields[key] = parsed.value;
				// A non-blocking hint, the resolver's diagnose-and-ignore verdict
				// said before the save: the setting keeps the row either way.
				if (Array.isArray(parsed.value)) {
					const unknown = parsed.value.find((name) => !groupFieldKeys.has(name));
					if (unknown !== undefined) {
						return {
							hint: l10n.t('"{0}" is not a capability field this record sets; its fallback mark is ignored', unknown),
						};
					}
				}
				return {};
			}
			if (key === INHERITABLE_DIRECTIVE) {
				const judged = judgeInheritableRow(param.valueText, groupFieldKeys);
				if (judged.problem !== undefined) {
					return { problem: { field: "value", message: judged.problem } };
				}
				fields[key] = judged.value;
				return judged.hint !== undefined ? { hint: judged.hint } : {};
			}
			if (key === INHERIT_FROM_DIRECTIVE) {
				const judged = judgeInheritFromRow(param.valueText, prefixes);
				if (judged.problem !== undefined) {
					return { problem: { field: "value", message: judged.problem } };
				}
				fields[key] = judged.value;
				return judged.hint !== undefined ? { hint: judged.hint } : {};
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

/** The per-row checkbox directives: `_fallback` on capability rows, `_force` on parameter rows, `_inheritable` on both. */
export type FieldDirective = typeof FALLBACK_DIRECTIVE | typeof FORCE_DIRECTIVE | typeof INHERITABLE_DIRECTIVE;

/**
 * Whether a row key can carry the directive's mark: `_fallback` marks the
 * known capability fields, `_force` any wire-eligible parameter (neither
 * provider-owned nor an underscore key), `_inheritable` any own field
 * (anything that is not itself a directive). The editors render a checkbox
 * for exactly these rows, and a literal `true` directive expands over exactly
 * these keys when a toggle rewrites it as a list.
 */
export function directiveEligible(directive: FieldDirective, key: string): boolean {
	if (directive === FALLBACK_DIRECTIVE) {
		return isCapabilityFieldName(key);
	}
	if (directive === INHERITABLE_DIRECTIVE) {
		return key.length > 0 && !key.startsWith("_");
	}
	return key.length > 0 && isForceableParameter(key);
}

/** The index of the group's directive row (the first, should duplicates exist; those block the parse anyway). */
function directiveRowIndex(group: PrefixGroup, directive: string): number {
	return group.params.findIndex((param) => param.key.trim() === directive);
}

/** Every eligible row key of the group, deduplicated in row order: what a literal `true` means. */
function eligibleRowKeys(group: PrefixGroup, directive: FieldDirective): string[] {
	return Array.from(new Set(group.params.map((param) => param.key.trim()))).filter((key) =>
		directiveEligible(directive, key)
	);
}

/**
 * The directive row's membership reading, deliberately more lenient than the
 * validating parse: the resolver salvages the string entries of a partly
 * invalid list (a `[42, "temperature"]` still forces temperature), so the
 * checkboxes must reflect exactly those - the strict parse meanwhile blocks
 * the row until the junk entry is fixed. `true` means every eligible row key;
 * anything unreadable means none.
 */
function directiveListedEntries(group: PrefixGroup, directive: FieldDirective): readonly string[] {
	const index = directiveRowIndex(group, directive);
	const row = index < 0 ? undefined : group.params[index];
	if (row === undefined) {
		return [];
	}
	const parsed = parseJsonValue(row.valueText);
	if (!parsed.ok) {
		return [];
	}
	if (parsed.value === true) {
		return eligibleRowKeys(group, directive);
	}
	if (Array.isArray(parsed.value)) {
		return parsed.value.filter((entry): entry is string => typeof entry === "string");
	}
	return [];
}

/**
 * The field names the group's directive row currently marks: the row's
 * string list entries, or every eligible row key for a literal `true`. Empty
 * when the row is absent, `false`, or unreadable - a malformed row is the
 * parse's verdict to report; the checkboxes simply start unmarked.
 */
export function directiveMarkedFields(group: PrefixGroup, directive: FieldDirective): ReadonlySet<string> {
	return new Set(directiveListedEntries(group, directive));
}

/**
 * Toggle one field's membership in the group's `_fallback`/`_force`/
 * `_inheritable` list, returning the updated group. Toggles always write the
 * explicit list form - a hand-written `true` is preserved untouched on load
 * and expands to the eligible row keys only on the first toggle - and
 * unmarking the last member removes the directive row entirely. Existing
 * list entries stay put, the invalid ones included (a stray name or a
 * non-string element is the user's text, flagged by the parse, never
 * silently dropped by an unrelated toggle); only a value that is no list at
 * all is replaced wholesale.
 */
export function toggleDirectiveField(
	group: PrefixGroup,
	directive: FieldDirective,
	field: string,
	enabled: boolean
): PrefixGroup {
	const index = directiveRowIndex(group, directive);
	const row = index < 0 ? undefined : group.params[index];
	const raw = row === undefined ? { ok: false as const } : parseJsonValue(row.valueText);
	// The rewrite base keeps every existing array element; `true` expands to
	// the eligible keys; anything else starts a fresh list.
	const base: readonly unknown[] = !raw.ok
		? []
		: Array.isArray(raw.value)
			? raw.value
			: raw.value === true
				? eligibleRowKeys(group, directive)
				: [];
	const next = enabled
		? base.some((entry) => entry === field)
			? [...base]
			: [...base, field]
		: base.filter((entry) => entry !== field);
	if (next.length === 0) {
		return index < 0 ? group : { ...group, params: group.params.filter((_, i) => i !== index) };
	}
	const valueText = JSON.stringify(next);
	return index < 0
		? { ...group, params: [...group.params, { key: directive, valueText }] }
		: { ...group, params: group.params.map((param, i) => (i === index ? { ...param, valueText } : param)) };
}

/**
 * The group-level `_inherit_from` control's reading of a draft group:
 * "default" (no directive row), "all" (true), "none" (false or the empty
 * list - the barrier), or "keys" with the named records. "unreadable" keeps
 * the control hands-off while the row holds text the strict parse rejects -
 * the row's own error tells that story, and the select must not silently
 * rewrite it.
 */
export type InheritFromChoice =
	| { readonly kind: "default" }
	| { readonly kind: "all" }
	| { readonly kind: "none" }
	| { readonly kind: "keys"; readonly keysText: string }
	| { readonly kind: "unreadable" };

export function inheritFromChoice(group: PrefixGroup): InheritFromChoice {
	const index = directiveRowIndex(group, INHERIT_FROM_DIRECTIVE);
	const row = index < 0 ? undefined : group.params[index];
	if (row === undefined) {
		return { kind: "default" };
	}
	const parsed = parseDirectiveListText(row.valueText);
	if (!parsed.ok) {
		return { kind: "unreadable" };
	}
	if (parsed.value === true) {
		return { kind: "all" };
	}
	if (parsed.value === false || (Array.isArray(parsed.value) && parsed.value.length === 0)) {
		return { kind: "none" };
	}
	return { kind: "keys", keysText: (parsed.value as string[]).join(", ") };
}

/**
 * Write the group-level `_inherit_from` choice back into the group's rows:
 * "default" removes the directive row, the others write its canonical value
 * (keysText splits on commas, trimmed, empties dropped - an all-empty list
 * writes `[]`, which the resolver reads as the barrier).
 */
export function setInheritFromChoice(
	group: PrefixGroup,
	choice: "default" | "all" | "none" | { readonly keysText: string }
): PrefixGroup {
	const index = directiveRowIndex(group, INHERIT_FROM_DIRECTIVE);
	if (choice === "default") {
		return index < 0 ? group : { ...group, params: group.params.filter((_, i) => i !== index) };
	}
	const valueText =
		choice === "all"
			? "true"
			: choice === "none"
				? "false"
				: JSON.stringify(
						choice.keysText
							.split(",")
							.map((key) => key.trim())
							.filter((key) => key.length > 0)
					);
	return index < 0
		? { ...group, params: [...group.params, { key: INHERIT_FROM_DIRECTIVE, valueText }] }
		: { ...group, params: group.params.map((param, i) => (i === index ? { ...param, valueText } : param)) };
}
