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
import type { DiscoveryObservations, ServedModelSets, StatusWindow } from "./statusWindow";

/** GroupServeOutcome minus the served-set counts, which recordAndServe derives from the served pair. */
type OkServeShape = Omit<Extract<GroupServeOutcome, { state: "ok" }>, "servedModelCount">;
type FailureServeShape = Omit<
	Extract<GroupServeOutcome, { state: "error" }>,
	"servedModelCount" | "declaredModelCount"
>;

/** What recordAndServe hands back: the served union plus the two origin sets, all group-attached. */
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
 * One server's cached discovery result: the registered infos plus the raw
 * model IDs discovery returned. Cache hits need the raw-ID set for declared-ID
 * inertness - the registered infos alone may hold only synthetic variants
 * (`foo:cheapest`) of a discovered `foo`, and a declared `foo` must stay
 * inert. The cache stays configuration-free: overrides and declared models
 * are applied where models are served, never stored. The effective API root
 * the models were fetched from is part of the cache KEY (discoveryCacheKey),
 * not the value, so an entry from a rotated root is unreachable by
 * construction rather than checked for.
 */
export interface DiscoveredGroupModels {
	readonly infos: readonly PreAttachModelInfo[];
	readonly discoveredRawIds: readonly string[];
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

/**
 * The discovery cache key for one group at one effective API root: the group
 * client ID (base URL plus credentials, so a rotation lands on a fresh entry)
 * composed with the root the models are actually fetched from (the entry's
 * apiVersion lives outside the group configuration, so the ID alone cannot
 * cover it). Every cache touch - lookups, loads, invalidation, and the prune
 * keep-set - must compose through here: an entry keyed under a rotated root is
 * unreachable, and pruning by the same composition is what ages it out.
 * JSON-encoded rather than delimiter-joined: both halves are free-form
 * strings (the client ID embeds the base URL, the root embeds the user's
 * apiVersion verbatim), and a delimiter would let content shifted across the
 * boundary collide - the oauthCredentialFingerprint rule.
 * Module-private with cacheKeyFor as the one consumer-facing composition.
 */
function discoveryCacheKey(groupClientId: string, apiRoot: string): string {
	return JSON.stringify([groupClientId, apiRoot]);
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
	 * The same apiVersion resolver ChatClient consumes, kept here so the
	 * discovery cache key can compose the effective API root a serve would
	 * fetch from: a serve resolving to a different root lands on a different
	 * key and misses by construction.
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
	/**
	 * The latest serve generation per labeled logical group (label + base URL),
	 * the rotation liveness check recordAndServe consults. Generations are
	 * claimed SYNCHRONOUSLY by beginServe before the caller's first await (the
	 * credential overlay's secrets read), so arrival order at the facade - not
	 * resolver or fetch completion order - decides which serve's record stands:
	 * cacheKeyFor recomputed from a serve's own frozen groupServer can detect a
	 * live apiVersion edit but never a credential rotation, since the rotated
	 * credentials arrive only with a LATER serve's overlaid server. Unlabeled
	 * groups stay out (two on one host is a documented, deliberate collision).
	 * Bounded by the labels served this session, like the status window.
	 */
	private readonly _serveGenerations = new Map<string, number>();

	constructor(options: GroupDiscoveryOptions) {
		this._options = options;
	}

	/** One injective identity per labeled logical group; undefined for unlabeled servers. */
	private logicalGroupId(groupServer: Pick<GroupServer, "label" | "baseUrl">): string | undefined {
		return groupServer.label !== undefined ? JSON.stringify([groupServer.label, groupServer.baseUrl]) : undefined;
	}

	/**
	 * Claim the next serve generation for a logical group, SYNCHRONOUSLY and
	 * before any await in the caller: the overlay never changes label or base
	 * URL, so the pre-overlay parse is a valid claim ticket. A serve carrying a
	 * superseded generation yields its record (see recordAndServe). Undefined
	 * for unlabeled groups, which keep plain last-write-wins recording.
	 */
	beginServe(groupServer: Pick<GroupServer, "label" | "baseUrl">): number | undefined {
		const logicalId = this.logicalGroupId(groupServer);
		if (logicalId === undefined) {
			return undefined;
		}
		const generation = (this._serveGenerations.get(logicalId) ?? 0) + 1;
		this._serveGenerations.set(logicalId, generation);
		return generation;
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
	 * The cache key this group's discovery results live under right now: the
	 * group client ID composed with the effective API root, resolved exactly
	 * the way the transport resolves it (only a labeled group can match an
	 * entry). The facade builds its prune keep-set through this same method,
	 * so an entry keyed under a rotated root - unreachable to every serve -
	 * ages out at the next prune instead of lingering with the old root's
	 * models.
	 */
	cacheKeyFor(groupServer: GroupServer): string {
		const apiRoot = apiRootOf(
			groupServer.baseUrl,
			groupServer.label !== undefined
				? this._options.getEntryApiVersion(groupServer.label, groupServer.baseUrl)
				: undefined
		);
		return discoveryCacheKey(groupClientId(groupServer), apiRoot);
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
	async fetchGroupModels(
		groupServer: GroupServer,
		silent: boolean,
		bypassCache = false,
		/** The beginServe claim for this serve; absent for unlabeled groups and callers with no earlier await. */
		generation?: number
	): Promise<LiteLLMModelInfo[]> {
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
		// The composed cache key covers the effective API root alongside the
		// group identity, so an apiVersion edit lands on a fresh key: a stored
		// result from a rotated root is unreachable rather than checked for, and
		// a serve can never join an in-flight load fetching a different root.
		// Computed before recordAndServe because it doubles as this serve's
		// configuration stamp there.
		const cacheKey = this.cacheKeyFor(groupServer);
		// A caller that could not claim before its own awaits (none today beyond
		// the unlabeled case) still participates: an unclaimed labeled serve
		// claims here, so it can at least be superseded by later serves.
		const logicalId = this.logicalGroupId(groupServer);
		const serveGeneration = generation ?? this.beginServe(groupServer);
		// Every path records and serves through here: the reporter gets exactly
		// the served pair the return value carries, and both outcome counts derive
		// from the same pair, so no branch can record one set and serve another.
		// The one outcome that serves WITHOUT recording is the rotated-
		// configuration yield below.
		const recordAndServe: RecordAndServe = (
			served: ServedModelSets,
			outcome: OkServeShape | FailureServeShape,
			observations: DiscoveryObservations = {}
		): AttachedServe => {
			const discovered = attach(served.discovered);
			const declared = attach(served.declared);
			// A serve whose configuration is no longer the group's CURRENT one
			// yields the record: composed keys let old and new configurations'
			// fetches run concurrently, so a late completion recording here would
			// overwrite the newer configuration's models, status, and stale-serve
			// anchor. Two staleness signals, both needed: the recomputed key
			// catches a live apiVersion edit on THIS server object, and the serve
			// generation catches a rotation, whose new credentials only ever
			// arrive with a LATER serve's overlaid server - claimed before the
			// overlay's await, so a serve that stalled in the resolver cannot
			// stamp itself current after a newer one recorded. The CALLER still
			// gets the models its call was configured for when it started; only
			// the shared record defers (a racing serve already recorded, or the
			// next sweep will).
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
			// The one served-count derivation: both states record exactly what this
			// serve hands out, so a failure still serving stale or declared models
			// stays visible to the merged count and every verdict.
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

		// A group the user explicitly removed answers empty and never touches
		// the network or the cache. Its status still reports (healthy with zero
		// models, flagged hiddenByRemoval) so the status window ages it like any
		// live group and the dashboard's hidden-groups view stays coherent.
		if (this._options.isGroupSuppressed(server.label, groupServer.baseUrl)) {
			this._options.log("Provider group is hidden by an explicit user removal; serving no models", {
				baseUrl: server.baseUrl,
			});
			return recordAndServe({ discovered: [], declared: [] }, { state: "ok", hiddenByRemoval: true }).served;
		}

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
					...(observedModelInfoKeys !== undefined ? { observedModelInfoKeys } : {}),
					...(modelInfoUnsupported !== undefined ? { modelInfoUnsupported } : {}),
				};
			};
			const discovered = await this._options.cache.fetch(cacheKey, load);
			// Overrides and declared models are applied to what is SERVED: the
			// discovery cache stays configuration-free, so an edit reaches the
			// very next serve. The status window records both served sets, keeping
			// declared models out of its stale-serve anchor; they are config-rebuilt
			// every serve.
			const freshServe = this._options.decorator.decorate(discovered, server, groupServer.label);
			this._options.log(`Provider group at ${server.baseUrl} returned ${discovered.infos.length} models`);
			return recordAndServe(
				freshServe,
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
			// A non-silent expected failure serves the declared set ALONE (the
			// return below), so its record must not count the stale set the silent
			// path would serve - and the declared synthesis must run against the
			// empty discovered set, or a pre-outage discovery could inert-suppress
			// a declared ID out of the only set this serve hands back.
			const servesDeclaredOnly = !silent && expected;
			const failureSets = this._options.decorator.decorate(
				!servesDeclaredOnly && stale !== undefined
					? { infos: stale.models, discoveredRawIds: stale.discoveredRawIds }
					: { infos: [], discoveredRawIds: [] },
				server,
				groupServer.label
			);
			// Recorded is what stays visible under the error: the declared-only serve
			// returns exactly this set, and the throwing unexpected branch still names
			// the stale set every silent pass keeps serving, never flashing zero.
			const failureServe = recordAndServe(failureSets, {
				state: "error",
				...texts,
				...(expected ? { expected: true } : {}),
			});
			if (silent) {
				// No success anchor means nothing servable: an empty literal, not the
				// attached set, so a decorator surprise cannot serve unmarked models.
				const staleServed =
					stale !== undefined ? markStale(failureServe.discovered, new Date(stale.lastSuccessAt).toLocaleString()) : [];
				return [...staleServed, ...failureServe.declared];
			}
			if (expected && failureSets.declared.length > 0) {
				return failureServe.declared;
			}
			// A non-Error throw is rebuilt with the status's log-safe rendering as
			// its mirror: the display text can embed response body and must never
			// reach the log path.
			throw error instanceof Error ? error : new MirroredError(texts.error, { englishMessage: texts.logSafeError });
		}
	}
}
