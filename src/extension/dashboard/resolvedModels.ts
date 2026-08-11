/**
 * The Resolved-models view builder: the Diagnostics tab's two renderings of
 * the precomputed resolution - the matcher-key inheritance trees and the flat
 * per-model provenance table - computed extension-side from the SAME
 * resolvers the request path and registration run (through the provider's
 * shared flat table when the query carries one), so what the tab shows is
 * exactly what will be sent.
 *
 * The tree is drawn against the live model set (docs/dashboard.md's honesty
 * note): each record nests under the record that most often precedes it in
 * the per-model matching chains, models leaf under their most specific
 * match, and records no current model matches sit at the root with no
 * leaves. Everything out is serializable data for the resolvedModels
 * response; the view is local to the dashboard and never enters issue
 * reports.
 */

import type { ServerModelsSnapshot } from "../../provider";
import { rawModelIdFromExposed } from "../../provider/catalog/modelCatalog";
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
import type { DeclaredServerView } from "../servers/serverSync";
import { modelScopeKey } from "./adoptHandle";
import type {
	RecordChainLink,
	RecordChainView,
	RecordTreeNode,
	RecordTreeView,
	ResolvedCapCell,
	ResolvedModelRow,
	ResolvedModelsView,
	ResolvedParamCell,
} from "./protocol";
import { formatJsonValue } from "./protocol";
import type { EntryCapabilitiesRecord, EntryParametersResolution, SettingsReader } from "./state";
import { labeledSnapshots } from "./state";

export interface ResolvedModelsQuery {
	readonly snapshots: readonly ServerModelsSnapshot[];
	readonly reader: SettingsReader;
	readonly resolveEntryParameters: (serverId: string) => EntryParametersResolution | undefined;
	readonly resolveEntryCapabilities: (serverId: string) => EntryCapabilitiesRecord | undefined;
	/**
	 * The declared entries' own record maps, straight from the setting: the
	 * entry TREES draw from these so an entry whose server currently serves
	 * zero models still renders its records (with empty leaves) instead of
	 * vanishing from the view.
	 */
	readonly declared: readonly Pick<DeclaredServerView, "label" | "modelParameters" | "modelCapabilities">[];
	readonly catalog: CapabilityCatalogLookup;
	readonly resolution?: ModelResolutionTable | undefined;
}

/** One model as the builder walks it: identity plus the per-server records that apply to it. */
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

/** The `_inherit_from` directive's display facts for a tree node. */
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

/** One record's own fields with their marks, for a tree node. */
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
 * One record map's matching chain for a model, as the inspectors' inheritance
 * figure renders it: matchChain's order (broadest first, the winner last)
 * with each record's inheritance display facts. The readModelParameters and
 * readModelCapabilities responders reuse this so the figure cannot drift from
 * the Diagnostics trees, which read the same inheritDisplay.
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
			...(inherit.inheritFrom !== undefined ? { inheritFrom: inherit.inheritFrom } : {}),
		};
	});
}

/** What resolveModelRecordChains reads; panel.ts supplies the same live stores the responders use. */
export interface ModelRecordChainsQuery {
	readonly snapshots: readonly ServerModelsSnapshot[];
	readonly reader: SettingsReader;
	readonly resolveEntryParameters: (serverId: string) => EntryParametersResolution | undefined;
	readonly resolveEntryCapabilities: (serverId: string) => EntryCapabilitiesRecord | undefined;
}

/**
 * One model's matching chains for the inspectors' inheritance figure, in the
 * figure's one reading direction - lower precedence first, winner last: the
 * global map's chain above the entry map's (entry beats global), each chain
 * itself broadest first. Maps that match nothing contribute no chain; a stale
 * scope key or a model no longer in its snapshot resolves to none, like the
 * responders.
 */
export function resolveModelRecordChains(
	query: ModelRecordChainsQuery,
	kind: "parameters" | "capabilities",
	scopeKey: string,
	rawId: string
): readonly RecordChainView[] {
	const labeled = labeledSnapshots(query.snapshots).find(
		(entry) => modelScopeKey(entry.snapshot.status.serverId) === scopeKey
	);
	if (labeled === undefined) {
		return [];
	}
	const serverId = labeled.snapshot.status.serverId;
	if (!labeled.snapshot.models.some((info) => rawModelIdFromExposed(info.id, serverId) === rawId)) {
		return [];
	}
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
					// The capability resolver hands back only the record; the entry's
					// label is the group's (the same join the resolver keys on).
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

/**
 * Build one record map's tree against the models it applies to. Chains order
 * records broadest first; each record's parent is its most frequent
 * immediate predecessor across the chains (records first in every chain, and
 * records matching no model, sit at the root). Leaves land under the model's
 * most specific match, showing the chain's resolved view for that model.
 */
function buildTree(
	kind: "parameters" | "capabilities",
	layer: "global" | "entry",
	entryLabel: string | undefined,
	records: ModelRecordMap,
	models: readonly { readonly id: string }[],
	parse: (record: Readonly<Record<string, unknown>>, key: string) => ParsedRecord,
	resolveLayer: (id: string, records: ModelRecordMap) => { fields: ReadonlyMap<string, { value: unknown }> }
): RecordTreeView {
	const parentVotes = new Map<string, Map<string, number>>();
	const leavesByKey = new Map<string, { id: string; resolvedText: string }[]>();
	const unmatched: string[] = [];
	// Seeded map-wide, not from the visited chains: an invalid key must report
	// even when no model exists to walk a chain past it.
	const invalidKeys = new Set<string>();
	for (const key of Object.keys(records)) {
		if (!parseMatcherKey(key).ok) {
			invalidKeys.add(key);
		}
	}
	const seenModelIds = new Set<string>();

	for (const model of models) {
		if (seenModelIds.has(model.id)) {
			continue;
		}
		seenModelIds.add(model.id);
		const { chain, diagnostics } = matchChain(model.id, records);
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
			const resolved = resolveLayer(model.id, records);
			const resolvedText = [...resolved.fields.entries()]
				.map(([name, field]) => `${name} ${formatJsonValue(field.value)}`)
				.join(", ");
			const leaves = leavesByKey.get(winner.key) ?? [];
			leaves.push({ id: model.id, resolvedText });
			leavesByKey.set(winner.key, leaves);
		}
	}

	// One parent per record: the most-voted immediate predecessor. Records in
	// no chain (no live model matches them) parent at the root.
	const parentOf = new Map<string, string>();
	for (const key of Object.keys(records)) {
		if (invalidKeys.has(key)) {
			continue;
		}
		const votes = parentVotes.get(key);
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

	const childrenOf = new Map<string, string[]>();
	for (const [key, parent] of parentOf) {
		const children = childrenOf.get(parent) ?? [];
		children.push(key);
		childrenOf.set(parent, children);
	}

	const buildNode = (key: string, seen: ReadonlySet<string>): RecordTreeNode => {
		const parsed = parse(records[key] ?? {}, key);
		const inherit = inheritDisplay(parsed);
		// The vote-based parent map cannot cycle (chains are acyclic per model),
		// but the guard keeps a future edge case from recursing forever.
		const nextSeen = new Set(seen).add(key);
		return {
			key,
			fields: nodeFields(parsed),
			barrier: inherit.barrier,
			...(inherit.inheritFrom !== undefined ? { inheritFrom: inherit.inheritFrom } : {}),
			children: (childrenOf.get(key) ?? [])
				.filter((child) => !nextSeen.has(child))
				.map((child) => buildNode(child, nextSeen)),
			models: leavesByKey.get(key) ?? [],
		};
	};

	return {
		kind,
		layer,
		...(entryLabel !== undefined ? { entryLabel } : {}),
		roots: (childrenOf.get("") ?? []).map((key) => buildNode(key, new Set())),
		unmatchedModelIds: unmatched.sort((a, b) => a.localeCompare(b)),
		invalidKeys: [...invalidKeys].sort((a, b) => a.localeCompare(b)),
	};
}

export function buildResolvedModelsView(query: ResolvedModelsQuery): ResolvedModelsView {
	const globalParameters = normalizeModelParameters(query.reader.get(MODEL_PARAMETERS_SETTING_KEY));
	const globalCapabilities = normalizeModelCapabilities(query.reader.get(MODEL_CAPABILITIES_SETTING_KEY));

	const models: WalkModel[] = labeledSnapshots(query.snapshots).flatMap(({ snapshot, label }) => {
		const serverId = snapshot.status.serverId;
		const entry = query.resolveEntryParameters(serverId);
		const entryCapabilities = query.resolveEntryCapabilities(serverId);
		const scopeKey = modelScopeKey(serverId);
		return snapshot.models.map((info) => ({
			serverId,
			serverLabel: label,
			scopeKey,
			rawId: rawModelIdFromExposed(info.id, serverId),
			entryLabel: entry?.entryLabel ?? (entryCapabilities !== undefined ? snapshot.status.label : undefined),
			entryParameters: entry?.entryParameters,
			entryCapabilities,
			serverDeclared: info.litellm.serverDeclared,
		}));
	});

	// The flat table: one row per (server, model), parameters and capabilities
	// resolved through the shared table when one rides the query.
	const rows: ResolvedModelRow[] = models.map((model) => {
		const parameterInputs = {
			globalParameters,
			entryParameters: model.entryParameters,
		};
		const resolvedParams =
			query.resolution !== undefined
				? query.resolution.resolveParameters(model.serverId, model.rawId, parameterInputs)
				: resolveModelParameters({ rawModelId: model.rawId, ...parameterInputs });
		const parameters: ResolvedParamCell[] = [...resolvedParams.sources.entries()]
			.map(([name, source]) => ({
				name,
				valueText: formatJsonValue(resolvedParams.params[name]),
				layer: source.source.layer,
				key: source.source.key,
				...(source.inheritedFrom !== undefined ? { inheritedFrom: source.inheritedFrom } : {}),
				...(source.forced === true ? { forced: true as const } : {}),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));

		const capabilityInputs = {
			globalCapabilities,
			entryCapabilities: model.entryCapabilities,
			catalog: query.catalog,
			serverDeclared: model.serverDeclared,
		};
		const resolvedCaps =
			query.resolution !== undefined
				? query.resolution.resolveCapabilities(model.serverId, model.rawId, capabilityInputs)
				: resolveModelCapabilities({ rawModelId: model.rawId, ...capabilityInputs });
		const capabilities: ResolvedCapCell[] = Object.entries(resolvedCaps.fields).flatMap(([name, field]) =>
			field === undefined
				? []
				: [
						{
							name,
							valueText: formatJsonValue(field.value),
							level: field.level,
							...(field.key !== undefined ? { key: field.key } : {}),
							...(field.inheritedFrom !== undefined ? { inheritedFrom: field.inheritedFrom } : {}),
						},
					]
		);

		const matchedKeys = new Set<string>();
		for (const map of [
			globalParameters,
			model.entryParameters ?? {},
			globalCapabilities,
			model.entryCapabilities ?? {},
		]) {
			for (const match of matchChain(model.rawId, map).chain) {
				matchedKeys.add(match.key);
			}
		}

		return {
			serverLabel: model.serverLabel,
			rawId: model.rawId,
			scopeKey: model.scopeKey,
			matchedKeys: [...matchedKeys].sort((a, b) => a.localeCompare(b)),
			parameters,
			capabilities,
		};
	});
	rows.sort((a, b) => a.serverLabel.localeCompare(b.serverLabel) || a.rawId.localeCompare(b.rawId));

	// The trees: the two global maps against every model, plus each entry's
	// own maps against that entry's models.
	const allModels = models.map((model) => ({ id: model.rawId }));
	const trees: RecordTreeView[] = [];
	const parseCapability = (record: Readonly<Record<string, unknown>>) => parseCapabilityRecord(record);
	if (Object.keys(globalParameters).length > 0) {
		trees.push(
			buildTree(
				"parameters",
				"global",
				undefined,
				globalParameters,
				allModels,
				parseParameterRecord,
				resolveParameterLayer
			)
		);
	}
	if (Object.keys(globalCapabilities).length > 0) {
		trees.push(
			buildTree(
				"capabilities",
				"global",
				undefined,
				globalCapabilities,
				allModels,
				parseCapability,
				resolveCapabilityLayer
			)
		);
	}
	// Entry trees draw from the DECLARED views, never from the live model
	// set: an entry whose server serves zero models right now must still
	// render its records (empty-leaved) rather than vanish. Its models, when
	// any exist, join by the resolved entry label.
	let entryRecordCount = 0;
	for (const view of query.declared) {
		const entryModels = models.filter((candidate) => candidate.entryLabel === view.label).map((m) => ({ id: m.rawId }));
		if (view.modelParameters !== undefined && Object.keys(view.modelParameters).length > 0) {
			entryRecordCount += Object.keys(view.modelParameters).length;
			trees.push(
				buildTree(
					"parameters",
					"entry",
					view.label,
					view.modelParameters,
					entryModels,
					parseParameterRecord,
					resolveParameterLayer
				)
			);
		}
		if (view.modelCapabilities !== undefined && Object.keys(view.modelCapabilities).length > 0) {
			entryRecordCount += Object.keys(view.modelCapabilities).length;
			trees.push(
				buildTree(
					"capabilities",
					"entry",
					view.label,
					view.modelCapabilities,
					entryModels,
					parseCapability,
					resolveCapabilityLayer
				)
			);
		}
	}

	const recordCount = Object.keys(globalParameters).length + Object.keys(globalCapabilities).length + entryRecordCount;

	return { trees, rows, recordCount };
}
