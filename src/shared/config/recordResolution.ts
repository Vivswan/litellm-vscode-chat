/**
 * The record-inheritance engine shared by both model-keyed records. The
 * matcher (modelMatcher.ts) orders every record matching a model into a
 * chain, broadest first; this module resolves that chain into one flat view
 * per model. Pure and type-agnostic: callers hand in a per-record parser (the
 * parameters records' open vocabulary, the capability records' closed one)
 * and get back fields with provenance; nothing here knows a setting name.
 *
 * The semantics, in one paragraph: by default the most specific matching
 * record wins wholesale. `_inheritable` (giver-side) marks fields that flow
 * to more specific matches; `_inherit_from` (receiver-side) decides what a
 * record accepts - everything that reaches it (`true`), nothing (`false`,
 * which also makes the record a barrier: broader fields can only travel
 * through each record's resolved view, so nothing flows past it), or exactly
 * the named records' literal fields (a list, which bypasses barriers). Fields
 * travel with their source record's markings (`_inheritable`, `_force`,
 * `_fallback`); directives themselves never travel, and a receiver cannot
 * re-mark fields it did not write.
 */

import type { ModelRecordMap } from "./modelMatcher";
import { compareSpecificity, matchChain, matcherMatches, parseMatcherKey } from "./modelMatcher";

export const INHERITABLE_DIRECTIVE = "_inheritable";
export const INHERIT_FROM_DIRECTIVE = "_inherit_from";

/** "entry" is the declared server entry's own record map; "global" the models.* setting. */
export type RecordLayer = "entry" | "global";

/**
 * One problem found in a record map. `recordKey` names the record that
 * carries the problem; `key` the offending directive, field, or matcher key
 * inside it (for "invalid-matcher" the two coincide).
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
	/** An unknown capability field name (capabilities records only). */
	| "unknown-key"
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

/**
 * One record parsed into the engine's terms. The type-specific parsers
 * produce it: `fields` holds the validly-typed own fields, the marking sets
 * are always subsets of `fields`' keys, and `diagnostics` carries everything
 * the parse refused (attributed to the record by the caller).
 */
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

/**
 * Parse the two engine-owned directives out of one raw record, given the
 * record's already-parsed own fields (the marking lists may only name those:
 * a receiver cannot re-mark inherited fields, and naming an absent field is
 * an invalid-directive diagnostic with the name skipped).
 */
export function parseSharedDirectives(
	record: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, unknown>>
): {
	inheritable: ReadonlySet<string>;
	inheritFrom: InheritFromDirective;
	diagnostics: Omit<RecordDiagnostic, "recordKey">[];
} {
	const diagnostics: Omit<RecordDiagnostic, "recordKey">[] = [];
	const inheritable = new Set<string>();
	if (Object.hasOwn(record, INHERITABLE_DIRECTIVE)) {
		const directive = record[INHERITABLE_DIRECTIVE];
		if (directive === true) {
			for (const name of Object.keys(fields)) {
				inheritable.add(name);
			}
		} else if (Array.isArray(directive)) {
			for (const name of directive) {
				if (typeof name === "string" && Object.hasOwn(fields, name)) {
					inheritable.add(name);
				} else {
					diagnostics.push({ kind: "invalid-directive", key: INHERITABLE_DIRECTIVE });
				}
			}
		} else if (directive !== false) {
			diagnostics.push({ kind: "invalid-directive", key: INHERITABLE_DIRECTIVE });
		}
	}

	let inheritFrom: InheritFromDirective = { kind: "default" };
	if (Object.hasOwn(record, INHERIT_FROM_DIRECTIVE)) {
		const directive = record[INHERIT_FROM_DIRECTIVE];
		if (directive === true) {
			inheritFrom = { kind: "all" };
		} else if (directive === false) {
			inheritFrom = { kind: "none" };
		} else if (Array.isArray(directive)) {
			const keys: string[] = [];
			for (const name of directive) {
				if (typeof name === "string") {
					keys.push(name);
				} else {
					diagnostics.push({ kind: "invalid-directive", key: INHERIT_FROM_DIRECTIVE });
				}
			}
			// The empty list names no sources and behaves exactly like `false`,
			// barrier included; "keys" with an empty list resolves the same way.
			inheritFrom = { kind: "keys", keys };
		} else {
			diagnostics.push({ kind: "invalid-directive", key: INHERIT_FROM_DIRECTIVE });
		}
	}

	return { inheritable, inheritFrom, diagnostics };
}

/** One resolved field: the value plus the markings that ride with it from its source record. */
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
	 * The most specific matching record's resolved view: its own fields plus
	 * everything it accepted, each field carrying its source record's key and
	 * markings. Empty when nothing matches.
	 */
	readonly fields: ReadonlyMap<string, ResolvedChainField>;
	/** The most specific matching record's key; undefined when nothing matches. */
	readonly winnerKey: string | undefined;
	/** The most specific matching record's parse, for type-specific directives (`_openrouter_model`). */
	readonly winner: ParsedRecord | undefined;
	/** Matcher, directive, and field problems across the matching chain, deduplicated. */
	readonly diagnostics: readonly RecordDiagnostic[];
}

/**
 * Record-level lint of one record map, independent of any model: invalid
 * matcher keys, every record's own parse diagnostics, and `_inherit_from`
 * entries naming keys the map does not hold. resolveRecordChain reports the
 * same problems, but only along one model's matching chain - a record no
 * current model matches would never be visited there, and the Diagnostics
 * tab must still flag it. Deduplicated like the chain walk's diagnostics.
 */
export function lintRecordMap(
	records: ModelRecordMap,
	parse: (record: Readonly<Record<string, unknown>>, key: string) => ParsedRecord
): readonly RecordDiagnostic[] {
	const diagnostics: RecordDiagnostic[] = [];
	const seen = new Set<string>();
	const diagnose = (diagnostic: RecordDiagnostic): void => {
		const dedupeKey = `${diagnostic.kind}\u0000${diagnostic.recordKey}\u0000${diagnostic.key}`;
		if (!seen.has(dedupeKey)) {
			seen.add(dedupeKey);
			diagnostics.push(diagnostic);
		}
	};
	for (const [key, record] of Object.entries(records)) {
		const parsedKey = parseMatcherKey(key);
		if (!parsedKey.ok) {
			diagnose({ kind: "invalid-matcher", recordKey: key, key });
		}
		const parsed = parse(record, key);
		for (const diagnostic of parsed.diagnostics) {
			diagnose({ ...diagnostic, recordKey: key });
		}
		if (parsed.inheritFrom.kind === "keys") {
			for (const named of parsed.inheritFrom.keys) {
				if (!Object.hasOwn(records, named)) {
					diagnose({ kind: "unknown-inherit-key", recordKey: key, key: named });
				}
			}
		}
	}
	return diagnostics;
}

/**
 * Resolve one record map for one model ID. The chain of matching records is
 * walked broadest to most specific; each record's resolved view is its own
 * fields over what it accepts from below, and what flows past a record is
 * exactly its resolved view - the pass-through rule that makes
 * `_inherit_from: false` a barrier. An `_inherit_from` list replaces the flow
 * with the named records' literal fields (nearest-first by specificity, own
 * fields still on top), reaching around any barrier; a named key must exist
 * in the map (diagnosed otherwise) and must itself match the model to
 * contribute (inheritance has sources, not includes - a non-matching name is
 * silently inert for this model).
 */
export function resolveRecordChain(
	id: string,
	records: ModelRecordMap,
	parse: (record: Readonly<Record<string, unknown>>, key: string) => ParsedRecord
): RecordChainResolution {
	const { chain, diagnostics: matcherDiagnostics } = matchChain(id, records);

	const diagnostics: RecordDiagnostic[] = [];
	const seen = new Set<string>();
	const diagnose = (diagnostic: RecordDiagnostic): void => {
		const dedupeKey = `${diagnostic.kind}\u0000${diagnostic.recordKey}\u0000${diagnostic.key}`;
		if (!seen.has(dedupeKey)) {
			seen.add(dedupeKey);
			diagnostics.push(diagnostic);
		}
	};
	for (const diagnostic of matcherDiagnostics) {
		diagnose({ kind: "invalid-matcher", recordKey: diagnostic.key, key: diagnostic.key });
	}

	// Parses are shared between chain membership and `_inherit_from` lookups,
	// so a record parsed for both reports its problems once.
	const parsedByKey = new Map<string, ParsedRecord>();
	const parsedFor = (key: string): ParsedRecord | undefined => {
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

	const ownFieldsOf = (key: string, parsed: ParsedRecord): Map<string, ResolvedChainField> => {
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
	};

	let incoming = new Map<string, ResolvedChainField>();
	let winner: { key: string; parsed: ParsedRecord } | undefined;
	for (const match of chain) {
		const parsed = parsedFor(match.key);
		if (parsed === undefined) {
			continue; // Unreachable: chain keys come from the record map.
		}
		for (const diagnostic of parsed.diagnostics) {
			diagnose({ ...diagnostic, recordKey: match.key });
		}

		const accepted = new Map<string, ResolvedChainField>();
		switch (parsed.inheritFrom.kind) {
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
			case "keys": {
				// Named sources contribute their LITERAL fields only (their own
				// inheritance never carries over), merged broadest first so the
				// most specific named record wins per field - specificity order,
				// not list order, and duplicates change nothing.
				const named: { key: string; parsed: ParsedRecord; position: number }[] = [];
				const namedSeen = new Set<string>();
				for (const nameKey of parsed.inheritFrom.keys) {
					if (namedSeen.has(nameKey)) {
						continue;
					}
					namedSeen.add(nameKey);
					if (!Object.hasOwn(records, nameKey)) {
						diagnose({ kind: "unknown-inherit-key", recordKey: match.key, key: nameKey });
						continue;
					}
					const namedParse = parseMatcherKey(nameKey);
					if (!namedParse.ok || !matcherMatches(namedParse.matcher, id)) {
						// A named record that does not match this model contributes
						// nothing; an invalid key already carries its own diagnostic.
						continue;
					}
					const namedParsed = parsedFor(nameKey);
					if (namedParsed !== undefined) {
						named.push({ key: nameKey, parsed: namedParsed, position: Object.keys(records).indexOf(nameKey) });
					}
				}
				named.sort((a, b) => {
					const aParse = parseMatcherKey(a.key);
					const bParse = parseMatcherKey(b.key);
					if (!aParse.ok || !bParse.ok) {
						return 0; // Unreachable: non-matching keys were filtered above.
					}
					return compareSpecificity(
						{ matcher: aParse.matcher, position: a.position },
						{ matcher: bParse.matcher, position: b.position }
					);
				});
				for (const source of named) {
					for (const [name, field] of ownFieldsOf(source.key, source.parsed)) {
						accepted.set(name, field);
					}
				}
				break;
			}
		}

		const view = accepted;
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
		diagnostics,
	};
}
