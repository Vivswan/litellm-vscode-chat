/**
 * The settings-redesign migration fuzzer: random old-world configurations run
 * through the pure pipeline, with three invariants:
 *
 *  (a) idempotent rerun: re-planning the migrated snapshot writes nothing;
 *  (b) write discipline: value writes land only on new-name ids (plus
 *      `servers`), deletions only on legacy ids, and never a workspace scope
 *      (the plan carries no scope at all);
 *  (c) lossless behavior equivalence: the FROZEN pre-redesign resolvers over
 *      the old snapshot agree with the LIVE resolvers over the migrated one,
 *      resolver-level views and the full capability walk (trio included)
 *      alike. See settingsRedesignOracle.ts for the documented divergence
 *      corners the property skips (each pinned deterministically below).
 *
 * Seed-pinned and FUZZ_RUNS-scaled like every property suite; failures pin
 * into MIGRATION_FUZZ_CORPUS (src/test/fuzzCorpus.ts) and replay first.
 */

import * as assert from "node:assert";
import * as fc from "fast-check";
import { isValidCapabilityField } from "../../../extension/migrations/settingsRedesign/legacyIds";
import { mergeTokenDefaults } from "../../../extension/migrations/settingsRedesign/tokenDefaults";
import { planSettingsRedesign } from "../../../extension/migrations/settingsRedesign/transform";
import type { SettingsSnapshot } from "../../../extension/migrations/settingsRedesign/types";
import { isRecord } from "../../../shared/util/json";
import { normalizePositiveNumber } from "../../../shared/util/numbers";
import { MIGRATION_FUZZ_CORPUS } from "../../fuzzCorpus";
import { resolveFuzzSeed } from "../../fuzzStream";
import { expectDefined } from "../../pureHelpers";
import { resolveOldModelCapabilities } from "./oldWorldResolvers";
import {
	acceptedServers,
	applyPlanToSnapshot,
	type EffectiveView,
	resolveNewWorldReference,
	resolveOldWorld,
	WALK_BASELINES,
	wireMaxTokens,
} from "./settingsRedesignOracle";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 120;
const SEED = resolveFuzzSeed();

// The id families, re-declared as literals so the discipline invariant pins the
// writes against the docs' rename table, not against the migration's own constants.
const LEGACY_IDS = [
	"requestTimeout",
	"promptCaching.enabled",
	"discoveryTimeout",
	"discoveryCacheTtl",
	"modelParameters",
	"modelCapabilities",
	"openRouterCatalog.enabled",
	"maskApiKeyInput",
	"headers",
	"defaultContextLength",
	"defaultMaxInputTokens",
	"defaultMaxOutputTokens",
];
const NEW_IDS = [
	"chat.timeout",
	"chat.promptCaching",
	"discovery.timeout",
	"discovery.cacheTtl",
	"models.parameters",
	"models.capabilities",
	"models.openRouterCatalog",
	"ui.maskSecretInputs",
];

const maybe = <T>(arbitrary: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(arbitrary, { nil: undefined });

const BASES = ["https://gw", "https://gw/v1", "http://localhost:4000"];
// "gpt*" keeps the star-bearing key rewrite (escaped-regex migration) alive.
const MODEL_PREFIXES = ["", "*", "gpt", "gpt*", "gpt-5", "gpt-5-turbo", "claude", "deepseek-r1", "v1/gpt", "other"];

const modelIdArb = fc.constantFrom(
	"gpt-5",
	"gpt-5-turbo",
	"gpt-5.7",
	"claude-4",
	"deepseek-r1",
	"qwen",
	"v1/gpt-mini",
	"gpt",
	// A literal-star ID: only the star-bearing keys' regex form may match it.
	"gpt*5",
	"other-model"
);

const paramRecordArb = fc
	.dictionary(
		// max_tokens keeps the migrated-_force rewrite ruling alive: old _force
		// could never cover it, so the migration must not let it become forced.
		fc.constantFrom("temperature", "top_p", "seed", "user", "max_tokens"),
		fc.oneof(fc.integer({ min: -3, max: 3 }), fc.boolean(), fc.constantFrom("x", "y")),
		{ maxKeys: 3 }
	)
	.chain((fields) =>
		fc.oneof(
			{ arbitrary: fc.constant(fields), weight: 3 },
			{ arbitrary: fc.subarray(Object.keys(fields)).map((list) => ({ ...fields, _force: list })), weight: 1 },
			{ arbitrary: fc.constant({ ...fields, _force: true }), weight: 1 },
			// Junk directive values behave as absent at value level; generated so
			// the migration's stays-as-written branch is equivalence-covered.
			{ arbitrary: fc.constantFrom({ ...fields, _force: false }, { ...fields, _force: "junk" }), weight: 1 }
		)
	);

const capRecordArb = fc
	.tuple(
		fc.dictionary(
			fc.constantFrom("context_length", "max_input_tokens", "max_output_tokens"),
			fc.integer({ min: 1, max: 1000000 }),
			{ maxKeys: 2 }
		),
		fc.dictionary(fc.constantFrom("supports_vision", "supports_reasoning", "supports_function_calling"), fc.boolean(), {
			maxKeys: 2,
		})
	)
	.map(([numbers, booleans]) => ({ ...numbers, ...booleans }))
	.chain((fields) =>
		// `_declare` and `_fallback` combine freely, the old ban's home ground
		// included, so the oracle characterizes the retired ban. Junk directive
		// values cover the migration's stays-as-written branches.
		fc
			.tuple(
				fc.option(
					fc.oneof(
						{ arbitrary: fc.constant<unknown>(true), weight: 2 },
						{ arbitrary: fc.subarray(Object.keys(fields)), weight: 2 },
						{ arbitrary: fc.constantFrom<unknown>(false, "junk"), weight: 1 }
					),
					{ nil: undefined }
				),
				fc.option(fc.constantFrom<unknown>(true, false, "junk"), { nil: undefined })
			)
			.map(([fallback, declare]) => ({
				...fields,
				...(fallback !== undefined ? { _fallback: fallback } : {}),
				...(declare !== undefined ? { _declare: declare } : {}),
			}))
	);

const unscopedKeyArb = fc.constantFrom(...MODEL_PREFIXES);
const scopedKeyArb = fc
	.tuple(fc.constantFrom(...BASES, "https://unmatched.example.com"), fc.constantFrom(...MODEL_PREFIXES))
	.map(([base, prefix]) => `${base}/${prefix}`);
const globalKeyArb = fc.oneof({ arbitrary: unscopedKeyArb, weight: 3 }, { arbitrary: scopedKeyArb, weight: 2 });

/** Drop undefined values so optional pieces stay absent instead of explicit. */
function prune(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

// Every flat auth combination, the settled apiKey+virtualKey primacy ruling
// included, plus virtual-key headers colliding with the extension-managed
// Authorization / X-API-Key names.
const authComboArb = fc.constantFrom<Record<string, unknown>>(
	{},
	{ apiKey: "sk-1" },
	{ virtualKeyHeader: "x-litellm-key", virtualKeyValue: "vk-1" },
	{ virtualKeyHeader: "x-litellm-key" },
	{ virtualKeyValue: "vk-2" },
	{ apiKey: "sk-2", virtualKeyHeader: "x-litellm-key", virtualKeyValue: "vk-3" },
	{ apiKey: "sk-3", virtualKeyHeader: "Authorization", virtualKeyValue: "vk-4" },
	{ apiKey: "sk-4", virtualKeyHeader: "X-API-Key", virtualKeyValue: "vk-5" },
	{ oauthTokenUrl: "https://idp.example.com/token", oauthClientId: "cid" },
	{
		oauthTokenUrl: "https://idp.example.com/token",
		oauthClientId: "cid",
		oauthClientSecret: "cs",
		oauthScopes: "read write",
	},
	{ oauthClientId: "cid" },
	{
		oauthTokenUrl: "https://idp.example.com/token",
		oauthClientId: "cid",
		apiKey: "sk-5",
		virtualKeyHeader: "x-two",
		virtualKeyValue: "vk-6",
	}
);

const entryArb = (label: string): fc.Arbitrary<Record<string, unknown>> =>
	fc
		.tuple(
			fc.tuple(fc.constantFrom(...BASES), fc.boolean()).map(([base, slash]) => (slash ? `${base}/` : base)),
			authComboArb,
			maybe(fc.dictionary(unscopedKeyArb, paramRecordArb, { maxKeys: 2 })),
			maybe(fc.dictionary(unscopedKeyArb, capRecordArb, { maxKeys: 2 })),
			maybe(fc.constantFrom(["modelInfo"], ["modelListing", "modelInfo"], ["bogus"])),
			// A hand-mixed entry already carrying the NEW discovery field: moved
			// `_declare` IDs must MERGE into the existing list (existing first, deduped).
			maybe(fc.constantFrom({ declared: ["pre-declared"] }, { declared: ["gpt-5", "pre-declared"] }))
		)
		.map(([baseUrl, auth, modelParameters, modelCapabilities, expectedFailures, discovery]) =>
			prune({ label, baseUrl, ...auth, modelParameters, modelCapabilities, expectedFailures, discovery })
		);

const serversArb = (minEntries: number): fc.Arbitrary<Record<string, unknown>[]> =>
	fc.subarray(["prod", "dev", "local"], { minLength: minEntries }).chain((labels) => {
		if (labels.length === 0) {
			return fc.constant([]);
		}
		return fc.tuple(...labels.map((label) => entryArb(label))).map((entries) => [...entries]);
	});

function snapshotArb(minEntries: number): fc.Arbitrary<SettingsSnapshot> {
	return fc
		.record({
			servers: maybe(serversArb(minEntries)),
			modelParameters: maybe(fc.dictionary(globalKeyArb, paramRecordArb, { maxKeys: 4 })),
			modelCapabilities: maybe(fc.dictionary(globalKeyArb, capRecordArb, { maxKeys: 4 })),
			headers: maybe(fc.dictionary(fc.constantFrom("x-env", "X-Trace", "x-team"), fc.constantFrom("a", "b"))),
			requestTimeout: maybe(fc.integer({ min: -10, max: 900000 })),
			"promptCaching.enabled": maybe(fc.boolean()),
			discoveryTimeout: maybe(fc.integer({ min: 0, max: 60000 })),
			discoveryCacheTtl: maybe(fc.integer({ min: -1, max: 100000 })),
			"openRouterCatalog.enabled": maybe(fc.boolean()),
			maskApiKeyInput: maybe(fc.boolean()),
			defaultContextLength: maybe(fc.integer({ min: 1, max: 400000 })),
			defaultMaxInputTokens: maybe(fc.integer({ min: 1, max: 400000 })),
			defaultMaxOutputTokens: maybe(fc.integer({ min: 1, max: 400000 })),
			// Workspace-layer noise on a few legacy ids, so the count-and-leave
			// rule is exercised on this tier too, not only under junk configs.
			workspaceNoiseIds: fc.subarray(["requestTimeout", "modelParameters", "headers", "defaultContextLength"]),
		})
		.map(({ workspaceNoiseIds, ...values }) => {
			const sections: Record<string, { globalValue?: unknown; workspaceValue?: unknown }> = {};
			// minEntries > 0 asks for a snapshot the equivalence oracle can
			// sample a server from, so the optional servers section is forced.
			for (const [id, value] of Object.entries(values)) {
				if (value !== undefined) {
					sections[id] = { globalValue: value };
				}
			}
			for (const id of workspaceNoiseIds) {
				sections[id] = { ...sections[id], workspaceValue: { noise: true } };
			}
			if (minEntries > 0 && sections.servers === undefined) {
				sections.servers = { globalValue: [{ label: "prod", baseUrl: "https://gw" }] };
			}
			return sections;
		});
}

/** Junk-heavy tier: arbitrary JSON at every id (new names and race states included), plus workspace layers. */
const junkSnapshotArb: fc.Arbitrary<SettingsSnapshot> = fc.dictionary(
	fc.constantFrom(...LEGACY_IDS, ...NEW_IDS, "servers"),
	fc
		.record(
			{
				globalValue: fc.jsonValue({ maxDepth: 2 }),
				workspaceValue: fc.jsonValue({ maxDepth: 1 }),
				workspaceFolderValue: fc.jsonValue({ maxDepth: 1 }),
			},
			{ requiredKeys: [] }
		)
		.filter((layers) => Object.keys(layers).length > 0),
	{ maxKeys: 6 }
);

function assertIdempotent(snapshot: SettingsSnapshot): void {
	const plan = planSettingsRedesign(snapshot);
	const migrated = applyPlanToSnapshot(snapshot, plan.writes);
	const rerun = planSettingsRedesign(migrated);
	assert.deepStrictEqual(rerun.writes, [], "re-planning the migrated snapshot must write nothing");
	assert.strictEqual(rerun.parkedHeaders, undefined, "a rerun never parks again");
}

function assertWriteDiscipline(snapshot: SettingsSnapshot): void {
	const plan = planSettingsRedesign(snapshot);
	for (const write of plan.writes) {
		if (write.value === undefined) {
			assert.ok(LEGACY_IDS.includes(write.section), `deletions may target legacy ids only, got ${write.section}`);
		} else {
			assert.ok(
				NEW_IDS.includes(write.section) || write.section === "servers",
				`value writes may target new ids or servers only, got ${write.section}`
			);
		}
	}
	// The headers parking contract: parked exactly when a value that really
	// carried headers is deleted, byte-identical to what the deletion consumes,
	// with at most one delete and never a value write.
	const headersWrites = plan.writes.filter((write) => write.section === "headers");
	assert.ok(headersWrites.length <= 1, "at most one headers write");
	assert.ok(
		headersWrites.every((write) => write.value === undefined),
		"the only legal headers write is the deletion"
	);
	const headersValue = snapshot.headers?.globalValue;
	const carriedHeaders = isRecord(headersValue) && Object.keys(headersValue).length > 0;
	if (headersWrites.length === 1 && carriedHeaders) {
		assert.deepStrictEqual(plan.parkedHeaders, headersValue, "the parked value is the deleted one");
	} else {
		assert.strictEqual(plan.parkedHeaders, undefined, "only a value that carried headers parks");
	}
	// The plan carries no scope: workspace layers survive application verbatim.
	const migrated = applyPlanToSnapshot(snapshot, plan.writes);
	for (const [id, layers] of Object.entries(snapshot)) {
		assert.deepStrictEqual(migrated[id]?.workspaceValue, layers.workspaceValue, `${id} workspace layer`);
		assert.deepStrictEqual(
			migrated[id]?.workspaceFolderValue,
			layers.workspaceFolderValue,
			`${id} workspace-folder layer`
		);
	}
}

suite("extension/migrations/settingsRedesign: fuzz", () => {
	test("corpus entries hold every invariant", () => {
		for (const entry of MIGRATION_FUZZ_CORPUS) {
			assertIdempotent(entry.snapshot);
			assertWriteDiscipline(entry.snapshot);
		}
	});

	test("idempotent rerun over random old-world configurations", () => {
		fc.assert(fc.property(snapshotArb(0), assertIdempotent), { numRuns: NUM_RUNS, seed: SEED });
	});

	test("write discipline over random old-world configurations", () => {
		fc.assert(fc.property(snapshotArb(0), assertWriteDiscipline), { numRuns: NUM_RUNS, seed: SEED });
	});

	test("junk-heavy configurations stay idempotent and disciplined", () => {
		fc.assert(
			fc.property(junkSnapshotArb, (snapshot) => {
				assertIdempotent(snapshot);
				assertWriteDiscipline(snapshot);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("trio placement rules hold for random trio values against random '*' record shapes", () => {
		// The equivalence property strips the trio, so this pins the merge's
		// PLACEMENT rules directly: fills land at each removed setting's level, the
		// override fill is never demoted, every fill is inheritable, user fields keep
		// value and level, and accounting covers every source.
		const trioValueArb = maybe(
			fc.oneof(fc.integer({ min: 1, max: 400000 }), fc.constantFrom<unknown>(0, -5, 0.5, "junk", null))
		);
		const listArb = fc.subarray([
			"context_length",
			"max_input_tokens",
			"max_output_tokens",
			"supports_vision",
			"bogus",
		]);
		const directiveArb = fc.oneof(fc.constantFrom<unknown>(undefined, true, false, "garbage"), listArb);
		const catchAllArb = maybe(
			fc
				.tuple(
					fc.dictionary(
						fc.constantFrom("context_length", "max_input_tokens", "max_output_tokens"),
						// Junk values exercise the expansion's validity filter: a field the
						// old parser refused was never marked and must not become marked.
						fc.oneof(fc.integer({ min: 1, max: 1000000 }), fc.constantFrom<unknown>(0, -1, 1.5, "junk")),
						{ maxKeys: 2 }
					),
					fc.dictionary(fc.constant("supports_vision"), fc.oneof(fc.boolean(), fc.constant("junk")), {
						maxKeys: 1,
					}),
					directiveArb,
					directiveArb
				)
				.map(([numbers, booleans, fallback, inheritable]) => {
					const record: Record<string, unknown> = { ...numbers, ...booleans };
					if (fallback !== undefined) {
						record._fallback = fallback;
					}
					if (inheritable !== undefined) {
						record._inheritable = inheritable;
					}
					return record;
				})
		);
		fc.assert(
			fc.property(
				fc.record({ context: trioValueArb, input: trioValueArb, output: trioValueArb, catchAll: catchAllArb }),
				({ context, input, output, catchAll }) => {
					const snapshot: SettingsSnapshot = {
						...(context !== undefined ? { defaultContextLength: { globalValue: context } } : {}),
						...(input !== undefined ? { defaultMaxInputTokens: { globalValue: input } } : {}),
						...(output !== undefined ? { defaultMaxOutputTokens: { globalValue: output } } : {}),
					};
					const capabilities = catchAll !== undefined ? { "*": catchAll } : undefined;
					const merge = mergeTokenDefaults(capabilities, snapshot);
					const configured = [context, input, output].filter((value) => value !== undefined).length;

					if (configured === 0) {
						assert.deepStrictEqual(merge, { consumedIds: [], movedFields: 0, drainedKeys: 0, blockedValues: 0 });
						return;
					}
					if (catchAll !== undefined && (catchAll._fallback === "garbage" || catchAll._inheritable === "garbage")) {
						assert.strictEqual(merge.blockedValues, configured, "an unmergeable record blocks every source");
						assert.strictEqual(merge.capabilitiesValue, undefined);
						assert.deepStrictEqual(merge.consumedIds, []);
						return;
					}
					assert.strictEqual(merge.consumedIds.length, configured, "every configured source is consumed");
					assert.strictEqual(
						merge.movedFields + merge.drainedKeys,
						configured,
						"moved plus drained covers every source"
					);

					const record = (merge.capabilitiesValue?.["*"] ?? catchAll ?? {}) as Record<string, unknown>;
					const fallbackMarked = (field: string): boolean =>
						record._fallback === true || (Array.isArray(record._fallback) && record._fallback.includes(field));
					const inheritableMarked = (field: string): boolean =>
						record._inheritable === true || (Array.isArray(record._inheritable) && record._inheritable.includes(field));

					const sources = [
						{ value: context, field: "context_length", placement: "fallback" },
						{ value: input, field: "max_input_tokens", placement: "override" },
						{ value: output, field: "max_output_tokens", placement: "fallback" },
					] as const;
					for (const source of sources) {
						if (source.value === undefined) {
							continue;
						}
						const honored = normalizePositiveNumber(source.value);
						if (catchAll !== undefined && Object.hasOwn(catchAll, source.field)) {
							assert.strictEqual(record[source.field], catchAll[source.field], "user fields keep their values");
							// Level preservation only matters for a field the old parser
							// accepted: an invalidly-typed field was dropped and never marked.
							if (isValidCapabilityField(source.field, catchAll[source.field])) {
								const markedBefore =
									catchAll._fallback === true ||
									(Array.isArray(catchAll._fallback) && catchAll._fallback.includes(source.field));
								assert.strictEqual(fallbackMarked(source.field), markedBefore, "a user field's level never changes");
							}
							continue;
						}
						if (honored === undefined) {
							assert.strictEqual(Object.hasOwn(record, source.field), false, "unhonored values never fill");
							continue;
						}
						assert.strictEqual(record[source.field], honored, "the fill carries the configured value");
						if (source.placement === "override") {
							assert.strictEqual(fallbackMarked(source.field), false, "the override fill must never land demoted");
						} else {
							assert.strictEqual(fallbackMarked(source.field), true, "fallback fills land below the server report");
						}
						assert.strictEqual(inheritableMarked(source.field), true, "every fill is inheritable");
					}

					const again = mergeTokenDefaults(merge.capabilitiesValue ?? capabilities, snapshot);
					assert.strictEqual(again.movedFields, 0, "a re-merge against the merged record is drain-only");
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("lossless equivalence: old resolvers on the old world == the live resolvers on the migrated world", () => {
		fc.assert(
			fc.property(snapshotArb(1), fc.nat(), modelIdArb, (snapshot, pick, modelId) => {
				const servers = acceptedServers(snapshot.servers?.globalValue);
				fc.pre(servers.length > 0);
				const server = servers[pick % servers.length];
				fc.pre(server !== undefined);
				const old = resolveOldWorld(snapshot, server as { label: string; baseUrl: string }, modelId);
				fc.pre(!old.skipEquivalence);

				// The resolver-level views compare trio-free: the old trio lived BELOW
				// the resolver, so the migrated "*" fills would otherwise surface as new
				// fallback fields. The old projection is trio-independent either way.
				const {
					defaultContextLength: _context,
					defaultMaxInputTokens: _input,
					defaultMaxOutputTokens: _output,
					...noTrio
				} = snapshot;
				const migratedNoTrio = applyPlanToSnapshot(noTrio, planSettingsRedesign(noTrio).writes);
				const projectedNoTrio = resolveNewWorldReference(
					migratedNoTrio,
					server as { label: string; baseUrl: string },
					modelId
				);
				const resolverView = (view: EffectiveView) => ({
					parameters: view.parameters,
					forced: view.forced,
					capabilityOverrides: view.capabilityOverrides,
					capabilityFallbacks: view.capabilityFallbacks,
					declared: view.declared,
				});
				assert.deepStrictEqual(resolverView(projectedNoTrio), resolverView(old));

				// The retired `_declare`+`_fallback` ban, characterized: the comparison
				// above ran BAN-FREE, so every field the real old ban rescued to override
				// level must still resolve in the migrated world.
				for (const field of old.banRescuedFields) {
					assert.ok(
						Object.hasOwn(projectedNoTrio.capabilityFallbacks, field) ||
							Object.hasOwn(projectedNoTrio.capabilityOverrides, field),
						`ban-rescued ${field} must still resolve in the migrated world`
					);
				}

				// The walk-level views compare WITH the trio: the fills must reproduce
				// the old default-setting behavior end to end. The trio-flow corners skip
				// only this comparison; the resolver views above stay live.
				if (!old.skipWalks) {
					const migrated = applyPlanToSnapshot(snapshot, planSettingsRedesign(snapshot).writes);
					const projected = resolveNewWorldReference(migrated, server as { label: string; baseUrl: string }, modelId);
					assert.deepStrictEqual(
						projected.walks.map((walk) => walk.fields),
						old.walks.map((walk) => walk.fields)
					);
					// The wire rule (min(4096, limit) exactly under "defaults"), per baseline:
					// provenance either agrees - identical wire max_tokens - or moves
					// "defaults" -> "user" through the ONE documented lift, the explicitly
					// configured defaultMaxOutputTokens whose migrated fill counts user-set.
					for (const [index, oldWalk] of old.walks.entries()) {
						const newWalk = projected.walks[index];
						assert.ok(newWalk !== undefined);
						if (newWalk.outputLimitSource === oldWalk.outputLimitSource) {
							assert.strictEqual(wireMaxTokens(newWalk), wireMaxTokens(oldWalk), `baseline ${index} wire max_tokens`);
						} else {
							assert.strictEqual(oldWalk.outputLimitSource, "defaults", `baseline ${index}: only the lift may differ`);
							assert.strictEqual(newWalk.outputLimitSource, "user", `baseline ${index}: only the lift may differ`);
							assert.ok(old.expectsOutputClampLift, `baseline ${index}: a lift needs a configured trio output`);
							assert.strictEqual(wireMaxTokens(newWalk), newWalk.fields.max_output_tokens as number);
							assert.strictEqual(wireMaxTokens(oldWalk), Math.min(4096, oldWalk.fields.max_output_tokens as number));
						}
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED, maxSkipsPerRun: 400 }
		);
	});
});

suite("extension/migrations/settingsRedesign: documented divergence pins", () => {
	// The corners the equivalence property skips, pinned deterministically so
	// the accepted behavior change is visible and reviewed, not accidental.

	test("a scoped record no longer replaces the unscoped global record wholesale", () => {
		const snapshot: SettingsSnapshot = {
			servers: { globalValue: [{ label: "prod", baseUrl: "https://gw" }] },
			modelParameters: {
				globalValue: {
					gpt: { top_p: 1 },
					"https://gw/gpt": { temperature: 0 },
				},
			},
		};
		const server = { label: "prod", baseUrl: "https://gw" };
		const old = resolveOldWorld(snapshot, server, "gpt-5");
		assert.deepStrictEqual(old.parameters, { temperature: 0 }, "old: the scoped record replaced unscoped WHOLE");

		const plan = planSettingsRedesign(snapshot);
		const migrated = applyPlanToSnapshot(snapshot, plan.writes);
		const projected = resolveNewWorldReference(migrated, server, "gpt-5");
		assert.deepStrictEqual(
			projected.parameters,
			{ top_p: 1, temperature: 0 },
			"new: the moved record sits at entry level and merges over the global record field by field"
		);
	});

	test("an entry key and a moved scoped key under DIFFERENT keys compete within one level", () => {
		const snapshot: SettingsSnapshot = {
			servers: {
				globalValue: [{ label: "prod", baseUrl: "https://gw", modelParameters: { gpt: { top_p: 1 } } }],
			},
			modelParameters: { globalValue: { "https://gw/gpt-5": { seed: 2 } } },
		};
		const server = { label: "prod", baseUrl: "https://gw" };
		const old = resolveOldWorld(snapshot, server, "gpt-5");
		assert.deepStrictEqual(old.parameters, { seed: 2, top_p: 1 }, "old: entry merged over the scoped record");

		const plan = planSettingsRedesign(snapshot);
		const migrated = applyPlanToSnapshot(snapshot, plan.writes);
		const projected = resolveNewWorldReference(migrated, server, "gpt-5");
		assert.deepStrictEqual(
			projected.parameters,
			{ seed: 2 },
			"new: both records live in the entry level and the more specific one wins wholesale"
		);
	});

	test("a scoped record forcing a field the entry overrides unforced: the entry value now wins", () => {
		// The one residual of the old "a scoped-forced field beats an unforced entry
		// value" refinement: re-pointing the scoped `_force` would force a value the
		// user never asked to force, so the mark drops and the entry's value stands.
		const snapshot: SettingsSnapshot = {
			servers: {
				globalValue: [{ label: "prod", baseUrl: "https://gw", modelParameters: { "gpt-5": { temperature: 1 } } }],
			},
			modelParameters: { globalValue: { "https://gw/gpt-5": { temperature: 0, _force: ["temperature"] } } },
		};
		const server = { label: "prod", baseUrl: "https://gw" };
		const old = resolveOldWorld(snapshot, server, "gpt-5");
		assert.deepStrictEqual(old.parameters, { temperature: 0 }, "old: the scoped _force beat the entry value");
		assert.deepStrictEqual(old.forced, { temperature: 0 });

		const plan = planSettingsRedesign(snapshot);
		const migrated = applyPlanToSnapshot(snapshot, plan.writes);
		const projected = resolveNewWorldReference(migrated, server, "gpt-5");
		assert.deepStrictEqual(projected.parameters, { temperature: 1 }, "new: the entry's own value stands");
		assert.deepStrictEqual(projected.forced, {}, "the scoped mark is dropped, never re-pointed");
	});

	test("the defaultMaxInputTokens quirk cannot pass a global record that fallback-marks max_input_tokens", () => {
		// Old: the trio's max_input slot sat ABOVE the server report and the fallback
		// candidates. New: the migrated "*" fill does not flow past a record that sets
		// the field, so the server report wins. The equivalence property skips this
		// walk corner (the oracle's trioFlowDiverges), pinned here instead.
		const snapshot: SettingsSnapshot = {
			servers: { globalValue: [{ label: "prod", baseUrl: "https://gw" }] },
			defaultMaxInputTokens: { globalValue: 111000 },
			modelCapabilities: { globalValue: { "gpt-5": { max_input_tokens: 50000, _fallback: ["max_input_tokens"] } } },
		};
		const server = { label: "prod", baseUrl: "https://gw" };
		const serverReported = WALK_BASELINES[2];
		assert.ok(serverReported !== undefined && serverReported.kind === "discovered");
		const old = resolveOldWorld(snapshot, server, "gpt-5");
		assert.strictEqual(old.skipWalks, true, "the oracle skips exactly this walk corner");
		assert.strictEqual(old.skipEquivalence, false, "the resolver-level comparison stays live");
		assert.strictEqual(old.walks[2]?.fields.max_input_tokens, 111000, "old: the quirk beat the server report");

		const plan = planSettingsRedesign(snapshot);
		const migrated = applyPlanToSnapshot(snapshot, plan.writes);
		const projected = resolveNewWorldReference(migrated, server, "gpt-5");
		assert.strictEqual(
			projected.walks[2]?.fields.max_input_tokens,
			serverReported.values.max_input_tokens,
			"new: the server report wins where the record sets the field"
		);
	});

	test("DOCUMENTED DIVERGENCE: the retired _declare+_fallback ban - fallback now fills on declared models", () => {
		// INTENTIONAL (user-approved source-invariance of capability records). Old
		// world: a record whose `_declare` created the resolved model had its
		// `_fallback` IGNORED, so context_length 5000 stayed an OVERRIDE and beat a
		// server report of 100000. New world: `_declare` moves to discovery.declared,
		// the `_fallback` stands, and the fill applies only where the server is silent.
		const snapshot: SettingsSnapshot = {
			servers: {
				globalValue: [
					{
						label: "prod",
						baseUrl: "https://gw",
						modelCapabilities: { "deepseek-r1": { context_length: 5000, _declare: true, _fallback: true } },
					},
				],
			},
		};
		const server = { label: "prod", baseUrl: "https://gw" };
		// The REAL old walk (ban active): the override beats the reported 100000.
		const bannedWalk = resolveOldModelCapabilities({
			rawModelId: "deepseek-r1",
			globalCapabilities: {},
			serverScopes: ["https://gw"],
			entryCapabilities: { "deepseek-r1": { context_length: 5000, _declare: true, _fallback: true } },
			serverDeclared: expectDefined(WALK_BASELINES[2]),
		});
		assert.strictEqual(bannedWalk.fields.context_length, 5000, "old: the ban kept the field an override");

		const old = resolveOldWorld(snapshot, server, "deepseek-r1");
		assert.deepStrictEqual(old.banRescuedFields, ["context_length"], "the oracle names the rescued field");

		const migrated = applyPlanToSnapshot(snapshot, planSettingsRedesign(snapshot).writes);
		const projected = resolveNewWorldReference(migrated, server, "deepseek-r1");
		assert.deepStrictEqual(projected.declared, ["deepseek-r1"], "the declaration itself survives the move");
		assert.strictEqual(
			projected.walks[2]?.fields.context_length,
			100000,
			"new: the server report wins; the fill applies below it"
		);
		assert.strictEqual(
			projected.walks[1]?.fields.context_length,
			5000,
			"new: with nothing reported, the fill still applies"
		);
		assert.deepStrictEqual(projected.capabilityFallbacks, { context_length: 5000 });
	});

	test("DOCUMENTED DIVERGENCE: the migrated defaultMaxOutputTokens fill lifts the wire clamp", () => {
		// INTENTIONAL: the old world clamped the trio-derived guess to min(4096, value)
		// on the wire; the migrated "*" fill is a user-written `_fallback`, so the
		// full value goes out.
		const snapshot: SettingsSnapshot = {
			servers: { globalValue: [{ label: "prod", baseUrl: "https://gw" }] },
			defaultMaxOutputTokens: { globalValue: 32000 },
		};
		const server = { label: "prod", baseUrl: "https://gw" };
		const old = resolveOldWorld(snapshot, server, "gpt-5");
		assert.strictEqual(old.expectsOutputClampLift, true);
		const oldWalk = expectDefined(old.walks[1]);
		assert.strictEqual(oldWalk.outputLimitSource, "defaults");
		assert.strictEqual(wireMaxTokens(oldWalk), 4096, "old: the guess never escaped the cap");

		const migrated = applyPlanToSnapshot(snapshot, planSettingsRedesign(snapshot).writes);
		const projected = resolveNewWorldReference(migrated, server, "gpt-5");
		const newWalk = expectDefined(projected.walks[1]);
		assert.strictEqual(newWalk.outputLimitSource, "user");
		assert.strictEqual(wireMaxTokens(newWalk), 32000, "new: the user-set fill goes out uncapped");
	});
});

suite("extension/migrations/settingsRedesign: behavior parity spot-checks", () => {
	const server = { label: "prod", baseUrl: "https://gw" };
	const migrate = (snapshot: SettingsSnapshot) => applyPlanToSnapshot(snapshot, planSettingsRedesign(snapshot).writes);

	test("a migrated trio context fallback loses to the server-declared context", () => {
		const snapshot: SettingsSnapshot = {
			servers: { globalValue: [{ label: "prod", baseUrl: "https://gw" }] },
			defaultContextLength: { globalValue: 64000 },
		};
		const projected = resolveNewWorldReference(migrate(snapshot), server, "gpt-5");
		// WALK_BASELINES[2] declares context_length 100000.
		assert.strictEqual(projected.walks[2]?.fields.context_length, 100000, "the server-declared context wins");
		assert.strictEqual(projected.walks[1]?.fields.context_length, 64000, "with nothing reported, the fill applies");
	});

	test("a migrated defaultMaxInputTokens override beats the server-reported max input", () => {
		const snapshot: SettingsSnapshot = {
			servers: { globalValue: [{ label: "prod", baseUrl: "https://gw" }] },
			defaultMaxInputTokens: { globalValue: 111000 },
		};
		const projected = resolveNewWorldReference(migrate(snapshot), server, "gpt-5");
		// WALK_BASELINES[2] reports max_input_tokens 90000; the migrated plain
		// override preserves the old quirk of beating it.
		assert.strictEqual(projected.walks[2]?.fields.max_input_tokens, 111000);
	});

	test("the migrated '*' record reaches a model that has a specific record (the _inheritable bit)", () => {
		const snapshot: SettingsSnapshot = {
			servers: { globalValue: [{ label: "prod", baseUrl: "https://gw" }] },
			defaultContextLength: { globalValue: 64000 },
			modelCapabilities: { globalValue: { "gpt-5": { supports_vision: true } } },
		};
		const projected = resolveNewWorldReference(migrate(snapshot), server, "gpt-5");
		// The specific record wins the chain wholesale, but the "*" fill is marked
		// `_inheritable`, so it still flows in - as the old defaults did for every model.
		assert.strictEqual(projected.capabilityOverrides.supports_vision, true);
		assert.strictEqual(
			projected.walks[1]?.fields.context_length,
			64000,
			"the inheritable fill reaches the specific match"
		);
	});
});
