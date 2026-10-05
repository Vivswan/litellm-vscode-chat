import { getDiscoveryCacheTtl } from "../../shared/config/settings";
import type { UnservedEndpointEvidence } from "../../shared/errorClassification";
import { MirroredError } from "../../shared/mirroredError";
import type { ExpectedFailureCategory, NonChatMode, SkippedModeCounts } from "../../shared/serverEntry";
import { apiRootOf } from "../../shared/util/baseUrl";
import type { ChatClient, ServerConnection } from "../transport/chatClient";
import { statusErrorTexts } from "../transport/errorMapping";
import type { ExpectedDiscoveryFailures } from "./discovery";
import type { DiscoveryCache } from "./discoveryCache";
import type { AttachedModelInfo, GroupServer, LiteLLMModelInfo, PreAttachModelInfo } from "./groupModels";
import { attachGroup, groupClientId, groupServerLabel, markStale } from "./groupModels";
import { buildModelInfos } from "./registration";
import type { ServedModelDecorator } from "./servedModels";
import type { GroupServeOutcome, GroupStatusReporter } from "./statusReporting";
import type { DiscoveryObservations, ServedModelSets, StatusWindow } from "./statusWindow";
import { groupIdentity, logicalGroupId } from "./statusWindow";

/** GroupServeOutcome minus the served-set counts, which recordAndServe derives from the served pair. */
type OkServeShape = Omit<Extract<GroupServeOutcome, { state: "ok" }>, "servedModelCount">;
type FailureServeShape = Omit<
	Extract<GroupServeOutcome, { state: "error" }>,
	"servedModelCount" | "declaredModelCount"
>;

type AttachedServe = {
	served: AttachedModelInfo[];
	discovered: AttachedModelInfo[];
	declared: AttachedModelInfo[];
};

/** Only an ok serve may carry observations; the failure signature has none, matching StatusWindow.record. */
type RecordAndServe = {
	(served: ServedModelSets, outcome: OkServeShape, observations?: DiscoveryObservations): AttachedServe;
	(served: ServedModelSets, outcome: FailureServeShape): AttachedServe;
};

/**
 * Configuration-free, so overrides and declared models are applied where models are served, never stored.
 * The raw-ID set rides along because the infos alone may hold only synthetic variants (`foo:cheapest`) of a
 * discovered `foo`, and a declared `foo` must stay inert on a cache hit.
 */
export interface DiscoveredGroupModels {
	readonly infos: readonly PreAttachModelInfo[];
	readonly discoveredRawIds: readonly string[];
	/** See FetchModelsResult.observedModelInfoKeys; rides the cache so cached serves re-report it. */
	readonly observedModelInfoKeys?: readonly string[];
	/** See FetchModelsResult.skippedModeCounts; rides the cache so cached serves re-report it. */
	readonly skippedModeCounts?: SkippedModeCounts;
	/**
	 * See FetchModelsResult.modelInfoUnsupported; rides the cache so cached serves re-report it. The serve gates it
	 * against the entry's CURRENT expectedFailures, so declaring the failure retires the hint immediately instead of
	 * waiting out the cache TTL.
	 */
	readonly modelInfoUnsupported?: UnservedEndpointEvidence;
}

/**
 * The apiVersion and includeModes live outside the group configuration yet change what a fetch yields, so both join
 * the group client ID, and every cache touch composes through here so a rotated root's or an edited mode list's entry
 * is unreachable and pruned alike. JSON-encoded, not delimiter-joined, or shifted free-form content could collide (the
 * oauthCredentialFingerprint rule).
 */
function discoveryCacheKey(groupClientId: string, apiRoot: string, includeModes: readonly NonChatMode[]): string {
	return JSON.stringify([groupClientId, apiRoot, [...includeModes].sort()]);
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
	 * The same apiVersion resolver ChatClient consumes, kept here so the discovery cache key can compose the effective
	 * API root a serve would fetch from: a serve resolving to a different root lands on a different key and misses by
	 * construction.
	 */
	getEntryApiVersion: (label: string, baseUrl: string) => string | undefined;
	/** Per-entry expectedFailures resolver, matched by label and normalized base URL. */
	getExpectedFailures: (label: string, baseUrl: string) => readonly ExpectedFailureCategory[] | undefined;
	/** Per-entry includeModes resolver, matched like getExpectedFailures; it also keys the discovery cache. */
	getEntryIncludeModes: (label: string, baseUrl: string) => readonly NonChatMode[] | undefined;
	/** The extension layer's tombstone predicate; see LiteLLMChatModelProviderOptions.isGroupSuppressed. */
	isGroupSuppressed: (label: string, baseUrl: string, entryLabel: string | undefined) => boolean;
	// Facade-bound log callbacks: this module logs only through them, so the provider facade stays the single logging
	// boundary.
	log: (message: string, data?: unknown) => void;
	logError: (message: string, error: unknown) => void;
}

export class GroupDiscovery {
	private readonly _options: GroupDiscoveryOptions;
	/**
	 * The claim counter, keyed by the pre-overlay claim key (a labeled group's logicalGroupId, else its client ID):
	 * index.ts claims the generation before its first await, so arrival order at the facade decides which serve's
	 * record stands, not resolver or fetch completion order.
	 */
	private readonly _serveGenerations = new Map<string, number>();
	/**
	 * The newest generation that has RECORDED, keyed by the group's IDENTITY (statusWindow.ts groupIdentity), so two
	 * unowned twins sharing a claim key never yield to each other. A serve yields to a newer record, never to a newer
	 * claim: until the newer serve lands, the older one's record is the only thing that makes its served models
	 * routable, and the newer record replaces it the moment it lands.
	 */
	private readonly _recordedGenerations = new Map<string, number>();

	constructor(options: GroupDiscoveryOptions) {
		this._options = options;
	}

	/**
	 * Claim the next serve generation, SYNCHRONOUSLY and before any await in the caller: the overlay never changes
	 * label or base URL, and an unlabeled group's client ID never changes either, so the pre-overlay parse is a valid
	 * claim ticket.
	 */
	beginServe(groupServer: GroupServer): number {
		const claimKey = logicalGroupId(groupServer) ?? groupClientId(groupServer);
		const generation = (this._serveGenerations.get(claimKey) ?? 0) + 1;
		this._serveGenerations.set(claimKey, generation);
		return generation;
	}

	private expectedFailuresFor(entryLabel: string | undefined, baseUrl: string): readonly ExpectedFailureCategory[] {
		return (entryLabel !== undefined ? this._options.getExpectedFailures(entryLabel, baseUrl) : undefined) ?? [];
	}

	private includeModesFor(entryLabel: string | undefined, baseUrl: string): readonly NonChatMode[] {
		return (entryLabel !== undefined ? this._options.getEntryIncludeModes(entryLabel, baseUrl) : undefined) ?? [];
	}

	private expectedDiscoveryFailures(entryLabel: string | undefined, baseUrl: string): ExpectedDiscoveryFailures {
		const categories = this.expectedFailuresFor(entryLabel, baseUrl);
		return { modelInfo: categories.includes("modelInfo"), modelListing: categories.includes("modelListing") };
	}

	/**
	 * The facade builds its prune keep-set through this same method, so an entry keyed under a rotated root -
	 * unreachable to every serve - ages out at the next prune instead of lingering with the old root's models.
	 */
	cacheKeyFor(groupServer: GroupServer): string {
		const apiRoot = apiRootOf(
			groupServer.baseUrl,
			groupServer.label !== undefined
				? this._options.getEntryApiVersion(groupServer.label, groupServer.baseUrl)
				: undefined
		);
		return discoveryCacheKey(
			groupClientId(groupServer),
			apiRoot,
			this.includeModesFor(groupServer.label, groupServer.baseUrl)
		);
	}

	/**
	 * A fresh cached result still reports its remembered outcome, so the merged status and the group-aging
	 * cycle bookkeeping stay live across cached sweeps. Every read stamps the group's identity onto a fresh outer
	 * object (nested metadata stays shared); the credential fingerprint of the CURRENT connection keys the cache.
	 */
	async fetchGroupModels(
		groupServer: GroupServer,
		silent: boolean,
		bypassCache = false,
		/** The beginServe claim for this serve; absent for callers with no earlier await. */
		generation?: number,
		/**
		 * A failure the caller established before any fetch (the entry's credentials did not resolve): it takes the
		 * fetch's own failure path, cached models included, so an ok record can never stand for a group whose
		 * requests would fail.
		 */
		preflightFailure?: Error
	): Promise<LiteLLMModelInfo[]> {
		const server: ServerConnection = {
			id: groupClientId(groupServer),
			label: groupServer.label ?? groupServerLabel(groupServer.baseUrl),
			baseUrl: groupServer.baseUrl,
			apiKey: groupServer.apiKey,
			// The configured label only: an unlabeled group's display fallback (the URL host) must not accidentally
			// match a declared entry.
			entryLabel: groupServer.label,
			...(groupServer.oauth !== undefined ? { oauth: groupServer.oauth } : {}),
			...(groupServer.virtualKey !== undefined ? { virtualKey: groupServer.virtualKey } : {}),
		};
		const identity = groupIdentity(groupServer, server.id);
		const attach = (infos: readonly PreAttachModelInfo[]): AttachedModelInfo[] =>
			infos.map((info) => attachGroup(info, identity));
		// The cache key composes the group with the live apiVersion and includeModes, so an edit lands on a fresh key.
		const cacheKey = this.cacheKeyFor(groupServer);
		// An unclaimed serve claims here, so it can at least be superseded by later serves.
		const serveGeneration = generation ?? this.beginServe(groupServer);
		// The one outcome that serves WITHOUT recording is the superseded yield below.
		//   both outcome counts -> derive from the same pair
		const recordAndServe: RecordAndServe = (
			served: ServedModelSets,
			outcome: OkServeShape | FailureServeShape,
			observations: DiscoveryObservations = {}
		): AttachedServe => {
			const discovered = attach(served.discovered);
			const declared = attach(served.declared);
			// A serve yields its record once a NEWER serve of the same group has recorded, since overwriting would put
			// an older configuration's models, status, and stale-serve anchor back. The CALLER still gets the models its
			// call was configured for. Until the newer serve lands, this record is what makes those models routable, so
			// a newer claim alone (or a live apiVersion edit, which the next serve carries) never yields.
			//   rotated credentials -> arrive only with a LATER serve's overlaid server, so they land as a newer record
			if ((this._recordedGenerations.get(identity) ?? 0) > serveGeneration) {
				this._options.log(
					"Discovery finished for a rotated configuration; leaving the group record to the current one",
					{
						baseUrl: server.baseUrl,
					}
				);
				return { served: [...discovered, ...declared], discovered, declared };
			}
			this._recordedGenerations.set(identity, serveGeneration);
			// The one served-count derivation.
			const servedModelCount = served.discovered.length + served.declared.length;
			if (outcome.state === "ok") {
				this._options.reporter.reportGroupStatus(
					server,
					groupServer,
					silent,
					{ ...outcome, servedModelCount },
					served,
					observations
				);
			} else {
				this._options.reporter.reportGroupStatus(
					server,
					groupServer,
					silent,
					{
						...outcome,
						servedModelCount,
						...(served.declared.length > 0 ? { declaredModelCount: served.declared.length } : {}),
					},
					served
				);
			}
			return { served: [...discovered, ...declared], discovered, declared };
		};

		// A group the user hid - removed its entry, or re-pointed the entry at another URL - answers empty and never
		// touches the network or the cache. Its status still reports (healthy with zero models, flagged
		// hiddenByRemoval) so the status window ages it like any live group and the dashboard's hidden-groups view
		// stays coherent.
		if (this._options.isGroupSuppressed(server.label, groupServer.baseUrl, groupServer.label)) {
			this._options.log("Provider group is hidden by the user's configuration; serving no models", {
				baseUrl: server.baseUrl,
			});
			return recordAndServe({ discovered: [], declared: [] }, { state: "ok", hiddenByRemoval: true }).served;
		}

		// Resolved before the cache read: the ok-path hint below gates on the entry's CURRENT declarations, cached
		// serve or fresh.
		const expectedFailures = this.expectedDiscoveryFailures(groupServer.label, server.baseUrl);
		const includeModes = this.includeModesFor(groupServer.label, server.baseUrl);
		// The one failure outcome, for a fetch that threw and for a preflight failure alike. `expected` is the entry's
		// modelListing declaration for a listing failure only: that declaration speaks about the endpoint, so a
		// credential failure stays unexpected and the declared set it serves cannot read as connected.
		const serveFailure = (error: unknown, expected: boolean): LiteLLMModelInfo[] => {
			if (expected) {
				// The one boundary log for an expected terminal failure: an info classification instead of an error.
				this._options.log(`Model discovery failed (expected: modelListing) for provider group`, {
					baseUrl: server.baseUrl,
				});
			} else {
				this._options.logError(`Failed to fetch models for provider group at ${server.baseUrl}`, error);
			}
			const texts = statusErrorTexts(error);
			const outcome: FailureServeShape = { state: "error", ...texts, ...(expected ? { expected: true } : {}) };
			const decorateFailure = (
				discovered: Pick<DiscoveredGroupModels, "infos" | "discoveredRawIds">
			): ServedModelSets => this._options.decorator.decorate(discovered, server, groupServer.label);
			// The window is this session's live state, never the extension layer's persisted status.
			const stale = this._options.window.staleServableModels(server.id, groupServer);
			// Declared models register through a credential failure too: chatClient.ts re-resolves the entry's
			// credentials before it sends anything, so a registered model never rides a baked key. The non-silent serve
			// synthesizes them against the EMPTY discovered set, or a pre-outage discovery could inert-suppress a declared
			// ID out of the only set it hands back; the record is then exactly that set, not the stale set it withholds.
			const declaredOnly = silent ? undefined : decorateFailure({ infos: [], discoveredRawIds: [] });
			if (declaredOnly !== undefined && declaredOnly.declared.length > 0) {
				return recordAndServe(declaredOnly, outcome).declared;
			}
			// A throwing serve still records the stale set every silent pass keeps serving.
			const failureServe = recordAndServe(
				stale !== undefined
					? decorateFailure({ infos: stale.models, discoveredRawIds: stale.discoveredRawIds })
					: (declaredOnly ?? decorateFailure({ infos: [], discoveredRawIds: [] })),
				outcome
			);
			if (silent) {
				// An empty literal, not the attached set, so a decorator surprise cannot serve unmarked models.
				const staleServed =
					stale !== undefined ? markStale(failureServe.discovered, new Date(stale.lastSuccessAt).toLocaleString()) : [];
				return [...staleServed, ...failureServe.declared];
			}
			// A non-Error throw is rebuilt with the status's log-safe rendering as its mirror: the display text can
			// embed response body and must never reach the log path.
			throw error instanceof Error ? error : new MirroredError(texts.error, { englishMessage: texts.logSafeError });
		};
		if (preflightFailure !== undefined) {
			return serveFailure(preflightFailure, false);
		}
		// The unserved-probe hint one ok serve carries; see DiscoveredGroupModels.modelInfoUnsupported.
		const probeHint = (
			discovered: Pick<DiscoveredGroupModels, "modelInfoUnsupported">
		): { modelInfoUnsupported?: UnservedEndpointEvidence } =>
			discovered.modelInfoUnsupported !== undefined && !expectedFailures.modelInfo
				? { modelInfoUnsupported: discovered.modelInfoUnsupported }
				: {};
		if (bypassCache) {
			this._options.cache.invalidate(cacheKey);
		} else {
			const ttl = getDiscoveryCacheTtl((msg, data) => this._options.log(msg, data));
			const cached = this._options.cache.lookup(cacheKey, ttl);
			if (cached !== undefined) {
				const cachedServe = this._options.decorator.decorate(cached, server, groupServer.label);
				this._options.log("Serving provider group models from the discovery cache", {
					baseUrl: server.baseUrl,
					count: cachedServe.discovered.length + cachedServe.declared.length,
				});
				return recordAndServe(
					cachedServe,
					{ state: "ok", ...probeHint(cached) },
					{
						discoveredRawIds: cached.discoveredRawIds,
						observedModelInfoKeys: cached.observedModelInfoKeys,
						skippedModeCounts: cached.skippedModeCounts,
					}
				).served;
			}
		}

		this._options.log("Fetching models for provider group", { baseUrl: server.baseUrl, silent });
		try {
			const load = async (): Promise<DiscoveredGroupModels> => {
				const { models, observedModelInfoKeys, skippedModeCounts, modelInfoUnsupported } =
					await this._options.client.fetchModels(server, expectedFailures, includeModes);
				return {
					infos: buildModelInfos(models, server, 1, (msg) => this._options.log(msg)).infos,
					discoveredRawIds: models.map((model) => model.id),
					...(observedModelInfoKeys !== undefined ? { observedModelInfoKeys } : {}),
					...(skippedModeCounts !== undefined ? { skippedModeCounts } : {}),
					...(modelInfoUnsupported !== undefined ? { modelInfoUnsupported } : {}),
				};
			};
			const discovered = await this._options.cache.fetch(cacheKey, load);
			// Overrides and declared models are applied to what is SERVED: the discovery cache stays
			// configuration-free, so an edit reaches the very next serve. The status window records both served sets,
			// keeping declared models out of its stale-serve anchor; they are config-rebuilt every serve.
			const freshServe = this._options.decorator.decorate(discovered, server, groupServer.label);
			this._options.log(`Provider group at ${server.baseUrl} returned ${discovered.infos.length} models`);
			return recordAndServe(
				freshServe,
				{ state: "ok", ...probeHint(discovered) },
				{
					discoveredRawIds: discovered.discoveredRawIds,
					observedModelInfoKeys: discovered.observedModelInfoKeys,
					skippedModeCounts: discovered.skippedModeCounts,
				}
			).served;
		} catch (error) {
			return serveFailure(error, expectedFailures.modelListing);
		}
	}
}
