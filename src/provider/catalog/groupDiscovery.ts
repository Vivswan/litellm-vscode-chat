import { getDiscoveryCacheTtl } from "../../shared/config/settings";
import type { UnservedEndpointEvidence } from "../../shared/errorClassification";
import { MirroredError } from "../../shared/mirroredError";
import type { ExpectedFailureCategory } from "../../shared/serverEntry";
import { apiRootOf } from "../../shared/util/baseUrl";
import type { ChatClient, ServerConnection } from "../transport/chatClient";
import { statusErrorTexts } from "../transport/errorMapping";
import type { ExpectedDiscoveryFailures } from "./discovery";
import type { DiscoveryCache } from "./discoveryCache";
import type { AttachedModelInfo, GroupServer, LiteLLMModelInfo, PreAttachModelInfo } from "./groupModels";
import { attachGroupServer, groupClientId, groupServerLabel, markStale } from "./groupModels";
import { buildModelInfos } from "./registration";
import type { ServedModelDecorator } from "./servedModels";
import type { GroupServeOutcome, GroupStatusReporter } from "./statusReporting";
import type { DiscoveryObservations, StatusWindow } from "./statusWindow";

/** GroupServeOutcome minus the served-set counts, which recordAndServe derives from the served pair. */
type ServeOutcomeShape =
	| Omit<Extract<GroupServeOutcome, { state: "ok" }>, "modelCount">
	| Omit<Extract<GroupServeOutcome, { state: "error" }>, "declaredModelCount">;

/**
 * One server's cached discovery result: the registered infos plus the raw
 * model IDs discovery returned. Cache hits need the raw-ID set for declared-ID
 * inertness - the registered infos alone may hold only synthetic variants
 * (`foo:cheapest`) of a discovered `foo`, and a declared `foo` must stay
 * inert. The cache stays configuration-free: overrides and declared models
 * are applied where models are served, never stored.
 */
export interface DiscoveredGroupModels {
	readonly infos: readonly PreAttachModelInfo[];
	readonly discoveredRawIds: readonly string[];
	/**
	 * The API root the models were fetched from. The cache key (the group
	 * client ID) does not cover the entry's apiVersion - it lives outside the
	 * group configuration - so a serve whose effective root differs treats the
	 * entry as a miss instead of serving models from the old root for the rest
	 * of the TTL.
	 */
	readonly apiRoot: string;
	/** See FetchModelsResult.observedModelInfoKeys; rides the cache so cached serves re-report it. */
	readonly observedModelInfoKeys?: readonly string[];
	/**
	 * See FetchModelsResult.modelInfoUnsupported; rides the cache so cached
	 * serves re-report it. The serve gates it against the entry's CURRENT
	 * expectedFailures, so declaring the failure retires the hint immediately
	 * instead of waiting out the cache TTL.
	 */
	readonly modelInfoUnsupported?: UnservedEndpointEvidence;
}

export interface GroupDiscoveryOptions {
	/** The transport's model listing; its errors arrive unlogged and are logged once here at the boundary. */
	client: Pick<ChatClient, "fetchModels">;
	cache: DiscoveryCache<DiscoveredGroupModels>;
	reporter: GroupStatusReporter;
	/** The facade-owned live window; read for the error path's stale-servable fallback. */
	window: Pick<StatusWindow, "staleServableModels">;
	decorator: ServedModelDecorator;
	/**
	 * The same apiVersion resolver ChatClient consumes, kept here for the
	 * discovery cache's root check: a cached result carries the API root it
	 * was fetched from, and a serve resolving to a different root must miss.
	 */
	getEntryApiVersion: (label: string, baseUrl: string) => string | undefined;
	/** Per-entry expectedFailures resolver, matched by label and normalized base URL. */
	getExpectedFailures: (label: string, baseUrl: string) => readonly ExpectedFailureCategory[] | undefined;
	/** The extension layer's tombstone predicate; see LiteLLMChatModelProviderOptions.isGroupSuppressed. */
	isGroupSuppressed: (label: string, baseUrl: string) => boolean;
	// Facade-bound log callbacks: this module logs only through them, so the
	// provider facade stays the single logging boundary.
	log: (message: string, data?: unknown) => void;
	logError: (message: string, error: unknown) => void;
}

/**
 * The per-group discovery pass: cache-preferred model resolution for one
 * VS Code-managed provider group, including the silent-refresh stale-window
 * fallback. Every outcome (served, suppressed, failed) records through the
 * reporter, so the merged status stays live across cached sweeps.
 */
export class GroupDiscovery {
	private readonly _options: GroupDiscoveryOptions;

	constructor(options: GroupDiscoveryOptions) {
		this._options = options;
	}

	/** The declared entry's expectedFailures for this server, or none for unlabeled and unmatched servers. */
	private expectedFailuresFor(entryLabel: string | undefined, baseUrl: string): readonly ExpectedFailureCategory[] {
		return (entryLabel !== undefined ? this._options.getExpectedFailures(entryLabel, baseUrl) : undefined) ?? [];
	}

	/** The entry's categories in discovery's per-endpoint shape; see ExpectedDiscoveryFailures. */
	private expectedDiscoveryFailures(entryLabel: string | undefined, baseUrl: string): ExpectedDiscoveryFailures {
		const categories = this.expectedFailuresFor(entryLabel, baseUrl);
		return { modelInfo: categories.includes("modelInfo"), modelListing: categories.includes("modelListing") };
	}

	/**
	 * Resolve one group's models, preferring the discovery cache: a fresh
	 * cached result is served without a network call but still reports its
	 * remembered outcome, so the merged status (and the cycle bookkeeping that
	 * ages groups out) stays live across cached sweeps. Cache misses go through
	 * the single-flight fetch, so a burst of host calls for one group costs one
	 * request. `bypassCache` drops the stored result first, forcing the network.
	 *
	 * The cache holds pre-attach infos; the group server is attached on every
	 * read, so each sweep hands the host fresh objects and nothing the host
	 * mutates in place can be pinned into later sweeps. Attaching the full group
	 * server also means cached sweeps route chat requests with the current
	 * credentials; the cache key fingerprints those credentials, so rotating any
	 * of them lands on a fresh cache entry.
	 */
	async fetchGroupModels(groupServer: GroupServer, silent: boolean, bypassCache = false): Promise<LiteLLMModelInfo[]> {
		const server: ServerConnection = {
			id: groupClientId(groupServer),
			label: groupServer.label ?? groupServerLabel(groupServer.baseUrl),
			baseUrl: groupServer.baseUrl,
			apiKey: groupServer.apiKey,
			// The configured label only: an unlabeled group's display fallback
			// (the URL host) must not accidentally match a declared entry.
			entryLabel: groupServer.label,
			...(groupServer.oauth !== undefined ? { oauth: groupServer.oauth } : {}),
			...(groupServer.virtualKey !== undefined ? { virtualKey: groupServer.virtualKey } : {}),
		};
		const attach = (infos: readonly PreAttachModelInfo[]): AttachedModelInfo[] =>
			infos.map((info) => attachGroupServer(info, groupServer));
		// Every outcome records and serves through here: the reporter gets exactly
		// the overridden set the return value carries, and both outcome counts
		// derive from the same pair, so no branch can record one set and serve another.
		const recordAndServe = (
			models: { overridden: readonly PreAttachModelInfo[]; declared: readonly PreAttachModelInfo[] },
			outcome: ServeOutcomeShape,
			observations: DiscoveryObservations = {}
		): { served: AttachedModelInfo[]; discovered: AttachedModelInfo[]; declared: AttachedModelInfo[] } => {
			let recorded: GroupServeOutcome;
			if (outcome.state === "ok") {
				const { state, ...rest } = outcome;
				recorded = { state, modelCount: models.overridden.length + models.declared.length, ...rest };
			} else {
				recorded = {
					...outcome,
					...(models.declared.length > 0 ? { declaredModelCount: models.declared.length } : {}),
				};
			}
			this._options.reporter.reportGroupStatus(server, groupServer, silent, recorded, models.overridden, observations);
			const discovered = attach(models.overridden);
			const declared = attach(models.declared);
			return { served: [...discovered, ...declared], discovered, declared };
		};

		// A group the user explicitly removed answers empty and never touches
		// the network or the cache. Its status still reports (healthy with zero
		// models, flagged hiddenByRemoval) so the status window ages it like any
		// live group and the dashboard's hidden-groups view stays coherent.
		if (this._options.isGroupSuppressed(server.label, groupServer.baseUrl)) {
			this._options.log("Provider group is hidden by an explicit user removal; serving no models", {
				baseUrl: server.baseUrl,
			});
			return recordAndServe({ overridden: [], declared: [] }, { state: "ok", hiddenByRemoval: true }).served;
		}

		// The effective API root, resolved exactly the way the transport
		// resolves it (only a labeled group can match an entry). Computed
		// before the cache read: a cached result from a different root is
		// stale configuration, not a hit.
		const effectiveApiRoot = apiRootOf(
			server.baseUrl,
			groupServer.label !== undefined ? this._options.getEntryApiVersion(groupServer.label, server.baseUrl) : undefined
		);
		// Resolved before the cache read: the ok-path hint below gates on the
		// entry's CURRENT declarations, cached serve or fresh.
		const expectedFailures = this.expectedDiscoveryFailures(groupServer.label, server.baseUrl);
		// The unserved-probe hint one ok serve carries; see DiscoveredGroupModels.modelInfoUnsupported.
		const probeHint = (
			discovered: Pick<DiscoveredGroupModels, "modelInfoUnsupported">
		): { modelInfoUnsupported?: UnservedEndpointEvidence } =>
			discovered.modelInfoUnsupported !== undefined && !expectedFailures.modelInfo
				? { modelInfoUnsupported: discovered.modelInfoUnsupported }
				: {};
		if (bypassCache) {
			this._options.cache.invalidate(server.id);
		} else {
			const ttl = getDiscoveryCacheTtl((msg, data) => this._options.log(msg, data));
			const cached = this._options.cache.lookup(server.id, ttl);
			if (cached !== undefined && cached.apiRoot !== effectiveApiRoot) {
				// The entry's apiVersion changed under the same group identity;
				// the stored models came from the old root. dropStored, not
				// invalidate: a concurrent serve may already be reloading the
				// corrected root, and its store must survive.
				this._options.cache.dropStored(server.id);
			} else if (cached !== undefined) {
				const { overridden, declared } = this._options.decorator.decorate(cached, server, groupServer.label);
				this._options.log("Serving provider group models from the discovery cache", {
					baseUrl: server.baseUrl,
					count: overridden.length + declared.infos.length,
				});
				return recordAndServe(
					{ overridden, declared: declared.infos },
					{ state: "ok", ...probeHint(cached) },
					{
						discoveredRawIds: cached.discoveredRawIds,
						observedModelInfoKeys: cached.observedModelInfoKeys,
					}
				).served;
			}
		}

		this._options.log("Fetching models for provider group", { baseUrl: server.baseUrl, silent });
		try {
			const load = async (): Promise<DiscoveredGroupModels> => {
				const { models, observedModelInfoKeys, modelInfoUnsupported } = await this._options.client.fetchModels(
					server,
					expectedFailures
				);
				return {
					infos: buildModelInfos(models, server, 1, (msg) => this._options.log(msg)).infos,
					discoveredRawIds: models.map((model) => model.id),
					apiRoot: effectiveApiRoot,
					...(observedModelInfoKeys !== undefined ? { observedModelInfoKeys } : {}),
					...(modelInfoUnsupported !== undefined ? { modelInfoUnsupported } : {}),
				};
			};
			let discovered = await this._options.cache.fetch(server.id, load);
			if (discovered.apiRoot !== effectiveApiRoot) {
				// Single-flight is keyed by group ID alone, so this serve joined a
				// load that started before the entry's apiVersion changed. Its
				// result is the old root's; drop it and load the current root.
				// dropStored, not invalidate: with several joiners correcting at
				// once, the first one's fresh reload is already in flight and the
				// rest must join it WITHOUT stripping its right to cache.
				this._options.cache.dropStored(server.id);
				discovered = await this._options.cache.fetch(server.id, load);
			}
			// Overrides and declared models are applied to what is SERVED: the
			// discovery cache stays configuration-free, so an edit reaches the
			// very next serve. The status window records the served (overridden)
			// models; declared models alone are config-rebuilt every serve and
			// never recorded.
			const { overridden, declared } = this._options.decorator.decorate(discovered, server, groupServer.label);
			this._options.log(`Provider group at ${server.baseUrl} returned ${discovered.infos.length} models`);
			return recordAndServe(
				{ overridden, declared: declared.infos },
				{ state: "ok", ...probeHint(discovered) },
				{
					discoveredRawIds: discovered.discoveredRawIds,
					observedModelInfoKeys: discovered.observedModelInfoKeys,
				}
			).served;
		} catch (error) {
			const expected = expectedFailures.modelListing;
			if (expected) {
				// The one boundary log for an expected terminal failure: an info
				// classification instead of an error, keeping the issue-report
				// buffer clean of failures the user declared normal.
				this._options.log(`Model discovery failed (expected: modelListing) for provider group`, {
					baseUrl: server.baseUrl,
				});
			} else {
				this._options.logError(`Failed to fetch models for provider group at ${server.baseUrl}`, error);
			}
			// Both status renderings are constructed at this boundary.
			const texts = statusErrorTexts(error);
			// The window's last known models ride along with the error status, so
			// a group that just failed does not lose its last-served set: a silent
			// refresh returns those models decorated as stale instead of making
			// them vanish. Retention is anchored to the last SUCCESSFUL discovery,
			// and the banner names the same success time, so repeated failures
			// cannot make the data look freshly checked. Past the window the
			// failure serves the empty list. The window is the honest source here:
			// it is this session's live state, unlike the extension layer's
			// persisted status. Declared models are rebuilt from the current
			// configuration and merged in un-staled; a declared ID the last
			// discovery listed stays inert against the stale set. Test Connection
			// (non-silent) still throws, except that an expected failure with
			// declared models serves the declared set instead.
			const stale = this._options.window.staleServableModels(server.id);
			const { overridden, declared } = this._options.decorator.decorate(
				stale !== undefined
					? { infos: stale.models, discoveredRawIds: stale.discoveredRawIds }
					: { infos: [], discoveredRawIds: [] },
				server,
				groupServer.label
			);
			// Recorded is what is served, by construction of recordAndServe. Safe
			// against the stale source: it anchors to the last SUCCESS bundle, so
			// this record cannot bake a mid-outage edit into later serves.
			const failureServe = recordAndServe(
				{ overridden, declared: declared.infos },
				{
					state: "error",
					...texts,
					...(expected ? { expected: true } : {}),
				},
				{ discoveredRawIds: stale?.discoveredRawIds ?? [] }
			);
			if (silent) {
				// No success anchor means nothing servable: an empty literal, not the
				// attached set, so a decorator surprise cannot serve unmarked models.
				const staleServed =
					stale !== undefined ? markStale(failureServe.discovered, new Date(stale.lastSuccessAt).toLocaleString()) : [];
				return [...staleServed, ...failureServe.declared];
			}
			if (expected && declared.infos.length > 0) {
				return failureServe.declared;
			}
			// A non-Error throw is rebuilt with the status's log-safe rendering as
			// its mirror: the display text can embed response body and must never
			// reach the log path.
			throw error instanceof Error ? error : new MirroredError(texts.error, { englishMessage: texts.logSafeError });
		}
	}
}
