/**
 * The inheritance fuzzer: random record trees with random `_inheritable`,
 * `_inherit_from`, `_force`, and `_fallback` placements, resolved for random
 * model IDs, against a NAIVE oracle that restates the documented semantics
 * directly (its own matcher, its own recursive walk - no code shared with
 * the engine). Directive values are generated well-formed; the malformed
 * shapes are unit-pinned in recordResolution.test.ts. On top of the oracle,
 * three targeted invariants: a barrier winner resolves to exactly its own
 * fields, an exclusive-list winner draws only from its own and the named
 * records' literal fields, and markings always ride from the writer. The
 * flat-table properties pin ModelResolutionTable == direct resolution, with
 * memo hits by identity and fingerprint invalidation on changed inputs.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { ServerDeclaredCapabilities } from "../../../shared/config/capabilityResolution";
import {
	EMPTY_CATALOG_LOOKUP,
	resolveCapabilityLayer,
	resolveModelCapabilities,
} from "../../../shared/config/capabilityResolution";
import { resolveModelParameters, resolveParameterLayer } from "../../../shared/config/parameterResolution";
import type { ResolvedChainField } from "../../../shared/config/recordResolution";
import { ModelResolutionTable } from "../../../shared/config/resolutionTable";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 300;
const SEED = resolveFuzzSeed();

// No regex metacharacters, so the naive matcher below can treat the one
// generated regex form ("/<literal>.*/") with plain startsWith semantics.
const idChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-");
const modelIdArb = fc.string({ unit: idChar, minLength: 1, maxLength: 8 });

const FIELD_POOL = ["temperature", "top_p", "seed", "penalty", "stop"] as const;
const CAP_FIELD_POOL = ["context_length", "max_output_tokens", "supports_vision", "supports_reasoning"] as const;

type RawRecord = Record<string, unknown>;

interface RecordSpec {
	/** Indexes into the active field pool; deduplicated at build time. */
	readonly fields: readonly number[];
	readonly inheritable: "absent" | "all" | "list";
	readonly inheritableList: readonly number[];
	readonly marking: "absent" | "all" | "list"; // _force (params) / _fallback (caps)
	readonly markingList: readonly number[];
	readonly inheritFrom: "absent" | "all" | "none" | "list";
	readonly inheritKeys: readonly number[];
	readonly ghostKey: boolean;
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
});

interface Scenario {
	readonly id: string;
	readonly records: Record<string, RawRecord>;
}

/** Build one raw record from its spec, given the map's final key list (for _inherit_from names). */
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
	if (spec.inheritable === "all") {
		record._inheritable = true;
	} else if (spec.inheritable === "list") {
		record._inheritable = spec.inheritableList
			.map((i) => fields[i % Math.max(1, fields.length)])
			.filter((f) => f !== undefined);
	}
	if (spec.marking === "all") {
		record[markingDirective] = true;
	} else if (spec.marking === "list") {
		record[markingDirective] = spec.markingList
			.map((i) => fields[i % Math.max(1, fields.length)])
			.filter((f) => f !== undefined);
	}
	if (spec.inheritFrom === "all") {
		record._inherit_from = true;
	} else if (spec.inheritFrom === "none") {
		record._inherit_from = false;
	} else if (spec.inheritFrom === "list") {
		const names = spec.inheritKeys.map((i) => allKeys[i % Math.max(1, allKeys.length)]).filter((k) => k !== undefined);
		record._inherit_from = spec.ghostKey ? [...names, "ghost-key"] : names;
	}
	return record;
}

function scenarioArb(fieldPool: readonly string[], markingDirective: "_force" | "_fallback"): fc.Arbitrary<Scenario> {
	return fc
		.record({
			id: modelIdArb,
			otherId: modelIdArb,
			keySpecs: fc.array(
				fc.record({
					cut: fc.nat(),
					form: fc.constantFrom("glob", "exact", "star", "regex", "foreign", "invalid"),
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
				const cutOf = (base: string) => base.slice(0, cut % (base.length + 1));
				const key =
					form === "glob"
						? `${cutOf(id)}*`
						: form === "exact"
							? cutOf(id) || id
							: form === "star"
								? "*"
								: form === "regex"
									? `/${cutOf(id)}.*/`
									: form === "foreign"
										? otherId
										: `${otherId}*${otherId}`;
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

/** Deterministic primitive values; capability number fields get positive ints, flags get booleans. */
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

/** Matching keys, broadest first, per the documented tiers, prefix lengths, and record positions. */
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

interface NaiveField {
	value: unknown;
	sourceKey: string;
	inheritable: boolean;
	marked: boolean; // _force (params) / _fallback (caps)
}

// The engine's unforceable set: provider-owned keys except max_tokens (the
// one settable provider-owned key), plus underscore keys. The field pools
// above never produce these, so this is spec restatement, not a live branch.
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

function naiveResolve(
	id: string,
	records: Record<string, RawRecord>,
	markingDirective: "_force" | "_fallback"
): Map<string, NaiveField> {
	let view = new Map<string, NaiveField>();
	for (const key of naiveChain(id, records)) {
		const record = records[key] as RawRecord;
		const accepted = new Map<string, NaiveField>();
		const inheritFrom = Object.hasOwn(record, "_inherit_from") ? record._inherit_from : undefined;
		if (inheritFrom === undefined) {
			for (const [name, field] of view) {
				if (field.inheritable) {
					accepted.set(name, field);
				}
			}
		} else if (inheritFrom === true) {
			for (const [name, field] of view) {
				accepted.set(name, field);
			}
		} else if (Array.isArray(inheritFrom)) {
			const named = [...new Set(inheritFrom)].filter((k): k is string => {
				if (typeof k !== "string" || !Object.hasOwn(records, k)) {
					return false;
				}
				const matcher = naiveParse(k);
				return matcher !== undefined && naiveMatches(matcher, id);
			});
			// Nearest-first is specificity order: apply broadest first so the
			// most specific named record wins per field.
			const chainOrder = naiveChain(id, records);
			named.sort((a, b) => chainOrder.indexOf(a) - chainOrder.indexOf(b));
			for (const namedKey of named) {
				for (const [name, field] of naiveOwnFields(namedKey, records[namedKey] as RawRecord, markingDirective)) {
					accepted.set(name, field);
				}
			}
		}
		// inheritFrom === false accepts nothing.
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

suite("shared/config recordResolution inheritance fuzzer", () => {
	const paramsScenario = scenarioArb(FIELD_POOL, "_force");
	const capsScenario = scenarioArb(CAP_FIELD_POOL, "_fallback");

	test("the parameters chain equals the naive oracle: fields, writers, and markings", () => {
		fc.assert(
			fc.property(paramsScenario, ({ id, records }) => {
				const engine = engineView(resolveParameterLayer(id, records).fields, "_force");
				assert.deepStrictEqual(engine, naiveResolve(id, records, "_force"));
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
				const winner = records[winnerKey] as RawRecord;
				const resolution = resolveParameterLayer(id, records);
				const inheritFrom = winner._inherit_from;
				const isBarrier = inheritFrom === false || (Array.isArray(inheritFrom) && inheritFrom.length === 0);
				if (isBarrier) {
					for (const field of resolution.fields.values()) {
						assert.strictEqual(field.sourceKey, winnerKey, "a barrier blocks all pass-through");
					}
				}
				if (Array.isArray(inheritFrom)) {
					const allowed = new Set<string>([
						winnerKey,
						...inheritFrom.filter((k): k is string => typeof k === "string"),
					]);
					for (const field of resolution.fields.values()) {
						assert.ok(allowed.has(field.sourceKey), "an exclusive list draws only from itself and the named records");
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

suite("shared/config resolutionTable equivalence", () => {
	const paramsScenario = scenarioArb(FIELD_POOL, "_force");
	const capsScenario = scenarioArb(CAP_FIELD_POOL, "_fallback");

	const serverDeclaredArb: fc.Arbitrary<ServerDeclaredCapabilities> = fc.oneof(
		fc.constant<ServerDeclaredCapabilities>({ kind: "declared" }),
		fc
			.record({
				context_length: fc.option(fc.integer({ min: 1, max: 500000 }), { nil: undefined }),
				max_output_tokens: fc.option(fc.integer({ min: 1, max: 500000 }), { nil: undefined }),
				outputDeclared: fc.boolean(),
			})
			.map(({ context_length, max_output_tokens, outputDeclared }) => ({
				kind: "discovered" as const,
				values: {
					...(context_length !== undefined ? { context_length } : {}),
					...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
				},
				outputDeclared,
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
				assert.deepStrictEqual(viaTable.diagnostics, direct.diagnostics);
				assert.strictEqual(table.resolveParameters("srv", id, inputs), viaTable, "a repeat is a memo hit");
				// Equal-but-not-identical inputs still hit the memo (fingerprinted).
				const clone = JSON.parse(JSON.stringify(inputs));
				assert.strictEqual(table.resolveParameters("srv", id, clone), viaTable);
				// A changed record invalidates: the table answers the new resolution.
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
				// A changed ENTRY record invalidates like a changed global one.
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
		// Overflow the per-server bound: the oldest entry (model-0) is evicted
		// and recomputes to an equal-but-new resolution; a younger entry
		// survives as a memo hit.
		for (let i = 1; i <= 512; i += 1) {
			table.resolveParameters("kept", `model-${i}`, inputs);
		}
		const recomputed = table.resolveParameters("kept", "model-0", inputs);
		assert.notStrictEqual(recomputed, first, "the oldest entry must have been evicted at the bound");
		assert.deepStrictEqual(recomputed.params, first.params);
		const young = table.resolveParameters("kept", "model-512", inputs);
		assert.strictEqual(table.resolveParameters("kept", "model-512", inputs), young, "younger entries survive");

		// prune keeps listed servers and drops the rest.
		const dropped = table.resolveParameters("dropped", "m", inputs);
		table.prune(["kept"]);
		assert.notStrictEqual(table.resolveParameters("dropped", "m", inputs), dropped, "a pruned server recomputes");
		assert.strictEqual(table.resolveParameters("kept", "model-512", inputs), young, "a kept server's memo survives");
		table.clear();
		assert.notStrictEqual(table.resolveParameters("kept", "model-512", inputs), young, "clear drops everything");
	});

	test("a catalog whose data swaps behind a stable facade still invalidates the cached capabilities", () => {
		// The real store keeps one lookup object and replaces its inner
		// snapshot on refresh, so the table must judge the catalog by its
		// ANSWERS, never by object identity.
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
