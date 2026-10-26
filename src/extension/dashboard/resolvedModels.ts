/**
 * The Resolved-models view builder: the Diagnostics tab's two renderings of the precomputed resolution - the
 * matcher-key inheritance trees and the flat per-model provenance table - computed extension-side from the SAME
 * resolvers the request path and registration run, so what the tab shows is exactly what will be sent. Everything out
 * is serializable data; the view is local to the dashboard and never enters issue reports.
 */

import { formatJsonValue } from "../../dashboard/presenters";
import type {
	RecordChainLink,
	RecordChainView,
	RecordTreeNode,
	RecordTreeView,
	ResolvedCapCell,
	ResolvedModelRow,
	ResolvedModelsView,
	ResolvedParamCell,
} from "../../dashboard/viewModels";
import type { ServerModelsSnapshot } from "../../provider/catalog/statusWindow";
import type {
	CapabilityCatalogLookup,
	ModelCapabilitiesRecord,
	ServerDeclaredCapabilities,
} from "../../shared/config/capabilityResolution";
import {
	parseCapabilityRecord,
	resolveCapabilityLayer,
	resolveModelCapabilities,
} from "../../shared/config/capabilityResolution";
import type { ModelRecordMap } from "../../shared/config/modelMatcher";
import { matchChain, parseMatcherKey } from "../../shared/config/modelMatcher";
import type { ModelParametersRecord } from "../../shared/config/parameterResolution";
import {
	parseParameterRecord,
	resolveModelParameters,
	resolveParameterLayer,
} from "../../shared/config/parameterResolution";
import type { ParsedRecord } from "../../shared/config/recordResolution";
import type { ModelResolutionTable } from "../../shared/config/resolutionTable";
import {
	MODEL_CAPABILITIES_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	normalizeModelCapabilities,
	normalizeModelParameters,
} from "../../shared/config/settings";
import type { DeclaredServerView } from "../servers/serverSync/engine";
import { locateModel, modelScopeKey } from "./adoptHandle";
import { labeledSnapshots } from "./declaredJoin";
import type { EntryCapabilitiesRecord, EntryParametersResolution, SettingsReader } from "./state";

/**
 * `declared` carries the entries' own record maps straight from the setting: the entry TREES draw from these, so an
 * entry whose server currently serves zero models still renders its records (with empty leaves).
 */
export interface ResolvedModelsQuery {
	readonly snapshots: readonly ServerModelsSnapshot[];
	readonly reader: SettingsReader;
	readonly resolveEntryParameters: (serverId: string) => EntryParametersResolution | undefined;
	readonly resolveEntryCapabilities: (serverId: string) => EntryCapabilitiesRecord | undefined;
	readonly declared: readonly Pick<DeclaredServerView, "label" | "modelParameters" | "modelCapabilities">[];
	readonly catalog: CapabilityCatalogLookup;
	readonly resolution?: ModelResolutionTable | undefined;
}

interface WalkModel {
	readonly serverId: string;
	readonly serverLabel: string;
	readonly scopeKey: string;
	readonly rawId: string;
	readonly entryLabel: string | undefined;
	readonly entryParameters: ModelParametersRecord | undefined;
	readonly entryCapabilities: ModelCapabilitiesRecord | undefined;
	readonly serverDeclared: ServerDeclaredCapabilities;
}

function inheritDisplay(parsed: ParsedRecord): { barrier: boolean; inheritFrom?: string } {
	switch (parsed.inheritFrom.kind) {
		case "default":
			return { barrier: false };
		case "all":
			return { barrier: false, inheritFrom: "true" };
		case "none":
			return { barrier: true, inheritFrom: "false" };
		case "keys":
			return parsed.inheritFrom.keys.length === 0
				? { barrier: true, inheritFrom: "[]" }
				: { barrier: false, inheritFrom: parsed.inheritFrom.keys.join(", ") };
	}
}

function nodeFields(parsed: ParsedRecord): RecordTreeNode["fields"] {
	return Object.entries(parsed.fields).map(([name, value]) => ({
		name,
		valueText: formatJsonValue(value),
		inheritable: parsed.inheritable.has(name),
		forced: parsed.forced.has(name),
		fallback: parsed.fallback.has(name),
	}));
}

/**
 * One record map's matching chain for a model, as the inspectors' inheritance figure renders it: matchChain's order
 * (broadest first, the winner last) with each record's inheritance display facts. The read responders reuse this so the
 * figure cannot drift from the Diagnostics trees.
 */
function recordChainLinks(
	rawId: string,
	records: ModelRecordMap,
	parse: (record: Readonly<Record<string, unknown>>, key: string) => ParsedRecord
): RecordChainLink[] {
	return matchChain(rawId, records).chain.map((match) => {
		const inherit = inheritDisplay(parse(records[match.key] ?? {}, match.key));
		return {
			key: match.key,
			barrier: inherit.barrier,
			...(inherit.inheritFrom === undefined ? {} : { inheritFrom: inherit.inheritFrom }),
		};
	});
}

export interface ModelRecordChainsQuery {
	readonly snapshots: readonly ServerModelsSnapshot[];
	readonly reader: SettingsReader;
	readonly resolveEntryParameters: (serverId: string) => EntryParametersResolution | undefined;
	readonly resolveEntryCapabilities: (serverId: string) => EntryCapabilitiesRecord | undefined;
}

/**
 * One model's matching chains for the inspectors' inheritance figure, in the figure's one reading direction - lower
 * precedence first, winner last: the global map's chain above the entry map's, each chain itself broadest first. Maps
 * that match nothing contribute no chain; a stale scope key or a model no longer in its snapshot resolves to none.
 */
export function resolveModelRecordChains(
	query: ModelRecordChainsQuery,
	kind: "parameters" | "capabilities",
	scopeKey: string,
	rawId: string
): readonly RecordChainView[] {
	const located = locateModel(query.snapshots, scopeKey, rawId);
	if (located === undefined) {
		return [];
	}
	const labeled = located.labeled;
	const serverId = labeled.snapshot.status.serverId;
	const [globalRecords, entryRecords, entryLabel, parse] =
		kind === "parameters"
			? (() => {
					const entry = query.resolveEntryParameters(serverId);
					return [
						normalizeModelParameters(query.reader.get(MODEL_PARAMETERS_SETTING_KEY)),
						entry?.entryParameters,
						entry?.entryLabel,
						parseParameterRecord as (record: Readonly<Record<string, unknown>>, key: string) => ParsedRecord,
					] as const;
				})()
			: ([
					normalizeModelCapabilities(query.reader.get(MODEL_CAPABILITIES_SETTING_KEY)),
					query.resolveEntryCapabilities(serverId),
					// The capability resolver hands back only the record; the entry's label is the group's.
					labeled.snapshot.status.label,
					(record: Readonly<Record<string, unknown>>) => parseCapabilityRecord(record),
				] as const);
	const chains: RecordChainView[] = [];
	const globalLinks = recordChainLinks(rawId, globalRecords, parse);
	if (globalLinks.length > 0) {
		chains.push({ layer: "global", links: globalLinks });
	}
	if (entryRecords !== undefined && entryLabel !== undefined) {
		const links = recordChainLinks(rawId, entryRecords, parse);
		if (links.length > 0) {
			chains.push({ layer: "entry", entryLabel, links });
		}
	}
	return chains;
}

/** What one inheritance tree is built from: the records to draw, the models to walk through them, and the layer's parser and resolver. */
interface TreeBuild {
	readonly kind: "parameters" | "capabilities";
	readonly layer: "global" | "entry";
	readonly entryLabel: string | undefined;
	readonly records: ModelRecordMap;
	readonly models: readonly { readonly id: string }[];
	readonly parse: (record: Readonly<Record<string, unknown>>, key: string) => ParsedRecord;
	readonly resolveLayer: (id: string, records: ModelRecordMap) => { fields: ReadonlyMap<string, { value: unknown }> };
}

/** One model's resolved leaf under its winning key. */
interface TreeLeaf {
	readonly id: string;
	readonly resolvedText: string;
}

/**
 * What walking every model through a record map yields: each matched key's votes for its parent, the leaves under
 * each winning key, the model IDs no key matched, and the keys that failed to parse.
 */
interface ChainWalk {
	readonly parentVotes: ReadonlyMap<string, ReadonlyMap<string, number>>;
	readonly leavesByKey: ReadonlyMap<string, readonly TreeLeaf[]>;
	readonly unmatched: readonly string[];
	readonly invalidKeys: ReadonlySet<string>;
}

/** The tree's shape once the votes are counted: each parent's children (roots under ""), and each key's leaves. */
interface TreeShape {
	readonly childrenOf: ReadonlyMap<string, readonly string[]>;
	readonly leavesByKey: ReadonlyMap<string, readonly TreeLeaf[]>;
}

/**
 * Walk each model once through the records. The invalid keys are seeded map-wide, not from the visited chains: an
 * invalid key must report even when no model exists to walk a chain past it.
 */
function walkModelChains(build: TreeBuild): ChainWalk {
	const parentVotes = new Map<string, Map<string, number>>();
	const leavesByKey = new Map<string, TreeLeaf[]>();
	const unmatched: string[] = [];
	const invalidKeys = new Set<string>();
	for (const key of Object.keys(build.records)) {
		if (!parseMatcherKey(key).ok) {
			invalidKeys.add(key);
		}
	}

	const seenModelIds = new Set<string>();
	for (const model of build.models) {
		if (seenModelIds.has(model.id)) {
			continue;
		}
		seenModelIds.add(model.id);
		const { chain, diagnostics } = matchChain(model.id, build.records);
		for (const diagnostic of diagnostics) {
			invalidKeys.add(diagnostic.key);
		}
		if (chain.length === 0) {
			unmatched.push(model.id);
			continue;
		}
		chain.forEach((match, index) => {
			const parent = index === 0 ? "" : (chain[index - 1]?.key ?? "");
			const votes = parentVotes.get(match.key) ?? new Map<string, number>();
			votes.set(parent, (votes.get(parent) ?? 0) + 1);
			parentVotes.set(match.key, votes);
		});
		const winner = chain[chain.length - 1];
		if (winner !== undefined) {
			const resolved = build.resolveLayer(model.id, build.records);
			const resolvedText = [...resolved.fields.entries()]
				.map(([name, field]) => `${name} ${formatJsonValue(field.value)}`)
				.join(", ");
			const leaves = leavesByKey.get(winner.key) ?? [];
			leaves.push({ id: model.id, resolvedText });
			leavesByKey.set(winner.key, leaves);
		}
	}

	return { parentVotes, leavesByKey, unmatched, invalidKeys };
}

/** Each valid key's parent by majority vote; a key no chain visited is a root (parent ""). */
function parentsByVote(records: ModelRecordMap, walk: ChainWalk): Map<string, string> {
	const parentOf = new Map<string, string>();
	for (const key of Object.keys(records)) {
		if (walk.invalidKeys.has(key)) {
			continue;
		}
		const votes = walk.parentVotes.get(key);
		if (votes === undefined) {
			parentOf.set(key, "");
			continue;
		}
		let best = "";
		let bestCount = -1;
		for (const [parent, count] of votes) {
			if (count > bestCount) {
				best = parent;
				bestCount = count;
			}
		}
		parentOf.set(key, best);
	}

	return parentOf;
}

/** The children of each parent key, in record order. */
function childrenByParent(parentOf: ReadonlyMap<string, string>): Map<string, string[]> {
	const childrenOf = new Map<string, string[]>();
	for (const [key, parent] of parentOf) {
		const children = childrenOf.get(parent) ?? [];
		children.push(key);
		childrenOf.set(parent, children);
	}

	return childrenOf;
}

/**
 * One node and its subtree. The vote-based parent map cannot cycle (chains are acyclic per model), but `seen` keeps a
 * future edge case from recursing forever.
 */
function treeNode(key: string, seen: ReadonlySet<string>, build: TreeBuild, shape: TreeShape): RecordTreeNode {
	const parsed = build.parse(build.records[key] ?? {}, key);
	const inherit = inheritDisplay(parsed);
	const nextSeen = new Set(seen).add(key);
	return {
		key,
		fields: nodeFields(parsed),
		barrier: inherit.barrier,
		...(inherit.inheritFrom === undefined ? {} : { inheritFrom: inherit.inheritFrom }),
		children: (shape.childrenOf.get(key) ?? [])
			.filter((child) => !nextSeen.has(child))
			.map((child) => treeNode(child, nextSeen, build, shape)),
		models: shape.leavesByKey.get(key) ?? [],
	};
}

function buildTree(build: TreeBuild): RecordTreeView {
	const walk = walkModelChains(build);
	const childrenOf = childrenByParent(parentsByVote(build.records, walk));
	const shape: TreeShape = { childrenOf, leavesByKey: walk.leavesByKey };
	return {
		kind: build.kind,
		layer: build.layer,
		...(build.entryLabel === undefined ? {} : { entryLabel: build.entryLabel }),
		roots: (childrenOf.get("") ?? []).map((key) => treeNode(key, new Set(), build, shape)),
		unmatchedModelIds: [...walk.unmatched].sort((a, b) => a.localeCompare(b)),
		invalidKeys: [...walk.invalidKeys].sort((a, b) => a.localeCompare(b)),
	};
}

/** The two global record maps, normalized once per view. */
interface GlobalRecords {
	readonly parameters: ReturnType<typeof normalizeModelParameters>;
	readonly capabilities: ReturnType<typeof normalizeModelCapabilities>;
}

/** Every served model with the entry-layer inputs its server resolves, in labeled snapshot order. */
function walkModels(query: ResolvedModelsQuery): WalkModel[] {
	return labeledSnapshots(query.snapshots).flatMap(({ snapshot, label }) => {
		const serverId = snapshot.status.serverId;
		const entry = query.resolveEntryParameters(serverId);
		const entryCapabilities = query.resolveEntryCapabilities(serverId);
		const scopeKey = modelScopeKey(serverId);
		return snapshot.models.map((info) => ({
			serverId,
			serverLabel: label,
			scopeKey,
			rawId: info.litellm.rawModelId,
			entryLabel: entry?.entryLabel ?? (entryCapabilities === undefined ? undefined : snapshot.status.label),
			entryParameters: entry?.entryParameters,
			entryCapabilities,
			serverDeclared: info.litellm.serverDeclared,
		}));
	});
}

/** One row's parameter cells, name-sorted, through the shared table when the query carries one. */
function parameterCells(
	model: WalkModel,
	query: ResolvedModelsQuery,
	globalParameters: GlobalRecords["parameters"]
): ResolvedParamCell[] {
	const parameterInputs = { globalParameters, entryParameters: model.entryParameters };
	const resolvedParams =
		query.resolution === undefined
			? resolveModelParameters({ rawModelId: model.rawId, ...parameterInputs })
			: query.resolution.resolveParameters(model.serverId, model.rawId, parameterInputs);
	return [...resolvedParams.sources.entries()]
		.map(([name, source]) => ({
			name,
			valueText: formatJsonValue(resolvedParams.params[name]),
			layer: source.source.layer,
			key: source.source.key,
			...(source.inheritedBy === undefined ? {} : { inheritedBy: source.inheritedBy }),
			...(source.forced === true ? { forced: true as const } : {}),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** One row's capability cells, through the shared table when the query carries one. */
function capabilityCells(
	model: WalkModel,
	query: ResolvedModelsQuery,
	globalCapabilities: GlobalRecords["capabilities"]
): ResolvedCapCell[] {
	const capabilityInputs = {
		globalCapabilities,
		entryCapabilities: model.entryCapabilities,
		catalog: query.catalog,
		serverDeclared: model.serverDeclared,
	};
	const resolvedCaps =
		query.resolution === undefined
			? resolveModelCapabilities({ rawModelId: model.rawId, ...capabilityInputs })
			: query.resolution.resolveCapabilities(model.serverId, model.rawId, capabilityInputs);
	return Object.entries(resolvedCaps.fields).flatMap(([name, field]) =>
		field === undefined
			? []
			: [
					{
						name,
						valueText: formatJsonValue(field.value),
						level: field.level,
						...(field.key === undefined ? {} : { key: field.key }),
						...(field.inheritedBy === undefined ? {} : { inheritedBy: field.inheritedBy }),
					},
				]
	);
}

/** Every matcher key any of the four record maps matched for the model, sorted. */
function matchedKeysOf(model: WalkModel, globals: GlobalRecords): string[] {
	const matchedKeys = new Set<string>();
	for (const map of [
		globals.parameters,
		model.entryParameters ?? {},
		globals.capabilities,
		model.entryCapabilities ?? {},
	]) {
		for (const match of matchChain(model.rawId, map).chain) {
			matchedKeys.add(match.key);
		}
	}

	return [...matchedKeys].sort((a, b) => a.localeCompare(b));
}

/** One model's provenance row. */
function resolvedRow(model: WalkModel, query: ResolvedModelsQuery, globals: GlobalRecords): ResolvedModelRow {
	return {
		serverLabel: model.serverLabel,
		rawId: model.rawId,
		scopeKey: model.scopeKey,
		matchedKeys: matchedKeysOf(model, globals),
		parameters: parameterCells(model, query, globals.parameters),
		capabilities: capabilityCells(model, query, globals.capabilities),
	};
}

/**
 * The inheritance trees: the two global maps over every model, then each declared entry's own maps over that entry's
 * models, with the record count the view states.
 */
function recordTrees(
	query: ResolvedModelsQuery,
	models: readonly WalkModel[],
	globals: GlobalRecords
): { trees: RecordTreeView[]; recordCount: number } {
	const allModels = models.map((model) => ({ id: model.rawId }));
	const trees: RecordTreeView[] = [];
	const parseCapability = (record: Readonly<Record<string, unknown>>) => parseCapabilityRecord(record);
	const parameterTree = (
		layer: "global" | "entry",
		entryLabel: string | undefined,
		records: ModelRecordMap,
		scoped: TreeBuild["models"]
	) =>
		buildTree({
			kind: "parameters",
			layer,
			entryLabel,
			records,
			models: scoped,
			parse: parseParameterRecord,
			resolveLayer: resolveParameterLayer,
		});
	const capabilityTree = (
		layer: "global" | "entry",
		entryLabel: string | undefined,
		records: ModelRecordMap,
		scoped: TreeBuild["models"]
	) =>
		buildTree({
			kind: "capabilities",
			layer,
			entryLabel,
			records,
			models: scoped,
			parse: parseCapability,
			resolveLayer: resolveCapabilityLayer,
		});
	if (Object.keys(globals.parameters).length > 0) {
		trees.push(parameterTree("global", undefined, globals.parameters, allModels));
	}
	if (Object.keys(globals.capabilities).length > 0) {
		trees.push(capabilityTree("global", undefined, globals.capabilities, allModels));
	}

	let entryRecordCount = 0;
	for (const view of query.declared) {
		const entryModels = models.filter((candidate) => candidate.entryLabel === view.label).map((m) => ({ id: m.rawId }));
		if (view.modelParameters !== undefined && Object.keys(view.modelParameters).length > 0) {
			entryRecordCount += Object.keys(view.modelParameters).length;
			trees.push(parameterTree("entry", view.label, view.modelParameters, entryModels));
		}
		if (view.modelCapabilities !== undefined && Object.keys(view.modelCapabilities).length > 0) {
			entryRecordCount += Object.keys(view.modelCapabilities).length;
			trees.push(capabilityTree("entry", view.label, view.modelCapabilities, entryModels));
		}
	}

	const recordCount =
		Object.keys(globals.parameters).length + Object.keys(globals.capabilities).length + entryRecordCount;
	return { trees, recordCount };
}

export function buildResolvedModelsView(query: ResolvedModelsQuery): ResolvedModelsView {
	const globals: GlobalRecords = {
		parameters: normalizeModelParameters(query.reader.get(MODEL_PARAMETERS_SETTING_KEY)),
		capabilities: normalizeModelCapabilities(query.reader.get(MODEL_CAPABILITIES_SETTING_KEY)),
	};
	const models = walkModels(query);
	const rows = models.map((model) => resolvedRow(model, query, globals));
	rows.sort((a, b) => a.serverLabel.localeCompare(b.serverLabel) || a.rawId.localeCompare(b.rawId));
	const { trees, recordCount } = recordTrees(query, models, globals);

	return { trees, rows, recordCount };
}
