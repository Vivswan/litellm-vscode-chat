import { getDiscoveryCacheTtl } from "../../shared/config/settings";
import type { UnservedEndpointEvidence } from "../../shared/errorClassification";
import { failureTexts } from "../../shared/failureCause";
import { MirroredError } from "../../shared/mirroredError";
import type { ExpectedFailureCategory, NonChatMode, SkippedModeCounts } from "../../shared/serverEntry";
import { apiRootOf } from "../../shared/util/baseUrl";
import type { ChatClient, ServerConnection } from "../transport/chatClient";
import { statusLogSafeError } from "../transport/transportErrors";
import type { ExpectedDiscoveryFailures } from "./discovery";
import type { DiscoveryCache } from "./discoveryCache";
import { discoveryLineWriter, failureKindOf } from "./discoveryLog";
import type {
	AttachedModelInfo,
	EntryCredentialsResolver,
	GroupServer,
	LiteLLMModelInfo,
	PreAttachModelInfo,
} from "./groupModels";
import {
	attachGroup,
	failureCauseOf,
	groupClientId,
	groupServerLabel,
	markStale,
	overlayEntryCredentials,
} from "./groupModels";
import { buildModelInfos } from "./registration";
import type { ServedModelDecorator } from "./servedModels";
import type { GroupServeOutcome, GroupStatusReporter } from "./statusReporting";
import type { DiscoveryObservations, ServedModelSets, StatusWindow } from "./statusWindow";
import { groupIdentity, logicalGroupId } from "./statusWindow";

/** GroupServeOutcome minus the served-set counts, which recordServe derives from the served pair. */
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

/**
 * What one serve records under, fixed once its claim settled: the hidden serve and the fetched serve record through
 * the same pipeline (recordServe), so the yield rule and the report shape cannot drift between them.
 *   identity     -> statusWindow.ts groupIdentity: the window's key and the identity a served model carries
 *   hostClientId -> groupClientId of the group as the host handed it over, before the overlay; a hidden serve records
 *                   under it while a visible serve of the same host group records under the owned identity, so
 *                   supersession between the two keys on it as well (see _recordedGenerations)
 */
interface ServeRecord {
	readonly generation: number;

	readonly server: ServerConnection;

	readonly groupServer: GroupServer;

	readonly identity: string;

	readonly hostClientId: string;

	readonly silent: boolean;
}

const NOTHING_SERVED: ServedModelSets = { discovered: [], declared: [] };

/** What one serve resolves before anything is served, cached or fresh. */
interface ServeContext {
	readonly record: ServeRecord;
	readonly cacheKey: string;
	readonly expectedFailures: ExpectedDiscoveryFailures;
	readonly includeModes: readonly NonChatMode[];
}

/**
 * Configuration-free, so overrides and declared models are applied where models are served, never stored.
 * `observedModelInfoKeys`, `skippedModeCounts`, and `modelInfoUnsupported` are FetchModelsResult's, riding the cache
 * so a cached serve re-reports them.
 *   discoveredRawIds     -> the infos alone may hold only synthetic variants (`foo:cheapest`) of a discovered `foo`,
 *                           and a declared `foo` must stay inert on a cache hit
 *   modelInfoUnsupported -> the serve gates it against the entry's CURRENT expectedFailures, so declaring the failure
 *                           retires the hint immediately instead of waiting out the cache TTL
 */
export interface DiscoveredGroupModels {
	readonly infos: readonly PreAttachModelInfo[];

	readonly discoveredRawIds: readonly string[];

	readonly observedModelInfoKeys?: readonly string[];

	readonly skippedModeCounts?: SkippedModeCounts;

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

/**
 * What the tombstone predicate (LiteLLMChatModelProviderOptions.isGroupSuppressed) judges a group by. `label` is the
 * status label: the configuration stamp, else the URL host.
 */
export interface SuppressedGroupKey {
	readonly groupId: string;

	readonly label: string;

	readonly entryLabel: string | undefined;

	readonly baseUrl: string;
}

/**
 * A serve's claim while its credentials resolve. `ready` is the overlay's own promise and settle is synchronous, so the
 * caller's await is the only hop between the overlay resolving and a cached serve's record.
 */
export interface PendingServeClaim {
	readonly generation: number;

	readonly ready: Promise<unknown>;

	/** This claim over its own completed overlay; throws before `ready` resolved. */
	settle(): ServeClaim;
}

/** Nominal through its private member, so neither a literal nor a spread stands in for one; claimServe is the minter. */
class SettledServeClaim {
	declare private readonly minter: "claimServe";

	constructor(
		readonly generation: number,
		readonly server: GroupServer,
		readonly failure: MirroredError | undefined,
		/** See ServeRecord.hostClientId; the overlay may have minted `server` a different one. */
		readonly hostClientId: string
	) {}
}

export type ServeClaim = SettledServeClaim;

/**
 * A suppressed group's claim, settled at claim time on the server the host handed over: its serve (serveHidden)
 * resolves no credentials and touches neither the network nor the cache. Nominal like SettledServeClaim.
 */
export class HiddenServeClaim {
	declare private readonly minter: "claimServe";
	constructor(
		readonly generation: number,
		readonly server: GroupServer
	) {}
}

export interface GroupDiscoveryOptions {
	/** The transport's model listing; its errors arrive unlogged and are logged once here at the boundary. */
	client: Pick<ChatClient, "fetchModels">;

	/** Keyed through discoveryCacheKey, so a changed API root or mode list misses by construction. */
	cache: DiscoveryCache<DiscoveredGroupModels>;

	/** Records each serve's outcome into the status window and fires the aggregated status callback. */
	reporter: GroupStatusReporter;

	/** The facade-owned live window; read for the error path's stale-servable fallback. */
	window: Pick<StatusWindow, "staleServableModels">;

	/** Applies capability overrides and declared models at serve time, outside the cache. */
	decorator: ServedModelDecorator;

	/** The same apiVersion resolver ChatClient consumes; the discovery cache key composes the effective API root. */
	getEntryApiVersion: (label: string, baseUrl: string) => string | undefined;

	/** Per-entry expectedFailures resolver, matched by label and normalized base URL. */
	getExpectedFailures: (label: string, baseUrl: string) => readonly ExpectedFailureCategory[] | undefined;

	/** Per-entry includeModes resolver, matched like getExpectedFailures; it also keys the discovery cache. */
	getEntryIncludeModes: (label: string, baseUrl: string) => readonly NonChatMode[] | undefined;

	/** The extension layer's tombstone predicate; see LiteLLMChatModelProviderOptions.isGroupSuppressed. */
	isGroupSuppressed: (group: SuppressedGroupKey) => boolean;

	/** See LiteLLMChatModelProviderOptions.resolveEntryCredentials. */
	resolveEntryCredentials: EntryCredentialsResolver | undefined;

	/** Facade-bound, like logFailure: the module logs only through these, so the facade stays the logging boundary. */
	log: (message: string, data?: unknown) => void;

	/** The error-level line of an unexpected failure: `data` for the channel, `error` for the report's recorder. */
	logFailure: (message: string, data: unknown, error: unknown) => void;
}

/**
 * Serves a group's models through the discovery cache and records the outcome. `_serveGenerations` holds the newest
 * generation CLAIMED per claim key; `_recordedGenerations` the newest that has RECORDED, keyed by the group's IDENTITY
 * (statusWindow.ts groupIdentity) and by the host client ID it was served under.
 *   two unowned twins sharing a claim key -> never yield to each other: distinct host groups, so neither key is shared
 *   a hidden serve                        -> records under the host client ID, while a visible serve of the same host
 *                                            group records under the owned identity; the host client ID key is what
 *                                            lets the hidden record supersede an older visible serve still in flight
 *   a newer claim                         -> is never yielded to, only a newer record: until the newer serve lands,
 *                                            the older record is the only thing that makes its served models
 *                                            routable, and the newer record replaces it the moment it lands
 */
export class GroupDiscovery {
	private readonly _options: GroupDiscoveryOptions;

	private readonly _serveGenerations = new Map<string, number>();

	private readonly _recordedGenerations = new Map<string, number>();

	constructor(options: GroupDiscoveryOptions) {
		this._options = options;
	}

	/**
	 * The overlay never changes label or base URL, so the pre-overlay group is the claim key, and the suppression
	 * judgment runs on it too: the host keeps every group registered for life and re-resolves all of them per change
	 * event, so a hidden group's serve must cost no credential resolution.
	 *   suppressed -> a HiddenServeClaim, settled here; serveHidden records it
	 *   otherwise  -> the overlay's pending claim
	 */
	claimServe(groupServer: GroupServer): PendingServeClaim | HiddenServeClaim {
		const hostClientId = groupClientId(groupServer);
		const claimKey = logicalGroupId(groupServer) ?? hostClientId;
		const generation = (this._serveGenerations.get(claimKey) ?? 0) + 1;
		this._serveGenerations.set(claimKey, generation);
		if (this.isSuppressed(groupServer, hostClientId)) {
			return new HiddenServeClaim(generation, groupServer);
		}
		const overlay = overlayEntryCredentials(groupServer, this._options.resolveEntryCredentials);
		let settled: ServeClaim | undefined;
		// Registered before the caller's await, so it has run when the caller's continuation does. A rejection reaches
		// the caller through that await; this reaction only mints.
		void overlay.then(
			(overlaid) => {
				settled = new SettledServeClaim(generation, overlaid.server, overlaid.failure, hostClientId);
			},
			() => undefined
		);
		return {
			generation,
			ready: overlay,
			settle: () => {
				if (settled === undefined) {
					throw new Error("A serve claim was settled before its overlay resolved");
				}
				return settled;
			},
		};
	}

	/**
	 * Judged on the group as the host handed it over. A tombstone's group ID is minted from the entry's configuration
	 * as the host bakes it (the sync engine's expectedClientId), so the pre-overlay client ID is the one it names; the
	 * label and URL keys are overlay-independent.
	 */
	private isSuppressed(groupServer: GroupServer, hostClientId: string): boolean {
		return this._options.isGroupSuppressed({
			groupId: hostClientId,
			label: groupServer.label ?? groupServerLabel(groupServer.baseUrl),
			entryLabel: groupServer.label,
			baseUrl: groupServer.baseUrl,
		});
	}

	private serveRecordOf(
		generation: number,
		groupServer: GroupServer,
		hostClientId: string,
		silent: boolean
	): ServeRecord {
		const server: ServerConnection = {
			id: groupClientId(groupServer),
			label: groupServer.label ?? groupServerLabel(groupServer.baseUrl),
			baseUrl: groupServer.baseUrl,
			apiKey: groupServer.apiKey,
			// The configured label only: an unlabeled group's display fallback (the URL host) must not accidentally
			// match a declared entry.
			entryLabel: groupServer.label,
			...(groupServer.oauth === undefined ? {} : { oauth: groupServer.oauth }),
			...(groupServer.virtualKey === undefined ? {} : { virtualKey: groupServer.virtualKey }),
		};
		return {
			generation,
			server,
			groupServer,
			identity: groupIdentity(groupServer, server.id),
			hostClientId,
			silent,
		};
	}

	/**
	 * The one outcome that serves WITHOUT recording is the superseded yield. Only an ok serve may carry observations;
	 * the failure signature has none, matching StatusWindow.record.
	 *   both outcome counts -> derive from the same pair
	 */
	private recordServe(
		record: ServeRecord,
		served: ServedModelSets,
		outcome: OkServeShape,
		observations?: DiscoveryObservations
	): AttachedServe;

	private recordServe(record: ServeRecord, served: ServedModelSets, outcome: FailureServeShape): AttachedServe;

	private recordServe(
		record: ServeRecord,
		served: ServedModelSets,
		outcome: OkServeShape | FailureServeShape,
		observations: DiscoveryObservations = {}
	): AttachedServe {
		const { server, groupServer, identity, hostClientId, silent } = record;
		const discovered = served.discovered.map((info) => attachGroup(info, identity));
		const declared = served.declared.map((info) => attachGroup(info, identity));
		// A serve yields its record once a NEWER serve of the same group has recorded: overwriting would put an older
		// configuration's models, status, and stale-serve anchor back. The caller still gets its own models.
		//   a newer claim alone    -> never yields: until it lands, this record is what makes these models routable
		//   a live apiVersion edit -> the same; the next serve carries it
		//   rotated credentials    -> arrive only with a LATER serve's overlaid server, so they land as a newer record
		//   hidden while in flight -> the hidden record lands under the host client ID, not the owned identity
		const recordedAfter = (key: string): boolean => (this._recordedGenerations.get(key) ?? 0) > record.generation;
		if (recordedAfter(identity) || recordedAfter(hostClientId)) {
			this._options.log("Discovery finished for a rotated configuration; leaving the group record to the current one", {
				baseUrl: server.baseUrl,
			});
			return { served: [...discovered, ...declared], discovered, declared };
		}
		this._recordedGenerations.set(identity, record.generation);
		this._recordedGenerations.set(hostClientId, record.generation);
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
	}

	/**
	 * A group the user hid - removed its entry, or re-pointed the entry at another URL - answers empty and never
	 * touches the network or the cache. Its status still reports (healthy with zero models, flagged hiddenByRemoval)
	 * so the status window ages it like any live group and the dashboard's hidden-groups view stays coherent.
	 *
	 * Recorded under the group as handed in: the host's baked configuration on a host serve, the window's recorded
	 * connection on a refresh probe. The overlay that judges ownership never runs, and no other identity is safe.
	 *   a labeled twin of a declared entry  -> under the entry's identity it would put the entry's models behind its
	 *                                          own connection
	 *   an owned record of this connection  -> replaced anyway: the window keeps one entry per client ID
	 */
	serveHidden(claim: HiddenServeClaim, silent: boolean): LiteLLMModelInfo[] {
		// The host's own group, so its client ID is the host client ID.
		const record = this.serveRecordOf(claim.generation, claim.server, groupClientId(claim.server), silent);
		this._options.log("Provider group is hidden by the user's configuration; serving no models", {
			baseUrl: record.server.baseUrl,
		});
		return this.recordServe(record, NOTHING_SERVED, { state: "ok", hiddenByRemoval: true }).served;
	}

	private expectedFailuresFor(entryLabel: string | undefined, baseUrl: string): readonly ExpectedFailureCategory[] {
		return (entryLabel === undefined ? undefined : this._options.getExpectedFailures(entryLabel, baseUrl)) ?? [];
	}

	private includeModesFor(entryLabel: string | undefined, baseUrl: string): readonly NonChatMode[] {
		return (entryLabel === undefined ? undefined : this._options.getEntryIncludeModes(entryLabel, baseUrl)) ?? [];
	}

	private expectedDiscoveryFailures(entryLabel: string | undefined, baseUrl: string): ExpectedDiscoveryFailures {
		const categories = this.expectedFailuresFor(entryLabel, baseUrl);
		return { modelInfo: categories.includes("modelInfo"), modelListing: categories.includes("modelListing") };
	}

	/** The facade's prune keep-set (index.ts pruneServerCaches) composes through here too. */
	cacheKeyFor(groupServer: GroupServer): string {
		const apiRoot = apiRootOf(
			groupServer.baseUrl,
			groupServer.label === undefined
				? undefined
				: this._options.getEntryApiVersion(groupServer.label, groupServer.baseUrl)
		);
		return discoveryCacheKey(
			groupClientId(groupServer),
			apiRoot,
			this.includeModesFor(groupServer.label, groupServer.baseUrl)
		);
	}

	/**
	 * Resolved before the cache read: the ok-path hint and the failure path gate on the entry's CURRENT declarations,
	 * cached serve or fresh; the cache key composes the group with the live apiVersion and includeModes, so an edit
	 * lands on a fresh key.
	 */
	private serveContextOf(record: ServeRecord): ServeContext {
		const { server, groupServer } = record;
		return {
			record,
			cacheKey: this.cacheKeyFor(groupServer),
			expectedFailures: this.expectedDiscoveryFailures(groupServer.label, server.baseUrl),
			includeModes: this.includeModesFor(groupServer.label, server.baseUrl),
		};
	}

	/** The unserved-probe hint one ok serve carries; see DiscoveredGroupModels.modelInfoUnsupported. */
	private static probeHint(
		expectedFailures: ExpectedDiscoveryFailures,
		discovered: Pick<DiscoveredGroupModels, "modelInfoUnsupported">
	): { modelInfoUnsupported?: UnservedEndpointEvidence } {
		return discovered.modelInfoUnsupported !== undefined && !expectedFailures.modelInfo
			? { modelInfoUnsupported: discovered.modelInfoUnsupported }
			: {};
	}

	/**
	 * The boundary's one log for a failed serve, through the closed discovery line table: an http error's English
	 * mirror quotes the response body, so the line carries the transport kind and status, never a rendering of the
	 * error. An expected failure is information; an unexpected one is the boundary's error and the issue report's
	 * latest.
	 */
	private logServeFailure(error: unknown, expected: boolean, silent: boolean): void {
		const log = discoveryLineWriter(
			expected
				? (message, line) => this._options.log(message, line)
				: (message, line) => this._options.logFailure(message, line, error)
		);
		log("Model discovery failed for provider group", { expected, silent, ...failureKindOf(error) });
	}

	/**
	 * The one failure outcome, for a fetch that threw and for a preflight failure alike. `expected` is the entry's
	 * modelListing declaration for a listing failure only: that declaration speaks about the endpoint, so a credential
	 * failure stays unexpected and the declared set it serves cannot read as connected.
	 */
	private serveFailure(serve: ServeContext, error: unknown, expected: boolean): LiteLLMModelInfo[] {
		const { record } = serve;
		const { server, groupServer, silent } = record;
		this.logServeFailure(error, expected, silent);
		const cause = failureCauseOf(error);
		const outcome: FailureServeShape = {
			state: "error",
			cause,
			logSafeError: statusLogSafeError(error),
			...(expected ? { expected: true } : {}),
		};
		const decorateFailure = (discovered: Pick<DiscoveredGroupModels, "infos" | "discoveredRawIds">): ServedModelSets =>
			this._options.decorator.decorate(discovered, server, groupServer.label);
		// The window is this session's live state, never the extension layer's persisted status.
		const stale = this._options.window.staleServableModels(server.id, groupServer);
		// Declared models register through a credential failure too: chatClient.ts re-resolves the entry's
		// credentials before it sends anything, so a registered model never rides a baked key. The non-silent serve
		// synthesizes them against the EMPTY discovered set, or a pre-outage discovery could inert-suppress a declared
		// ID out of the only set it hands back; the record is then exactly that set, not the stale set it withholds.
		const declaredOnly = silent ? undefined : decorateFailure({ infos: [], discoveredRawIds: [] });
		if (declaredOnly !== undefined && declaredOnly.declared.length > 0) {
			return this.recordServe(record, declaredOnly, outcome).declared;
		}
		// A throwing serve still records the stale set every silent pass keeps serving.
		const failureServe = this.recordServe(
			record,
			stale === undefined
				? (declaredOnly ?? decorateFailure({ infos: [], discoveredRawIds: [] }))
				: decorateFailure({ infos: stale.models, discoveredRawIds: stale.discoveredRawIds }),
			outcome
		);
		if (silent) {
			// An empty literal, not the attached set, so a decorator surprise cannot serve unmarked models.
			const staleServed =
				stale === undefined ? [] : markStale(failureServe.discovered, new Date(stale.lastSuccessAt).toLocaleString());
			return [...staleServed, ...failureServe.declared];
		}
		// A non-Error throw is rebuilt from the cause's rendering, with the status's log-safe rendering as its mirror.
		if (error instanceof Error) {
			throw error;
		}
		const texts = failureTexts(cause, server.baseUrl);
		throw new MirroredError(texts.display, { englishMessage: outcome.logSafeError });
	}

	/** A cached serve, when the cache holds a fresh enough result; undefined sends the caller to the network. */
	private serveFromCache(serve: ServeContext): LiteLLMModelInfo[] | undefined {
		const { record, cacheKey, expectedFailures } = serve;
		const { server, groupServer } = record;
		const ttl = getDiscoveryCacheTtl((msg, data) => this._options.log(msg, data));
		const cached = this._options.cache.lookup(cacheKey, ttl);
		if (cached === undefined) {
			return undefined;
		}
		const cachedServe = this._options.decorator.decorate(cached, server, groupServer.label);
		this._options.log("Serving provider group models from the discovery cache", {
			baseUrl: server.baseUrl,
			count: cachedServe.discovered.length + cachedServe.declared.length,
		});
		return this.recordServe(
			record,
			cachedServe,
			{ state: "ok", ...GroupDiscovery.probeHint(expectedFailures, cached) },
			{
				discoveredRawIds: cached.discoveredRawIds,
				observedModelInfoKeys: cached.observedModelInfoKeys,
				skippedModeCounts: cached.skippedModeCounts,
			}
		).served;
	}

	/** The one network load behind the cache: the listing, registered configuration-free. */
	private async loadDiscovered(serve: ServeContext): Promise<DiscoveredGroupModels> {
		const { server } = serve.record;
		const { models, observedModelInfoKeys, skippedModeCounts, modelInfoUnsupported } =
			await this._options.client.fetchModels(server, serve.expectedFailures, serve.includeModes);
		return {
			infos: buildModelInfos(
				models,
				server,
				1,
				discoveryLineWriter((message, line) => this._options.log(message, line))
			).infos,
			discoveredRawIds: models.map((model) => model.id),
			...(observedModelInfoKeys === undefined ? {} : { observedModelInfoKeys }),
			...(skippedModeCounts === undefined ? {} : { skippedModeCounts }),
			...(modelInfoUnsupported === undefined ? {} : { modelInfoUnsupported }),
		};
	}

	/**
	 * A fresh serve through the cache. Overrides and declared models are applied to what is SERVED: the discovery
	 * cache stays configuration-free, so an edit reaches the very next serve. The status window records both served
	 * sets, keeping declared models out of its stale-serve anchor; they are config-rebuilt every serve.
	 */
	private async serveFresh(serve: ServeContext): Promise<LiteLLMModelInfo[]> {
		const { record, cacheKey, expectedFailures } = serve;
		const { server, groupServer } = record;
		const discovered = await this._options.cache.fetch(cacheKey, () => this.loadDiscovered(serve));
		const freshServe = this._options.decorator.decorate(discovered, server, groupServer.label);
		this._options.log(`Provider group at ${server.baseUrl} returned ${discovered.infos.length} models`);
		return this.recordServe(
			record,
			freshServe,
			{ state: "ok", ...GroupDiscovery.probeHint(expectedFailures, discovered) },
			{
				discoveredRawIds: discovered.discoveredRawIds,
				observedModelInfoKeys: discovered.observedModelInfoKeys,
				skippedModeCounts: discovered.skippedModeCounts,
			}
		).served;
	}

	/**
	 * A fresh cached result still reports its remembered outcome, so the merged status and the group-aging
	 * cycle bookkeeping stay live across cached sweeps. Every read stamps the group's identity onto a fresh outer
	 * object (nested metadata stays shared); the credential fingerprint of the CURRENT connection keys the cache.
	 */
	async fetchGroupModels(claim: ServeClaim, silent: boolean): Promise<LiteLLMModelInfo[]> {
		const record = this.serveRecordOf(claim.generation, claim.server, claim.hostClientId, silent);
		const serve = this.serveContextOf(record);
		if (claim.failure !== undefined) {
			return this.serveFailure(serve, claim.failure, false);
		}

		const cached = this.serveFromCache(serve);
		if (cached !== undefined) {
			return cached;
		}

		this._options.log("Fetching models for provider group", { baseUrl: record.server.baseUrl, silent });
		try {
			return await this.serveFresh(serve);
		} catch (error) {
			return this.serveFailure(serve, error, serve.expectedFailures.modelListing);
		}
	}
}
