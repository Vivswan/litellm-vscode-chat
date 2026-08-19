/**
 * The cross-surface serving-vocabulary table: one window state per row, with
 * what EVERY headline surface must say about it - the status bar's state and
 * severity, the dashboard hero's word and tone, the notifier's toast (or its
 * silence), the diagnostics paste line, and the row pills. Two suites consume
 * it (the host suite for the bar/notifier/paste line and the real state
 * builder's mirror, the bun webview suite for the hero and the rendered
 * pills), so the surfaces are pinned against the SAME rows and cannot
 * contradict each other without one suite going red.
 *
 * Each row also names its one severity class, and aggregateContradictions()
 * proves the aggregate surfaces sit inside that class - the composed check the
 * per-surface suites cannot make alone (a green bar beside a red hero passes
 * both surface suites and fails here). Coverage fails closed: ALL_VERDICTS is
 * compile-pinned to the OverallVerdict union and every verdict and pill word
 * must appear in some row (uncoveredVerdicts / uncoveredPills), so a new
 * verdict cannot ship without a row saying what every surface makes of it.
 */

import type { OverallVerdict } from "../dashboard/presenters";
import type { DashboardServer, DeclaredServerNotice } from "../dashboard/viewModels";
import { markLogSafe } from "../shared/logger";
import type { ServerStatus } from "../shared/servers";

/**
 * The one severity every aggregate surface of a row must express. "setup" is
 * the call-to-action tier: the bar prompts with a warning tint while the hero
 * stays muted - nothing is degraded, something is just not set up yet.
 */
type SeverityClass = "ok" | "warn" | "error" | "muted" | "setup";

/** The status-bar expectation: the persisted state string plus the rendered background severity. */
interface BarExpectation {
	readonly state: "not-configured" | "connecting" | "loading" | "connected" | "degraded" | "error";
	readonly severity: "plain" | "warning" | "error";
}

/** The notifier expectation: the toast's kind and a fragment of its message, or silence. */
type NotifierExpectation = { readonly kind: "info" | "warning" | "error"; readonly contains: string } | "none";

/** One rendered pill: its visible word and its dot tone class (both English-bundle values). */
interface PillExpectation {
	readonly word: string;
	readonly tone: "ok" | "warn" | "error" | "muted";
}

export interface WindowStateRow {
	readonly name: string;
	/** The provider-reported status window, exactly as handleAggregatedStatus and the notifier receive it. */
	readonly window: readonly ServerStatus[];
	/**
	 * Declared entries whose provider-group sync failed, by entry label: the
	 * sync-failure overlay's input beside the window. The host suite feeds them
	 * to the bar and notifier as declared views carrying syncError and its
	 * class (the class gates the overlay's no-live-status synthesis).
	 */
	readonly syncFailures?: readonly {
		readonly label: string;
		readonly message: string;
		readonly failureClass: "upsertFailed" | "blocked" | "secretsUnreadable";
	}[];
	/** The merged count reportMerged would derive from the window (asserted, not assumed). */
	readonly totalModels: number;
	/** Whether servers are configured (the bar's and notifier's shared gate); every row but not-configured. */
	readonly configured: boolean;
	/** The same state as the dashboard's server rows; the host suite pins this mirror against the REAL builder. */
	readonly rows: readonly DashboardServer[];
	/**
	 * How many provider groups explicit removals hide (state.hiddenGroups). The
	 * hero and paste line read it beside the rows; the window carries the same
	 * groups as hiddenByRemoval ok statuses, which the host mirror tombstones.
	 */
	readonly hiddenGroups?: number;
	readonly expect: {
		readonly severityClass: SeverityClass;
		/** classifyOverall over the rows (and over the window, when the window is non-empty). */
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

function errorStatus(overrides: {
	serverId?: string;
	servedModelCount: number;
	declaredModelCount?: number;
	expected?: true;
	error?: string;
}): ServerStatus {
	return {
		serverId: overrides.serverId ?? "srv1",
		label: overrides.serverId ?? "srv1",
		baseUrl: `http://${overrides.serverId ?? "srv1"}.test`,
		state: "error",
		error: overrides.error ?? "connection refused",
		logSafeError: markLogSafe("RequestError(connection)"),
		servedModelCount: overrides.servedModelCount,
		...(overrides.declaredModelCount !== undefined ? { declaredModelCount: overrides.declaredModelCount } : {}),
		...(overrides.expected !== undefined ? { expected: overrides.expected } : {}),
		lastChecked: CHECKED_AT,
	};
}

const NO_SECRETS = { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } as const;

/**
 * A declared dashboard row mirroring one window status, with the notices the
 * REAL builder derives for it. Hand-written so the bun suite needs no host
 * imports; the host suite rebuilds the same rows through buildDashboardState
 * and asserts the mirror holds - notices included - so this literal cannot
 * drift from the builder without a red host test.
 */
function declaredRow(status: ServerStatus, notices?: readonly DeclaredServerNotice[]): DashboardServer {
	const base = {
		origin: "declared",
		label: status.label,
		baseUrl: status.baseUrl,
		servedModelCount: status.servedModelCount,
		hasApiKey: false,
		hasOAuth: false,
		lastChecked: status.lastChecked,
		config: { secrets: NO_SECRETS },
		...(notices !== undefined && notices.length > 0 ? { notices } : {}),
	} as const;
	return status.state === "ok"
		? { ...base, state: "ok" }
		: {
				...base,
				state: "error",
				error: status.error,
				errorEnglish: status.logSafeError,
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
		hasApiKey: false,
		hasOAuth: false,
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
		hasApiKey: false,
		hasOAuth: false,
		state: "error",
		error: "misconfigured entry; not used until its configuration is fixed",
		errorEnglish: "misconfigured entry; not used until its configuration is fixed",
		problems: ["auth: configures more than one form"],
	};
}

/**
 * A declared row whose provider-group sync failed, mirroring declaredOutcome's
 * sync branch: an error row carrying the sync message, with the live status's
 * served count when a group serves and zero (no lastChecked either) when the
 * entry never reached discovery.
 */
function syncFailedRow(name: string, message: string, live?: ServerStatus): DashboardServer {
	return {
		origin: "declared",
		label: name,
		baseUrl: `http://${name}.test`,
		servedModelCount: live?.servedModelCount ?? 0,
		hasApiKey: false,
		hasOAuth: false,
		...(live !== undefined ? { lastChecked: live.lastChecked } : {}),
		state: "error",
		error: message,
		config: { secrets: NO_SECRETS },
	};
}

const allFailedDeclaredServing = errorStatus({ servedModelCount: 2, declaredModelCount: 2, error: "HTTP 500" });
const staleServing = errorStatus({ servedModelCount: 3 });
const answeredEmpty = okStatus({ servedModelCount: 0 });
const hiddenGroup = okStatus({ serverId: "ghost", servedModelCount: 0, hiddenByRemoval: true });
const expectedServing = errorStatus({
	serverId: "gw",
	servedModelCount: 1,
	declaredModelCount: 1,
	expected: true,
	error: "404 on /models",
});
const expectedStaleServing = errorStatus({
	serverId: "gw",
	servedModelCount: 2,
	expected: true,
	error: "404 on /models",
});
const expectedMixedServing = errorStatus({
	serverId: "gw",
	servedModelCount: 5,
	declaredModelCount: 2,
	expected: true,
	error: "404 on /models",
});
const expectedDead = errorStatus({ serverId: "gw", servedModelCount: 0, expected: true, error: "404 on /models" });
const unexpectedDead = errorStatus({ serverId: "down", servedModelCount: 0, error: "boom" });
const healthy = okStatus({ servedModelCount: 3 });
const liveBeforeSyncFailure = okStatus({ serverId: "live", servedModelCount: 2 });

/** Sync-failure fixtures: engine-classified texts (the real constants' shape), never host-derived. */
const UPSERT_FAILED = "The host rejected the provider group upsert";
const UPDATE_UNAVAILABLE =
	"A VS Code provider group already uses this name, and VS Code cannot update an existing group.";

/**
 * The window states the initiative's integration findings came from, plus the
 * anchors that bound the classes and one row per remaining verdict and pill
 * word (the coverage helpers below fail closed on omissions). The
 * never-checked row has an EMPTY window on purpose: an entry no discovery pass
 * has seen exists only as a dashboard row, and the bar's configured-gate
 * renders the empty window as the neutral spinner; the misconfigured row rides
 * beside it, since a parser-refused entry never reaches the window either.
 * Sync failures never enter the window either; the two sync-failure rows pin
 * the overlay (applySyncFailures) that folds them into the bar's and
 * notifier's input.
 *
 * Known residuals (left deliberately - each needs plumbing or a vocabulary
 * ruling of its own, not this table):
 * 1. The sync-failure residual is narrowed, not gone: a blocked or
 *    secretsUnreadable entry with no live status renders a red dashboard row
 *    while the bar shows the spinner, because the overlay synthesizes only
 *    for upsertFailed (the one class proving no group exists; synthesizing
 *    for the others raced the first discovery report red). Transient for
 *    blocked - the name-holding group reports - but persistent for an entry
 *    whose secrets were never readable, since no group was ever created.
 * 2. Several sync-failed claimants sharing one snapshot collapse to one
 *    window status while the dashboard renders one row each; with a shared
 *    snapshot serving zero beside a clean claimant, the window can read
 *    "error" where the rows read "degraded".
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
			// The row itself is healthy: the warning is an aggregate claim, and a
			// red or amber pill here would blame a server that answered fine.
			pills: [{ word: "Connected", tone: "ok" }],
		},
	},
	{
		name: "only hidden groups remain, so zero models is user-chosen configuration",
		// The hidden group leaves the servers table entirely (rows is empty); the
		// hidden-groups count is what keeps every surface on the connected
		// zero-model warning instead of "Not configured" beside a warning bar.
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
			statusLine: "Connected, but 0 models are served (1 hidden by user removal)",
			notifier: { kind: "warning", contains: "hidden by an explicit removal" },
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
			statusLine: "Connected, but 0 models are served (1 hidden by user removal; 1 answered with an empty listing)",
			notifier: { kind: "warning", contains: "hidden by an explicit removal" },
			pills: [{ word: "Connected", tone: "ok" }],
		},
	},
	{
		name: "a hidden group beside a declared entry no discovery pass has seen",
		// The unchecked entry contributes no window status; the hidden group's
		// synthesized row is what keeps the rows verdict on the window's
		// "connected" instead of a muted "waiting" beside a warning bar.
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
			statusLine: "Connected, but 0 models are served (1 hidden by user removal)",
			notifier: { kind: "warning", contains: "hidden by an explicit removal" },
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
			// The dead row's pill IS red: row severity may exceed the aggregate
			// (one dead server degrades a fleet), never the other way around.
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
			// The failure is declared normal and models serve: quiet everywhere,
			// never one surface's "Connected" beside another's "Error". Serving
			// through the stale window alone earns NO nothing-declared notice.
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
			statusLine: "Error: boom",
			notifier: { kind: "error", contains: "boom" },
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
		// Empty window on purpose: the failed upsert means no group exists to
		// report, so only the overlay can carry the failure to the bar
		// (upsertFailed is the one class that proves the absence).
		window: [],
		syncFailures: [{ label: "pending", message: UPSERT_FAILED, failureClass: "upsertFailed" }],
		totalModels: 0,
		configured: true,
		rows: [syncFailedRow("pending", UPSERT_FAILED)],
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
		name: "a live group serving models while its entry's sync stays blocked",
		window: [liveBeforeSyncFailure],
		syncFailures: [{ label: "live", message: UPDATE_UNAVAILABLE, failureClass: "blocked" }],
		totalModels: 2,
		configured: true,
		rows: [syncFailedRow("live", UPDATE_UNAVAILABLE, liveBeforeSyncFailure)],
		expect: {
			// Serving through the failed sync: degraded everywhere, never the ok
			// window's "Connected" beside a red dashboard row.
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
 * Every OverallVerdict value, compile-pinned both ways against the union: a
 * new verdict fails this assignment until it is listed here, and listing it
 * fails uncoveredVerdicts() until a table row says what every surface makes
 * of it. The strongest fail-closed form available to a runtime walk.
 */
const ALL_VERDICTS = ["not-configured", "error", "degraded", "waiting", "connected", "needs-declare"] as const;
const _allVerdictsMatchUnion: [
	Exclude<OverallVerdict, (typeof ALL_VERDICTS)[number]>,
	Exclude<(typeof ALL_VERDICTS)[number], OverallVerdict>,
] extends [never, never]
	? true
	: never = true;

/** Verdicts no table row covers; both suites assert emptiness. */
export function uncoveredVerdicts(): OverallVerdict[] {
	return ALL_VERDICTS.filter((verdict) => !WINDOW_STATE_ROWS.some((row) => row.expect.verdict === verdict));
}

/**
 * Every pill word the row health walk can produce (serverHealth's seven
 * verdicts collapse onto these six words; "Connected" covers both the clean
 * and the expected-serving states). An equality pin, not derivable here: the
 * vocabulary lives webview-side and this table must stay importable by the
 * host suite.
 */
const ALL_PILL_WORDS = [
	"Connected",
	"Sync issue",
	"Error",
	"Not checked",
	"Expected failure",
	"Misconfigured",
] as const;

/** Pill words no table row covers; both suites assert emptiness. */
export function uncoveredPills(): string[] {
	return ALL_PILL_WORDS.filter(
		(word) => !WINDOW_STATE_ROWS.some((row) => row.expect.pills.some((pill) => pill.word === word))
	);
}

/** What each severity class permits of each aggregate surface; the single mapping both suites enforce. */
const CLASS_RULES: Readonly<
	Record<
		SeverityClass,
		{
			bar: readonly BarExpectation["severity"][];
			hero: readonly WindowStateRow["expect"]["hero"]["tone"][];
			notifier: readonly ("none" | "info" | "warning" | "error")[];
		}
	>
> = {
	ok: { bar: ["plain"], hero: ["ok"], notifier: ["none", "info"] },
	warn: { bar: ["warning"], hero: ["warn"], notifier: ["none", "warning"] },
	error: { bar: ["error"], hero: ["error"], notifier: ["error"] },
	muted: { bar: ["plain"], hero: ["muted"], notifier: ["none"] },
	setup: { bar: ["warning"], hero: ["muted"], notifier: ["none", "warning"] },
};

/**
 * The contradictions a row's EXPECTATIONS carry, before any surface runs: an
 * aggregate surface outside the row's severity class. Empty for a consistent
 * table; both suites assert emptiness, so an expectation edit that reintroduces
 * a green-hero-beside-red-bar row fails even with every surface matching it.
 */
export function aggregateContradictions(row: WindowStateRow): string[] {
	const rules = CLASS_RULES[row.expect.severityClass];
	const problems: string[] = [];
	if (row.expect.severityClass === "setup" && row.expect.verdict !== "not-configured") {
		// The softer setup tier exists for the nothing-to-check state alone; a
		// health verdict claiming it would dodge the strict class rules.
		problems.push(`class "setup" is reserved for the not-configured verdict, not "${row.expect.verdict}"`);
	}
	if (!rules.bar.includes(row.expect.bar.severity)) {
		problems.push(`bar severity "${row.expect.bar.severity}" is outside class "${row.expect.severityClass}"`);
	}
	if (!rules.hero.includes(row.expect.hero.tone)) {
		problems.push(`hero tone "${row.expect.hero.tone}" is outside class "${row.expect.severityClass}"`);
	}
	const notifierKind = row.expect.notifier === "none" ? "none" : row.expect.notifier.kind;
	if (!rules.notifier.includes(notifierKind)) {
		problems.push(`notifier "${notifierKind}" is outside class "${row.expect.severityClass}"`);
	}
	return problems;
}
