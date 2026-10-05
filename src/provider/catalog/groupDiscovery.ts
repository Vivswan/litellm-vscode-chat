import { getDiscoveryCacheTtl } from "../../shared/config/settings";
import type { UnservedEndpointEvidence } from "../../shared/errorClassification";
import { MirroredError } from "../../shared/mirroredError";
import type { ExpectedFailureCategory, NonChatMode, SkippedModeCounts } from "../../shared/serverEntry";
import { apiRootOf } from "../../shared/util/baseUrl";
import type { ChatClient, ServerConnection } from "../transport/chatClient";
import { statusErrorTexts } from "../transport/errorMapping";
import type { ExpectedDiscoveryFailures } from "./discovery";
import type { DiscoveryCache } from "./discoveryCache";
import { discoveryLineWriter, failureKindOf } from "./discoveryLog";
import type { AttachedModelInfo, GroupServer, LiteLLMModelInfo, PreAttachModelInfo } from "./groupModels";
import { attachGroupServer, groupClientId, groupServerLabel, markStale } from "./groupModels";
import { buildModelInfos } from "./registration";
import type { ServedModelDecorator } from "./servedModels";
import type { GroupServeOutcome, GroupStatusReporter } from "./statusReporting";
import type { DiscoveryObservations, ServedModelSets, StatusWindow } from "./statusWindow";
import { logicalGroupId } from "./statusWindow";

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

export interface SuppressedGroupKey {
	readonly groupId: string;
	/** The status label: the configuration stamp, else the URL host. */
	readonly label: string;
	readonly entryLabel: string | undefined;
	readonly baseUrl: string;
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
	isGroupSuppressed: (group: SuppressedGroupKey) => boolean;
	// Facade-bound log callbacks: this module logs only through them, so the provider facade stays the single logging
	// boundary.
	log: (message: string, data?: unknown) => void;
	/**
	 * The error-level line for an unexpected failure: `data` is what the channel shows, `error` what the report
	 * records.
	 */
	logFailure: (message: string, data: unknown, error: unknown) => void;
}

export class GroupDiscovery {
	private readonly _options: GroupDiscoveryOptions;
	/**
	 * index.ts claims the generation before its first await, so arrival order at the facade decides which serve's
	 * record stands, not resolver or fetch completion order. Unlabeled groups stay out.
	 */
	private readonly _serveGenerations = new Map<string, number>();

	constructor(options: GroupDiscoveryOptions) {
		this._options = options;
	}

	/**
	 * Claim the next serve generation for a logical group, SYNCHRONOUSLY and before any await in the caller: the
	 * overlay never changes label or base URL, so the pre-overlay parse is a valid claim ticket.
	 *   Undefined for unlabeled groups -> keep plain last-write-wins recording
	 */
	beginServe(groupServer: Pick<GroupServer, "label" | "baseUrl">): number | undefined {
		const logicalId = logicalGroupId(groupServer);
		if (logicalId === undefined) {
			return undefined;
		}
		const generation = (this._serveGenerations.get(logicalId) ?? 0) + 1;
		this._serveGenerations.set(logicalId, generation);
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
	 * cycle bookkeeping stay live across cached sweeps. Every read attaches the group server to a fresh outer
	 * object (nested metadata stays shared) carrying the CURRENT credentials, whose fingerprint keys the cache.
	 */
	async fetchGroupModels(
		groupServer: GroupServer,
		silent: boolean,
		bypassCache = false,
		/** The beginServe claim for this serve; absent for unlabeled groups and callers with no earlier await. */
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
		const attach = (infos: readonly PreAttachModelInfo[]): AttachedModelInfo[] =>
			infos.map((info) => attachGroupServer(info, groupServer));
		// Computed before recordAndServe because it doubles as this serve's configuration stamp there.
		const cacheKey = this.cacheKeyFor(groupServer);
		// An unclaimed labeled serve claims here, so it can at least be superseded by later serves.
		const logicalId = logicalGroupId(groupServer);
		const serveGeneration = generation ?? this.beginServe(groupServer);
		// The one outcome that serves WITHOUT recording is the rotated-configuration yield below.
		//   both outcome counts -> derive from the same pair
		const recordAndServe: RecordAndServe = (
			served: ServedModelSets,
			outcome: OkServeShape | FailureServeShape,
			observations: DiscoveryObservations = {}
		): AttachedServe => {
			const discovered = attach(served.discovered);
			const declared = attach(served.declared);
			// A serve whose configuration is no longer the group's CURRENT one yields the record, since a late
			// completion would overwrite the newer configuration's models, status, and stale-serve anchor. The
			// CALLER still gets the models its call was configured for.
			//
			//   recomputed cache key differs -> a live apiVersion edit on THIS server object
			//   a later serve claimed        -> covers rotation too, since rotated credentials arrive only with a LATER
			//                                   serve's overlaid server, invisible to this serve's recomputed key
			const superseded =
				logicalId !== undefined &&
				serveGeneration !== undefined &&
				this._serveGenerations.get(logicalId) !== serveGeneration;
			if (superseded || this.cacheKeyFor(groupServer) !== cacheKey) {
				this._options.log(
					"Discovery finished for a rotated configuration; leaving the group record to the current one",
					{
						baseUrl: server.baseUrl,
					}
				);
				return { served: [...discovered, ...declared], discovered, declared };
			}
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
		if (
			this._options.isGroupSuppressed({
				groupId: server.id,
				label: server.label,
				entryLabel: groupServer.label,
				baseUrl: groupServer.baseUrl,
			})
		) {
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
			// The boundary's one log for the failure, through the closed discovery line table: an http error's English
			// mirror quotes the response body, so the line carries the transport kind and status, never a rendering of
			// the error. An expected failure is information; an unexpected one is the boundary's error and the issue
			// report's latest.
			const log = discoveryLineWriter(
				expected
					? (message, line) => this._options.log(message, line)
					: (message, line) => this._options.logFailure(message, line, error)
			);
			log("Model discovery failed for provider group", { expected, silent, ...failureKindOf(error) });
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
