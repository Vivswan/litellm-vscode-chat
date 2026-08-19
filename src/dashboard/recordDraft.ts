/**
 * The record editors' pure model: draft rows and their parse back into the
 * records the wire intents carry. Each parser validates and assembles in one
 * pass - the record or the per-row problems that block it - so the two cannot
 * diverge. DOM-free by construction.
 */

import * as l10n from "@vscode/l10n";
import type { CapabilityFieldName, CapabilityValueKind } from "../shared/config/capabilityResolution";
import {
	CAPABILITY_FIELDS,
	CONSUMED_CAPABILITY_FIELDS,
	isValidConsumedCapabilityValue,
} from "../shared/config/capabilityResolution";
import { compareSpecificity, parseMatcherKey } from "../shared/config/modelMatcher";
import { isForceableParameter } from "../shared/config/parameterResolution";
import {
	FALLBACK_DIRECTIVE,
	FORCE_DIRECTIVE,
	INHERIT_FROM_DIRECTIVE,
	INHERITABLE_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
	wrongTypeDirectives,
} from "../shared/config/recordResolution";
import type { ExpectedFailureCategory } from "../shared/serverEntry";
import { EXPECTED_FAILURE_CATEGORIES } from "../shared/serverEntry";
import type { HeaderScalar } from "../shared/util/headers";
import { isValidHeaderName, isValidHeaderValue } from "../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../shared/util/json";
import { formatHeaderValue, formatJsonValue, parseHeaderValue, parseJsonValue } from "./presenters";

export interface ParamRow {
	/** UI-only draft identity (React keys, the focus hold); never part of the row's value. */
	readonly id: string;
	readonly key: string;
	readonly valueText: string;
}

/**
 * Draft rows need an identity that survives reorders, absorptions, and edits,
 * which neither the index nor the (duplicable) key text provides. The id is
 * minted here, rides the row through every immutable update, and is invisible
 * to value comparisons (draftRowsKey) and to the assembled records.
 */
let nextRowId = 0;
export function newParamRow(key: string, valueText: string): ParamRow {
	nextRowId += 1;
	return { id: `row-${nextRowId}`, key, valueText };
}

/** Value identity of draft rows: their serialization with the UI-only row ids stripped. */
export function draftRowsKey(rows: unknown): string {
	return JSON.stringify(rows, (key, value: unknown) => (key === "id" ? undefined : value)) ?? "";
}

export interface PrefixGroup {
	readonly prefix: string;
	readonly params: readonly ParamRow[];
}

/** The matcher table's per-row kind annotation; "invalid" covers keys the grammar rejects (empty included). */
export type MatcherKind = "catch-all" | "regex" | "glob" | "exact" | "invalid";

/**
 * Classified RAW, exactly as the resolver matches: the grammar trims nothing,
 * so a stored "gpt-4 " is an exact key for the ID "gpt-4 ".
 */
export function matcherKind(prefix: string): MatcherKind {
	const parse = parseMatcherKey(prefix);
	return parse.ok ? parse.matcher.kind : "invalid";
}

/**
 * The record table's display order: draft indices sorted lowest precedence
 * first, invalid keys last. A VIEW order only - the stored record's own key
 * order is never rewritten, because regex precedence IS declaration order.
 * Keys are parsed RAW by shared/config/modelMatcher, never a reimplementation.
 */
export function sortedGroupOrder(groups: readonly PrefixGroup[]): readonly number[] {
	const parsed = groups.map((group, index) => {
		const parse = parseMatcherKey(group.prefix);
		return { index, matcher: parse.ok ? parse.matcher : undefined };
	});
	return parsed
		.slice()
		.sort((a, b) => {
			if (a.matcher === undefined || b.matcher === undefined) {
				const rankA = a.matcher === undefined ? 1 : 0;
				const rankB = b.matcher === undefined ? 1 : 0;
				return rankA !== rankB ? rankA - rankB : a.index - b.index;
			}
			const specificity = compareSpecificity(
				{ matcher: a.matcher, position: a.index },
				{ matcher: b.matcher, position: b.index }
			);
			return specificity !== 0 ? specificity : a.index - b.index;
		})
		.map((entry) => entry.index);
}

export function toGroups(value: Readonly<Record<string, Readonly<Record<string, unknown>>>>): PrefixGroup[] {
	return Object.entries(value).map(([prefix, params]) => ({
		prefix,
		params: Object.entries(params).map(([key, paramValue]) => newParamRow(key, formatJsonValue(paramValue))),
	}));
}

/**
 * The sibling record types' directive names, straight from the registry: what
 * each editor hints as belonging to the other record type. The resolver later
 * diagnoses the same names as wrong-record-type, from the same rows.
 */
const PARAMETER_WRONG_TYPE_DIRECTIVES: ReadonlySet<string> = new Set(wrongTypeDirectives("parameters"));
const CAPABILITY_WRONG_TYPE_DIRECTIVES: ReadonlySet<string> = new Set(wrongTypeDirectives("capabilities"));

/**
 * THE raw-vs-trimmed rule, one reading per record type, mirroring each
 * resolver's parse boundary: capability records trim field keys and the
 * `_fallback`/`_inheritable` list entries (parseCapabilityRecord), while
 * parameters records are verbatim - a padded key or entry is its own live
 * field on the wire, never a directive. Matcher keys and `_inherit_from`
 * entries stay raw in both, because the matcher grammar trims nothing. Every
 * draft surface that classifies, marks, or persists a field name reads it
 * through here, so the editor and the resolver cannot disagree.
 */
export function resolvedFieldName(kind: "params" | "caps", key: string): string {
	return kind === "caps" ? key.trim() : key;
}

/**
 * The wrong-record-type sentence for a resolver-read row key, or undefined
 * where the key belongs. One reading of the sibling-directive sets, shared by
 * the row hints here and the editors' "ignored" badges, so the badge and the
 * hint classify keys identically - callers pass the key through
 * resolvedFieldName, so a padded parameters key (a live verbatim field, not a
 * directive) never wears the badge.
 */
export function wrongRecordTypeHint(kind: "params" | "caps", key: string): string | undefined {
	if (kind === "params") {
		return PARAMETER_WRONG_TYPE_DIRECTIVES.has(key)
			? l10n.t('"{0}" belongs to capability records and is ignored here', key)
			: undefined;
	}
	return CAPABILITY_WRONG_TYPE_DIRECTIVES.has(key)
		? l10n.t('"{0}" belongs to parameters records and is ignored here', key)
		: undefined;
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
 * The per-catalog halves of a key's problem message, passed in as already
 * localized literals so l10n extraction sees whole sentences.
 */
interface KeyProblemMessages {
	readonly empty: string;
	readonly duplicate: string;
}

function keyProblem(key: string, messages: KeyProblemMessages, dupes: Set<string>): string | undefined {
	// Emptiness is judged trimmed for every kind: a whitespace-only name is
	// almost certainly an accident, and a visible refusal beats persisting it.
	if (key.trim().length === 0) {
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
 * Row-aligned non-blocking notes for one prefix group: directive semantics
 * and wrong-type notes. The setting keeps such rows and the resolver
 * diagnoses them at request time, so the editor flags without refusing; a
 * wrong-type note may ride beside a row's blocking value problem.
 */
export interface GroupHints {
	readonly params: readonly (string | undefined)[];
}

/**
 * ONE parse of a directive row's value, carrying both readings its consumers
 * take: the flag or raw list for the validating parse, plus the salvaged
 * string entries - the resolver keeps a partly invalid list's string members,
 * so the membership surfaces (checkboxes, chip badges) read exactly those.
 * Structural pairing: strict and lenient can never come from two parses.
 */
type DirectiveValueReading =
	| { readonly kind: "unreadable" }
	| { readonly kind: "flag"; readonly value: boolean }
	| {
			readonly kind: "list";
			/** The raw entries, invalid members included (toggles preserve them). */
			readonly entries: readonly unknown[];
			/** The string members only: the lenient membership reading. */
			readonly strings: readonly string[];
	  };

function readDirectiveValue(text: string): DirectiveValueReading {
	const parsed = parseJsonValue(text);
	if (!parsed.ok) {
		return { kind: "unreadable" };
	}
	if (typeof parsed.value === "boolean") {
		return { kind: "flag", value: parsed.value };
	}
	if (Array.isArray(parsed.value)) {
		return {
			kind: "list",
			entries: parsed.value,
			strings: parsed.value.filter((entry): entry is string => typeof entry === "string"),
		};
	}
	return { kind: "unreadable" };
}

/**
 * The strict reading of a directive draft: JSON `true`/`false` or an array of
 * ONLY strings - the shape the `_fallback`, `_force`, `_inheritable`, and
 * `_inherit_from` rows must hold to parse clean.
 */
function parseDirectiveListText(text: string): { ok: true; value: boolean | string[] } | { ok: false } {
	const reading = readDirectiveValue(text);
	if (reading.kind === "flag") {
		return { ok: true, value: reading.value };
	}
	if (reading.kind === "list" && reading.strings.length === reading.entries.length) {
		return { ok: true, value: [...reading.strings] };
	}
	return { ok: false };
}

/**
 * The `_inheritable` row's verdict, shared by both editors: true, false, or a
 * list of the group's own field names. Entries read through resolvedFieldName
 * (the capability resolver trims them, the parameters resolver matches them
 * verbatim), and the value parses back in the same reading. A listed name the
 * group does not set hints without blocking - the resolver diagnoses it at
 * request time.
 */
function judgeInheritableRow(
	kind: "params" | "caps",
	valueText: string,
	groupKeys: ReadonlySet<string>
): { problem?: string; hint?: string; value?: boolean | string[] } {
	const parsed = parseDirectiveListText(valueText);
	if (!parsed.ok) {
		return { problem: l10n.t('Enter true or a list of field names, e.g. ["temperature"]') };
	}
	if (Array.isArray(parsed.value)) {
		const entries = parsed.value.map((name) => resolvedFieldName(kind, name));
		const unset = entries.find((name) => !groupKeys.has(name));
		if (unset !== undefined) {
			return {
				value: entries,
				hint: l10n.t('"{0}" is not a field this record sets; its inheritable mark is ignored', unset),
			};
		}
		return { value: entries };
	}
	return { value: parsed.value };
}

/**
 * The `_inherit_from` row's verdict, shared by both editors: true, false, or
 * a list of record keys. A named key absent from the draft's own prefixes
 * hints without blocking: the resolver skips it and applies the rest.
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
 * that judges them. Field keys are judged and saved VERBATIM, matching
 * parseParameterRecord: only an exact `_`-led key is a directive, so a padded
 * " _fallback" is a live pass-through field the editor must neither badge as
 * ignored nor silently canonicalize on Apply. Matcher keys persist verbatim
 * too - the grammar trims nothing, so a stored "gpt-4 " is an exact key for
 * the ID "gpt-4 " and Apply must not re-aim it at a different model.
 */
export function parseGroups(groups: readonly PrefixGroup[]): GroupsParse {
	const duplicatePrefixes = duplicates(groups.map((group) => group.prefix));
	const prefixes: ReadonlySet<string> = new Set(groups.map((group) => group.prefix));
	const problems: GroupProblems[] = [];
	const hints: GroupHints[] = [];
	let blocked = false;
	const value: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
	for (const group of groups) {
		const duplicateKeys = duplicates(group.params.map((param) => param.key));
		const groupKeys: ReadonlySet<string> = new Set(group.params.map((param) => param.key));
		const params: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		const paramHints: (string | undefined)[] = group.params.map(() => undefined);
		const prefixProblem = keyProblem(
			group.prefix,
			{ empty: l10n.t("Enter a model matcher"), duplicate: l10n.t("Duplicate matcher key") },
			duplicatePrefixes
		);
		const paramProblems = group.params.map((param, index): RowFieldProblem | undefined => {
			const problem = keyProblem(
				param.key,
				{ empty: l10n.t("Enter a parameter name"), duplicate: l10n.t("Duplicate parameter name") },
				duplicateKeys
			);
			if (problem !== undefined) {
				return { field: "name", message: problem };
			}
			// The `_force` directive row is typed where plain rows are open JSON:
			// true, false, or a list of parameter names. Entries the resolver would
			// only diagnose at request time hint without blocking.
			if (param.key === FORCE_DIRECTIVE) {
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
			// The shared inheritance directives, same in both editors: judged once,
			// hints non-blocking.
			if (param.key === INHERITABLE_DIRECTIVE) {
				const judged = judgeInheritableRow("params", param.valueText, groupKeys);
				if (judged.problem !== undefined) {
					return { field: "value", message: judged.problem };
				}
				params[INHERITABLE_DIRECTIVE] = judged.value;
				paramHints[index] = judged.hint;
				return undefined;
			}
			if (param.key === INHERIT_FROM_DIRECTIVE) {
				const judged = judgeInheritFromRow(param.valueText, prefixes);
				if (judged.problem !== undefined) {
					return { field: "value", message: judged.problem };
				}
				params[INHERIT_FROM_DIRECTIVE] = judged.value;
				paramHints[index] = judged.hint;
				return undefined;
			}
			// A sibling record type's directive: the setting keeps the row and the
			// resolver diagnoses it wrong-record-type, so the editor hints here too.
			// Keyed BEFORE the value parse - fixing the value would not make the
			// key any less ignored, so the hint rides beside a value problem.
			const wrongType = wrongRecordTypeHint("params", param.key);
			if (wrongType !== undefined) {
				paramHints[index] = wrongType;
			}
			const parsed = parseJsonValue(param.valueText);
			if (!parsed.ok) {
				return { field: "value", message: parsed.error };
			}
			params[param.key] = parsed.value;
			return undefined;
		});
		blocked = blocked || prefixProblem !== undefined || paramProblems.some((problem) => problem !== undefined);
		problems.push({ prefix: prefixProblem, params: paramProblems });
		hints.push({ params: paramHints });
		if (prefixProblem === undefined) {
			value[group.prefix] = { ...params };
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
 * One row-input problem, naming the field it belongs to (key-side or
 * value-side) so the editors mark only the offending input invalid.
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
 * (it drops offenders silently at request time), so Apply cannot "succeed" on
 * a header that would never be sent.
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
 * A JSON text draft parsed into the same rows the grid edits, judged by the
 * identical parse pass. Problems flatten to a single message because a
 * textarea has no rows to align to.
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
 * The capability editor's JSON side door: the pasted record goes through
 * parseCapabilityGroups here and again in the editor, so it can never be more
 * lenient than row-by-row entry.
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
 * A modelCapabilities record rendered into prefix-group rows. Values render
 * through formatJsonValue, except the `_openrouter_model` directive, whose
 * catalog ID renders bare (and parses back leniently) so users type plain IDs.
 */
export function toCapabilityGroups(value: Readonly<Record<string, Readonly<Record<string, unknown>>>>): PrefixGroup[] {
	return Object.entries(value).map(([prefix, fields]) => ({
		prefix,
		params: Object.entries(fields).map(([key, fieldValue]) =>
			newParamRow(
				key,
				key === OPENROUTER_MODEL_DIRECTIVE && typeof fieldValue === "string" ? fieldValue : formatJsonValue(fieldValue)
			)
		),
	}));
}

/**
 * One capability row's verdicts: an optional blocking problem plus an optional
 * non-blocking hint. Hints exist because the vocabulary is OPEN and the
 * setting lenient - an unknown key and an invalid consumed value both survive
 * the save and are diagnosed at resolution, so the editor flags without refusing.
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

/** The consumed vocabulary's kind for a key, own-property guarded ("toString" is a legal open field name). */
function consumedFieldKind(key: string): CapabilityValueKind | undefined {
	return Object.hasOwn(CONSUMED_CAPABILITY_FIELDS, key) ? CONSUMED_CAPABILITY_FIELDS[key] : undefined;
}

/**
 * The non-blocking note on a consumed row whose value fails its kind: the
 * setting keeps the row, and the resolver leaves the field unset so a lower
 * level can win.
 */
function consumedInvalidHint(kind: CapabilityValueKind, key: string): string {
	switch (kind) {
		case "number":
			return l10n.t('"{0}" takes a positive whole number; this value is ignored and lower levels fill in', key);
		case "cost":
			return l10n.t('"{0}" takes a cost per token, 0 or more; this value is ignored and lower levels fill in', key);
		case "boolean":
			return l10n.t('"{0}" takes true or false; this value is ignored and lower levels fill in', key);
		case "string-array":
			return l10n.t(
				'"{0}" takes a list of non-empty strings, e.g. ["temperature"]; this value is ignored and lower levels fill in',
				key
			);
	}
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
 * row-aligned issues that block it. Core fields block on their kinds; a
 * consumed key with an invalid value is kept in the setting but resolves
 * unset, so it hints without blocking; OPEN keys apply as-is, hinted as a
 * possible typo only when `recognizedKeys` is known, non-empty, and names
 * neither the key nor a consumed field - with no evidence, hints stay
 * suppressed.
 */
export function parseCapabilityGroups(
	groups: readonly PrefixGroup[],
	recognizedKeys?: ReadonlySet<string> | undefined
): CapabilityGroupsParse {
	const duplicatePrefixes = duplicates(groups.map((group) => group.prefix));
	const prefixes: ReadonlySet<string> = new Set(groups.map((group) => group.prefix));
	const issues: CapabilityGroupIssues[] = [];
	let blocked = false;
	const value: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
	for (const group of groups) {
		const duplicateKeys = duplicates(group.params.map((param) => resolvedFieldName("caps", param.key)));
		const prefixProblem = keyProblem(
			group.prefix,
			{ empty: l10n.t("Enter a model ID or matcher"), duplicate: l10n.t("Duplicate matcher key") },
			duplicatePrefixes
		);
		// Two passes so the group-referencing directives (`_fallback`,
		// `_inheritable`) are judged against the loop's own row VERDICTS: the
		// fields whose values would actually resolve, exactly the set the
		// resolver keeps - a consumed field with an invalid value resolves
		// unset, so a mark naming it hints as stranded here too. Entries and
		// issues are index-aligned holders, so deferring the directive rows
		// reorders neither the issues nor the assembled record's keys.
		const setFieldKeys = new Set<string>();
		const rowIssues: (CapabilityRowIssue | undefined)[] = new Array<CapabilityRowIssue | undefined>(
			group.params.length
		);
		const rowEntries: (readonly [string, unknown] | undefined)[] = new Array<readonly [string, unknown] | undefined>(
			group.params.length
		);
		const deferred: number[] = [];
		group.params.forEach((param, index) => {
			// Field keys read through the record type's own rule: the capability
			// side trims, matching parseCapabilityRecord, so a hand-padded
			// settings.json key is judged as the field it names everywhere.
			const key = resolvedFieldName("caps", param.key);
			const problem = keyProblem(
				key,
				{ empty: l10n.t("Enter a capability or directive"), duplicate: l10n.t("Duplicate capability name") },
				duplicateKeys
			);
			if (problem !== undefined) {
				rowIssues[index] = { problem: { field: "name", message: problem } };
				return;
			}
			if (key === OPENROUTER_MODEL_DIRECTIVE) {
				const id = parseCatalogIdText(param.valueText);
				if (id === undefined) {
					rowIssues[index] = {
						problem: { field: "value", message: l10n.t("Enter an OpenRouter model ID, e.g. openai/gpt-4o") },
					};
					return;
				}
				rowEntries[index] = [key, id];
				rowIssues[index] = {};
				return;
			}
			if (key === FALLBACK_DIRECTIVE || key === INHERITABLE_DIRECTIVE) {
				deferred.push(index);
				return;
			}
			if (key === INHERIT_FROM_DIRECTIVE) {
				const judged = judgeInheritFromRow(param.valueText, prefixes);
				if (judged.problem !== undefined) {
					rowIssues[index] = { problem: { field: "value", message: judged.problem } };
					return;
				}
				rowEntries[index] = [key, judged.value];
				rowIssues[index] = judged.hint !== undefined ? { hint: judged.hint } : {};
				return;
			}
			if (isCapabilityFieldName(key)) {
				if (CAPABILITY_FIELDS[key] === "number") {
					const parsed = parseJsonValue(param.valueText);
					if (!parsed.ok || typeof parsed.value !== "number" || !Number.isInteger(parsed.value) || parsed.value <= 0) {
						rowIssues[index] = {
							problem: { field: "value", message: l10n.t("Enter a positive whole number of tokens") },
						};
						return;
					}
					rowEntries[index] = [key, parsed.value];
					setFieldKeys.add(key);
					rowIssues[index] = {};
					return;
				}
				const parsed = parseBooleanText(param.valueText);
				if (parsed === undefined) {
					rowIssues[index] = { problem: { field: "value", message: l10n.t("Enter true or false") } };
					return;
				}
				rowEntries[index] = [key, parsed];
				setFieldKeys.add(key);
				rowIssues[index] = {};
				return;
			}
			// A sibling record type's directive, which the resolver later diagnoses
			// wrong-record-type: minted from the key BEFORE the value parse -
			// fixing the value would not make the key any less ignored, so the
			// hint rides beside a value problem.
			const wrongTypeHint = wrongRecordTypeHint("caps", key);
			const parsed = parseJsonValue(param.valueText);
			if (!parsed.ok) {
				rowIssues[index] = { problem: { field: "value", message: parsed.error }, hint: wrongTypeHint };
				return;
			}
			rowEntries[index] = [key, parsed.value];
			// Advisory-typed, judged by the resolver's OWN validator: the setting
			// keeps an invalid value and resolution leaves the field unset, so the
			// row hints without blocking - and does NOT count as set.
			const consumedKind = consumedFieldKind(key);
			if (consumedKind !== undefined) {
				if (isValidConsumedCapabilityValue(consumedKind, parsed.value)) {
					setFieldKeys.add(key);
					rowIssues[index] = {};
				} else {
					rowIssues[index] = { hint: consumedInvalidHint(consumedKind, key) };
				}
				return;
			}
			// Underscore keys are reserved for future directives and pass silently,
			// except a sibling record type's directive, whose hint was minted above.
			// Anything else is an OPEN field the resolver applies as-is (so it
			// counts as set); it hints as a possible typo only against real
			// evidence - a known, non-empty observed /model/info key set that does
			// not name it.
			if (key.startsWith("_")) {
				rowIssues[index] = wrongTypeHint !== undefined ? { hint: wrongTypeHint } : {};
				return;
			}
			setFieldKeys.add(key);
			rowIssues[index] =
				recognizedKeys === undefined || recognizedKeys.size === 0 || recognizedKeys.has(key)
					? {}
					: { hint: l10n.t('"{0}" is not a field this extension knows; it is applied as an override as-is', key) };
		});
		for (const index of deferred) {
			const param = group.params[index];
			if (param === undefined) {
				continue;
			}
			const key = resolvedFieldName("caps", param.key);
			if (key === FALLBACK_DIRECTIVE) {
				const parsed = parseDirectiveListText(param.valueText);
				if (!parsed.ok) {
					rowIssues[index] = {
						problem: {
							field: "value",
							message: l10n.t('Enter true or a list of capability fields, e.g. ["context_length"]'),
						},
					};
					continue;
				}
				// Entries are judged and saved trimmed, the same reading
				// parseCapabilityRecord takes: a padded entry still names its
				// trimmed field, so it must read as marking it here too.
				const value = Array.isArray(parsed.value)
					? parsed.value.map((name) => resolvedFieldName("caps", name))
					: parsed.value;
				rowEntries[index] = [key, value];
				// A non-blocking hint, the resolver's diagnose-and-ignore verdict
				// said before the save: the setting keeps the row either way.
				if (Array.isArray(value)) {
					const unknown = value.find((name) => !setFieldKeys.has(name));
					if (unknown !== undefined) {
						rowIssues[index] = {
							hint: l10n.t('"{0}" is not a capability field this record sets; its fallback mark is ignored', unknown),
						};
						continue;
					}
				}
				rowIssues[index] = {};
				continue;
			}
			const judged = judgeInheritableRow("caps", param.valueText, setFieldKeys);
			if (judged.problem !== undefined) {
				rowIssues[index] = { problem: { field: "value", message: judged.problem } };
				continue;
			}
			rowEntries[index] = [key, judged.value];
			rowIssues[index] = judged.hint !== undefined ? { hint: judged.hint } : {};
		}
		const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (const entry of rowEntries) {
			if (entry !== undefined) {
				fields[entry[0]] = entry[1];
			}
		}
		const rows = rowIssues.map((issue) => issue ?? {});
		blocked = blocked || prefixProblem !== undefined || rows.some((row) => row.problem !== undefined);
		issues.push({ prefix: prefixProblem, rows });
		if (prefixProblem === undefined) {
			value[group.prefix] = { ...fields };
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
 * Whether a row key can carry the directive's mark: `_fallback` and
 * `_inheritable` mark any own field (anything that is not itself a directive),
 * `_force` any wire-eligible parameter (neither provider-owned nor an
 * underscore key). A literal `true` expands over exactly these keys.
 */
export function directiveEligible(directive: FieldDirective, key: string): boolean {
	if (directive === FALLBACK_DIRECTIVE || directive === INHERITABLE_DIRECTIVE) {
		return key.length > 0 && !key.startsWith("_");
	}
	return key.length > 0 && isForceableParameter(key);
}

/** The index of the group's directive row (the first, should duplicates exist; those block the parse anyway). */
function directiveRowIndex(kind: "params" | "caps", group: PrefixGroup, directive: string): number {
	return group.params.findIndex((param) => resolvedFieldName(kind, param.key) === directive);
}

/** Every eligible row key of the group, deduplicated in row order: what a literal `true` means. */
function eligibleRowKeys(kind: "params" | "caps", group: PrefixGroup, directive: FieldDirective): string[] {
	return Array.from(new Set(group.params.map((param) => resolvedFieldName(kind, param.key)))).filter((key) =>
		directiveEligible(directive, key)
	);
}

/**
 * The directive row's membership reading: the salvaged string entries off the
 * one structural parse, each read through resolvedFieldName. `true` means
 * every eligible row key; anything unreadable means none.
 */
function directiveListedEntries(
	kind: "params" | "caps",
	group: PrefixGroup,
	directive: FieldDirective
): readonly string[] {
	const index = directiveRowIndex(kind, group, directive);
	const row = index < 0 ? undefined : group.params[index];
	if (row === undefined) {
		return [];
	}
	const reading = readDirectiveValue(row.valueText);
	if (reading.kind === "flag") {
		return reading.value ? eligibleRowKeys(kind, group, directive) : [];
	}
	return reading.kind === "list" ? reading.strings.map((entry) => resolvedFieldName(kind, entry)) : [];
}

/**
 * The field names the group's directive row currently marks: the row's string
 * list entries, or every eligible row key for a literal `true`. Empty when the
 * row is absent, `false`, or unreadable.
 */
export function directiveMarkedFields(
	kind: "params" | "caps",
	group: PrefixGroup,
	directive: FieldDirective
): ReadonlySet<string> {
	return new Set(directiveListedEntries(kind, group, directive));
}

/** Whether the Inherits control's comma-joined keys input can reproduce this `_inherit_from` list entry. */
function inheritKeyRoundTrips(entry: string): boolean {
	return entry.length > 0 && entry === entry.trim() && !entry.includes(",");
}

/**
 * Whether the editors' dedicated controls fully represent a group's directive
 * row, so the row grid absorbs it. Conservative - a duplicated key, a value
 * the strict parse rejects, an entry no eligible checkbox can show, a checkbox
 * directive with no eligible row, or an `_inherit_from` key the comma-joined
 * input cannot round-trip all keep the row visible - which buys the invariant
 * absorbed implies valid, so chip surfaces may omit absorbed rows safely.
 */
export function directiveRowAbsorbed(
	kind: "params" | "caps",
	group: PrefixGroup,
	rowIndex: number,
	flagDirectives: readonly FieldDirective[]
): boolean {
	const row = group.params[rowIndex];
	if (row === undefined) {
		return false;
	}
	const key = resolvedFieldName(kind, row.key);
	if (group.params.filter((param) => resolvedFieldName(kind, param.key) === key).length !== 1) {
		return false;
	}
	const parsed = parseDirectiveListText(row.valueText);
	if (!parsed.ok) {
		return false;
	}
	if (key === INHERIT_FROM_DIRECTIVE) {
		return typeof parsed.value === "boolean" || parsed.value.every(inheritKeyRoundTrips);
	}
	if (!(flagDirectives as readonly string[]).includes(key)) {
		return false;
	}
	const eligible = new Set(eligibleRowKeys(kind, group, key as FieldDirective));
	if (eligible.size === 0) {
		return false;
	}
	if (typeof parsed.value === "boolean") {
		return true;
	}
	return parsed.value.every((entry) => eligible.has(resolvedFieldName(kind, entry)));
}

/**
 * Toggle one field's membership in the group's `_fallback`/`_force`/
 * `_inheritable` list. `field` arrives in the resolver's reading
 * (resolvedFieldName), and membership compares entries the same way, so
 * unmarking removes every spelling that names the field - a padded entry
 * cannot survive its own checkbox. Always writes the explicit list form (a
 * hand-written `true` is preserved on load and expands only on the first
 * toggle); unmarking the last member removes the row, and entries for OTHER
 * fields stay put, the invalid ones included - only a value that is no list
 * at all is replaced wholesale.
 */
export function toggleDirectiveField(
	kind: "params" | "caps",
	group: PrefixGroup,
	directive: FieldDirective,
	field: string,
	enabled: boolean
): PrefixGroup {
	const index = directiveRowIndex(kind, group, directive);
	const row = index < 0 ? undefined : group.params[index];
	const reading = row === undefined ? ({ kind: "unreadable" } as const) : readDirectiveValue(row.valueText);
	const names = (entry: unknown): boolean => typeof entry === "string" && resolvedFieldName(kind, entry) === field;
	const base: readonly unknown[] =
		reading.kind === "list"
			? reading.entries
			: reading.kind === "flag" && reading.value
				? eligibleRowKeys(kind, group, directive)
				: [];
	const next = enabled ? (base.some(names) ? [...base] : [...base, field]) : base.filter((entry) => !names(entry));
	if (next.length === 0) {
		return index < 0 ? group : { ...group, params: group.params.filter((_, i) => i !== index) };
	}
	const valueText = JSON.stringify(next);
	return index < 0
		? { ...group, params: [...group.params, newParamRow(directive, valueText)] }
		: { ...group, params: group.params.map((param, i) => (i === index ? { ...param, valueText } : param)) };
}

/**
 * The group-level `_inherit_from` control's reading of a draft group:
 * "default" (no directive row), "all" (true), "none" (false or the empty list
 * - the barrier), or "keys" with the named records. "unreadable" keeps the
 * control hands-off wherever writing through the select would silently rewrite
 * the user's list, so the row itself must stay the editor.
 */
export type InheritFromChoice =
	| { readonly kind: "default" }
	| { readonly kind: "all" }
	| { readonly kind: "none" }
	| { readonly kind: "keys"; readonly keysText: string }
	| { readonly kind: "unreadable" };

export function inheritFromChoice(kind: "params" | "caps", group: PrefixGroup): InheritFromChoice {
	const index = directiveRowIndex(kind, group, INHERIT_FROM_DIRECTIVE);
	const row = index < 0 ? undefined : group.params[index];
	if (row === undefined) {
		return { kind: "default" };
	}
	const reading = readDirectiveValue(row.valueText);
	if (reading.kind === "unreadable") {
		return { kind: "unreadable" };
	}
	if (reading.kind === "flag") {
		return reading.value ? { kind: "all" } : { kind: "none" };
	}
	if (reading.entries.length !== reading.strings.length) {
		return { kind: "unreadable" };
	}
	if (reading.strings.length === 0) {
		return { kind: "none" };
	}
	if (!reading.strings.every(inheritKeyRoundTrips)) {
		return { kind: "unreadable" };
	}
	return { kind: "keys", keysText: reading.strings.join(", ") };
}

/** The comma-joined keys input's reading: trimmed keys, empties dropped; undefined until a first key exists. */
export function parseInheritKeysText(text: string): readonly [string, ...string[]] | undefined {
	const keys = text
		.split(",")
		.map((key) => key.trim())
		.filter((key) => key.length > 0);
	const [first, ...rest] = keys;
	return first === undefined ? undefined : [first, ...rest];
}

/**
 * Write the group-level `_inherit_from` choice back into the group's rows:
 * "default" removes the directive row, the others write its canonical value.
 * The keys arm takes a non-empty list BY TYPE (parseInheritKeysText's shape),
 * so this writer cannot produce `[]`: the barrier is "none" (written as
 * false), and a literal empty list stays expressible only through Edit as
 * JSON.
 */
export function setInheritFromChoice(
	kind: "params" | "caps",
	group: PrefixGroup,
	choice: "default" | "all" | "none" | { readonly keys: readonly [string, ...string[]] }
): PrefixGroup {
	const index = directiveRowIndex(kind, group, INHERIT_FROM_DIRECTIVE);
	if (choice === "default") {
		return index < 0 ? group : { ...group, params: group.params.filter((_, i) => i !== index) };
	}
	const valueText = choice === "all" ? "true" : choice === "none" ? "false" : JSON.stringify(choice.keys);
	return index < 0
		? { ...group, params: [...group.params, newParamRow(INHERIT_FROM_DIRECTIVE, valueText)] }
		: { ...group, params: group.params.map((param, i) => (i === index ? { ...param, valueText } : param)) };
}
