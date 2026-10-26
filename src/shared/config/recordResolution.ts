/**
 * The record-inheritance engine shared by both model-keyed records. Fields travel with their source record's
 * markings; directives themselves never travel, and a receiver cannot re-mark fields it did not write.
 *   The matcher (modelMatcher.ts) orders every record matching a model into a chain, broadest first -> this module
 *     resolves that chain into one flat view per model
 *   The semantics -> by default the most specific matching record wins wholesale
 *   `_inheritable` (giver-side) -> marks fields that flow to more specific matches
 *   `_inherit_from` (receiver-side) decides what a record accepts -> everything that reaches it (`true`), nothing
 *     (`false`, which also makes the record a barrier: broader fields can only travel through each record's resolved
 *     view, so nothing flows past it), or exactly the named records' literal fields (a list, which bypasses barriers)
 */

import { trimHttpWhitespace } from "../util/headers";
import type { ModelRecordMap } from "./modelMatcher";
import { compareSpecificity, matchChain, matcherMatches, parseMatcherKey } from "./modelMatcher";

export const INHERITABLE_DIRECTIVE = "_inheritable";
export const INHERIT_FROM_DIRECTIVE = "_inherit_from";

/**
 * Marks all (`true`) or the listed parameter fields as FORCED: forced fields beat runtime modelOptions and the picker
 * configuration on the wire. Parsed and enforced in parameterResolution.ts.
 */
export const FORCE_DIRECTIVE = "_force";

/**
 * Demotes all (`true`) or the listed capability fields from override level to fallback level: applied BELOW the
 * server-reported value instead of above it. Parsed and enforced in capabilityResolution.ts.
 */
export const FALLBACK_DIRECTIVE = "_fallback";

/**
 * Names an OpenRouter catalog entry whose capabilities backfill fields the record leaves unset. Parsed and enforced in
 * capabilityResolution.ts.
 */
export const OPENROUTER_MODEL_DIRECTIVE = "_openrouter_model";

/**
 * Names a FIM prompt template for raw backends without native fill-in-the-middle support: a string carrying both
 * `{prefix}` and `{suffix}` placeholders.
 *
 * The ONE parameters-record directive the /completions path reads - everything else in a parameters record
 * stays chat-only.
 *
 *   the completions transport applies it (provider/transport/fim.ts) -> omits the wire `suffix` field when it does
 */
export const FIM_TEMPLATE_DIRECTIVE = "_fim_template";

/** Whether a raw directive value is a usable FIM template: the one grammar, shared by the parser and the transport. */
export function isFimTemplateValue(value: unknown): value is string {
	return typeof value === "string" && value.includes("{prefix}") && value.includes("{suffix}");
}

/** Every type-specific directive name, minted once, keyed by the owning record type. */
export const RECORD_TYPE_DIRECTIVES = {
	parameters: [FORCE_DIRECTIVE, FIM_TEMPLATE_DIRECTIVE],
	capabilities: [FALLBACK_DIRECTIVE, OPENROUTER_MODEL_DIRECTIVE],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type RecordType = keyof typeof RECORD_TYPE_DIRECTIVES;

/**
 * Field identity inside a record, one rule for the parsers and for the settings-redesign migration's record merges:
 * capability keys and list entries lose edge HTTP whitespace (the one trim rule, so a U+00A0 stays), matching the
 * editor, which judges and saves keys the same way, so a hand-padded key means the same field on every surface;
 * parameter keys are taken as written.
 */
export function canonicalFieldKey(type: RecordType, key: string): string {
	return type === "capabilities" ? trimHttpWhitespace(key) : key;
}

export function wrongTypeDirectives(own: RecordType): readonly string[] {
	return Object.entries(RECORD_TYPE_DIRECTIVES).flatMap(([type, names]) => (type === own ? [] : names));
}

/** "entry" is the declared server entry's own record map; "global" the models.* setting. */
export type RecordLayer = "entry" | "global";

/**
 * One problem found in a record map. `recordKey` names the record that carries the problem; `key` the offending
 * directive, field, or matcher key inside it (for "invalid-matcher" the two coincide).
 */
export type RecordDiagnosticKind =
	/** A malformed matcher key: empty, mid-key `*`, invalid regex, or an unsupported regex flag. */
	| "invalid-matcher"
	/** A malformed directive value, or a directive list naming a field the record does not set. */
	| "invalid-directive"
	/** A known directive of the other record type (`_force` in capabilities, `_fallback` in parameters). */
	| "wrong-record-type"
	/** An `_inherit_from` entry naming a record key that does not exist in this record map. */
	| "unknown-inherit-key"
	/** `_force` naming a provider-owned or underscore key (parameters records only). */
	| "unforceable-key"
	/**
	 * Informational: a capability field outside the consumed vocabulary; the field still applies as-is (capabilities
	 * records only).
	 */
	| "unrecognized-key"
	/** A capability field with a value of the wrong type (capabilities records only). */
	| "invalid-value";

export interface RecordDiagnostic {
	readonly kind: RecordDiagnosticKind;
	readonly recordKey: string;
	readonly key: string;
}

/** What a record's `_inherit_from` asks for; "default" is the absent directive. */
export type InheritFromDirective =
	| { readonly kind: "default" }
	| { readonly kind: "all" }
	| { readonly kind: "none" }
	| { readonly kind: "keys"; readonly keys: readonly string[] };

/** The marking sets are always subsets of `fields`' keys. */
export interface ParsedRecord {
	readonly fields: Readonly<Record<string, unknown>>;
	readonly inheritable: ReadonlySet<string>;
	/** `_force`-marked fields (parameters records); empty elsewhere. */
	readonly forced: ReadonlySet<string>;
	/** `_fallback`-marked fields (capabilities records); empty elsewhere. */
	readonly fallback: ReadonlySet<string>;
	readonly inheritFrom: InheritFromDirective;
	readonly diagnostics: readonly Omit<RecordDiagnostic, "recordKey">[];
}

/** Which keys may carry a mark and how a refused list entry is diagnosed (`_force`'s forceability rule). */
interface MarkableRule {
	readonly allows: (key: string) => boolean;
	readonly refusalKind: RecordDiagnosticKind;
}

/** The marks a directive list carries, each entry judged in the order the parseMarkingDirective doc states. */
function markListedFields(
	names: readonly unknown[],
	directiveName: string,
	fields: Readonly<Record<string, unknown>>,
	markable: MarkableRule | undefined
): { marked: Set<string>; diagnostics: Omit<RecordDiagnostic, "recordKey">[] } {
	const marked = new Set<string>();
	const diagnostics: Omit<RecordDiagnostic, "recordKey">[] = [];
	for (const name of names) {
		if (typeof name !== "string") {
			diagnostics.push({ kind: "invalid-directive", key: directiveName });
		} else if (markable !== undefined && !markable.allows(name)) {
			diagnostics.push({ kind: markable.refusalKind, key: name });
		} else if (Object.hasOwn(fields, name)) {
			marked.add(name);
		} else {
			diagnostics.push({ kind: "invalid-directive", key: directiveName });
		}
	}

	return { marked, diagnostics };
}

/**
 * The one parse of the marking-directive grammar, shared by `_inheritable` (here), `_force` (parameters records), and
 * `_fallback` (capabilities records). `markable` narrows which keys may carry the mark (`_force`'s forceability rule),
 * and the two arms narrow differently by design: `true` skips a refused field silently, while a refused list entry is
 * diagnosed under its own name with the caller's kind, ahead of the own-field check.
 */
export function parseMarkingDirective(
	record: Readonly<Record<string, unknown>>,
	directiveName: string,
	fields: Readonly<Record<string, unknown>>,
	markable?: MarkableRule
): { marked: ReadonlySet<string>; diagnostics: readonly Omit<RecordDiagnostic, "recordKey">[] } {
	if (!Object.hasOwn(record, directiveName)) {
		return { marked: new Set<string>(), diagnostics: [] };
	}

	const directive = record[directiveName];
	if (directive === true) {
		const marked = new Set<string>();
		for (const name of Object.keys(fields)) {
			if (markable === undefined || markable.allows(name)) {
				marked.add(name);
			}
		}
		return { marked, diagnostics: [] };
	}

	if (Array.isArray(directive)) {
		return markListedFields(directive, directiveName, fields, markable);
	}

	if (directive === false) {
		return { marked: new Set<string>(), diagnostics: [] };
	}

	return { marked: new Set<string>(), diagnostics: [{ kind: "invalid-directive", key: directiveName }] };
}

/**
 * `_inherit_from` as the record spells it, "default" when absent. The empty list names no sources and behaves exactly
 * like `false`, barrier included.
 */
function parseInheritFromDirective(record: Readonly<Record<string, unknown>>): {
	inheritFrom: InheritFromDirective;
	diagnostics: Omit<RecordDiagnostic, "recordKey">[];
} {
	if (!Object.hasOwn(record, INHERIT_FROM_DIRECTIVE)) {
		return { inheritFrom: { kind: "default" }, diagnostics: [] };
	}

	const directive = record[INHERIT_FROM_DIRECTIVE];
	if (directive === true) {
		return { inheritFrom: { kind: "all" }, diagnostics: [] };
	}

	if (directive === false) {
		return { inheritFrom: { kind: "none" }, diagnostics: [] };
	}

	if (!Array.isArray(directive)) {
		return {
			inheritFrom: { kind: "default" },
			diagnostics: [{ kind: "invalid-directive", key: INHERIT_FROM_DIRECTIVE }],
		};
	}

	const keys: string[] = [];
	const diagnostics: Omit<RecordDiagnostic, "recordKey">[] = [];
	for (const name of directive) {
		if (typeof name === "string") {
			keys.push(name);
		} else {
			diagnostics.push({ kind: "invalid-directive", key: INHERIT_FROM_DIRECTIVE });
		}
	}

	return { inheritFrom: { kind: "keys", keys }, diagnostics };
}

/**
 * Marking only the record's OWN fields is that grammar's rule, and the reason a receiver cannot re-mark what it
 * inherited.
 */
export function parseSharedDirectives(
	record: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, unknown>>
): {
	inheritable: ReadonlySet<string>;
	inheritFrom: InheritFromDirective;
	diagnostics: Omit<RecordDiagnostic, "recordKey">[];
} {
	const inheritable = parseMarkingDirective(record, INHERITABLE_DIRECTIVE, fields);
	const inheritFrom = parseInheritFromDirective(record);

	return {
		inheritable: inheritable.marked,
		inheritFrom: inheritFrom.inheritFrom,
		diagnostics: [...inheritable.diagnostics, ...inheritFrom.diagnostics],
	};
}

export interface ResolvedChainField {
	readonly value: unknown;
	/** The record key whose literal field this is - markings always come from here. */
	readonly sourceKey: string;
	readonly inheritable: boolean;
	readonly forced: boolean;
	readonly fallback: boolean;
}

export interface RecordChainResolution {
	/**
	 * The most specific matching record's resolved view: its own fields plus everything it accepted, each field
	 * carrying its source record's key and markings. Empty when nothing matches.
	 */
	readonly fields: ReadonlyMap<string, ResolvedChainField>;
	/** The most specific matching record's key; undefined when nothing matches. */
	readonly winnerKey: string | undefined;
	/** The most specific matching record's parse, for type-specific directives (`_openrouter_model`). */
	readonly winner: ParsedRecord | undefined;
	/** Matcher, directive, and field problems across the matching chain, deduplicated. */
	readonly diagnostics: readonly RecordDiagnostic[];
}

/** The problems one walk reports, each (kind, record, key) once, in first-report order. */
class DiagnosticSet {
	readonly all: RecordDiagnostic[] = [];
	private readonly seen = new Set<string>();

	add(diagnostic: RecordDiagnostic): void {
		const dedupeKey = `${diagnostic.kind}\u0000${diagnostic.recordKey}\u0000${diagnostic.key}`;
		if (this.seen.has(dedupeKey)) {
			return;
		}

		this.seen.add(dedupeKey);
		this.all.push(diagnostic);
	}
}

/** Record-level lint of one record map, independent of any model. */
export function lintRecordMap(
	records: ModelRecordMap,
	parse: (record: Readonly<Record<string, unknown>>, key: string) => ParsedRecord
): readonly RecordDiagnostic[] {
	const diagnostics = new DiagnosticSet();
	for (const [key, record] of Object.entries(records)) {
		const parsedKey = parseMatcherKey(key);
		if (!parsedKey.ok) {
			diagnostics.add({ kind: "invalid-matcher", recordKey: key, key });
		}
		const parsed = parse(record, key);
		for (const diagnostic of parsed.diagnostics) {
			diagnostics.add({ ...diagnostic, recordKey: key });
		}
		if (parsed.inheritFrom.kind === "keys") {
			for (const named of parsed.inheritFrom.keys) {
				if (!Object.hasOwn(records, named)) {
					diagnostics.add({ kind: "unknown-inherit-key", recordKey: key, key: named });
				}
			}
		}
	}
	return diagnostics.all;
}

/**
 * The parse of each record, shared between chain membership and `_inherit_from` lookups, so a record parsed for both
 * reports its problems once.
 */
function parseCache(
	records: ModelRecordMap,
	parse: (record: Readonly<Record<string, unknown>>, key: string) => ParsedRecord
): (key: string) => ParsedRecord | undefined {
	const parsedByKey = new Map<string, ParsedRecord>();

	return (key) => {
		const record = records[key];
		if (record === undefined) {
			return undefined;
		}
		let parsed = parsedByKey.get(key);
		if (parsed === undefined) {
			parsed = parse(record, key);
			parsedByKey.set(key, parsed);
		}
		return parsed;
	};
}

function ownFieldsOf(key: string, parsed: ParsedRecord): Map<string, ResolvedChainField> {
	const own = new Map<string, ResolvedChainField>();
	for (const [name, value] of Object.entries(parsed.fields)) {
		own.set(name, {
			value,
			sourceKey: key,
			inheritable: parsed.inheritable.has(name),
			forced: parsed.forced.has(name),
			fallback: parsed.fallback.has(name),
		});
	}

	return own;
}

/** What one chain walk's steps share: the model, the record map, the parse cache, and the problem collector. */
interface ChainWalk {
	readonly id: string;
	readonly records: ModelRecordMap;
	readonly parsedFor: (key: string) => ParsedRecord | undefined;
	readonly diagnostics: DiagnosticSet;
}

/** A record an `_inherit_from` list names, with its position in the record map for the specificity tie-break. */
interface NamedSource {
	readonly key: string;
	readonly parsed: ParsedRecord;
	readonly position: number;
}

/** Broadest first, so the most specific named record wins per field: specificity order, not list order. */
function bySpecificity(a: NamedSource, b: NamedSource): number {
	const aParse = parseMatcherKey(a.key);
	const bParse = parseMatcherKey(b.key);
	if (!aParse.ok || !bParse.ok) {
		return 0; // Unreachable: non-matching keys were filtered above.
	}

	return compareSpecificity(
		{ matcher: aParse.matcher, position: a.position },
		{ matcher: bParse.matcher, position: b.position }
	);
}

/**
 * The records an `_inherit_from` list names that match this model, in specificity order. An unknown key is diagnosed;
 * a named record that does not match this model contributes nothing, and an invalid key already carries its own
 * diagnostic.
 */
function namedSources(walk: ChainWalk, recordKey: string, keys: readonly string[]): NamedSource[] {
	const named: NamedSource[] = [];
	const namedSeen = new Set<string>();
	for (const nameKey of keys) {
		if (namedSeen.has(nameKey)) {
			continue;
		}
		namedSeen.add(nameKey);
		if (!Object.hasOwn(walk.records, nameKey)) {
			walk.diagnostics.add({ kind: "unknown-inherit-key", recordKey, key: nameKey });
			continue;
		}
		const namedParse = parseMatcherKey(nameKey);
		if (!namedParse.ok || !matcherMatches(namedParse.matcher, walk.id)) {
			continue;
		}
		const namedParsed = walk.parsedFor(nameKey);
		if (namedParsed !== undefined) {
			named.push({ key: nameKey, parsed: namedParsed, position: Object.keys(walk.records).indexOf(nameKey) });
		}
	}

	return named.sort(bySpecificity);
}

/** The fields a record accepts from the chain above it, by its `_inherit_from`; named sources give their LITERAL fields only. */
function acceptedFields(
	inheritFrom: InheritFromDirective,
	incoming: ReadonlyMap<string, ResolvedChainField>,
	walk: ChainWalk,
	recordKey: string
): Map<string, ResolvedChainField> {
	const accepted = new Map<string, ResolvedChainField>();
	switch (inheritFrom.kind) {
		case "default":
			for (const [name, field] of incoming) {
				if (field.inheritable) {
					accepted.set(name, field);
				}
			}
			break;
		case "all":
			for (const [name, field] of incoming) {
				accepted.set(name, field);
			}
			break;
		case "none":
			break;
		case "keys":
			for (const source of namedSources(walk, recordKey, inheritFrom.keys)) {
				for (const [name, field] of ownFieldsOf(source.key, source.parsed)) {
					accepted.set(name, field);
				}
			}
			break;
	}

	return accepted;
}

export function resolveRecordChain(
	id: string,
	records: ModelRecordMap,
	parse: (record: Readonly<Record<string, unknown>>, key: string) => ParsedRecord
): RecordChainResolution {
	const { chain, diagnostics: matcherDiagnostics } = matchChain(id, records);
	const diagnostics = new DiagnosticSet();
	for (const diagnostic of matcherDiagnostics) {
		diagnostics.add({ kind: "invalid-matcher", recordKey: diagnostic.key, key: diagnostic.key });
	}
	const walk: ChainWalk = { id, records, parsedFor: parseCache(records, parse), diagnostics };

	let incoming = new Map<string, ResolvedChainField>();
	let winner: { key: string; parsed: ParsedRecord } | undefined;
	for (const match of chain) {
		const parsed = walk.parsedFor(match.key);
		if (parsed === undefined) {
			continue; // Unreachable: chain keys come from the record map.
		}
		for (const diagnostic of parsed.diagnostics) {
			diagnostics.add({ ...diagnostic, recordKey: match.key });
		}

		const view = acceptedFields(parsed.inheritFrom, incoming, walk, match.key);
		for (const [name, field] of ownFieldsOf(match.key, parsed)) {
			view.set(name, field);
		}
		incoming = view;
		winner = { key: match.key, parsed };
	}

	return {
		fields: incoming,
		winnerKey: winner?.key,
		winner: winner?.parsed,
		diagnostics: diagnostics.all,
	};
}
