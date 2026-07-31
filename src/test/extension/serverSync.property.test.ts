import * as assert from "node:assert";
import * as fc from "fast-check";
import type { StoredServerSecrets } from "../../extension/serverSync";
import { acceptedEntry, buildGroupArgs, parseServersSetting } from "../../extension/serverSync";
import { OPTIONAL_ENTRY_FIELDS, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { isRecord, isUnsafeRecordKey } from "../../shared/util/json";
import { resolveFuzzSeed } from "../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

/**
 * The servers setting is user-authored JSON that decides which provider
 * groups exist and where credentials land, so its acceptance rules get
 * property coverage: parsing is total, labels are unique first-wins and never
 * reserved, acceptedEntry resolves exactly what parseServersSetting accepted
 * (the dashboard's per-entry reads and writes depend on that agreement), and
 * buildGroupArgs emits its keys in the frozen descriptor order the persisted
 * sync fingerprints hash.
 */

/** Mirror of the parser's usable-text rule, for the small acceptance oracle below. */
function usable(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const labelPool = ["alpha", "beta", "gamma", "delta"] as const;

/** Label-ish values: usable (some shared to force duplicates), padded, empty, reserved, non-string. */
const labelArb = fc.oneof(
	fc.constantFrom(...labelPool),
	fc.constantFrom(...labelPool).map((label) => `  ${label}\t`),
	fc.constantFrom("", "   ", "__proto__", "constructor", "prototype"),
	fc.integer(),
	fc.constant(undefined)
);

const baseUrlArb = fc.oneof(
	fc.constantFrom("http://one.test", "http://two.test", " http://padded.test "),
	fc.constantFrom("", "  "),
	fc.constant(undefined),
	fc.integer()
);

const fieldIds = OPTIONAL_ENTRY_FIELDS.map((field) => field.id);

const optionalFieldsArb = fc.dictionary(
	fc.constantFrom(...fieldIds),
	fc.oneof(fc.constantFrom("value", " padded ", "", "  "), fc.integer(), fc.constant(null)),
	{ maxKeys: 4 }
);

/** One raw settings element: a plausible record, or outright junk. */
const rawElementArb = fc.oneof(
	{
		weight: 4,
		arbitrary: fc
			.tuple(labelArb, baseUrlArb, optionalFieldsArb)
			.map(([label, baseUrl, fields]) => ({ ...fields, label, baseUrl })),
	},
	{ weight: 1, arbitrary: fc.jsonValue({ maxDepth: 1 }) }
);

const rawSettingArb = fc.array(rawElementArb, { maxLength: 8 });

/** The documented acceptance rule, restated independently of the implementation. */
function isAcceptableAt(raw: readonly unknown[], index: number, seen: ReadonlySet<string>): string | undefined {
	const item = raw[index];
	if (!isRecord(item)) {
		return undefined;
	}
	const label = usable(item.label);
	if (label === undefined || usable(item.baseUrl) === undefined || isUnsafeRecordKey(label) || seen.has(label)) {
		return undefined;
	}
	return label;
}

suite("extension/serverSync parsing properties", () => {
	test("parseServersSetting is total; non-arrays yield no entries and one problem", () => {
		fc.assert(
			fc.property(fc.oneof(fc.jsonValue(), fc.anything()), (raw) => {
				const { entries, problems } = parseServersSetting(raw);
				assert.ok(Array.isArray(entries));
				if (raw === undefined || raw === null) {
					assert.deepStrictEqual(entries, []);
					assert.deepStrictEqual(problems, []);
				} else if (!Array.isArray(raw)) {
					assert.deepStrictEqual(entries, []);
					assert.strictEqual(problems.length, 1);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("every element is accepted or reported, labels are unique first-wins and never reserved", () => {
		fc.assert(
			fc.property(rawSettingArb, (raw) => {
				const { entries, problems } = parseServersSetting(raw);
				assert.strictEqual(entries.length + problems.length, raw.length, "each element accepts or reports once");

				const seen = new Set<string>();
				const expectedLabels: string[] = [];
				for (let index = 0; index < raw.length; index += 1) {
					const label = isAcceptableAt(raw, index, seen);
					if (label !== undefined) {
						seen.add(label);
						expectedLabels.push(label);
					}
				}
				assert.deepStrictEqual(
					entries.map((entry) => entry.label),
					expectedLabels,
					"accepted labels follow the documented first-wins rule in raw order"
				);
				for (const entry of entries) {
					assert.ok(!isUnsafeRecordKey(entry.label), "reserved labels never pass");
					for (const value of Object.values(entry)) {
						assert.strictEqual(typeof value, "string");
						assert.strictEqual(value, (value as string).trim(), "accepted fields are trimmed");
						assert.ok((value as string).length > 0, "accepted fields are non-empty");
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("acceptedEntry agrees with parseServersSetting label for label", () => {
		fc.assert(
			fc.property(rawSettingArb, fc.constantFrom(...labelPool, "never-declared", "__proto__"), (raw, probe) => {
				const { entries } = parseServersSetting(raw);
				for (const entry of entries) {
					const resolved = acceptedEntry(raw, entry.label);
					assert.ok(resolved !== undefined, `accepted label "${entry.label}" must resolve`);
					assert.deepStrictEqual(resolved.entry, entry, "acceptedEntry returns the parsed view of the same entry");
					const rawItem = raw[resolved.index];
					assert.ok(
						isRecord(rawItem) && usable(rawItem.label) === entry.label,
						"the index points at the accepted raw entry"
					);
				}
				const acceptedLabels = new Set(entries.map((entry) => entry.label));
				if (!acceptedLabels.has(probe)) {
					assert.strictEqual(acceptedEntry(raw, probe), undefined, "labels the parser rejected resolve to nothing");
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a rejected same-label sibling earlier in the array never shadows the accepted entry", () => {
		fc.assert(
			fc.property(fc.constantFrom(...labelPool), optionalFieldsArb, (label, fields) => {
				const rejected = { label }; // no baseUrl: parseServersSetting reports it
				const accepted = { ...fields, label, baseUrl: "http://real.test" };
				const raw = [rejected, accepted];
				const resolved = acceptedEntry(raw, label);
				assert.ok(resolved !== undefined);
				assert.strictEqual(resolved.index, 1, "the accepted entry, not the rejected sibling, resolves");
				assert.strictEqual(resolved.entry.baseUrl, "http://real.test");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

suite("extension/serverSync buildGroupArgs properties", () => {
	const entryRecordArb = fc
		.tuple(fc.constantFrom(...labelPool), optionalFieldsArb)
		.map(([label, fields]) => ({ ...fields, label, baseUrl: "http://args.test" }));

	const storedArb: fc.Arbitrary<StoredServerSecrets> = fc.dictionary(
		fc.constantFrom(...SECRET_FIELD_IDS),
		fc.constantFrom("stored-secret", "other-stored"),
		{ maxKeys: 3 }
	) as fc.Arbitrary<StoredServerSecrets>;

	test("args keys ride in the frozen descriptor order; raw key order never matters", () => {
		fc.assert(
			fc.property(
				entryRecordArb,
				storedArb,
				fc.array(fc.nat(), { minLength: 8, maxLength: 8 }),
				(record, stored, shuffleSeed) => {
					const [entry] = parseServersSetting([record]).entries;
					fc.pre(entry !== undefined);

					const args = buildGroupArgs(entry, stored);
					const canonical = ["name", "vendor", "baseUrl", "label", ...fieldIds];
					const expectedKeys = canonical.filter((key) => key in args);
					assert.deepStrictEqual(
						Object.keys(args),
						expectedKeys,
						"the persisted fingerprint hashes this order; it must not depend on input shape"
					);

					// The same logical record with its keys inserted in another order
					// must produce the byte-identical fingerprint payload.
					const keys = Object.keys(record);
					const reordered: Record<string, unknown> = {};
					keys
						.map((key, index) => ({ key, rank: shuffleSeed[index % shuffleSeed.length] ?? 0 }))
						.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key))
						.forEach(({ key }) => {
							reordered[key] = (record as Record<string, unknown>)[key];
						});
					const [reparsed] = parseServersSetting([reordered]).entries;
					fc.pre(reparsed !== undefined);
					assert.strictEqual(JSON.stringify(buildGroupArgs(reparsed, stored)), JSON.stringify(args));
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("inline secret values outrank the stored blob; fields absent from both stay absent", () => {
		fc.assert(
			fc.property(entryRecordArb, storedArb, (record, stored) => {
				const [entry] = parseServersSetting([record]).entries;
				fc.pre(entry !== undefined);
				const args = buildGroupArgs(entry, stored);
				for (const field of OPTIONAL_ENTRY_FIELDS) {
					const inline: string | undefined = entry[field.id];
					const storedValue: string | undefined = field.secret ? stored[field.id] : undefined;
					const expected: string | undefined = field.secret ? (inline ?? storedValue) : inline;
					assert.strictEqual(args[field.id], expected, `${field.id} must resolve inline-first`);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
