/**
 * The inheritance fuzzer: random record trees with random `_inheritable`, `_inherit_from`, `_force`, and `_fallback`
 * placements, resolved for random model IDs against a NAIVE oracle that restates the documented semantics from scratch
 * (its own matcher, its own recursive walk, no code shared with the engine). Directive values are generated
 * well-formed; the malformed shapes are unit-pinned in recordResolution.test.ts.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { ServerDeclaredCapabilities } from "../../../../shared/config/capabilityResolution";
import {
	EMPTY_CATALOG_LOOKUP,
	resolveCapabilityLayer,
	resolveModelCapabilities,
} from "../../../../shared/config/capabilityResolution";
import type { ParsedParameterRecord } from "../../../../shared/config/parameterResolution";
import { resolveModelParameters, resolveParameterLayer } from "../../../../shared/config/parameterResolution";
import type { RecordChainResolution, ResolvedChainField } from "../../../../shared/config/recordResolution";
import { isFimTemplateValue } from "../../../../shared/config/recordResolution";
import { ModelResolutionTable } from "../../../../shared/config/resolutionTable";
import { resolveFuzzSeed } from "../../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 300;
const SEED = resolveFuzzSeed();

const idChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-");

const modelIdArb = fc.string({ unit: idChar, minLength: 1, maxLength: 8 });

const FIELD_POOL = ["temperature", "top_p", "seed", "penalty", "stop"] as const;
const CAP_FIELD_POOL = ["context_length", "max_output_tokens", "supports_vision", "supports_reasoning"] as const;

type RawRecord = Record<string, unknown>;

/**
 * The directive placements of one generated record. `fields` are indexes into the active field pool, deduplicated at
 * build time; `marking` is `_force` for parameters and `_fallback` for capabilities.
 */
interface RecordSpec {
	readonly fields: readonly number[];
	readonly inheritable: "absent" | "all" | "list";
	readonly inheritableList: readonly number[];
	readonly marking: "absent" | "all" | "list";
	readonly markingList: readonly number[];
	readonly inheritFrom: "absent" | "all" | "none" | "list";
	readonly inheritKeys: readonly number[];
	readonly ghostKey: boolean;
	readonly fim: "absent" | "valid" | "invalid";
}

const recordSpecArb: fc.Arbitrary<RecordSpec> = fc.record({
	fields: fc.uniqueArray(fc.nat({ max: 20 }), { maxLength: 3 }),
	inheritable: fc.constantFrom("absent", "all", "list"),
	inheritableList: fc.array(fc.nat(), { maxLength: 2 }),
	marking: fc.constantFrom("absent", "all", "list"),
	markingList: fc.array(fc.nat(), { maxLength: 2 }),
	inheritFrom: fc.oneof(
		{ arbitrary: fc.constant<"absent">("absent"), weight: 3 },
		{ arbitrary: fc.constantFrom<"all" | "none" | "list">("all", "none", "list"), weight: 2 }
	),
	inheritKeys: fc.array(fc.nat(), { maxLength: 3 }),
	ghostKey: fc.boolean(),
	fim: fc.oneof(
		{ arbitrary: fc.constant<"absent">("absent"), weight: 4 },
		{ arbitrary: fc.constantFrom<"valid" | "invalid">("valid", "invalid"), weight: 2 }
	),
});

interface Scenario {
	readonly id: string;
	readonly records: Record<string, RawRecord>;
}

/** The record key forms a scenario draws: cuts of the model ID, the catch-all, a stranger's ID, and an invalid key. */
type KeyForm = "glob" | "exact" | "star" | "regex" | "foreign" | "invalid";

/** The field names a directive list names; each index wraps around the record's own fields. */
function listedFields(indexes: readonly number[], fields: readonly string[]): string[] {
	return indexes.map((i) => fields[i % Math.max(1, fields.length)]).filter((f) => f !== undefined);
}

/** A marking directive's value for its mode: every own field, the listed ones, or absent. */
function markingValue(
	mode: "absent" | "all" | "list",
	list: readonly number[],
	fields: readonly string[]
): true | string[] | undefined {
	if (mode === "all") {
		return true;
	}
	if (mode === "list") {
		return listedFields(list, fields);
	}
	return undefined;
}

/**
 * A `_fim_template` value: valid templates vary by salt so a winner swap is observable, and the invalid arm covers
 * both the wrong-type and the missing-placeholder shape.
 */
function fimTemplateValue(fim: "valid" | "invalid", salt: number): unknown {
	if (fim === "valid") {
		return `<s${salt}>{prefix}|{suffix}`;
	}
	return salt % 2 === 0 ? 42 : "{prefix} only";
}

/** An `_inherit_from` value for its mode: everything, nothing, the named keys plus a ghost key on demand, or absent. */
function inheritFromValue(spec: RecordSpec, allKeys: readonly string[]): boolean | string[] | undefined {
	if (spec.inheritFrom === "all") {
		return true;
	}
	if (spec.inheritFrom === "none") {
		return false;
	}
	if (spec.inheritFrom !== "list") {
		return undefined;
	}
	const names = spec.inheritKeys.map((i) => allKeys[i % Math.max(1, allKeys.length)]).filter((k) => k !== undefined);
	return spec.ghostKey ? [...names, "ghost-key"] : names;
}

function buildRecord(
	spec: RecordSpec,
	allKeys: readonly string[],
	fieldPool: readonly string[],
	markingDirective: "_force" | "_fallback",
	fieldValue: (name: string, salt: number) => unknown,
	salt: number
): RawRecord {
	const record: RawRecord = {};
	const fields = [...new Set(spec.fields.map((i) => fieldPool[i % fieldPool.length]))].filter(
		(f): f is string => f !== undefined
	);
	for (const name of fields) {
		record[name] = fieldValue(name, salt);
	}

	const inheritable = markingValue(spec.inheritable, spec.inheritableList, fields);
	if (inheritable !== undefined) {
		record._inheritable = inheritable;
	}

	const marking = markingValue(spec.marking, spec.markingList, fields);
	if (marking !== undefined) {
		record[markingDirective] = marking;
	}

	if (markingDirective === "_force" && spec.fim !== "absent") {
		record._fim_template = fimTemplateValue(spec.fim, salt);
	}

	const inheritFrom = inheritFromValue(spec, allKeys);
	if (inheritFrom !== undefined) {
		record._inherit_from = inheritFrom;
	}

	return record;
}

/** The key one spec asks for: a cut of the ID in its form, the catch-all, or a key built off the unrelated ID. */
function keyFor(form: KeyForm, cut: number, id: string, otherId: string): string {
	const prefix = id.slice(0, cut % (id.length + 1));
	switch (form) {
		case "glob":
			return `${prefix}*`;
		case "exact":
			return prefix || id;
		case "star":
			return "*";
		case "regex":
			return `/${prefix}.*/`;
		case "foreign":
			return otherId;
		case "invalid":
			return `${otherId}*${otherId}`;
	}
}

function scenarioArb(fieldPool: readonly string[], markingDirective: "_force" | "_fallback"): fc.Arbitrary<Scenario> {
	return fc
		.record({
			id: modelIdArb,
			otherId: modelIdArb,
			keySpecs: fc.array(
				fc.record({
					cut: fc.nat(),
					form: fc.constantFrom<KeyForm>("glob", "exact", "star", "regex", "foreign", "invalid"),
					spec: recordSpecArb,
				}),
				{ maxLength: 5 }
			),
			salt: fc.nat(),
		})
		.map(({ id, otherId, keySpecs, salt }) => {
			const keys: { key: string; spec: RecordSpec }[] = [];
			const seen = new Set<string>();
			for (const { cut, form, spec } of keySpecs) {
				const key = keyFor(form, cut, id, otherId);
				if (!seen.has(key)) {
					seen.add(key);
					keys.push({ key, spec });
				}
			}
			const allKeys = keys.map((entry) => entry.key);
			const records: Record<string, RawRecord> = {};
			let i = 0;
			for (const { key, spec } of keys) {
				records[key] = buildRecord(spec, allKeys, fieldPool, markingDirective, fieldValueFor(fieldPool), salt + i);
				i += 1;
			}
			return { id, records };
		});
}

function fieldValueFor(fieldPool: readonly string[]): (name: string, salt: number) => unknown {
	return (name, salt) => {
		if (fieldPool === CAP_FIELD_POOL) {
			return name.startsWith("supports_") ? salt % 2 === 0 : (salt % 100000) + 1;
		}
		return `${name}#${salt}`;
	};
}

// ---------------------------------------------------------------------------
// The naive oracle: the documented semantics restated from scratch.
// ---------------------------------------------------------------------------

type NaiveMatcher =
	| { kind: "exact"; key: string }
	| { kind: "glob"; prefix: string }
	| { kind: "regex"; prefix: string }
	| { kind: "star" };

/** The generated sublanguage's keys only; anything else (the invalid form) answers undefined. */
function naiveParse(key: string): NaiveMatcher | undefined {
	if (key === "*") {
		return { kind: "star" };
	}
	if (/^\/[a-z0-9-]*\.\*\/$/.test(key)) {
		return { kind: "regex", prefix: key.slice(1, -4) };
	}
	if (key.endsWith("*") && !key.slice(0, -1).includes("*")) {
		return { kind: "glob", prefix: key.slice(0, -1) };
	}
	if (key.includes("*")) {
		return undefined;
	}
	return { kind: "exact", key };
}

/**
 * Generated IDs hold no regex metacharacters (idChar), so the one regex form, a slash-wrapped literal followed by
 * `.*`, is a plain startsWith.
 */
function naiveMatches(matcher: NaiveMatcher, id: string): boolean {
	switch (matcher.kind) {
		case "exact":
			return id === matcher.key;
		case "glob":
		case "regex":
			return id.startsWith(matcher.prefix);
		case "star":
			return true;
	}
}

const NAIVE_TIER = { star: 0, regex: 1, glob: 2, exact: 3 } as const;

function naiveChain(id: string, records: Record<string, RawRecord>): string[] {
	const order = Object.keys(records);
	return order
		.filter((key) => {
			const matcher = naiveParse(key);
			return matcher !== undefined && naiveMatches(matcher, id);
		})
		.sort((a, b) => {
			const ma = naiveParse(a) as NaiveMatcher;
			const mb = naiveParse(b) as NaiveMatcher;
			if (NAIVE_TIER[ma.kind] !== NAIVE_TIER[mb.kind]) {
				return NAIVE_TIER[ma.kind] - NAIVE_TIER[mb.kind];
			}
			if (ma.kind === "glob" && mb.kind === "glob") {
				return ma.prefix.length - mb.prefix.length;
			}
			if (ma.kind === "regex" && mb.kind === "regex") {
				return order.indexOf(a) - order.indexOf(b);
			}
			return 0;
		});
}

/** One field as the oracle resolves it; `marked` is `_force` for parameters and `_fallback` for capabilities. */
interface NaiveField {
	value: unknown;
	sourceKey: string;
	inheritable: boolean;
	marked: boolean;
}

/** Provider-owned keys the engine never forces; the pools never produce them, so the branch restates the spec. */
const UNFORCEABLE = new Set(["model", "messages", "stream", "stream_options", "tools", "tool_choice"]);

function naiveOwnFields(
	key: string,
	record: RawRecord,
	markingDirective: "_force" | "_fallback"
): Map<string, NaiveField> {
	const fields = new Map<string, NaiveField>();
	const names = Object.keys(record).filter((name) => !name.startsWith("_"));
	const inheritable = record._inheritable;
	const marking = record[markingDirective];
	for (const name of names) {
		const inheritableHere = inheritable === true || (Array.isArray(inheritable) && inheritable.includes(name));
		let markedHere = marking === true || (Array.isArray(marking) && marking.includes(name));
		if (markingDirective === "_force" && (name.startsWith("_") || UNFORCEABLE.has(name))) {
			markedHere = false;
		}
		fields.set(name, { value: record[name], sourceKey: key, inheritable: inheritableHere, marked: markedHere });
	}
	return fields;
}

/** The view's inheritable fields alone: what a record takes when it says nothing about inheritance. */
function inheritableFields(view: ReadonlyMap<string, NaiveField>): Map<string, NaiveField> {
	const accepted = new Map<string, NaiveField>();
	for (const [name, field] of view) {
		if (field.inheritable) {
			accepted.set(name, field);
		}
	}
	return accepted;
}

/**
 * The own fields of the records an `_inherit_from` list names, laid down broadest first so the most specific named
 * record wins per field; a name that is no matching record of the chain is skipped.
 */
function namedRecordFields(
	inheritFrom: readonly unknown[],
	id: string,
	records: Record<string, RawRecord>,
	chain: readonly string[],
	markingDirective: "_force" | "_fallback"
): Map<string, NaiveField> {
	const named = [...new Set(inheritFrom)].filter((k): k is string => {
		if (typeof k !== "string" || !Object.hasOwn(records, k)) {
			return false;
		}
		const matcher = naiveParse(k);
		return matcher !== undefined && naiveMatches(matcher, id);
	});
	named.sort((a, b) => chain.indexOf(a) - chain.indexOf(b));

	const accepted = new Map<string, NaiveField>();
	for (const namedKey of named) {
		for (const [name, field] of naiveOwnFields(namedKey, records[namedKey] as RawRecord, markingDirective)) {
			accepted.set(name, field);
		}
	}
	return accepted;
}

/**
 * The fields a record inherits before its own are laid on top, as its `_inherit_from` value admits them: the view's
 * inheritable fields when absent, the whole view on `true`, the named records' own fields on a list, nothing on
 * `false`.
 */
function inheritedFields(
	view: ReadonlyMap<string, NaiveField>,
	inheritFrom: unknown,
	id: string,
	records: Record<string, RawRecord>,
	chain: readonly string[],
	markingDirective: "_force" | "_fallback"
): Map<string, NaiveField> {
	if (inheritFrom === undefined) {
		return inheritableFields(view);
	}
	if (inheritFrom === true) {
		return new Map(view);
	}
	if (Array.isArray(inheritFrom)) {
		return namedRecordFields(inheritFrom, id, records, chain, markingDirective);
	}
	return new Map();
}

function naiveResolve(
	id: string,
	records: Record<string, RawRecord>,
	markingDirective: "_force" | "_fallback"
): Map<string, NaiveField> {
	const chain = naiveChain(id, records);
	let view = new Map<string, NaiveField>();
	for (const key of chain) {
		const record = records[key] as RawRecord;
		const inheritFrom = Object.hasOwn(record, "_inherit_from") ? record._inherit_from : undefined;
		const accepted = inheritedFields(view, inheritFrom, id, records, chain, markingDirective);
		for (const [name, field] of naiveOwnFields(key, record, markingDirective)) {
			accepted.set(name, field);
		}
		view = accepted;
	}
	return view;
}

function engineView(fields: ReadonlyMap<string, ResolvedChainField>, markingDirective: "_force" | "_fallback") {
	return new Map(
		[...fields].map(([name, field]) => [
			name,
			{
				value: field.value,
				sourceKey: field.sourceKey,
				inheritable: field.inheritable,
				marked: markingDirective === "_force" ? field.forced : field.fallback,
			},
		])
	);
}

/** Whether an `_inherit_from` value closes the chain: `false`, or an empty list. */
function isBarrier(inheritFrom: unknown): boolean {
	return inheritFrom === false || (Array.isArray(inheritFrom) && inheritFrom.length === 0);
}

/** Every resolved field was written by the winner itself. */
function assertOnlyOwnFields(resolution: RecordChainResolution, winnerKey: string): void {
	for (const field of resolution.fields.values()) {
		assert.strictEqual(field.sourceKey, winnerKey, "a barrier blocks all pass-through");
	}
}

/** Every resolved field was written by the winner or by a record its list names. */
function assertOnlyNamedSources(
	resolution: RecordChainResolution,
	winnerKey: string,
	inheritFrom: readonly unknown[]
): void {
	const allowed = new Set<string>([winnerKey, ...inheritFrom.filter((k): k is string => typeof k === "string")]);
	for (const field of resolution.fields.values()) {
		assert.ok(allowed.has(field.sourceKey), "an exclusive list draws only from itself and the named records");
	}
}

describe("shared/config recordResolution inheritance fuzzer", () => {
	const paramsScenario = scenarioArb(FIELD_POOL, "_force");
	const capsScenario = scenarioArb(CAP_FIELD_POOL, "_fallback");

	test("the parameters chain equals the naive oracle: fields, writers, and markings", () => {
		fc.assert(
			fc.property(paramsScenario, ({ id, records }) => {
				const layer = resolveParameterLayer(id, records);
				const engine = engineView(layer.fields, "_force");
				assert.deepStrictEqual(engine, naiveResolve(id, records, "_force"));
				// The `_fim_template` directive belongs to the chain's WINNER alone: never inherited, never taken from
				// a broader record, and an invalid value reads as absent (its diagnostic is covered elsewhere).
				const winnerKey = naiveChain(id, records).at(-1);
				const winnerValue = winnerKey === undefined ? undefined : (records[winnerKey] as RawRecord)._fim_template;
				const expected = isFimTemplateValue(winnerValue) ? winnerValue : undefined;
				assert.strictEqual((layer.winner as ParsedParameterRecord | undefined)?.fimTemplate, expected);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("the capabilities chain equals the naive oracle: fields, writers, and fallback markings", () => {
		fc.assert(
			fc.property(capsScenario, ({ id, records }) => {
				const engine = engineView(resolveCapabilityLayer(id, records).fields, "_fallback");
				assert.deepStrictEqual(engine, naiveResolve(id, records, "_fallback"));
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a barrier winner resolves to exactly its own fields; an exclusive winner only to own plus named literals", () => {
		fc.assert(
			fc.property(paramsScenario, ({ id, records }) => {
				const chain = naiveChain(id, records);
				const winnerKey = chain[chain.length - 1];
				if (winnerKey === undefined) {
					return;
				}
				const inheritFrom = (records[winnerKey] as RawRecord)._inherit_from;
				const resolution = resolveParameterLayer(id, records);
				if (isBarrier(inheritFrom)) {
					assertOnlyOwnFields(resolution, winnerKey);
				}
				if (Array.isArray(inheritFrom)) {
					assertOnlyNamedSources(resolution, winnerKey, inheritFrom);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

describe("shared/config resolutionTable equivalence", () => {
	const paramsScenario = scenarioArb(FIELD_POOL, "_force");
	const capsScenario = scenarioArb(CAP_FIELD_POOL, "_fallback");

	const serverDeclaredArb: fc.Arbitrary<ServerDeclaredCapabilities> = fc.oneof(
		fc.constant<ServerDeclaredCapabilities>({ kind: "declared" }),
		fc
			.record({
				context_length: fc.option(fc.integer({ min: 1, max: 500000 }), { nil: undefined }),
				max_output_tokens: fc.option(fc.integer({ min: 1, max: 500000 }), { nil: undefined }),
				defaultMaxTokens: fc.integer({ min: 1, max: 500000 }),
			})
			.map(({ context_length, max_output_tokens, defaultMaxTokens }) => ({
				kind: "discovered" as const,
				values: {
					...(context_length === undefined ? {} : { context_length }),
					...(max_output_tokens === undefined ? {} : { max_output_tokens }),
				},
				defaultMaxTokens,
			}))
	);

	test("table parameters == direct resolution; repeats hit the memo; changed inputs recompute", () => {
		fc.assert(
			fc.property(paramsScenario, paramsScenario, ({ id, records }, second) => {
				const table = new ModelResolutionTable();
				const inputs = { globalParameters: records, entryParameters: second.records };
				const viaTable = table.resolveParameters("srv", id, inputs);
				const direct = resolveModelParameters({
					rawModelId: id,
					globalParameters: records,
					entryParameters: second.records,
				});
				assert.deepStrictEqual(viaTable.params, direct.params);
				assert.deepStrictEqual(viaTable.forcedParams, direct.forcedParams);
				assert.strictEqual(viaTable.fimTemplate, direct.fimTemplate, "the directive rides the table unchanged");
				assert.deepStrictEqual(viaTable.diagnostics, direct.diagnostics);
				assert.strictEqual(table.resolveParameters("srv", id, inputs), viaTable, "a repeat is a memo hit");
				// Equal-but-not-identical inputs still hit the memo (fingerprinted).
				const clone = JSON.parse(JSON.stringify(inputs));
				assert.strictEqual(table.resolveParameters("srv", id, clone), viaTable);
				const changed = { ...inputs, globalParameters: { ...records, "*": { temperature: "changed" } } };
				assert.deepStrictEqual(
					table.resolveParameters("srv", id, changed).params,
					resolveModelParameters({
						rawModelId: id,
						globalParameters: changed.globalParameters,
						entryParameters: second.records,
					}).params
				);
			}),
			{ numRuns: Math.min(NUM_RUNS, 150), seed: SEED }
		);
	});

	test("table capabilities == direct resolution, memoized and invalidated the same way", () => {
		fc.assert(
			fc.property(capsScenario, capsScenario, serverDeclaredArb, ({ id, records }, second, serverDeclared) => {
				const table = new ModelResolutionTable();
				const inputs = {
					globalCapabilities: records,
					entryCapabilities: second.records,
					serverDeclared,
					catalog: EMPTY_CATALOG_LOOKUP,
				};
				const viaTable = table.resolveCapabilities("srv", id, inputs);
				const direct = resolveModelCapabilities({
					rawModelId: id,
					globalCapabilities: records,
					entryCapabilities: second.records,
					serverDeclared,
					catalog: EMPTY_CATALOG_LOOKUP,
				});
				assert.deepStrictEqual(viaTable, direct);
				assert.strictEqual(table.resolveCapabilities("srv", id, inputs), viaTable, "a repeat is a memo hit");
				const changedEntry = { ...second.records, "*": { context_length: 424242 } };
				assert.deepStrictEqual(
					table.resolveCapabilities("srv", id, { ...inputs, entryCapabilities: changedEntry }),
					resolveModelCapabilities({
						rawModelId: id,
						globalCapabilities: records,
						entryCapabilities: changedEntry,
						serverDeclared,
						catalog: EMPTY_CATALOG_LOOKUP,
					})
				);
			}),
			{ numRuns: Math.min(NUM_RUNS, 150), seed: SEED }
		);
	});

	test("prune drops whole servers and the per-server bound evicts oldest model entries", () => {
		const table = new ModelResolutionTable();
		const inputs = { globalParameters: { "*": { temperature: 0.5 } } };
		const first = table.resolveParameters("kept", "model-0", inputs);
		for (let i = 1; i <= 512; i += 1) {
			table.resolveParameters("kept", `model-${i}`, inputs);
		}
		const recomputed = table.resolveParameters("kept", "model-0", inputs);
		assert.notStrictEqual(recomputed, first, "the oldest entry must have been evicted at the bound");
		assert.deepStrictEqual(recomputed.params, first.params);
		const young = table.resolveParameters("kept", "model-512", inputs);
		assert.strictEqual(table.resolveParameters("kept", "model-512", inputs), young, "younger entries survive");

		const dropped = table.resolveParameters("dropped", "m", inputs);
		table.prune(["kept"]);
		assert.notStrictEqual(table.resolveParameters("dropped", "m", inputs), dropped, "a pruned server recomputes");
		assert.strictEqual(table.resolveParameters("kept", "model-512", inputs), young, "a kept server's memo survives");
		table.clear();
		assert.notStrictEqual(table.resolveParameters("kept", "model-512", inputs), young, "clear drops everything");
	});

	test("a catalog whose data swaps behind a stable facade still invalidates the cached capabilities", () => {
		// The real store keeps one lookup object and swaps its inner snapshot on refresh, so the table must judge the
		// catalog by its ANSWERS.
		fc.assert(
			fc.property(capsScenario, serverDeclaredArb, ({ id, records }, serverDeclared) => {
				const table = new ModelResolutionTable();
				let contextFromCatalog = 11111;
				const facade = {
					byExactId: () => ({ kind: "not-found" }) as const,
					byRawModelId: (rawId: string) =>
						rawId === id
							? ({ kind: "found", id: `imp/${id}`, fields: { context_length: contextFromCatalog } } as const)
							: ({ kind: "not-found" } as const),
				};
				const inputs = {
					globalCapabilities: records,
					entryCapabilities: undefined,
					serverDeclared,
					catalog: facade,
				};
				const before = table.resolveCapabilities("srv", id, inputs);
				assert.strictEqual(table.resolveCapabilities("srv", id, inputs), before, "same answers hit the memo");
				contextFromCatalog = 22222;
				const after = table.resolveCapabilities("srv", id, inputs);
				assert.deepStrictEqual(
					after,
					resolveModelCapabilities({
						rawModelId: id,
						globalCapabilities: records,
						entryCapabilities: undefined,
						serverDeclared,
						catalog: facade,
					}),
					"the changed catalog answer must recompute through the same facade object"
				);
			}),
			{ numRuns: Math.min(NUM_RUNS, 100), seed: SEED }
		);
	});
});
