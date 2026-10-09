/**
 * The cross-surface serving-vocabulary table: one window state per row, with what EVERY headline surface must say about
 * it - the status bar's state and severity, the dashboard hero's word and tone, the notifier's toast (or its silence),
 * the diagnostics paste line, and the row pills. Two suites consume it (the host suite for the bar/notifier/paste line
 * and the real state builder's mirror, the bun webview suite for the hero and the rendered pills), so the surfaces are
 * pinned against the SAME rows and cannot contradict each other without one suite going red.
 *
 *   Each row also names the one severity class its aggregate surfaces belong to
 *     -> a reader can see at a glance which rows a green bar beside a red hero would violate
 */

import type { OverallVerdict } from "../dashboard/presenters";
import type { DashboardServer, DeclaredServerNotice } from "../dashboard/viewModels";
import type { DeclaredServerView } from "../extension/servers/serverSync/engine";
import type { ServerEntryReport } from "../extension/servers/serverSync/setting";
import { ServerVerdict } from "../extension/servers/syncFailureOverlay";
import type { FailureCause, SyncErrorClass } from "../shared/failureCause";
import { markLogSafe } from "../shared/logger";
import type { ServerStatus } from "../shared/servers";

/**
 * The one severity every aggregate surface of a row must express. "setup" is the call-to-action tier: the bar prompts
 * with a warning tint while the hero stays muted - nothing is degraded, something is just not set up yet.
 */
type SeverityClass = "ok" | "warn" | "error" | "muted" | "setup";

/** The status-bar expectation: the persisted state string plus the rendered background severity. */
interface BarExpectation {
	readonly state: "not-configured" | "connecting" | "loading" | "connected" | "degraded" | "error";
	readonly severity: "plain" | "warning" | "error";
}

type NotifierExpectation = { readonly kind: "info" | "warning" | "error"; readonly contains: string } | "none";

/** One rendered pill: its visible word (compile-pinned to the vocabulary below) and its dot tone class. */
interface PillExpectation {
	readonly word: (typeof ALL_PILL_WORDS)[number];
	readonly tone: "ok" | "warn" | "error" | "muted";
}

export interface WindowStateRow {
	readonly name: string;
	/** The provider-reported status window, exactly as handleAggregatedStatus and the notifier receive it. */
	readonly window: readonly ServerStatus[];
	/**
	 * Declared entries whose provider-group sync failed, by entry label: the sync-failure overlay's input beside the
	 * window. The host suite feeds them to the bar and notifier as declared views carrying syncFailure; one with no
	 * live status is synthesized as an error serving nothing, whatever its class.
	 */
	readonly syncFailures?: readonly {
		readonly label: string;
		/** Derived from the engine union, so a new class can never leave this registry silently narrower. */
		readonly failureClass: NonNullable<DeclaredServerView["syncFailure"]>["class"];
	}[];
	/**
	 * The label-agnostic connection ID a declared entry mirrors (DeclaredServerView.expectedConnectionId), by entry
	 * label: how two entries share one live group whose report carries that ID as its serverId.
	 */
	readonly connectionIds?: Readonly<Record<string, string>>;
	/** The merged count reportMerged would derive from the window (asserted, not assumed). */
	readonly totalModels: number;
	/** Whether servers are configured (the bar's and notifier's shared gate); every row but not-configured. */
	readonly configured: boolean;
	/** The same state as the dashboard's server rows; the host suite pins this mirror against the REAL builder. */
	readonly rows: readonly DashboardServer[];
	/**
	 * How many provider groups the user's configuration hides (state.hiddenGroups). The window carries the same groups
	 * as hiddenByRemoval ok statuses, which the host mirror tombstones; the verdict rows count them from the window.
	 */
	readonly hiddenGroups?: number;
	readonly expect: {
		readonly severityClass: SeverityClass;
		/** classifyOverall over the verdict rows (the window joined with the declared views, plus the refused entries). */
		readonly verdict: OverallVerdict;
		readonly bar: BarExpectation;
		/** The dashboard hero's word (English bundle) and tone. */
		readonly hero: { readonly word: string; readonly tone: "ok" | "warn" | "error" | "muted" };
		/** The overallStatusText paste line (English by policy). */
		readonly statusLine: string;
		readonly notifier: NotifierExpectation;
		/** The row pills, in `rows` order (English bundle words plus dot tones). */
		readonly pills: readonly PillExpectation[];
	};
}

const CHECKED_AT = "2026-07-26T00:00:00.000Z";

/**
 * The row's declared rows as sync-engine views: what the state builder joins and what the bar's and notifier's overlay
 * reads, with the row's sync failures riding as syncFailure - the same one input on every surface.
 */
export function declaredViews(row: WindowStateRow): DeclaredServerView[] {
	return row.rows
		.filter((server) => server.origin === "declared")
		.map((server) => {
			const failure = row.syncFailures?.find((candidate) => candidate.label === server.label);
			const connectionId = row.connectionIds?.[server.label];
			return {
				label: server.label,
				baseUrl: server.baseUrl,
				secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } as const,
				expectedClientId: row.window.find((status) => status.label === server.label)?.serverId,
				...(connectionId !== undefined ? { expectedConnectionId: connectionId } : {}),
				syncFailure: failure !== undefined ? { class: failure.failureClass } : undefined,
			};
		});
}

/**
 * The verdict owner over the row's window, views, and refused entries: what the status bar, the notifier, the hero,
 * and the paste line all classify (the host suite pins the real builder's inputs to these same three).
 */
export function rowVerdict(row: WindowStateRow): ServerVerdict {
	return new ServerVerdict({
		statuses: () => row.window,
		declared: () => ({ source: "engine", views: declaredViews(row) }),
		entryReports: () => rejectedReports(row),
	});
}

/**
 * The row's misconfigured rows as the parser's entry reports: what serverSettingReports hands the state builder for an
 * entry it refused, so the mirror exercises the builder's misconfigured-row branch rather than assuming the
 * hand-written literal.
 */
export function rejectedReports(row: WindowStateRow): ServerEntryReport[] {
	return row.rows
		.filter((server): server is Extract<DashboardServer, { origin: "misconfigured" }> => {
			return server.origin === "misconfigured";
		})
		.map((server, index) => ({
			index,
			label: server.label,
			baseUrl: server.baseUrl,
			problems: [...server.problems],
			accepted: false,
		}));
}

function okStatus(overrides: { serverId?: string; servedModelCount: number; hiddenByRemoval?: true }): ServerStatus {
	return {
		serverId: overrides.serverId ?? "srv1",
		label: overrides.serverId ?? "srv1",
		baseUrl: `http://${overrides.serverId ?? "srv1"}.test`,
		state: "ok",
		servedModelCount: overrides.servedModelCount,
		...(overrides.hiddenByRemoval !== undefined ? { hiddenByRemoval: overrides.hiddenByRemoval } : {}),
		lastChecked: CHECKED_AT,
	};
}

/** A failing status: a refused connection unless the test names another cause. */
function errorStatus(overrides: {
	serverId?: string;
	servedModelCount: number;
	declaredModelCount?: number;
	expected?: true;
	cause?: FailureCause;
}): ServerStatus {
	return {
		serverId: overrides.serverId ?? "srv1",
		label: overrides.serverId ?? "srv1",
		baseUrl: `http://${overrides.serverId ?? "srv1"}.test`,
		state: "error",
		cause: overrides.cause ?? { kind: "transport", classification: { kind: "connection" } },
		logSafeError: markLogSafe("RequestError(connection)"),
		servedModelCount: overrides.servedModelCount,
		...(overrides.declaredModelCount !== undefined ? { declaredModelCount: overrides.declaredModelCount } : {}),
		...(overrides.expected !== undefined ? { expected: overrides.expected } : {}),
		lastChecked: CHECKED_AT,
	};
}

const NO_SECRETS = {
	kind: "proven",
	locations: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
} as const;

/**
 * A declared dashboard row mirroring one window status, with the notices the REAL builder derives for it. Hand-written
 * so the bun suite needs no host imports; the host suite rebuilds the same rows through buildDashboardState and asserts
 * the mirror holds - notices included - so this literal cannot drift from the builder without a red host test.
 */
function declaredRow(status: ServerStatus, notices?: readonly DeclaredServerNotice[]): DashboardServer {
	const base = {
		origin: "declared",
		label: status.label,
		baseUrl: status.baseUrl,
		servedModelCount: status.servedModelCount,
		credentials: "absent",
		hasOAuth: false,
		hasVirtualKey: false,
		// Mirrors state.ts's checkedAtMs (the push's one ISO-to-epoch-ms owner) without its ""-sentinel branch: every
		// status here carries a real instant (CHECKED_AT), so a sentinel reaching this mirror fails the host suite's
		// equality pin loudly instead of mapping to absent.
		lastChecked: new Date(status.lastChecked).getTime(),
		config: { secrets: NO_SECRETS },
		...(notices !== undefined && notices.length > 0 ? { notices } : {}),
	} as const;
	return status.state === "ok"
		? { ...base, state: "ok" }
		: {
				...base,
				state: "error",
				cause: status.cause,
				...(status.expected === true ? { expected: true } : {}),
				...(status.declaredModelCount !== undefined ? { declaredModelCount: status.declaredModelCount } : {}),
			};
}

/** A declared entry no discovery pass has seen: a dashboard row with no window entry behind it. */
function uncheckedRow(name: string): DashboardServer {
	return {
		origin: "declared",
		label: name,
		baseUrl: `http://${name}.test`,
		servedModelCount: 0,
		credentials: "absent",
		hasOAuth: false,
		hasVirtualKey: false,
		state: "unchecked",
		config: { secrets: NO_SECRETS },
	};
}

/** A servers-setting entry the parser refused: a row with no window entry (it never reaches discovery). */
function misconfiguredRow(name: string): DashboardServer {
	return {
		origin: "misconfigured",
		label: name,
		baseUrl: `http://${name}.test`,
		servedModelCount: 0,
		credentials: "absent",
		hasOAuth: false,
		hasVirtualKey: false,
		state: "error",
		cause: { kind: "misconfiguredEntry" },
		problems: ["auth: configures more than one form"],
	};
}

/**
 * A declared row whose provider-group sync failed, mirroring declaredOutcome's sync branch: an error row carrying the
 * sync failure's class as its cause, with the live status's served count when a group serves and zero (no lastChecked
 * either) when the entry never reached discovery.
 */
function syncFailedRow(name: string, failureClass: SyncErrorClass, live?: ServerStatus): DashboardServer {
	return {
		origin: "declared",
		label: name,
		baseUrl: `http://${name}.test`,
		servedModelCount: live?.servedModelCount ?? 0,
		credentials: "absent",
		hasOAuth: false,
		hasVirtualKey: false,
		...(live !== undefined ? { lastChecked: new Date(live.lastChecked).getTime() } : {}),
		state: "error",
		cause: { kind: "sync", failureClass },
		config: { secrets: NO_SECRETS },
	};
}

const HTTP_500: FailureCause = { kind: "transport", classification: { kind: "http", status: 500 } };
/** A model listing the entry declares unsupported: the 404 discovery proved, with the hint that the entry can declare it. */
const LISTING_404: FailureCause = {
	kind: "transport",
	classification: { kind: "http", status: 404, unsupportedEndpoint: "modelListing" },
};
const allFailedDeclaredServing = errorStatus({ servedModelCount: 2, declaredModelCount: 2, cause: HTTP_500 });
const staleServing = errorStatus({ servedModelCount: 3 });
const answeredEmpty = okStatus({ servedModelCount: 0 });
const hiddenGroup = okStatus({ serverId: "ghost", servedModelCount: 0, hiddenByRemoval: true });
const expectedServing = errorStatus({
	serverId: "gw",
	servedModelCount: 1,
	declaredModelCount: 1,
	expected: true,
	cause: LISTING_404,
});
const expectedStaleServing = errorStatus({
	serverId: "gw",
	servedModelCount: 2,
	expected: true,
	cause: LISTING_404,
});
const expectedMixedServing = errorStatus({
	serverId: "gw",
	servedModelCount: 5,
	declaredModelCount: 2,
	expected: true,
	cause: LISTING_404,
});
const expectedDead = errorStatus({ serverId: "gw", servedModelCount: 0, expected: true, cause: LISTING_404 });
const unexpectedDead = errorStatus({ serverId: "down", servedModelCount: 0 });
const healthy = okStatus({ servedModelCount: 3 });
const liveBeforeSyncFailure = okStatus({ serverId: "live", servedModelCount: 2 });
/** A pre-label group answering with an empty listing, reporting under its connection ID. */
const sharedEmpty = okStatus({ serverId: "shared", servedModelCount: 0 });

/** The upsert failure's English rendering (failureTexts), as the paste line and the toast carry it. */
const UPSERT_FAILED = "The host rejected the provider group upsert";

/**
 * The never-checked and misconfigured rows have an EMPTY window on purpose, since neither reaches a discovery
 * pass, and the three sync-failure rows pin the applySyncFailures overlay. One residual stays, needing a vocabulary
 * ruling of its own:
 *
 *   sync-failed claimants sharing one snapshot     -> one window status against one row each; zero served beside a
 *                                                     clean claimant reads "error" in the window and "degraded" in the
 *                                                     rows
 */
export const WINDOW_STATE_ROWS: readonly WindowStateRow[] = [
	{
		name: "all servers failed unexpectedly, but declared models keep serving",
		window: [allFailedDeclaredServing],
		totalModels: 2,
		configured: true,
		rows: [declaredRow(allFailedDeclaredServing)],
		expect: {
			severityClass: "warn",
			verdict: "degraded",
			bar: { state: "degraded", severity: "warning" },
			hero: { word: "Degraded", tone: "warn" },
			statusLine: "Degraded (2 models, some servers failed)",
			notifier: "none",
			pills: [{ word: "Sync issue", tone: "warn" }],
		},
	},
	{
		name: "an unexpected failure inside the stale window keeps serving the last known models",
		window: [staleServing],
		totalModels: 3,
		configured: true,
		rows: [declaredRow(staleServing)],
		expect: {
			severityClass: "warn",
			verdict: "degraded",
			bar: { state: "degraded", severity: "warning" },
			hero: { word: "Degraded", tone: "warn" },
			statusLine: "Degraded (3 models, some servers failed)",
			notifier: "none",
			pills: [{ word: "Sync issue", tone: "warn" }],
		},
	},
	{
		name: "every server answered and nothing failed, yet zero models are served",
		window: [answeredEmpty],
		totalModels: 0,
		configured: true,
		rows: [declaredRow(answeredEmpty)],
		expect: {
			severityClass: "warn",
			verdict: "connected",
			bar: { state: "connected", severity: "warning" },
			hero: { word: "Connected, no models", tone: "warn" },
			statusLine: "Connected, but 0 models are served (answered with an empty listing)",
			notifier: { kind: "warning", contains: "listed no models" },
			// The row itself is healthy: the warning is an aggregate claim, and a red or amber pill here would blame a
			// server that answered fine.
			pills: [{ word: "Connected", tone: "ok" }],
		},
	},
	{
		name: "only hidden groups remain, so zero models is user-chosen configuration",
		// The hidden group leaves the servers table entirely (rows is empty); the hidden-groups count is what keeps
		// every surface on the connected zero-model warning instead of "Not configured" beside a warning bar.
		window: [hiddenGroup],
		totalModels: 0,
		configured: true,
		rows: [],
		hiddenGroups: 1,
		expect: {
			severityClass: "warn",
			verdict: "connected",
			bar: { state: "connected", severity: "warning" },
			hero: { word: "Connected, no models", tone: "warn" },
			statusLine: "Connected, but 0 models are served (1 hidden by the user's configuration)",
			notifier: { kind: "warning", contains: "is hidden and serves no models" },
			pills: [],
		},
	},
	{
		name: "a hidden group beside a server that answered with an empty listing",
		window: [hiddenGroup, answeredEmpty],
		totalModels: 0,
		configured: true,
		rows: [declaredRow(answeredEmpty)],
		hiddenGroups: 1,
		expect: {
			severityClass: "warn",
			verdict: "connected",
			bar: { state: "connected", severity: "warning" },
			hero: { word: "Connected, no models", tone: "warn" },
			statusLine:
				"Connected, but 0 models are served (1 hidden by the user's configuration; 1 answered with an empty listing)",
			notifier: { kind: "warning", contains: "is hidden and serves no models" },
			pills: [{ word: "Connected", tone: "ok" }],
		},
	},
	{
		name: "a hidden group beside a declared entry no discovery pass has seen",
		// The unchecked entry contributes no window status; the hidden group's synthesized row is what keeps the rows
		// verdict on the window's "connected" instead of a muted "waiting" beside a warning bar.
		window: [hiddenGroup],
		totalModels: 0,
		configured: true,
		rows: [uncheckedRow("fresh")],
		hiddenGroups: 1,
		expect: {
			severityClass: "warn",
			verdict: "connected",
			bar: { state: "connected", severity: "warning" },
			hero: { word: "Connected, no models", tone: "warn" },
			statusLine: "Connected, but 0 models are served (1 hidden by the user's configuration)",
			notifier: { kind: "warning", contains: "is hidden and serves no models" },
			pills: [{ word: "Not checked", tone: "muted" }],
		},
	},
	{
		name: "an expected failure serving declared models beside an unexpected dead failure",
		window: [expectedServing, unexpectedDead],
		totalModels: 1,
		configured: true,
		rows: [declaredRow(expectedServing), declaredRow(unexpectedDead)],
		expect: {
			severityClass: "warn",
			verdict: "degraded",
			bar: { state: "degraded", severity: "warning" },
			hero: { word: "Degraded", tone: "warn" },
			statusLine: "Degraded (1 models, some servers failed)",
			notifier: "none",
			// The dead row's pill IS red: row severity may exceed the aggregate (one dead server degrades a fleet),
			// never the other way around.
			pills: [
				{ word: "Connected", tone: "ok" },
				{ word: "Error", tone: "error" },
			],
		},
	},
	{
		name: "a declared entry no discovery pass has seen, beside a parser-refused entry",
		window: [],
		totalModels: 0,
		configured: true,
		rows: [uncheckedRow("fresh"), misconfiguredRow("broken")],
		expect: {
			severityClass: "muted",
			verdict: "waiting",
			bar: { state: "connecting", severity: "plain" },
			hero: { word: "Waiting for first sync", tone: "muted" },
			statusLine: "Waiting for first sync",
			notifier: "none",
			pills: [
				{ word: "Not checked", tone: "muted" },
				{ word: "Misconfigured", tone: "error" },
			],
		},
	},
	{
		name: "only a parser-refused entry, nothing reporting",
		// The owner's rows hold the refused entry alone: an error on every surface, where an empty window once left the
		// bar on "connecting" beside a red hero.
		window: [],
		totalModels: 0,
		configured: true,
		rows: [misconfiguredRow("broken")],
		expect: {
			severityClass: "error",
			verdict: "error",
			bar: { state: "error", severity: "error" },
			hero: { word: "Error", tone: "error" },
			statusLine: "Error: misconfigured entry; not used until its configuration is fixed",
			notifier: { kind: "error", contains: "misconfigured" },
			pills: [{ word: "Misconfigured", tone: "error" }],
		},
	},
	{
		name: "an expected failure serving its declared models alone",
		window: [expectedServing],
		totalModels: 1,
		configured: true,
		rows: [declaredRow(expectedServing)],
		expect: {
			severityClass: "ok",
			verdict: "connected",
			bar: { state: "connected", severity: "plain" },
			hero: { word: "Connected", tone: "ok" },
			statusLine: "Connected (1 models)",
			notifier: "none",
			pills: [{ word: "Connected", tone: "ok" }],
		},
	},
	{
		name: "an expected failure serving only the stale window's last known models",
		window: [expectedStaleServing],
		totalModels: 2,
		configured: true,
		rows: [declaredRow(expectedStaleServing)],
		expect: {
			// The failure is declared normal and models serve: quiet everywhere, never one surface's "Connected" beside
			// another's "Error". Serving through the stale window alone earns NO nothing-declared notice.
			severityClass: "ok",
			verdict: "connected",
			bar: { state: "connected", severity: "plain" },
			hero: { word: "Connected", tone: "ok" },
			statusLine: "Connected (2 models)",
			notifier: "none",
			pills: [{ word: "Connected", tone: "ok" }],
		},
	},
	{
		name: "an expected failure serving the stale window beside its declared models",
		window: [expectedMixedServing],
		totalModels: 5,
		configured: true,
		rows: [declaredRow(expectedMixedServing)],
		expect: {
			severityClass: "ok",
			verdict: "connected",
			bar: { state: "connected", severity: "plain" },
			hero: { word: "Connected", tone: "ok" },
			statusLine: "Connected (5 models)",
			notifier: "none",
			pills: [{ word: "Connected", tone: "ok" }],
		},
	},
	{
		name: "every server fails expectedly and nothing is declared to serve through it",
		window: [expectedDead],
		totalModels: 0,
		configured: true,
		rows: [declaredRow(expectedDead, ["expected-failures-nothing-declared"])],
		expect: {
			severityClass: "warn",
			verdict: "needs-declare",
			bar: { state: "connecting", severity: "warning" },
			hero: { word: "No declared models", tone: "warn" },
			statusLine: "Expected discovery failures; no declared models (add IDs to the entry's discovery.declared)",
			notifier: { kind: "warning", contains: "discovery.declared" },
			pills: [{ word: "Expected failure", tone: "error" }],
		},
	},
	{
		name: "every server failed unexpectedly and nothing serves",
		window: [unexpectedDead],
		totalModels: 0,
		configured: true,
		rows: [declaredRow(unexpectedDead)],
		expect: {
			severityClass: "error",
			verdict: "error",
			bar: { state: "error", severity: "error" },
			hero: { word: "Error", tone: "error" },
			// The paste line is the cause's English rendering; the toast its localized one (English here).
			statusLine: "Error: Could not connect to http://down.test",
			notifier: { kind: "error", contains: "Could not connect to http://down.test" },
			pills: [{ word: "Error", tone: "error" }],
		},
	},
	{
		name: "every server serves cleanly",
		window: [healthy],
		totalModels: 3,
		configured: true,
		rows: [declaredRow(healthy)],
		expect: {
			severityClass: "ok",
			verdict: "connected",
			bar: { state: "connected", severity: "plain" },
			hero: { word: "Connected", tone: "ok" },
			statusLine: "Connected (3 models)",
			notifier: "none",
			pills: [{ word: "Connected", tone: "ok" }],
		},
	},
	{
		name: "a declared entry discovery never saw, whose provider-group sync failed",
		// Empty window on purpose: the failed upsert means no group exists to report, so only the overlay can carry the
		// failure to the bar (upsertFailed is the one class that proves the absence).
		window: [],
		syncFailures: [{ label: "pending", failureClass: "upsertFailed" }],
		totalModels: 0,
		configured: true,
		rows: [syncFailedRow("pending", "upsertFailed")],
		expect: {
			severityClass: "error",
			verdict: "error",
			bar: { state: "error", severity: "error" },
			hero: { word: "Error", tone: "error" },
			statusLine: `Error: ${UPSERT_FAILED}`,
			notifier: { kind: "error", contains: "rejected the provider group upsert" },
			pills: [{ word: "Error", tone: "error" }],
		},
	},
	{
		name: "two entries mirroring one live group by connection, the first one's upsert refused",
		// One shared snapshot, claimed by both entries through the connection pass: the overlay replaces that one
		// status with the first entry's failure (the window has nothing else), so the verdict is "error" on every
		// surface even though the table draws the second claimant's row as connected.
		window: [sharedEmpty],
		syncFailures: [{ label: "primary", failureClass: "upsertFailed" }],
		connectionIds: { primary: "shared", mirror: "shared" },
		totalModels: 0,
		configured: true,
		rows: [syncFailedRow("primary", "upsertFailed", sharedEmpty), { ...declaredRow(sharedEmpty), label: "mirror" }],
		expect: {
			severityClass: "error",
			verdict: "error",
			bar: { state: "error", severity: "error" },
			hero: { word: "Error", tone: "error" },
			statusLine: `Error: ${UPSERT_FAILED}`,
			notifier: { kind: "error", contains: "rejected the provider group upsert" },
			pills: [
				{ word: "Error", tone: "error" },
				{ word: "Connected", tone: "ok" },
			],
		},
	},
	{
		name: "a live group serving models while its entry's sync stays blocked",
		window: [liveBeforeSyncFailure],
		syncFailures: [{ label: "live", failureClass: "blocked" }],
		totalModels: 2,
		configured: true,
		rows: [syncFailedRow("live", "blocked", liveBeforeSyncFailure)],
		expect: {
			// Serving through the failed sync: degraded everywhere, never the ok window's "Connected" beside a red
			// dashboard row.
			severityClass: "warn",
			verdict: "degraded",
			bar: { state: "degraded", severity: "warning" },
			hero: { word: "Degraded", tone: "warn" },
			statusLine: "Degraded (2 models, some servers failed)",
			notifier: "none",
			pills: [{ word: "Sync issue", tone: "warn" }],
		},
	},
	{
		name: "a healthy group beside an entry whose stored secrets could not be read and whose group never reported",
		// The skipped entry's group may not exist yet, so only the overlay can carry its failure to the bar; the row the
		// dashboard draws for it is the same error serving nothing, so the bar reads degraded with the hero.
		window: [healthy],
		syncFailures: [{ label: "unread", failureClass: "secretsUnreadable" }],
		totalModels: 3,
		configured: true,
		rows: [declaredRow(healthy), syncFailedRow("unread", "secretsUnreadable")],
		expect: {
			severityClass: "warn",
			verdict: "degraded",
			bar: { state: "degraded", severity: "warning" },
			hero: { word: "Degraded", tone: "warn" },
			statusLine: "Degraded (3 models, some servers failed)",
			notifier: "none",
			// The skipped row's pill is red (it serves nothing); row severity may exceed the aggregate, never the reverse.
			pills: [
				{ word: "Connected", tone: "ok" },
				{ word: "Error", tone: "error" },
			],
		},
	},
	{
		name: "an entry awaiting its first report beside an entry whose stored secrets could not be read",
		// An empty window: the bar's verdict row set carries the awaiting entry as an unchecked row (verdictRows), the
		// set the dashboard draws, so one failure among two entries is degraded on every surface, never error on the
		// bar alone.
		window: [],
		syncFailures: [{ label: "unread", failureClass: "secretsUnreadable" }],
		totalModels: 0,
		configured: true,
		rows: [uncheckedRow("fresh"), syncFailedRow("unread", "secretsUnreadable")],
		expect: {
			severityClass: "warn",
			verdict: "degraded",
			bar: { state: "degraded", severity: "warning" },
			hero: { word: "Degraded", tone: "warn" },
			statusLine: "Degraded (0 models, some servers failed)",
			notifier: "none",
			pills: [
				{ word: "Not checked", tone: "muted" },
				{ word: "Error", tone: "error" },
			],
		},
	},
	{
		name: "nothing is configured anywhere",
		window: [],
		totalModels: 0,
		configured: false,
		rows: [],
		expect: {
			severityClass: "setup",
			verdict: "not-configured",
			bar: { state: "not-configured", severity: "warning" },
			hero: { word: "Not configured", tone: "muted" },
			statusLine: "Not configured",
			notifier: { kind: "warning", contains: "No servers configured" },
			pills: [],
		},
	},
];

/**
 * Every pill word the row health walk can produce (serverHealth's seven verdicts collapse onto these six words;
 * "Connected" covers both the clean and the expected-serving states). The vocabulary lives webview-side (ServerPillWord
 * in servers.tsx) and this table must stay importable by the host suite, whose project cannot reach a .tsx module - so
 * the bun webview suite owns the pin: a compile-level both-ways check of this list against ServerPillWord, beside the
 * rendered-word equality.
 */
export const ALL_PILL_WORDS = [
	"Connected",
	"Sync issue",
	"Error",
	"Not checked",
	"Expected failure",
	"Misconfigured",
] as const;
