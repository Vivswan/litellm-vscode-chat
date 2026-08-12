import type { CapabilityCatalogLookup, ModelCapabilitiesRecord } from "../../shared/config/capabilityResolution";
import type { ModelResolutionTable } from "../../shared/config/resolutionTable";
import { getModelCapabilitiesConfig } from "../../shared/config/settings";
import type { ServerConfig } from "../../shared/servers";
import type { CapabilityOverrideOptions, DeclaredModelSynthesis } from "./capabilityOverrides";
import { applyCapabilityOverrides, synthesizeDeclaredModels } from "./capabilityOverrides";
import type { PreAttachModelInfo } from "./groupModels";
import type { ServerModelsSnapshot } from "./statusWindow";

/**
 * The label+URL identity entry configuration (modelCapabilities,
 * expectedFailures) resolves against for one served server; undefined when no
 * entry can match (an unlabeled group, or a server no longer in the status
 * window).
 */
export interface EntryIdentity {
	readonly label: string;
	readonly baseUrl: string;
}

export interface ServedModelDecoratorOptions {
	/** Per-entry modelCapabilities resolver, matched by label and normalized base URL. */
	getEntryModelCapabilities: (label: string, baseUrl: string) => ModelCapabilitiesRecord | undefined;
	/** Per-entry discovery.declared model IDs, matched like getEntryModelCapabilities. */
	getEntryDeclaredModels: (label: string, baseUrl: string) => readonly string[] | undefined;
	/** The OpenRouter catalog lookup, read at serve time so a refreshed snapshot reaches the next attach. */
	getCatalogLookup: () => CapabilityCatalogLookup;
	/** The shared flat resolution table; the same cache requests and the dashboard read. */
	resolution: ModelResolutionTable;
	// Facade-bound log callbacks: this module never touches a logger directly
	// (the provider facade is the single logging boundary).
	log: (message: string, data?: unknown) => void;
	logAdvisory: (message: string, data?: unknown) => void;
}

/**
 * Model-info preparation for one serve pass: capability overrides and
 * declared-model synthesis applied to a discovery result and the CURRENT
 * configuration. Applied outside the discovery cache on purpose - a
 * configuration edit reaches the next serve without a cache clear, and a
 * removed declared ID disappears immediately.
 */
export class ServedModelDecorator {
	private readonly _options: ServedModelDecoratorOptions;

	constructor(options: ServedModelDecoratorOptions) {
		this._options = options;
	}

	/**
	 * The capability configuration one serve pass resolves against, assembled
	 * from the injected seams. `entryLabel` names the declared entry candidate
	 * (a group's configured label); the injected resolver answers only when
	 * label and base URL identify the same declared entry, mirroring the
	 * request path's entry-parameters match.
	 */
	capabilityOptions(server: ServerConfig, entryLabel: string | undefined): CapabilityOverrideOptions {
		return {
			globalCapabilities: getModelCapabilitiesConfig(),
			entryCapabilities:
				entryLabel !== undefined ? this._options.getEntryModelCapabilities(entryLabel, server.baseUrl) : undefined,
			entryDeclaredModels:
				entryLabel !== undefined ? this._options.getEntryDeclaredModels(entryLabel, server.baseUrl) : undefined,
			catalog: this._options.getCatalogLookup(),
			resolution: this._options.resolution,
			log: (message, data) => this._options.log(message, data),
			// Advisory notes bypass the issue-report buffer; see Logger.advisory.
			logAdvisory: (message, data) => this._options.logAdvisory(message, data),
		};
	}

	/**
	 * Everything a serve pass hands out, derived from one discovery result and
	 * the CURRENT configuration: the discovered infos with capability
	 * overrides applied, and the declared models discovery did not list
	 * (inert against the discovered raw-ID set, suppressed on collision with a
	 * registered ID). The status window records the overridden result;
	 * declared models alone stay out of it.
	 */
	decorate(
		discovered: { readonly infos: readonly PreAttachModelInfo[]; readonly discoveredRawIds: readonly string[] },
		server: ServerConfig,
		entryLabel: string | undefined
	): { overridden: readonly PreAttachModelInfo[]; declared: DeclaredModelSynthesis } {
		const opts = this.capabilityOptions(server, entryLabel);
		const overridden = applyCapabilityOverrides(discovered.infos, server, opts);
		const declared = synthesizeDeclaredModels(
			new Set(discovered.discoveredRawIds),
			new Set(overridden.map((info) => info.id)),
			server,
			1,
			opts
		);
		return { overridden, declared };
	}

	/**
	 * The declared models the current configuration synthesizes for one
	 * status-window snapshot, for the dashboard's state builder:
	 * snapshots stay discovered-only (declared models are config-rebuilt every
	 * serve and never stored), so the dashboard merges this projection into
	 * each server's model list. The composition mirrors the serve path exactly
	 * - `identity` is the group's own configured label resolving the entry
	 * layer (status labels can be display fallbacks) - so the dashboard shows
	 * the same IDs, names, and entry-layer resolution the picker serves.
	 * Display-only, so record problems and suppressions do not re-log on every
	 * state push; the serve path already logged them.
	 */
	declaredModelsForSnapshot(
		snapshot: ServerModelsSnapshot,
		identity: EntryIdentity | undefined
	): readonly PreAttachModelInfo[] {
		const { status } = snapshot;
		const server: ServerConfig = {
			id: status.serverId,
			label: identity?.label ?? status.label,
			baseUrl: status.baseUrl,
		};
		return synthesizeDeclaredModels(
			new Set(snapshot.discoveredRawIds),
			new Set(snapshot.models.map((info) => info.id)),
			server,
			1,
			{ ...this.capabilityOptions(server, identity?.label), log: () => {}, logAdvisory: () => {} }
		).infos;
	}
}
