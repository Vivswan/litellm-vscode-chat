import * as assert from "node:assert";
import type { RecordTreeNode } from "../../../dashboard/viewModels";
import { modelScopeKey } from "../../../extension/dashboard/adoptHandle";
import type { ResolvedModelsQuery } from "../../../extension/dashboard/resolvedModels";
import { buildResolvedModelsView, resolveModelRecordChains } from "../../../extension/dashboard/resolvedModels";
import type { SettingsReader } from "../../../extension/dashboard/state";
import { EMPTY_CATALOG_LOOKUP } from "../../../shared/config/capabilityResolution";
import { makeModelInfo } from "../../pureHelpers";
import { makeServerStatus } from "../../testUtils";

function makeReader(values: Record<string, unknown>): SettingsReader {
	return {
		get: (key) => values[key],
		inspect: (key) => (Object.hasOwn(values, key) ? { globalValue: values[key] } : undefined),
	};
}

function snapshotWith(serverId: string, label: string, modelIds: readonly string[]) {
	return {
		discoveredRawIds: [],
		status: makeServerStatus({ serverId, label }),
		models: modelIds.map((id) => makeModelInfo({ id, name: id })),
	};
}

function makeQuery(overrides: Partial<ResolvedModelsQuery> = {}): ResolvedModelsQuery {
	return {
		snapshots: [snapshotWith("g1", "Prod", ["gpt-4", "claude"])],
		reader: makeReader({}),
		resolveEntryParameters: () => undefined,
		resolveEntryCapabilities: () => undefined,
		declared: [],
		catalog: EMPTY_CATALOG_LOOKUP,
		...overrides,
	};
}

/** Every node of a tree, flattened for lookups by key. */
function flatten(nodes: readonly RecordTreeNode[]): RecordTreeNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

suite("extension/dashboard/resolvedModels", () => {
	test("no records at all: recordCount 0, no trees, and every model still gets a provenance row", () => {
		const view = buildResolvedModelsView(makeQuery());

		assert.strictEqual(view.recordCount, 0);
		assert.deepStrictEqual(view.trees, []);
		assert.deepStrictEqual(
			view.rows.map((row) => [row.serverLabel, row.rawId]),
			[
				["Prod", "claude"],
				["Prod", "gpt-4"],
			],
			"rows sort by server label then raw ID"
		);
		const row = view.rows[1];
		assert.ok(row !== undefined);
		assert.deepStrictEqual(row.matchedKeys, []);
		assert.deepStrictEqual(row.parameters, []);
		// Capabilities are total by construction: every field resolves at some
		// level (here the floor and the derived input limit).
		assert.strictEqual(row.capabilities.length, 7);
		const toolCalling = row.capabilities.find((cell) => cell.name === "supports_function_calling");
		assert.strictEqual(toolCalling?.level, "floor");
	});

	suite("the flat rows", () => {
		test("entry parameters beat global ones with per-cell provenance, and matchedKeys spans every map", () => {
			const view = buildResolvedModelsView(
				makeQuery({
					reader: makeReader({
						"models.parameters": { "*": { temperature: 0.1, top_p: 0.9 } },
						"models.capabilities": { "gpt-4": { supports_vision: true } },
					}),
					resolveEntryParameters: (serverId) =>
						serverId === "g1" ? { entryLabel: "Prod", entryParameters: { "gpt-4": { temperature: 0.3 } } } : undefined,
				})
			);

			const gpt4 = view.rows.find((row) => row.rawId === "gpt-4");
			assert.ok(gpt4 !== undefined);
			assert.deepStrictEqual(gpt4.matchedKeys, ["*", "gpt-4"]);
			const temperature = gpt4.parameters.find((cell) => cell.name === "temperature");
			assert.deepStrictEqual(temperature, { name: "temperature", valueText: "0.3", layer: "entry", key: "gpt-4" });
			const topP = gpt4.parameters.find((cell) => cell.name === "top_p");
			assert.deepStrictEqual(topP, { name: "top_p", valueText: "0.9", layer: "global", key: "*" });
			const vision = gpt4.capabilities.find((cell) => cell.name === "supports_vision");
			assert.strictEqual(vision?.level, "global");
			assert.strictEqual(vision?.key, "gpt-4");
			assert.strictEqual(vision?.valueText, "true");

			const claude = view.rows.find((row) => row.rawId === "claude");
			assert.ok(claude !== undefined);
			assert.deepStrictEqual(claude.matchedKeys, ["*"], "the entry record and the capability record match only gpt-4");
			const claudeTemperature = claude.parameters.find((cell) => cell.name === "temperature");
			assert.strictEqual(claudeTemperature?.layer, "global");
		});

		test("an inherited field's cell names the record it came from; a forced field carries its mark", () => {
			const view = buildResolvedModelsView(
				makeQuery({
					reader: makeReader({
						"models.parameters": {
							"gpt*": { temperature: 0.5, _inheritable: true },
							"gpt-4": { top_p: 1, _force: ["top_p"], _inherit_from: true },
						},
					}),
				})
			);

			const gpt4 = view.rows.find((row) => row.rawId === "gpt-4");
			const temperature = gpt4?.parameters.find((cell) => cell.name === "temperature");
			assert.strictEqual(temperature?.key, "gpt*", "the value's home record, the place to edit it");
			assert.strictEqual(temperature?.inheritedFrom, "gpt*");
			const topP = gpt4?.parameters.find((cell) => cell.name === "top_p");
			assert.strictEqual(topP?.forced, true);
			assert.ok(!("inheritedFrom" in (topP ?? {})), "an own field carries no inheritance mark");
		});

		test("open capability fields render extra rows with level and key provenance; the core seven stay put", () => {
			const view = buildResolvedModelsView(
				makeQuery({
					reader: makeReader({
						"models.capabilities": { "gpt-4": { mystery_flag: "on" } },
					}),
				})
			);

			const gpt4 = view.rows.find((row) => row.rawId === "gpt-4");
			assert.ok(gpt4 !== undefined);
			assert.deepStrictEqual(
				gpt4.capabilities.slice(0, 7).map((cell) => cell.name),
				[
					"context_length",
					"max_input_tokens",
					"max_output_tokens",
					"supports_function_calling",
					"supports_vision",
					"supports_reasoning",
					"supports_audio_input",
				],
				"the core seven keep their table positions"
			);
			const extra = gpt4.capabilities.find((cell) => cell.name === "mystery_flag");
			assert.deepStrictEqual(extra, { name: "mystery_flag", valueText: '"on"', level: "global", key: "gpt-4" });
			assert.strictEqual(gpt4.capabilities.length, 8, "extras append; nothing else changes");

			const claude = view.rows.find((row) => row.rawId === "claude");
			assert.strictEqual(claude?.capabilities.length, 7, "a model the record does not match keeps the core table");
		});

		test("a server-supplied consumed field renders at the server level with no record key", () => {
			const view = buildResolvedModelsView(
				makeQuery({
					snapshots: [
						{
							discoveredRawIds: [],
							status: makeServerStatus({ serverId: "g1", label: "Prod" }),
							models: [
								makeModelInfo({
									id: "gpt-4",
									name: "gpt-4",
									litellm: {
										supportsPromptCaching: false,
										outputLimitSource: "defaults",
										serverDeclared: {
											kind: "discovered",
											values: { input_cost_per_token: 0.000002, supports_pdf_input: true },
											outputDeclared: false,
										},
									},
								}),
							],
						},
					],
				})
			);

			const gpt4 = view.rows.find((row) => row.rawId === "gpt-4");
			assert.ok(gpt4 !== undefined);
			const cost = gpt4.capabilities.find((cell) => cell.name === "input_cost_per_token");
			assert.deepStrictEqual(cost, { name: "input_cost_per_token", valueText: "0.000002", level: "server" });
			const pdf = gpt4.capabilities.find((cell) => cell.name === "supports_pdf_input");
			assert.deepStrictEqual(pdf, { name: "supports_pdf_input", valueText: "true", level: "server" });
		});
	});

	suite("the record trees", () => {
		test("records nest under their next-broader match, models leaf under their most specific record", () => {
			const view = buildResolvedModelsView(
				makeQuery({
					reader: makeReader({
						"models.parameters": {
							"*": { seed: 1, _inheritable: true },
							"gpt*": { temperature: 0.5 },
						},
					}),
				})
			);

			assert.strictEqual(view.recordCount, 2);
			assert.strictEqual(view.trees.length, 1);
			const tree = view.trees[0];
			assert.ok(tree !== undefined);
			assert.strictEqual(tree.kind, "parameters");
			assert.strictEqual(tree.layer, "global");
			assert.deepStrictEqual(tree.invalidKeys, []);
			assert.deepStrictEqual(tree.unmatchedModelIds, []);

			const root = tree.roots[0];
			assert.ok(root !== undefined);
			assert.strictEqual(root.key, "*");
			assert.deepStrictEqual(
				root.models.map((leaf) => leaf.id),
				["claude"],
				"the catch-all is claude's most specific match"
			);
			const child = root.children[0];
			assert.strictEqual(child?.key, "gpt*");
			assert.deepStrictEqual(
				child?.models.map((leaf) => leaf.id),
				["gpt-4"]
			);
			assert.strictEqual(
				child?.models[0]?.resolvedText.includes("temperature 0.5"),
				true,
				"the leaf shows the chain's resolved view"
			);
			const seedField = root.fields.find((field) => field.name === "seed");
			assert.strictEqual(seedField?.inheritable, true);
		});

		test("barriers, unmatched models, invalid keys, and matcherless records sit where the honesty note says", () => {
			const view = buildResolvedModelsView(
				makeQuery({
					reader: makeReader({
						"models.parameters": {
							"gpt*": { temperature: 0.5 },
							"gpt-4": { top_p: 1, _inherit_from: false },
							"a*b": { seed: 2 },
							"unmatched-anywhere*": { seed: 3 },
						},
					}),
				})
			);

			const tree = view.trees[0];
			assert.ok(tree !== undefined);
			assert.deepStrictEqual(tree.invalidKeys, ["a*b"], "a mid-key glob is an invalid matcher, outside the tree");
			assert.deepStrictEqual(tree.unmatchedModelIds, ["claude"], "claude matches no record in this map");

			const nodes = flatten(tree.roots);
			const barrier = nodes.find((node) => node.key === "gpt-4");
			assert.strictEqual(barrier?.barrier, true);
			assert.strictEqual(barrier?.inheritFrom, "false");
			const unvisited = tree.roots.find((node) => node.key === "unmatched-anywhere*");
			assert.ok(unvisited !== undefined, "a record no model matches roots with no leaves");
			assert.deepStrictEqual(unvisited.models, []);
			assert.deepStrictEqual(unvisited.children, []);
		});

		test("with no models at all, invalid keys still report and valid records root leafless", () => {
			// Invalid matchers are seeded from the map's own keys, not harvested
			// from per-model walks: an empty server must not launder "a*b" into a
			// normal-looking tree root.
			const view = buildResolvedModelsView(
				makeQuery({
					snapshots: [snapshotWith("g1", "Prod", [])],
					reader: makeReader({
						"models.parameters": { "a*b": { seed: 2 }, "gpt*": { temperature: 0.5 } },
					}),
				})
			);

			assert.deepStrictEqual(view.rows, []);
			const tree = view.trees[0];
			assert.ok(tree !== undefined);
			assert.deepStrictEqual(tree.invalidKeys, ["a*b"]);
			assert.deepStrictEqual(
				tree.roots.map((node) => [node.key, node.models.length, node.children.length]),
				[["gpt*", 0, 0]]
			);
		});

		test("entry maps tree per entry against that entry's models and count into recordCount", () => {
			// The trees draw from the DECLARED views (an entry with zero models
			// must still render); the entry's models join by the resolved label.
			const view = buildResolvedModelsView(
				makeQuery({
					snapshots: [snapshotWith("g1", "Prod", ["gpt-4"]), snapshotWith("g2", "Staging", ["claude"])],
					resolveEntryParameters: (serverId) =>
						serverId === "g1" ? { entryLabel: "Prod", entryParameters: { "*": { temperature: 0.2 } } } : undefined,
					resolveEntryCapabilities: (serverId) =>
						serverId === "g1" ? { "gpt*": { supports_vision: true } } : undefined,
					declared: [
						{
							label: "Prod",
							modelParameters: { "*": { temperature: 0.2 } },
							modelCapabilities: { "gpt*": { supports_vision: true } },
						},
					],
				})
			);

			assert.strictEqual(view.recordCount, 2, "one parameters record plus one capabilities record");
			assert.deepStrictEqual(
				view.trees.map((tree) => [tree.kind, tree.layer, tree.entryLabel]),
				[
					["parameters", "entry", "Prod"],
					["capabilities", "entry", "Prod"],
				]
			);
			const parametersTree = view.trees[0];
			assert.deepStrictEqual(
				parametersTree?.roots[0]?.models.map((leaf) => leaf.id),
				["gpt-4"],
				"only the entry's own models leaf in its tree"
			);
		});
	});

	suite("resolveModelRecordChains (the inspectors' inheritance figure)", () => {
		test("orders the global chain broadest to winner with barrier and exclusive-list display facts", () => {
			const chains = resolveModelRecordChains(
				{
					snapshots: [snapshotWith("g1", "Prod", ["gpt-4"])],
					reader: makeReader({
						"models.parameters": {
							"*": { temperature: 0.1 },
							"gpt*": { top_p: 0.9, _inherit_from: false },
							"gpt-4": { temperature: 0.3, _inherit_from: ["*"] },
						},
					}),
					resolveEntryParameters: () => undefined,
					resolveEntryCapabilities: () => undefined,
				},
				"parameters",
				modelScopeKey("g1"),
				"gpt-4"
			);

			assert.deepStrictEqual(chains, [
				{
					layer: "global",
					links: [
						{ key: "*", barrier: false },
						{ key: "gpt*", barrier: true, inheritFrom: "false" },
						{ key: "gpt-4", barrier: false, inheritFrom: "*" },
					],
				},
			]);
		});

		test("the global map's chain rides above the entry's (lower precedence first); capabilities read their own maps", () => {
			const query = {
				snapshots: [snapshotWith("g1", "Prod", ["gpt-4"])],
				reader: makeReader({
					"models.capabilities": { "*": { context_length: 100 } },
				}),
				resolveEntryParameters: () => undefined,
				resolveEntryCapabilities: (serverId: string) =>
					serverId === "g1" ? { "gpt*": { supports_vision: true }, "gpt-4": { context_length: 200 } } : undefined,
			};
			const chains = resolveModelRecordChains(query, "capabilities", modelScopeKey("g1"), "gpt-4");
			assert.deepStrictEqual(
				chains.map((chain) => [chain.layer, chain.links.map((link) => link.key)]),
				[
					["global", ["*"]],
					["entry", ["gpt*", "gpt-4"]],
				]
			);
		});

		test("a stale scope key, a model gone from its snapshot, or maps matching nothing yield no chains", () => {
			const query = {
				snapshots: [snapshotWith("g1", "Prod", ["gpt-4"])],
				reader: makeReader({ "models.parameters": { "claude*": { temperature: 1 }, "*": { top_p: 0.9 } } }),
				resolveEntryParameters: () => undefined,
				resolveEntryCapabilities: () => undefined,
			};
			assert.deepStrictEqual(resolveModelRecordChains(query, "parameters", modelScopeKey("gone"), "gpt-4"), []);
			// A raw ID the matchers WOULD match but the snapshot no longer serves:
			// the figure must answer empty like the responders, never invent one.
			assert.deepStrictEqual(resolveModelRecordChains(query, "parameters", modelScopeKey("g1"), "claude-4"), []);
			// A live model whose maps match nothing contributes no chain either.
			const noMatch = { ...query, reader: makeReader({ "models.parameters": { "claude*": { temperature: 1 } } }) };
			assert.deepStrictEqual(resolveModelRecordChains(noMatch, "parameters", modelScopeKey("g1"), "gpt-4"), []);
		});
	});
});
