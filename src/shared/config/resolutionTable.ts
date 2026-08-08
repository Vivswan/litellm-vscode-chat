/**
 * The precomputed flat resolution table: per (server, model), the resolved
 * models.parameters merge and the effective capabilities, memoized so the
 * matcher-and-inheritance walk never runs per request. One instance is owned
 * by the provider and shared by every consumer - the chat request path, the
 * registration decorator, and the dashboard's inspectors all read the SAME
 * cache, so they cannot disagree.
 *
 * Invalidation is by input fingerprint, not by listener wiring: every lookup
 * passes the current inputs, and a changed fingerprint recomputes the entry.
 * The record maps and the server baseline are small JSON-shaped
 * configuration, fingerprinted by serialization; the catalog is a lookup
 * interface whose backing data can swap behind a stable facade (the store
 * replaces its inner snapshot on refresh), so a capability entry instead
 * records exactly the catalog queries its resolution made and replays them
 * against the current lookup on every hit - identical answers mean the
 * cached resolution is still exact, a changed answer recomputes. A settings
 * edit, an entry edit, a discovery change, or a catalog refresh therefore
 * reaches the very next lookup with no event plumbing to forget, while the
 * steady state costs one small serialization and a couple of map lookups
 * instead of a resolution walk. The seed-pinned equivalence property pins
 * table output == direct resolver output.
 */

import type {
	CapabilityCatalogLookup,
	EffectiveCapabilities,
	ModelCapabilitiesRecord,
	ServerDeclaredCapabilities,
} from "./capabilityResolution";
import { resolveModelCapabilities } from "./capabilityResolution";
import type { ModelParametersRecord, ResolvedModelParameters } from "./parameterResolution";
import { resolveModelParameters } from "./parameterResolution";

export interface ParameterResolutionInputs {
	/** The models.parameters setting as the request path reads it (normalizeModelParameters output). */
	readonly globalParameters: ModelParametersRecord;
	/** The declared server entry's own record, when the request routes through one. */
	readonly entryParameters?: ModelParametersRecord | undefined;
}

export interface CapabilityResolutionInputs {
	/** The models.capabilities setting as normalizeModelCapabilities returns it. */
	readonly globalCapabilities: ModelCapabilitiesRecord;
	/** The declared server entry's own capability records, when one matched. */
	readonly entryCapabilities?: ModelCapabilitiesRecord | undefined;
	readonly serverDeclared: ServerDeclaredCapabilities;
	readonly catalog: CapabilityCatalogLookup;
}

interface ParameterEntry {
	readonly fingerprint: string;
	readonly resolved: ResolvedModelParameters;
}

/** One catalog question a cached resolution asked, with the answer it got (serialized). */
interface CatalogProbe {
	readonly method: keyof CapabilityCatalogLookup;
	readonly id: string;
	readonly answer: string;
}

interface CapabilityEntry {
	readonly fingerprint: string;
	readonly probes: readonly CatalogProbe[];
	readonly resolved: EffectiveCapabilities;
}

/**
 * The record maps arrive as plain JSON-shaped configuration, so
 * JSON.stringify is a faithful fingerprint (key order rides along, which is
 * load-bearing: record order is part of the matcher's regex tie rule). A
 * spurious mismatch merely recomputes - stale reads are impossible by
 * construction.
 */
function fingerprintOf(parts: readonly unknown[]): string {
	return JSON.stringify(parts);
}

/** A catalog wrapper that records every query and its serialized answer. */
function recordingCatalog(catalog: CapabilityCatalogLookup): {
	lookup: CapabilityCatalogLookup;
	probes: CatalogProbe[];
} {
	const probes: CatalogProbe[] = [];
	const ask = (method: keyof CapabilityCatalogLookup, id: string) => {
		const result = catalog[method](id);
		probes.push({ method, id, answer: JSON.stringify(result) });
		return result;
	};
	return {
		lookup: { byExactId: (id) => ask("byExactId", id), byRawModelId: (rawId) => ask("byRawModelId", rawId) },
		probes,
	};
}

/** Whether the current catalog still answers every recorded query the same way. */
function probesStillHold(probes: readonly CatalogProbe[], catalog: CapabilityCatalogLookup): boolean {
	return probes.every((probe) => JSON.stringify(catalog[probe.method](probe.id)) === probe.answer);
}

/**
 * Per-server model-entry bound: whole servers are pruned with the provider's
 * other caches, but a server can rotate model IDs indefinitely, so the
 * per-server map evicts its oldest entry past this bound (an evicted entry
 * merely recomputes on its next lookup).
 */
const MAX_MODELS_PER_SERVER = 512;

export class ModelResolutionTable {
	private readonly parameters = new Map<string, Map<string, ParameterEntry>>();
	private readonly capabilities = new Map<string, Map<string, CapabilityEntry>>();

	/** The resolved configured parameters for one model on one server; recomputed only when the inputs changed. */
	resolveParameters(serverKey: string, rawModelId: string, inputs: ParameterResolutionInputs): ResolvedModelParameters {
		const fingerprint = fingerprintOf([inputs.globalParameters, inputs.entryParameters ?? null]);
		const byModel = mapFor(this.parameters, serverKey);
		const cached = byModel.get(rawModelId);
		if (cached !== undefined && cached.fingerprint === fingerprint) {
			return cached.resolved;
		}
		const resolved = resolveModelParameters({
			rawModelId,
			globalParameters: inputs.globalParameters,
			entryParameters: inputs.entryParameters,
		});
		remember(byModel, rawModelId, { fingerprint, resolved });
		return resolved;
	}

	/** The effective capabilities for one model on one server; recomputed only when the inputs changed. */
	resolveCapabilities(
		serverKey: string,
		rawModelId: string,
		inputs: CapabilityResolutionInputs
	): EffectiveCapabilities {
		const fingerprint = fingerprintOf([
			inputs.globalCapabilities,
			inputs.entryCapabilities ?? null,
			inputs.serverDeclared,
		]);
		const byModel = mapFor(this.capabilities, serverKey);
		const cached = byModel.get(rawModelId);
		if (cached !== undefined && cached.fingerprint === fingerprint && probesStillHold(cached.probes, inputs.catalog)) {
			return cached.resolved;
		}
		const recording = recordingCatalog(inputs.catalog);
		const resolved = resolveModelCapabilities({
			rawModelId,
			globalCapabilities: inputs.globalCapabilities,
			entryCapabilities: inputs.entryCapabilities,
			catalog: recording.lookup,
			serverDeclared: inputs.serverDeclared,
		});
		remember(byModel, rawModelId, { fingerprint, probes: recording.probes, resolved });
		return resolved;
	}

	/** Drop entries for servers no longer served; mirrors the provider's other per-server caches. */
	prune(keepServerKeys: readonly string[]): void {
		const keep = new Set(keepServerKeys);
		for (const key of this.parameters.keys()) {
			if (!keep.has(key)) {
				this.parameters.delete(key);
			}
		}
		for (const key of this.capabilities.keys()) {
			if (!keep.has(key)) {
				this.capabilities.delete(key);
			}
		}
	}

	clear(): void {
		this.parameters.clear();
		this.capabilities.clear();
	}
}

function mapFor<T>(store: Map<string, Map<string, T>>, serverKey: string): Map<string, T> {
	let byModel = store.get(serverKey);
	if (byModel === undefined) {
		byModel = new Map();
		store.set(serverKey, byModel);
	}
	return byModel;
}

/** Store one memo entry, evicting the oldest past the per-server bound (Map order is insertion order). */
function remember<T>(byModel: Map<string, T>, rawModelId: string, entry: T): void {
	if (!byModel.has(rawModelId) && byModel.size >= MAX_MODELS_PER_SERVER) {
		const oldest = byModel.keys().next();
		if (!oldest.done) {
			byModel.delete(oldest.value);
		}
	}
	byModel.set(rawModelId, entry);
}
