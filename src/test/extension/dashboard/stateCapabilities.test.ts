/**
 * The state's capability side: expected failures, observed model_info keys, record-key specificity, and
 * resolveDashboardModelCapabilities.
 */
import * as assert from "node:assert";
import { modelScopeKey } from "../../../extension/dashboard/adoptHandle";
import {
	mostSpecificGlobalRecordKey,
	observedKeysByEntryLabel,
	observedModelInfoKeysUnion,
	resolveDashboardModelCapabilities,
} from "../../../extension/dashboard/state";
import { EMPTY_CATALOG_LOOKUP } from "../../../shared/config/capabilityResolution";
import { makeModelInfo } from "../../pureHelpers";
import { makeServerStatus } from "../../testUtils";
import { buildState, makeDeclared, makeReader } from "./stateHelpers";

suite("extension/dashboard/state: capabilities", () => {
	suite("buildDashboardState: capabilities and expected failures", () => {
		test("the config prefill carries the entry's modelCapabilities and expectedFailures", () => {
			const state = buildState([], makeReader({}), [
				makeDeclared({
					modelCapabilities: { "my-model": { context_length: 128000 } },
					expectedFailures: ["modelListing"],
				}),
			]);
			const server = state.servers[0];
			assert.ok(server?.origin === "declared");
			assert.deepStrictEqual(server.config.modelCapabilities, {
				"my-model": { context_length: 128000 },
			});
			assert.deepStrictEqual(server.config.expectedFailures, ["modelListing"]);
		});

		test("the config prefill carries the entry's apiVersion, the empty-string override included", () => {
			const state = buildState([], makeReader({}), [makeDeclared({ apiVersion: "" })]);
			const server = state.servers[0];
			assert.ok(server?.origin === "declared");
			assert.strictEqual(server.config.apiVersion, "");
			assert.ok("apiVersion" in server.config, '"" is a real override and must survive into the prefill');

			const absent = buildState([], makeReader({}), [makeDeclared()]);
			const plain = absent.servers[0];
			assert.ok(plain?.origin === "declared");
			assert.ok(!("apiVersion" in plain.config), "an entry without the field prefills the auto default");
		});

		test("an expected failure rides the row with its declared count as the model count", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-prod-labeled:http://x.test",
							label: "Prod",
							baseUrl: "http://x.test",
							state: "error",
							error: "404 on /models",
							expected: true,
							declaredModelCount: 2,
						}),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-prod-labeled:http://x.test",
						expectedFailures: ["modelListing"],
					}),
				]
			);
			const server = state.servers[0];
			assert.ok(server?.state === "error");
			assert.strictEqual(server.expected, true);
			assert.strictEqual(server.declaredModelCount, 2);
			assert.strictEqual(server.servedModelCount, 2, "declared models join the row's count");
			assert.strictEqual(server.notices, undefined, "declared models mean nothing to flag");
		});

		test("an ok status's model-info-unsupported marker rides onto the declared row", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-prod-labeled:http://x.test",
							label: "Prod",
							baseUrl: "http://x.test",
							state: "ok",
							servedModelCount: 1,
							modelInfoUnsupported: "timeout",
						}),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-prod-labeled:http://x.test",
					}),
				]
			);
			const server = state.servers[0];
			assert.ok(server?.state === "ok");
			assert.strictEqual(server.modelInfoUnsupported, "timeout");
		});

		test("an expected failure with nothing declared raises the needs-declare notice", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-prod-labeled:http://x.test",
							label: "Prod",
							baseUrl: "http://x.test",
							state: "error",
							error: "404 on /models",
							expected: true,
						}),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-prod-labeled:http://x.test",
						expectedFailures: ["modelListing"],
					}),
				]
			);
			const server = state.servers[0];
			assert.ok(server?.state === "error");
			assert.strictEqual(server.servedModelCount, 0);
			assert.deepStrictEqual(server.notices, ["expected-failures-nothing-declared"]);
		});

		test("an expected failure serving only the stale window raises no needs-declare notice", () => {
			// The notice gates on servedModelCount, like every other serving
			// verdict: a row quietly serving its last known list must not carry a
			// paste line contradicting itself ("still served" beside "add IDs").
			const state = buildState(
				[
					{
						status: makeServerStatus({
							serverId: "group:fp-prod-labeled:http://x.test",
							label: "Prod",
							baseUrl: "http://x.test",
							state: "error",
							error: "404 on /models",
							expected: true,
							servedModelCount: 3,
						}),
						models: [],
					},
				],
				makeReader({}),
				[
					makeDeclared({
						label: "Prod",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp-prod-labeled:http://x.test",
						expectedFailures: ["modelListing"],
					}),
				]
			);
			const server = state.servers[0];
			assert.ok(server?.state === "error");
			assert.strictEqual(server.servedModelCount, 3);
			assert.strictEqual(server.notices, undefined, "the stale window serves, so there is nothing to declare");
		});

		test("a declared model's badge marker rides the dashboard model; discovered models carry none", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g1" }),
						models: [
							makeModelInfo({ id: "gpt-4", name: "a" }),
							makeModelInfo({
								id: "my-model",
								name: "b",
								litellm: {
									rawModelId: "my-model",
									supportsPromptCaching: false,
									outputLimitSource: "defaults",
									declared: true,
									serverDeclared: { kind: "declared" },
								},
							}),
						],
					},
				],
				makeReader({})
			);
			assert.deepStrictEqual(
				state.models.map((model) => [model.rawId, model.declared]),
				[
					["gpt-4", undefined],
					["my-model", true],
				]
			);
		});
	});

	suite("observed model_info keys", () => {
		test("ride the matched declared row and the external row; absent when the snapshot carries no set", () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g1", label: "Prod", baseUrl: "http://prod.test" }),
						models: [],
						observedModelInfoKeys: ["max_input_tokens", "mystery_flag"],
					},
					{
						status: makeServerStatus({ serverId: "g2", label: "External", baseUrl: "http://ext.test" }),
						models: [],
						observedModelInfoKeys: ["supports_vision"],
					},
					{
						status: makeServerStatus({ serverId: "g3", label: "Bare", baseUrl: "http://bare.test" }),
						models: [],
					},
				],
				makeReader({}),
				[makeDeclared({ label: "Prod", baseUrl: "http://prod.test" })]
			);
			const byLabel = new Map(state.servers.map((server) => [server.label, server.observedModelInfoKeys]));
			assert.deepStrictEqual(byLabel.get("Prod"), ["max_input_tokens", "mystery_flag"]);
			assert.deepStrictEqual(byLabel.get("External"), ["supports_vision"]);
			assert.strictEqual(byLabel.get("Bare"), undefined);
			assert.deepStrictEqual(
				state.observedModelInfoKeys,
				["max_input_tokens", "mystery_flag", "supports_vision"],
				"the state-level union spans exactly the servers that reported a set, sorted"
			);
		});

		test("the state union is absent when no server reported a set, and an unchecked declared row carries none", () => {
			const state = buildState([], makeReader({}), [makeDeclared()]);
			assert.ok(!("observedModelInfoKeys" in state), "no set anywhere means no union, not an empty one");
			assert.strictEqual(state.servers[0]?.observedModelInfoKeys, undefined);
		});

		test('a server-reported "__proto__" key is carried as data, never applied as an object key', () => {
			const state = buildState(
				[
					{
						status: makeServerStatus({ serverId: "g1" }),
						models: [],
						observedModelInfoKeys: ["__proto__", "constructor"],
					},
				],
				makeReader({})
			);
			assert.deepStrictEqual(state.observedModelInfoKeys, ["__proto__", "constructor"]);
			// The union is Set-built; had a raw object keyed the accumulation, the
			// "__proto__" write would have re-pointed the accumulator's prototype
			// instead of recording the key. Fresh objects must stay pristine.
			assert.strictEqual(Object.getPrototypeOf({}), Object.prototype);
		});

		test("observedModelInfoKeysUnion distinguishes no sets (undefined) from empty sets (the empty array)", () => {
			assert.strictEqual(observedModelInfoKeysUnion([{}]), undefined);
			assert.deepStrictEqual(observedModelInfoKeysUnion([{ observedModelInfoKeys: [] }]), []);
			assert.deepStrictEqual(
				observedModelInfoKeysUnion([{ observedModelInfoKeys: ["b", "a"] }, {}, { observedModelInfoKeys: ["a", "c"] }]),
				["a", "b", "c"]
			);
		});

		test("observedKeysByEntryLabel joins each entry to its serving snapshot's set; setless and unmatched entries stay absent", () => {
			const byLabel = observedKeysByEntryLabel(
				[
					{
						status: makeServerStatus({ serverId: "g1", label: "Prod", baseUrl: "http://prod.test" }),
						models: [],
						observedModelInfoKeys: ["max_input_tokens"],
					},
					{
						status: makeServerStatus({ serverId: "g2", label: "Bare", baseUrl: "http://bare.test" }),
						models: [],
					},
				],
				[
					makeDeclared({ label: "Prod", baseUrl: "http://prod.test" }),
					makeDeclared({ label: "Bare", baseUrl: "http://bare.test" }),
					makeDeclared({ label: "Unseen", baseUrl: "http://unseen.test" }),
				]
			);
			assert.deepStrictEqual([...byLabel.entries()], [["Prod", ["max_input_tokens"]]]);
		});
	});

	suite("mostSpecificGlobalRecordKey", () => {
		test("names the most specific matching key of the addressed map, or nothing", () => {
			const reader = makeReader({
				"models.parameters": { "*": { temperature: 0.7 }, "gpt*": { temperature: 0.3 } },
				"models.capabilities": { "claude-4": { supports_vision: true } },
			});
			assert.strictEqual(mostSpecificGlobalRecordKey(reader, "parameters", "gpt-4"), "gpt*");
			assert.strictEqual(mostSpecificGlobalRecordKey(reader, "parameters", "claude-4"), "*");
			assert.strictEqual(mostSpecificGlobalRecordKey(reader, "capabilities", "claude-4"), "claude-4");
			assert.strictEqual(mostSpecificGlobalRecordKey(reader, "capabilities", "gpt-4"), undefined);
			assert.strictEqual(mostSpecificGlobalRecordKey(makeReader({}), "parameters", "gpt-4"), undefined);
		});
	});

	suite("resolveDashboardModelCapabilities", () => {
		const snapshots = [
			{
				status: makeServerStatus({ serverId: "g1", baseUrl: "http://x.test" }),
				models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
			},
		];

		test("resolves through the shared walk: entry beats global beats the floor, shadowed values kept", () => {
			const capabilities = resolveDashboardModelCapabilities(
				{
					snapshots,
					reader: makeReader({ "models.capabilities": { "gpt-4": { context_length: 111 } } }),
					resolveEntryCapabilities: () => ({ "gpt-4": { context_length: 222 } }),
					catalog: EMPTY_CATALOG_LOOKUP,
				},
				modelScopeKey("g1"),
				"gpt-4"
			);
			assert.ok(capabilities !== undefined);
			assert.strictEqual(capabilities.fields.context_length.value, 222);
			assert.strictEqual(capabilities.fields.context_length.level, "entry");
			assert.deepStrictEqual(
				capabilities.fields.context_length.shadowed.map((shadow) => [shadow.level, shadow.value]),
				[["global", 111]]
			);
			assert.strictEqual(capabilities.fields.supports_vision.level, "floor");
			assert.strictEqual(capabilities.outputLimitSource, "defaults");
		});

		test("a server baseline riding the model metadata resolves at the server level", () => {
			const withBaseline = [
				{
					status: makeServerStatus({ serverId: "g1", baseUrl: "http://x.test" }),
					models: [
						makeModelInfo({
							id: "gpt-4",
							name: "gpt-4",
							litellm: {
								rawModelId: "gpt-4",
								supportsPromptCaching: false,
								outputLimitSource: "provider",
								serverDeclared: {
									kind: "discovered",
									values: { context_length: 999, max_output_tokens: 500 },
									outputDeclared: true,
								},
							},
						}),
					],
				},
			];
			const capabilities = resolveDashboardModelCapabilities(
				{
					snapshots: withBaseline,
					reader: makeReader({}),
					resolveEntryCapabilities: () => undefined,
					catalog: EMPTY_CATALOG_LOOKUP,
				},
				modelScopeKey("g1"),
				"gpt-4"
			);
			assert.ok(capabilities !== undefined);
			assert.strictEqual(capabilities.fields.context_length.value, 999);
			assert.strictEqual(capabilities.fields.context_length.level, "server");
			assert.strictEqual(capabilities.outputLimitSource, "provider");
		});

		test("a claimed snapshot whose entry label differs from the group's still resolves its models", () => {
			// The population the entry-capabilities-inactive notice exists for: entry
			// "Prod", group label "x.test". The rows render under the entry label and
			// their scope keys must still answer - the key hashes the server ID, so
			// no label enters the resolution.
			const divergent = [
				{
					status: makeServerStatus({
						serverId: "group:fp-other:http://x.test",
						label: "x.test",
						baseUrl: "http://x.test",
					}),
					models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
				},
			];
			const state = buildState(divergent, makeReader({}), [makeDeclared({ label: "Prod", baseUrl: "http://x.test" })]);
			assert.strictEqual(state.models[0]?.serverLabel, "Prod", "the row renders under the claimant label");
			const capabilities = resolveDashboardModelCapabilities(
				{
					snapshots: divergent,
					reader: makeReader({}),
					resolveEntryCapabilities: () => undefined,
					catalog: EMPTY_CATALOG_LOOKUP,
				},
				state.models[0]?.scopeKey ?? "",
				state.models[0]?.rawId ?? ""
			);
			assert.ok(capabilities !== undefined, "a divergent-label row must still resolve");
		});

		test("two groups on one host resolve their own capabilities despite the ordinal display labels", () => {
			const twoGroups = [
				{
					status: makeServerStatus({ serverId: "g-a", label: "Prod", baseUrl: "http://x.test" }),
					models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
				},
				{
					status: makeServerStatus({ serverId: "g-b", label: "Prod", baseUrl: "http://x.test" }),
					models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
				},
			];
			const state = buildState(twoGroups, makeReader({}));
			const keys = state.models.map((model) => model.scopeKey);
			assert.strictEqual(new Set(keys).size, 2, "each group's models carry their own key");
			for (const model of state.models) {
				const capabilities = resolveDashboardModelCapabilities(
					{
						snapshots: twoGroups,
						reader: makeReader({}),
						resolveEntryCapabilities: () => undefined,
						catalog: EMPTY_CATALOG_LOOKUP,
					},
					model.scopeKey,
					model.rawId
				);
				assert.ok(capabilities !== undefined, `the ${model.serverLabel} row must resolve`);
			}
		});

		test("a stale scope key, a malformed one, or an unknown raw ID answers undefined", () => {
			const query = {
				snapshots,
				reader: makeReader({}),
				resolveEntryCapabilities: () => undefined,
				catalog: EMPTY_CATALOG_LOOKUP,
			};
			assert.strictEqual(resolveDashboardModelCapabilities(query, "s0", "gpt-4"), undefined);
			assert.strictEqual(resolveDashboardModelCapabilities(query, "bogus", "gpt-4"), undefined);
			assert.strictEqual(resolveDashboardModelCapabilities(query, modelScopeKey("g1"), "no-such-model"), undefined);
			// A key minted for a server that left the window de-resolves; it can
			// never re-point at whatever server the snapshot list now holds.
			assert.strictEqual(resolveDashboardModelCapabilities(query, modelScopeKey("gone"), "gpt-4"), undefined);
		});

		suite("advisory filtering of unrecognized-key diagnostics", () => {
			const snapshotWithKeys = (observedModelInfoKeys: readonly string[] | undefined) => [
				{
					status: makeServerStatus({ serverId: "g1", baseUrl: "http://x.test" }),
					models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
					...(observedModelInfoKeys !== undefined ? { observedModelInfoKeys } : {}),
				},
			];
			const resolve = (observed: readonly string[] | undefined) =>
				resolveDashboardModelCapabilities(
					{
						snapshots: snapshotWithKeys(observed),
						reader: makeReader({ "models.capabilities": { "gpt-4": { mystery_flag: true } } }),
						resolveEntryCapabilities: () => undefined,
						catalog: EMPTY_CATALOG_LOOKUP,
					},
					modelScopeKey("g1"),
					"gpt-4"
				);

			test("with no observed set the hint drops; the field still applies", () => {
				const capabilities = resolve(undefined);
				assert.ok(capabilities !== undefined);
				assert.deepStrictEqual(capabilities.diagnostics, []);
				assert.strictEqual(capabilities.fields.mystery_flag?.value, true, "filtering touches diagnostics only");
			});

			test("an unobserved key on a server WITH a set survives; an observed one drops", () => {
				const unobserved = resolve(["supports_vision"]);
				assert.deepStrictEqual(unobserved?.diagnostics, [
					{ kind: "unrecognized-key", recordKey: "gpt-4", key: "mystery_flag", layer: "global" },
				]);
				const observed = resolve(["mystery_flag"]);
				assert.deepStrictEqual(observed?.diagnostics, []);
			});

			test("other diagnostic kinds pass through whatever the observed set says", () => {
				const capabilities = resolveDashboardModelCapabilities(
					{
						snapshots: snapshotWithKeys(undefined),
						reader: makeReader({ "models.capabilities": { "gpt-4": { context_length: "big" } } }),
						resolveEntryCapabilities: () => undefined,
						catalog: EMPTY_CATALOG_LOOKUP,
					},
					modelScopeKey("g1"),
					"gpt-4"
				);
				assert.deepStrictEqual(capabilities?.diagnostics, [
					{ kind: "invalid-value", recordKey: "gpt-4", key: "context_length", layer: "global" },
				]);
			});

			test("entry-layer hints filter against the same server set", () => {
				const capabilities = resolveDashboardModelCapabilities(
					{
						snapshots: snapshotWithKeys(["entry_key"]),
						reader: makeReader({}),
						resolveEntryCapabilities: () => ({ "gpt-4": { entry_key: 1, entry_mystery: 2 } }),
						catalog: EMPTY_CATALOG_LOOKUP,
					},
					modelScopeKey("g1"),
					"gpt-4"
				);
				assert.deepStrictEqual(capabilities?.diagnostics, [
					{ kind: "unrecognized-key", recordKey: "gpt-4", key: "entry_mystery", layer: "entry" },
				]);
			});

			suite("layered evidence: global hints use the cross-server union, entry hints the server's own set", () => {
				// Server A serves nothing relevant but observed the key; server B
				// serves the inspected model and did not. Each layer must be judged
				// the way Configuration diagnostics and the settings editor judge it,
				// or a click-through from a hint lands on a record that reads clean.
				const twoServers = (servingSet: readonly string[] | undefined, otherSet: readonly string[] | undefined) => [
					{
						status: makeServerStatus({ serverId: "gB", label: "B", baseUrl: "http://b.test" }),
						models: [makeModelInfo({ id: "gpt-4", name: "gpt-4" })],
						...(servingSet !== undefined ? { observedModelInfoKeys: servingSet } : {}),
					},
					{
						status: makeServerStatus({ serverId: "gA", label: "A", baseUrl: "http://a.test" }),
						models: [],
						...(otherSet !== undefined ? { observedModelInfoKeys: otherSet } : {}),
					},
				];
				const resolveOnB = (
					servingSet: readonly string[] | undefined,
					otherSet: readonly string[] | undefined,
					entryRecord?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
				) =>
					resolveDashboardModelCapabilities(
						{
							snapshots: twoServers(servingSet, otherSet),
							reader: makeReader({ "models.capabilities": { "gpt-4": { supports_web_search: true } } }),
							resolveEntryCapabilities: () => entryRecord,
							catalog: EMPTY_CATALOG_LOOKUP,
						},
						modelScopeKey("gB"),
						"gpt-4"
					);

				test("a global hint drops when ANY server observed the key, even one not serving this model", () => {
					// The regression shape: the SERVING server carries a real, non-empty
					// set that lacks the key, and only the other server observed it. A
					// serving-set-only filter fails here; the union must win.
					const discriminating = resolveOnB(["known_key"], ["supports_web_search"]);
					assert.deepStrictEqual(discriminating?.diagnostics, []);
					// And the softer shape: the serving server has no set at all.
					const noServingSet = resolveOnB(undefined, ["supports_web_search"]);
					assert.deepStrictEqual(noServingSet?.diagnostics, []);
				});

				test("a global hint survives against the union when no server observed the key", () => {
					const capabilities = resolveOnB(undefined, ["something_else"]);
					assert.deepStrictEqual(capabilities?.diagnostics, [
						{ kind: "unrecognized-key", recordKey: "gpt-4", key: "supports_web_search", layer: "global" },
					]);
				});

				test("an entry hint keeps its own server's evidence: another server's observation cannot silence it", () => {
					const capabilities = resolveOnB(["known_key"], ["entry_mystery"], {
						"gpt-4": { entry_mystery: 1 },
					});
					assert.deepStrictEqual(
						capabilities?.diagnostics.filter((diagnostic) => diagnostic.layer === "entry"),
						[{ kind: "unrecognized-key", recordKey: "gpt-4", key: "entry_mystery", layer: "entry" }]
					);
				});

				test("an entry hint drops when its own server has no evidence, whatever the union holds", () => {
					const capabilities = resolveOnB(undefined, ["anything"], { "gpt-4": { entry_mystery: 1 } });
					assert.deepStrictEqual(
						capabilities?.diagnostics.filter((diagnostic) => diagnostic.layer === "entry"),
						[]
					);
				});

				test("no evidence anywhere stays silent on both layers", () => {
					const capabilities = resolveOnB(undefined, undefined, { "gpt-4": { entry_mystery: 1 } });
					assert.deepStrictEqual(capabilities?.diagnostics, []);
				});
			});
		});
	});
});
