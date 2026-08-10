/**
 * The dashboard's wire contract: the serializable state the extension pushes
 * into the webview and the intents the webview posts back. This module is
 * imported by both sides (the extension host and the browser bundle), so it
 * must stay pure: no vscode, no DOM, no Node. Pure helpers from src/shared
 * and @vscode/l10n (the one l10n API that works in both runtimes) are the
 * allowed dependencies, re-exported here because webview code may
 * import only this module (the Biome override in biome.json enforces that).
 *
 * The dashboard is a stateless view over the existing stores. Everything in
 * DashboardState is derived on demand from the provider's status window and
 * from workspace configuration; nothing here is persisted anywhere.
 */

// The capability inspector renders the extension-resolved EffectiveCapabilities
// it receives over the message protocol; only the types (and the small pure
// vocabulary constants the editor keys its inputs off) cross into the webview
// bundle - never the resolver itself or any catalog data.
export type {
	CapabilityDiagnostic,
	CapabilityFieldName,
	CapabilityLevel,
	EffectiveCapabilities,
	EffectiveCapabilityField,
	ShadowedCapabilityValue,
} from "../../shared/config/capabilityResolution";
export {
	CAPABILITY_FIELDS,
	FALLBACK_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
} from "../../shared/config/capabilityResolution";
// The effective-values inspector renders through the same resolution the
// request path runs; the webview may import only this module, so the pure
// functions are re-exported here (the isValidHeaderName precedent).
export type {
	EffectiveParameterRow,
	ParameterDiagnostic,
	ParameterSourceRef,
	ProjectedMaxTokens,
	ShadowedParameterValue,
} from "../../shared/config/parameterResolution";
export { DEFAULT_MAX_TOKENS_CAP, FORCE_DIRECTIVE, isForceableParameter } from "../../shared/config/parameterResolution";
export type { RecordDiagnostic } from "../../shared/config/recordResolution";
export { INHERIT_FROM_DIRECTIVE, INHERITABLE_DIRECTIVE } from "../../shared/config/recordResolution";
export type { BooleanSettingId, NumberSettingId } from "../../shared/config/settingSpec";
export { NUMBER_SETTING_SPECS } from "../../shared/config/settingSpec";
// The intentFailed notice's classification: enum ids and a status number,
// never message text, so it is safe across the webview boundary (the same
// rule the logs follow).
export type { SetupHintKind, TransportErrorClassification } from "../../shared/errorClassification";
export type {
	ExpectedFailureCategory,
	NonSecretOptionalFieldId,
	SecretFieldId,
	SecretLocation,
} from "../../shared/serverEntry";
export { EXPECTED_FAILURE_CATEGORIES, NON_SECRET_OPTIONAL_FIELD_IDS, SECRET_FIELD_IDS } from "../../shared/serverEntry";
export { statusErrorDetail, statusErrorHeadline } from "../../shared/util/errorText";
export type { HeaderScalar } from "../../shared/util/headers";
export { isValidHeaderName, isValidHeaderValue } from "../../shared/util/headers";
export { isRecord, isUnsafeRecordKey } from "../../shared/util/json";

import * as l10n from "@vscode/l10n";
import type { CapabilityLevel, EffectiveCapabilities } from "../../shared/config/capabilityResolution";
import type { EffectiveParametersProjection } from "../../shared/config/parameterResolution";
import type { RecordDiagnostic } from "../../shared/config/recordResolution";
import type { BooleanSettingId, NumberSettingId } from "../../shared/config/settingSpec";
import { BOOLEAN_SETTING_SPECS, NUMBER_SETTING_SPECS } from "../../shared/config/settingSpec";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import type {
	ExpectedFailureCategory,
	NonSecretOptionalFields,
	SecretFieldId,
	SecretLocation,
} from "../../shared/serverEntry";
import { statusErrorDetail, statusErrorHeadline } from "../../shared/util/errorText";
import type { HeaderScalar } from "../../shared/util/headers";

/** A per-entry modelParameters record: model-ID prefix to request parameters. Non-secret user configuration. */
type EntryModelParametersPayload = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** A per-entry modelCapabilities record: model-ID prefix to capability fields and directives. Non-secret. */
type EntryModelCapabilitiesPayload = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The non-secret configuration of a declared server, for the edit form's prefill. */
interface DashboardServerConfig extends NonSecretOptionalFields {
	/** Where each secret currently lives; the values themselves never reach the webview. */
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
	/** The entry's own modelParameters, when it has any; the edit form's prefill. */
	readonly modelParameters?: EntryModelParametersPayload | undefined;
	/** The entry's own modelCapabilities, when it has any; the edit form's prefill. */
	readonly modelCapabilities?: EntryModelCapabilitiesPayload | undefined;
	/** The entry's expected discovery-failure categories, when it declares any. */
	readonly expectedFailures?: readonly ExpectedFailureCategory[] | undefined;
	/** The entry's custom HTTP headers (plain settings text, not secrets); the edit form's prefill. */
	readonly headers?: Readonly<Record<string, string>> | undefined;
	/** The entry's discovery.declared model IDs, when it lists any. */
	readonly declaredModels?: readonly string[] | undefined;
	/** The entry's manual usage budget in USD, when set. */
	readonly budget?: number | undefined;
}

/**
 * Row-level warning classifications for declared entries. Only the
 * classification crosses the extension-webview boundary; the user-facing copy
 * is rendered webview-side - the same rule the logs follow (classifications,
 * never free text).
 *
 * "entry-params-inactive" / "entry-capabilities-inactive": the entry declares
 * an entry-only field (per-entry modelParameters; per-entry modelCapabilities
 * or expectedFailures), but the live group serving it did not join by the
 * entry's exact labeled identity - it predates entry labels, predates a
 * rename, or carries someone else's label - so the request path's
 * label-and-URL check does not apply those fields. Recreating the group
 * activates them. One classification per field family so a row can name
 * exactly what is inactive.
 *
 * "expected-failures-nothing-declared": discovery failed in a category the
 * entry expects, and the entry's discovery.declared list supplies no models -
 * the server is healthy by its own declaration but serves nothing, which only
 * a declared model can fix.
 */
export type DeclaredServerNotice =
	| "entry-params-inactive"
	| "entry-capabilities-inactive"
	| "entry-headers-inactive"
	| "expected-failures-nothing-declared";

/**
 * Where an external provider group came from, when the extension's removal
 * bookkeeping knows: the leftover of a removed entry (with the removed
 * label), or the leftover of a rename (old label -> new label). Absent for
 * groups added outside this extension or predating the tracking - the webview
 * renders that honest default. Classifications and labels only, never free
 * text, like DeclaredServerNotice.
 */
export type ExternalServerProvenance =
	| { readonly kind: "removed-entry-leftover"; readonly removedLabel: string }
	| { readonly kind: "rename-leftover"; readonly oldLabel: string; readonly newLabel: string };

/**
 * One provider group the user explicitly removed (tombstoned): it answers
 * with no models and leaves the servers table for the collapsed hidden-groups
 * line, which offers Unhide per row. The identity is what the unhideServer
 * intent echoes back.
 */
export interface HiddenGroup {
	readonly label: string;
	readonly baseUrl: string;
}

interface DashboardServerBase {
	readonly label: string;
	readonly baseUrl: string;
	readonly modelCount: number;
	/** ISO timestamp of the last discovery attempt; absent while unchecked. */
	readonly lastChecked?: string | undefined;
	/** Whether the server has credentials configured anywhere; never the credentials themselves. */
	readonly hasApiKey: boolean;
	readonly hasOAuth: boolean;
}

/**
 * One server row: a declared entry from the litellm-vscode-chat.servers
 * setting, a live provider group the status window saw, or both merged
 * (joined by label and base URL). Secrets never reach the webview; only
 * their locations do.
 *
 * Discriminated twice. On `origin`: a declared row always carries the edit
 * form's config prefill, an external row always carries the opaque adopt
 * handle, and neither carries the other's field. On `state`: an error row
 * always has its message, an "ok" row may STILL carry one (deliberate: a
 * declared entry whose group upsert failed while an already-live group keeps
 * serving renders "OK (N models) - <sync error>"), and "unchecked" (declared
 * in settings but not yet seen by a discovery pass) carries none.
 * `errorEnglish` is the error's log-safe English rendering
 * (ServerStatus.logSafeError, markLogSafe-branded - no secrets, no raw
 * response text), present only when `error` is the transport error itself:
 * the on-screen row renders the localized `error`, while the copyable
 * diagnostics block substitutes `errorEnglish` so pasted reports stay
 * English (see diagnostics.tsx).
 */
export type DashboardServer = DashboardServerBase &
	(
		| {
				/** In the servers setting (editable here); `config` is the edit form's prefill. */
				readonly origin: "declared";
				readonly config: DashboardServerConfig;
				readonly adoptHandle?: undefined;
				/** Warning classifications for the row, when any apply; see DeclaredServerNotice. */
				readonly notices?: readonly DeclaredServerNotice[] | undefined;
				readonly provenance?: undefined;
				readonly hideable?: undefined;
				readonly problems?: undefined;
		  }
		| {
				/**
				 * A servers-setting entry the parser REFUSED (an ambiguous or
				 * incomplete auth shape, per docs/servers.md#authentication): present
				 * in the setting but never synced or served until fixed. `problems`
				 * carries the parser's English structural reports (configuration key
				 * names only, never entered values - the same text the sync engine
				 * logs), rendered on the row, in Configuration diagnostics, and in
				 * copied reports. No `config`: the broken shape cannot round-trip
				 * through the edit form without silently rewriting what the user
				 * typed, so the fix lives in settings.json (the row's Fix action
				 * reveals the entry).
				 */
				readonly origin: "misconfigured";
				readonly problems: readonly string[];
				readonly config?: undefined;
				readonly adoptHandle?: undefined;
				readonly notices?: undefined;
				readonly provenance?: undefined;
				readonly hideable?: undefined;
		  }
		| {
				/**
				 * A provider group managed outside the setting. `adoptHandle` is the
				 * opaque token the adopt intent names its source group by: a salted
				 * one-way hash of the extension-side server ID, stable across state
				 * pushes for the session (rendered labels and row order are not); it
				 * carries no credential material, cannot be reproduced outside the
				 * extension host, and resolves back to a group only while that group
				 * is still external.
				 */
				readonly origin: "external";
				readonly adoptHandle: string;
				readonly config?: undefined;
				readonly notices?: undefined;
				/** Why the group exists, when a removal or rename explains it; see ExternalServerProvenance. */
				readonly provenance?: ExternalServerProvenance | undefined;
				/**
				 * Whether Remove (hide) applies: true for provider-group rows, false
				 * for legacy-registry rows, whose models the registry path would
				 * keep serving - hiding those would only make the dashboard lie.
				 */
				readonly hideable: boolean;
				readonly problems?: undefined;
		  }
	) &
	(
		| {
				readonly state: "ok";
				readonly error?: string | undefined;
				readonly errorEnglish?: string | undefined;
				readonly classification?: undefined;
				readonly expected?: undefined;
				readonly declaredModelCount?: undefined;
		  }
		| {
				readonly state: "error";
				readonly error: string;
				readonly errorEnglish?: string | undefined;
				/**
				 * The transport classification behind the row's error, when one
				 * exists. Classification only - enum ids and a status number, never
				 * message text - so it is safe to cross the webview boundary; present
				 * under the same rule as errorEnglish (only when `error` IS the
				 * transport error - a masking sync error is not classified). The
				 * webview maps the setup-hint id to the matching troubleshooting-guide
				 * link, exactly like the intentFailed notice's classification.
				 */
				readonly classification?: TransportErrorClassification | undefined;
				/**
				 * True when the failure hit a category the entry's expectedFailures
				 * declares: the discovery outcome stays a truthful error (the stale
				 * anchor and counts depend on it), but every presentation surface
				 * treats it as expected - excluded from failure verdicts, annotated
				 * "(expected)" instead of rendered red.
				 */
				readonly expected?: boolean | undefined;
				/** How many declared models this server keeps serving despite the failure. */
				readonly declaredModelCount?: number | undefined;
		  }
		| {
				readonly state: "unchecked";
				readonly error?: undefined;
				readonly errorEnglish?: undefined;
				readonly classification?: undefined;
				readonly expected?: undefined;
				readonly declaredModelCount?: undefined;
		  }
	);

/**
 * The overall configuration verdict, shared by the dashboard hero and the
 * Diagnostics tab so their headline judgement cannot drift. Each surface
 * renders it differently (the hero as a colored word, the tab as a line with
 * model counts and the first error), but the classification itself lives
 * here once. Only real failures count as failures: declared entries a
 * discovery pass has not reached yet stay neutral, and so do failures the
 * entry's expectedFailures declares - an expected failure serving declared
 * models counts as connected, and one serving nothing yields the neutral
 * "needs-declare" verdict instead of a red claim. Misconfigured entries are
 * neutral too: they never reach the host, so the status bar cannot see them,
 * and counting them here would split the headline from the status bar (their
 * signal is the Misconfigured pill, the red banner, and Configuration
 * diagnostics) - except that a configuration consisting ONLY of misconfigured
 * entries is an error, not "waiting" (nothing will ever connect until it is
 * fixed).
 */
export type OverallVerdict = "not-configured" | "error" | "degraded" | "waiting" | "connected" | "needs-declare";

export function classifyOverall(
	servers: readonly (Pick<DashboardServer, "state" | "expected" | "declaredModelCount"> & {
		readonly origin?: DashboardServer["origin"];
	})[]
): OverallVerdict {
	if (servers.length === 0) {
		return "not-configured";
	}
	const transport = servers.filter((server) => server.origin !== "misconfigured");
	if (transport.length === 0) {
		return "error";
	}
	const errors = transport.filter((server) => server.state === "error" && server.expected !== true).length;
	if (errors === transport.length) {
		return "error";
	}
	if (errors > 0) {
		return "degraded";
	}
	const serving = transport.some(
		(server) => server.state === "ok" || (server.state === "error" && (server.declaredModelCount ?? 0) > 0)
	);
	if (serving) {
		return "connected";
	}
	// Nothing serves and nothing failed unexpectedly: expected failures with no
	// declared models are the actionable case, plain unchecked entries wait.
	if (transport.some((server) => server.state === "error")) {
		return "needs-declare";
	}
	return "waiting";
}

/**
 * The verdict as one sentence, the headline of the Diagnostics tab (which is
 * what litellm.showDiagnostics opens). Shared like classifyOverall and pinned
 * by tests: this line is what users paste into issue reports, so its wording
 * must not depend on which surface they copied from. English by policy: users
 * paste these lines into public issue reports, so localization sweeps must
 * skip this function. The legacy registry (pre-migration installs and test
 * mode) is real configuration even though it contributes no server rows, so
 * it overrides the bare not-configured claim.
 */
export function overallStatusText(
	servers: readonly DashboardServer[],
	modelCount: number,
	legacyServerCount = 0
): string {
	switch (classifyOverall(servers)) {
		case "not-configured":
			return legacyServerCount > 0
				? `Legacy registry only (${legacyServerCount} ${legacyServerCount === 1 ? "server" : "servers"})`
				: "Not configured";
		case "error": {
			// The verdict guarantees at least one error-state server; the fallback
			// only satisfies the type checker, which cannot see that. A transport
			// failure outranks a misconfigured row's fixed text: rows sort by
			// label, and the real outage is the line worth pasting.
			const errorRows = servers.filter((server) => server.state === "error");
			const firstError =
				(errorRows.find((server) => server.origin !== "misconfigured") ?? errorRows[0])?.error ?? "Unknown error";
			return `Error: ${firstError}`;
		}
		case "degraded":
			return `Degraded (${modelCount} models, some servers failed)`;
		case "waiting":
			return "Waiting for first sync";
		case "needs-declare":
			return "Expected discovery failures; no declared models (add IDs to the entry's discovery.declared)";
		case "connected":
			return `Connected (${modelCount} models)`;
	}
}

/**
 * The entry-params-inactive classification as diagnostics prose. Fixed text
 * derived from the classification alone (no user or response content):
 * "my per-entry parameters do nothing" is exactly what lands in issue
 * reports, so every diagnostics surface must name it the same way. English by
 * policy: users paste these lines into public issue reports, so localization
 * sweeps must skip this constant.
 */
const ENTRY_PARAMS_INACTIVE_TEXT =
	"per-entry modelParameters are not applied (the provider group does not carry this entry's labeled identity); delete the group's object from the models file (chatLanguageModels.json), reload the window, and run Sync Models Now, or save the entry under a new label";

/** The capabilities twin of ENTRY_PARAMS_INACTIVE_TEXT; English by the same issue-report policy. */
const ENTRY_CAPABILITIES_INACTIVE_TEXT =
	"per-entry modelCapabilities, declared models, and expectedFailures are not applied (the provider group does not carry this entry's labeled identity); delete the group's object from the models file (chatLanguageModels.json), reload the window, and run Sync Models Now, or save the entry under a new label";

/** The custom-headers twin of ENTRY_PARAMS_INACTIVE_TEXT; English by the same issue-report policy. */
const ENTRY_HEADERS_INACTIVE_TEXT =
	"per-entry custom headers are not applied (the provider group does not carry this entry's labeled identity); delete the group's object from the models file (chatLanguageModels.json), reload the window, and run Sync Models Now, or save the entry under a new label";

/** The expected-failure-with-nothing-to-serve line; English by the same issue-report policy. */
const EXPECTED_FAILURES_NOTHING_DECLARED_TEXT =
	"discovery fails in an expected category and no models are declared; add IDs to the entry's discovery.declared list to serve models without discovery";

/** One notice classification's fixed diagnostics prose; see the constants above. */
function noticeText(notice: DeclaredServerNotice): string {
	switch (notice) {
		case "entry-params-inactive":
			return ENTRY_PARAMS_INACTIVE_TEXT;
		case "entry-capabilities-inactive":
			return ENTRY_CAPABILITIES_INACTIVE_TEXT;
		case "entry-headers-inactive":
			return ENTRY_HEADERS_INACTIVE_TEXT;
		case "expected-failures-nothing-declared":
			return EXPECTED_FAILURES_NOTHING_DECLARED_TEXT;
	}
}

/**
 * serverOutcomeText decomposed, for surfaces that render the pieces
 * separately (the Diagnostics tab's outcome grid): the status verdict, the
 * model-count clause an "ok" line carries, the error the row carries, and the
 * row's warning notices. The one-line form composes exactly these parts,
 * flattening a two-part error's newline to " - " (protocol.test.ts pins the
 * equality), so a grid cell and the copied line cannot drift apart in wording.
 */
export interface ServerOutcomeParts {
	/** The verdict as a Status cell shows it. */
	readonly status: "OK" | "Error" | "Misconfigured" | "Not checked yet";
	/** The model-count clause an "ok" line parenthesizes ("3 models"); absent on other states. */
	readonly models?: string | undefined;
	/**
	 * The row's error: an "error" state's message (with the English
	 * "(expected)" annotation when the entry expects the category), or the
	 * sync failure an "ok" row can still carry (a declared entry whose group
	 * upsert failed while an already-live group keeps serving).
	 */
	readonly error?: string | undefined;
	/** The row's warning notices, fixed classification text, one line each. */
	readonly notice: readonly string[];
}

export function serverOutcomeParts(server: DashboardServer): ServerOutcomeParts {
	const notice = (server.notices ?? []).map(noticeText);
	if (server.origin === "misconfigured") {
		// The parser's structural reports (configuration key names, never entered
		// values); English like the notices - these lines land in issue reports.
		return { status: "Misconfigured", error: server.problems.join("; "), notice };
	}
	switch (server.state) {
		case "ok":
			return { status: "OK", models: `${server.modelCount} models`, error: server.error, notice };
		case "error": {
			if (server.expected === true) {
				// Truthful error, expected presentation: the annotation stays
				// English (it lands in issue reports) and rides the headline
				// line, so a two-part error shows its expected marker in the
				// grid's prominent line rather than trailing the dimmed detail.
				// A row still serving declared models reads as OK-with-note
				// rather than a failure.
				const detail = statusErrorDetail(server.error);
				const headline = `${statusErrorHeadline(server.error)} (expected)`;
				const error = detail === undefined ? headline : `${headline}\n${detail}`;
				const declared = server.declaredModelCount ?? 0;
				if (declared > 0) {
					const models = declared === 1 ? "1 declared model" : `${declared} declared models`;
					return { status: "OK", models, error, notice };
				}
				return { status: "Error", error, notice };
			}
			return { status: "Error", error: server.error, notice };
		}
		case "unchecked":
			return { status: "Not checked yet", notice };
	}
}

/**
 * One server's diagnostics outcome line, pinned by tests like
 * overallStatusText. English by policy: users paste these lines into public
 * issue reports, so localization sweeps must skip this function.
 */
export function serverOutcomeText(server: DashboardServer): string {
	const parts = serverOutcomeParts(server);
	// "OK (2 models) - <sync error>" vs "Error: <error>": the error joins an
	// OK line as an aside and an Error line as its object.
	const status = parts.models === undefined ? parts.status : `${parts.status} (${parts.models})`;
	// A two-part error (headline "\n" detail) flattens to one physical line
	// here: this is the copy-paste issue-report form, and a line break would
	// split one server's outcome across lines.
	const flatError = parts.error
		?.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(" - ");
	const error = flatError === undefined ? "" : parts.status === "OK" ? ` - ${flatError}` : `: ${flatError}`;
	// Notices ride alongside whatever the state line says: a noticed row is
	// usually healthy ("ok"), which is exactly why it needs calling out.
	const notice = parts.notice.map((text) => ` - ${text}`).join("");
	return `${status}${error}${notice}`;
}

/** The most recent lastChecked across the servers, as epoch milliseconds; undefined while nothing was checked. */
export function latestCheckedMs(servers: readonly Pick<DashboardServer, "lastChecked">[]): number | undefined {
	const times = servers
		.map((server) => (server.lastChecked === undefined ? Number.NaN : new Date(server.lastChecked).getTime()))
		.filter((time) => !Number.isNaN(time));
	return times.length > 0 ? Math.max(...times) : undefined;
}

/** One registered model, reduced to display facts. Costs are USD per million tokens, as registration converted them. */
export interface DashboardModel {
	readonly id: string;
	/**
	 * The model ID as the server knows it: what a request's `model` field and a
	 * modelParameters prefix match against. Differs from `id` only on
	 * legacy-registry multi-server registrations, where `id` carries a server
	 * namespace.
	 */
	readonly rawId: string;
	/**
	 * An opaque per-session handle for the model's serving server (a salted
	 * hash of the extension-side server ID): what the inspector reads
	 * (readModelParameters, readModelCapabilities) address a server by, so a
	 * stale key de-resolves instead of hitting another server. Push-local,
	 * never persisted.
	 */
	readonly scopeKey: string;
	readonly name: string;
	readonly family: string;
	readonly serverLabel: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	/** Whether the server declared the output limit; gates the request's max_tokens cap (see resolveMaxTokens). */
	readonly outputLimitDeclared: boolean;
	readonly inputCost?: number | undefined;
	readonly outputCost?: number | undefined;
	readonly cacheReadCost?: number | undefined;
	readonly cacheWriteCost?: number | undefined;
	/** Long-context tier costs; present only when the tier differs from the base price. */
	readonly longContextInputCost?: number | undefined;
	readonly longContextOutputCost?: number | undefined;
	readonly longContextCacheReadCost?: number | undefined;
	readonly longContextCacheWriteCost?: number | undefined;
	readonly toolCalling: boolean;
	readonly imageInput: boolean;
	readonly promptCaching: boolean;
	/** True when the model advertises the reasoning-effort configuration control. */
	readonly reasoning: boolean;
	/** True for a declared model (discovery does not list it); drives the declared badge. */
	readonly declared?: boolean | undefined;
}

/**
 * What each number setting counts. Static classification, deliberately apart
 * from the localized presentation: value logic keys off these codes through
 * NUMBER_UNIT_BEHAVIOR, and the form renders the localized unit suffix from
 * numberSettingPresentation instead. Module-private with the behavior table:
 * consumers read a setting's unit through unitBehavior().
 */
const NUMBER_SETTING_UNITS = {
	"chat.timeout": "ms",
	"discovery.timeout": "ms",
	"discovery.cacheTtl": "ms",
	"usage.pollInterval": "ms",
} as const satisfies Record<NumberSettingId, NumberSettingUnit>;

/**
 * One unit's value behavior: everything the display and validation paths key
 * off a setting's unit, so adding a unit (a percentage, a currency) is one
 * row in NUMBER_UNIT_BEHAVIOR and every consumer picks it up through
 * unitBehavior(). Localized strings resolve inside the functions, per call,
 * so the table holds no localized constants.
 */
export interface NumberUnitBehavior {
	/** A draft's numeric reading under the unit's grammar; undefined when the text has no reading. */
	readonly parseDraft: (text: string) => number | undefined;
	/** The localized problem to render when parseDraft has no reading. */
	readonly parseProblem: () => string;
	/** An exact human rendering of a value ("5 min"), or undefined to show the raw number. */
	readonly exactDisplay: (value: number) => string | undefined;
	/** The muted "= ..." equivalence beside the input, or undefined when the unit offers none. */
	readonly equivalence: (value: number, zeroMeaning: string | undefined) => string | undefined;
	/** The minimum bound as failure-detail text, unit-suffixed; stays English (it rides intent-failure detail lines). */
	readonly minimumText: (minimum: number) => string;
	/** Whether the grammar needs a free-text input (a number input would swallow suffix letters). */
	readonly freeTextInput: boolean;
}

// The rows may reference parseDurationDraftMs and formatDuration above their
// definitions only because those are hoisted function declarations; turning
// either into a const arrow would crash this table at module load.
const NUMBER_UNIT_BEHAVIOR = {
	ms: {
		parseDraft: parseDurationDraftMs,
		parseProblem: () =>
			l10n.t({
				message: "Not a duration - use ms, s, m, or h",
				comment: ["Do not translate the suffixes ms/s/m/h; the parser accepts only these ASCII letters."],
			}),
		exactDisplay: (value) => {
			const duration = formatDuration(value);
			return duration?.exact ? duration.label : undefined;
		},
		equivalence: (value, zeroMeaning) => {
			if (value === 0) {
				return zeroMeaning === undefined ? undefined : `= ${zeroMeaning}`;
			}
			const duration = formatDuration(value);
			return duration === undefined ? undefined : `= ${duration.label}`;
		},
		minimumText: (minimum) => `${minimum} ms`,
		freeTextInput: true,
	},
	tokens: {
		parseDraft: (text) => {
			const trimmed = text.trim();
			// Number("") is 0; an empty draft has no reading under any grammar.
			if (trimmed.length === 0) {
				return undefined;
			}
			const value = Number(trimmed);
			return Number.isFinite(value) ? value : undefined;
		},
		parseProblem: () => l10n.t("Not a number"),
		exactDisplay: () => undefined,
		// A digit-grouped echo of the same number would say nothing; the unit
		// suffix on the input carries the meaning.
		equivalence: () => undefined,
		minimumText: (minimum) => String(minimum),
		freeTextInput: false,
	},
} as const satisfies Record<string, NumberUnitBehavior>;

/** The closed unit vocabulary; adding a unit means adding its NUMBER_UNIT_BEHAVIOR row. */
type NumberSettingUnit = keyof typeof NUMBER_UNIT_BEHAVIOR;

/** The unit behavior of one number setting: the single lookup every unit-dependent path goes through. */
export function unitBehavior(id: NumberSettingId): NumberUnitBehavior {
	return NUMBER_UNIT_BEHAVIOR[NUMBER_SETTING_UNITS[id]];
}

/** One number setting's presentation strings, resolved per call so the l10n bundle is honored. */
export interface NumberSettingPresentation {
	readonly label: string;
	readonly description: string;
	/** The input's unit suffix; display text only - the grammar keys off NUMBER_SETTING_UNITS, never off this. */
	readonly unit: string;
	/** What a configured 0 means, when 0 is legal and has a special reading (the cache TTL). */
	readonly zeroMeaning?: string;
}

/**
 * The presentation of one number-valued litellm-vscode-chat.* setting the
 * dashboard edits. A function, not a module-level catalog: these strings
 * localize, and module-level constants would freeze the English text before
 * l10n.config runs (the value side stays static in
 * shared/config/settingSpec's NUMBER_SETTING_SPECS). The state builder still
 * reads display-fallback defaults through configuration inspection, which
 * settingSpec.test.ts pins to the same numbers.
 */
export function numberSettingPresentation(id: NumberSettingId): NumberSettingPresentation {
	switch (id) {
		case "chat.timeout":
			return {
				label: l10n.t("Request timeout"),
				description: l10n.t("Hard bound for one chat completion call."),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
			};
		case "discovery.timeout":
			return {
				label: l10n.t("Discovery timeout"),
				description: l10n.t("Hard bound for one model discovery call."),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
			};
		case "discovery.cacheTtl":
			return {
				label: l10n.t("Discovery cache lifetime"),
				description: l10n.t("How long discovered model lists are reused; 0 asks the server on every refresh."),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
				zeroMeaning: l10n.t("every refresh"),
			};
		case "usage.pollInterval":
			return {
				label: l10n.t("Usage poll interval"),
				description: l10n.t("How often per-server spend and budget data refresh; 0 turns polling off."),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
				zeroMeaning: l10n.t("polling off"),
			};
	}
}

export const NUMBER_SETTING_IDS = Object.keys(NUMBER_SETTING_SPECS) as readonly NumberSettingId[];

/** Millisecond multipliers for the duration grammar's unit suffixes. */
const DURATION_SUFFIX_MS: Readonly<Record<string, number>> = {
	ms: 1,
	s: 1000,
	m: 60000,
	h: 3600000,
};

/**
 * A duration draft as milliseconds: "1500ms", "90s", "5m", "1h" (suffixes
 * case-insensitive, whitespace before the suffix allowed), or a bare number
 * meaning milliseconds as before. Undefined for everything else - a bare
 * suffix, a junk prefix, a non-finite number - so the form renders one
 * grammar error. Module-private on purpose: every consumer reads durations
 * through parseNumberDraft's single verdict (isBoundViolation included, via
 * draftValue below).
 */
function parseDurationDraftMs(text: string): number | undefined {
	const trimmed = text.trim();
	const match = /^(.*?)(ms|s|m|h)$/i.exec(trimmed);
	if (match === null) {
		// No suffix: the bare-number-is-ms reading. Number("") is 0, so the
		// empty draft must never reach this helper unguarded (draftValue and
		// parseNumberDraft both handle it first).
		const bare = trimmed.length === 0 ? Number.NaN : Number(trimmed);
		return Number.isFinite(bare) ? bare : undefined;
	}
	const prefix = match[1] ?? "";
	const suffix = (match[2] ?? "").toLowerCase();
	if (prefix.trim().length === 0) {
		return undefined;
	}
	const value = Number(prefix);
	if (!Number.isFinite(value)) {
		return undefined;
	}
	const scaled = value * (DURATION_SUFFIX_MS[suffix] ?? Number.NaN);
	// The scaling can overflow ("9e307h"); a non-finite product is as
	// unwritable as a non-finite prefix and must not read as a valid draft.
	// Finite products round to whole milliseconds: "1.0005s" means 1001 ms,
	// and sub-millisecond precision in a duration string is never intent.
	return Number.isFinite(scaled) ? Math.round(scaled) : undefined;
}

/**
 * One draft's numeric reading under the field's grammar: the duration grammar
 * on ms-unit settings, plain trim-and-Number elsewhere (the unit's parseDraft,
 * looked up through unitBehavior). Undefined when the text has no reading
 * (empty included). The single value extraction behind parseNumberDraft AND
 * isBoundViolation, so the two can never disagree about what a draft is
 * worth.
 */
function draftValue(id: NumberSettingId, text: string): number | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	return unitBehavior(id).parseDraft(trimmed);
}

/**
 * What a modified number row shows as the setting's built-in default: the
 * unit's exact human rendering when it has one, the raw number otherwise.
 * Millisecond defaults speak the same duration idiom as the field's
 * equivalence hint ("5 min", not "300000"), so the two read consistently side
 * by side - but only when the duration is exact: a "~" approximation would
 * misstate what the default actually is, so those fall back to the raw
 * number.
 */
export function defaultDisplay(id: NumberSettingId): string {
	const spec = NUMBER_SETTING_SPECS[id];
	return unitBehavior(id).exactDisplay(spec.default) ?? String(spec.default);
}

/**
 * Whether a draft parseNumberDraft rejected failed only the minimum bound: it
 * reads as a finite number under the field's grammar (durations included),
 * just one below spec.minimum. The form keeps these quiet until the field
 * blurs (typing the 5 of 5000 passes through honest below-minimum values),
 * while true parse failures stay live. Reads the draft through the same
 * draftValue extraction parseNumberDraft uses, so the two classifications
 * cannot drift; the settings-form tests pin both.
 */
export function isBoundViolation(id: NumberSettingId, text: string): boolean {
	const value = draftValue(id, text);
	return value !== undefined && value < NUMBER_SETTING_SPECS[id].minimum;
}

/** One boolean setting's presentation strings, resolved per call so the l10n bundle is honored. */
export interface BooleanSettingPresentation {
	readonly label: string;
	readonly description: string;
}

/**
 * The presentation of one boolean litellm-vscode-chat.* setting the dashboard
 * edits; a function for the same lazy-localization reason as
 * numberSettingPresentation (the value side stays static in
 * shared/config/settingSpec's BOOLEAN_SETTING_SPECS).
 */
export function booleanSettingPresentation(id: BooleanSettingId): BooleanSettingPresentation {
	switch (id) {
		case "chat.promptCaching":
			return {
				label: l10n.t("Prompt caching"),
				description: l10n.t("Cache the system prompt on models that advertise support."),
			};
		case "ui.maskSecretInputs":
			return {
				label: l10n.t("Mask secret inputs"),
				description: l10n.t("Hide API keys and other credentials while typing them into configuration prompts."),
			};
		case "models.openRouterCatalog":
			return {
				label: l10n.t("OpenRouter catalog"),
				description: l10n.t("Fill missing model capabilities from the OpenRouter catalog, refreshed weekly."),
			};
	}
}

export const BOOLEAN_SETTING_IDS = Object.keys(BOOLEAN_SETTING_SPECS) as readonly BooleanSettingId[];

/**
 * The settings the revealSetting intent may name: exactly what the Settings
 * tab renders rows or editors for - the scalars plus the record setting.
 * A classification list, not free text: only these ids cross the webview
 * boundary, and the extension resolves each to "litellm-vscode-chat.<id>"
 * itself.
 */
export type RevealableSettingId =
	| NumberSettingId
	| BooleanSettingId
	| "models.parameters"
	| "models.capabilities"
	| "servers"
	| "usage.alertThresholds"
	| "usage.statusBar";

export const REVEALABLE_SETTING_IDS: readonly RevealableSettingId[] = [
	...NUMBER_SETTING_IDS,
	...BOOLEAN_SETTING_IDS,
	"models.parameters",
	"models.capabilities",
	"servers",
	"usage.alertThresholds",
	"usage.statusBar",
];

/**
 * A millisecond count as humans read clocks: "5 min", "1 h 30 min". At most
 * two units; a truncated remainder gets a "~" instead of false precision,
 * with `exact` saying which happened so callers that cannot tolerate an
 * approximation (the default note) need not sniff the label. Sub-second
 * values return undefined (they already read as milliseconds). The unit names
 * localize inside the function, per call, so the module never holds localized
 * constants.
 */
function formatDuration(ms: number): { label: string; exact: boolean } | undefined {
	if (!Number.isInteger(ms) || ms < 1000) {
		return undefined;
	}
	const units: readonly (readonly [number, string])[] = [
		[3600000, l10n.t({ message: "h", comment: ["Abbreviation for hours in durations like '1 h 30 min'."] })],
		[60000, l10n.t({ message: "min", comment: ["Abbreviation for minutes (not minimum) in durations like '5 min'."] })],
		[1000, l10n.t({ message: "s", comment: ["Abbreviation for seconds in durations like '90 s'."] })],
	];
	const parts: string[] = [];
	let rest = ms;
	for (const [size, name] of units) {
		const count = Math.floor(rest / size);
		if (count > 0 && parts.length < 2) {
			parts.push(`${count} ${name}`);
			rest -= count * size;
		}
	}
	return { label: `${rest > 0 ? "~" : ""}${parts.join(" ")}`, exact: rest === 0 };
}

/**
 * One number-setting draft parsed once: rejected with the reason to render,
 * an empty draft that clears a nullable setting, or the committed value. The
 * error display, the commit, and the equivalence hint all read this one
 * parse, so a keystroke is judged exactly once. ms-unit settings read drafts
 * through the duration grammar (parseDurationDraftMs): unit suffixes on top
 * of the bare-number-is-ms reading, with unit typos as parse errors.
 */
export type NumberDraftParse =
	| { readonly kind: "invalid"; readonly problem: string }
	| { readonly kind: "clear" }
	| { readonly kind: "value"; readonly value: number };

export function parseNumberDraft(id: NumberSettingId, text: string): NumberDraftParse {
	const spec = NUMBER_SETTING_SPECS[id];
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return spec.nullable ? { kind: "clear" } : { kind: "invalid", problem: l10n.t("Enter a number") };
	}
	const value = draftValue(id, text);
	if (value === undefined) {
		return { kind: "invalid", problem: unitBehavior(id).parseProblem() };
	}
	if (value < spec.minimum) {
		return { kind: "invalid", problem: l10n.t("Must be at least {0}", spec.minimum) };
	}
	return { kind: "value", value };
}

/**
 * The muted equivalence rendered next to a number input, recomputed from the
 * parsed draft as the user types: millisecond durations in clock units, and
 * the TTL's special zero reading ("= every refresh"). Takes the value
 * parseNumberDraft committed to, so it cannot re-read the raw text by other
 * rules; the rendering itself is the unit's.
 */
export function equivalence(id: NumberSettingId, value: number): string | undefined {
	return unitBehavior(id).equivalence(value, numberSettingPresentation(id).zeroMeaning);
}

/**
 * The identity of a scalar setting's external state, which the settings
 * form's draft-resync effect keys on. Both halves are load-bearing: a
 * successful reset can change the configured scope while leaving the
 * effective value untouched (removing a value pinned to exactly its default),
 * and the field's draft - possibly a rejected one, error and all - must
 * resync to the store on that push too, not only when the value itself moves.
 */
export function draftSyncKey(value: number | null, configuredScope: SettingScope | null): string {
	return `${value === null ? "" : String(value)}@${configuredScope ?? "default"}`;
}

/** The configuration scopes a setting value can live in, in ascending precedence. */
export type SettingScope = "global" | "workspace" | "workspaceFolder";

/** The human-readable name of a configuration scope, resolved per call so the l10n bundle is honored. */
export function settingScopeLabel(scope: SettingScope): string {
	switch (scope) {
		case "global":
			return l10n.t("User");
		case "workspace":
			return l10n.t("Workspace");
		case "workspaceFolder":
			return l10n.t("Workspace folder");
	}
}

/**
 * An object setting split by configuration scope. VS Code shallow-merges
 * object settings across scopes (workspace keys win over user keys), so an
 * editor over the merged value would copy user-scope entries into workspace
 * files on write and could never delete an entry from the other scope. The
 * dashboard therefore edits exactly one scope's own record (`editScope`,
 * matching where writes land) and shows the records other scopes hold
 * read-only.
 */
export interface ScopedRecordSetting<V> {
	readonly editScope: SettingScope;
	/** The record the edit scope itself holds; what the editor edits and writes back whole. */
	readonly value: Readonly<Record<string, V>>;
	/** Non-empty records held by other scopes, read-only in the dashboard. */
	readonly otherScopes: readonly { readonly scope: SettingScope; readonly value: Readonly<Record<string, V>> }[];
	/**
	 * The scope-merged record exactly as the request path reads it (the same
	 * normalization applied to WorkspaceConfiguration.get's effective value).
	 * Read-only display truth for the effective-values inspector; the editors
	 * above keep editing single scopes.
	 */
	readonly effective: Readonly<Record<string, V>>;
}

/** The settings snapshot the dashboard renders. Scalars are the effective values; records are per-scope. */
export interface DashboardSettings {
	readonly numbers: Readonly<Record<NumberSettingId, number | null>>;
	readonly booleans: Readonly<Record<BooleanSettingId, boolean>>;
	/**
	 * Where each scalar setting is explicitly configured, if anywhere: the
	 * highest-precedence scope inspection reports a value in (workspaceFolder
	 * over workspace over global), or null when only the default applies.
	 * Drives the form's modified indicator and the per-scope Reset naming.
	 * "Modified" means the key is set somewhere, matching the native Settings
	 * editor - a value pinned to exactly its default still shows the bar and
	 * can be reset - and the named scope is the one a reset removes first.
	 */
	readonly configuredScopes: {
		readonly numbers: Readonly<Record<NumberSettingId, SettingScope | null>>;
		readonly booleans: Readonly<Record<BooleanSettingId, SettingScope | null>>;
	};
	readonly modelParameters: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	/** The models.capabilities twin of modelParameters; the Settings tab's second record editor. */
	readonly modelCapabilities: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	/** The OpenRouter catalog row's status line; see CatalogStatusView. */
	readonly catalog: CatalogStatusView;
	/** The two non-scalar usage settings' rows (the enum and the fraction list). */
	readonly usage: {
		readonly statusBarMode: UsageStatusBarModeSetting;
		readonly statusBarScope: SettingScope | null;
		/** The configured thresholds as normalization reads them (valid fractions, deduplicated, ascending). */
		readonly alertThresholds: readonly number[];
		readonly thresholdsScope: SettingScope | null;
	};
}

/** The usage.statusBar enum, re-declared here so the webview bundle needs no settings-module import. */
export type UsageStatusBarModeSetting = "always" | "alerts-only" | "off";

/** The settings the resetSetting intent may name: the scalar rows plus the two non-scalar usage rows. */
export type ResettableSettingId = NumberSettingId | BooleanSettingId | "usage.statusBar" | "usage.alertThresholds";

export const RESETTABLE_SETTING_IDS: readonly ResettableSettingId[] = [
	...NUMBER_SETTING_IDS,
	...BOOLEAN_SETTING_IDS,
	"usage.statusBar",
	"usage.alertThresholds",
];

/**
 * The models.openRouterCatalog row's status: the snapshot's size, when the
 * last refresh succeeded, and the standing failure classification when the
 * last one did not (a fixed English vocabulary - "HTTP 503", "network error" -
 * never response-derived text). `refreshing` disables the row's Refresh
 * button while a refresh is in flight.
 */
export interface CatalogStatusView {
	readonly modelCount: number;
	readonly lastSuccessAt: number | undefined;
	readonly lastFailure?: { readonly classification: string; readonly at: number } | undefined;
	readonly refreshing: boolean;
}

/**
 * One usage endpoint's standing as the card renders it, mirrored from the
 * usage store's classification (closed enums and status numbers only - usage
 * response bodies embed hashed key material, so nothing body-derived may ever
 * ride here). "unavailable" is permanent until an explicit refresh re-probes;
 * "error" keeps retrying on scheduled polls (the poller spaces consecutive
 * failures out with exponential backoff).
 */
export type UsageEndpointStandingView =
	| { readonly kind: "unknown" }
	| { readonly kind: "ok" }
	| { readonly kind: "unavailable"; readonly reason: "unsupported" | "forbidden"; readonly status?: number | undefined }
	| {
			readonly kind: "error";
			readonly classification?: "http" | "network" | "timeout" | undefined;
			readonly status?: number | undefined;
	  };

/**
 * One server's usage facts as the Usage tab renders them: numbers, epoch
 * timestamps, user-configured identity, and closed endpoint-standing enums
 * only (the spend client already narrowed everything response-derived away).
 * Servers whose proxy serves no usage endpoints never appear here at all.
 */
export interface UsageServerView {
	readonly kind: "usage";
	readonly label: string;
	readonly baseUrl: string;
	/**
	 * Whether the data is fresh under the polling rule (last fetch OK and
	 * younger than two poll intervals; ten minutes with polling off). Stale
	 * data still renders, labeled with its age.
	 */
	readonly fresh: boolean;
	/** The /key/info standing: why spend numbers are missing or not updating. */
	readonly keyInfo: UsageEndpointStandingView;
	/** The /user/daily/activity standing: why request statistics are missing. */
	readonly dailyActivity: UsageEndpointStandingView;
	/** Epoch ms of the last successful fetch; the "last updated" label. */
	readonly lastUpdatedAt?: number | undefined;
	/** The key's server-side spend in USD, when /key/info reports one. */
	readonly spend?: number | undefined;
	/** The budget bars and alerts run against: entry over key. */
	readonly effectiveBudget?: number | undefined;
	/** The key-reported max_budget, retained even when the entry's budget wins. */
	readonly keyBudget?: number | undefined;
	/** The entry's manual budget, when set. */
	readonly entryBudget?: number | undefined;
	readonly budgetSource: "entry" | "key" | "none";
	/** spend / effectiveBudget; can exceed 1 (the label shows the literal percentage). */
	readonly spentFraction?: number | undefined;
	/** The key's budget_reset_at as epoch ms, when it carries one. */
	readonly budgetResetAt?: number | undefined;
	/** The recent-window request statistics, when /user/daily/activity answers. */
	readonly requests?:
		| {
				readonly total: number;
				/** successfulRequests / total, when total > 0. */
				readonly successRate?: number | undefined;
				/** cacheReadInputTokens / promptTokens, when prompt tokens exist. */
				readonly cacheHitRate?: number | undefined;
		  }
		| undefined;
}

/**
 * A server left with no readable usage by a forbidden standing (401/403 -
 * typically since the key's very first probe): actionable, so it gets a
 * reduced card - a localized headline plus the standings' English detail
 * lines - with no spend numbers to fake. Servers whose endpoints are merely
 * unsupported (a DB-less proxy) stay hidden instead: there is nothing the
 * user can do about those. Same closed-enum discipline as UsageServerView;
 * nothing response-derived rides here.
 */
export interface UsageForbiddenServerView {
	readonly kind: "forbidden";
	readonly label: string;
	readonly baseUrl: string;
	/** The /key/info standing behind the block. */
	readonly keyInfo: UsageEndpointStandingView;
	/** The /user/daily/activity standing behind the block. */
	readonly dailyActivity: UsageEndpointStandingView;
}

/** One Usage tab card: full usage facts, or the reduced forbidden card. */
export type UsageServerCardView = UsageServerView | UsageForbiddenServerView;

/** The Usage tab's whole snapshot; pushed with every state like the rest. */
export interface DashboardUsage {
	readonly servers: readonly UsageServerCardView[];
	/** The normalized alert thresholds, ascending; empty = alerts off. */
	readonly thresholds: readonly number[];
	/** The effective poll interval; 0 = background polling off. */
	readonly pollIntervalMs: number;
	/** The effective discovery.timeout (the usage requests' whole-call bound); the timeout detail line prints it. */
	readonly discoveryTimeoutMs: number;
	/** Whether a usage refresh pass is in flight (one serialized engine); disables Refresh now. */
	readonly refreshing: boolean;
	/** When this snapshot was computed (epoch ms); ages render against it. */
	readonly generatedAt: number;
}

/** The legacy leftovers worth a dashboard hint; mirrors the migration's LegacyHintKind (never imported: that module is host-only). */
type LegacyHintViewKind = "inert-url-scoped-key" | "inert-global-headers" | "parked-global-headers";

/**
 * One configuration problem for the Diagnostics tab, each also rendered
 * beside the row or editor it concerns. Sources: the record lints of the two
 * global settings and every entry's records, the servers-setting parser's
 * per-entry reports, the migration's legacy-leftover hints, and dropped
 * usage.alertThresholds values. Free text here is structural configuration
 * only (setting ids, record keys, header names) - never entered values.
 */
export type ConfigDiagnosticView =
	| {
			readonly kind: "record";
			/** Which record map: the setting id, or the entry field for entry layers. */
			readonly setting: "models.parameters" | "models.capabilities";
			/** The owning entry's label for entry-layer records; absent for the global settings. */
			readonly entryLabel?: string | undefined;
			readonly diagnostic: RecordDiagnostic;
	  }
	| {
			/** One rejected or partially-ignored servers-setting entry; `misconfigured` when the entry is skipped whole. */
			readonly kind: "entry";
			readonly label?: string | undefined;
			/** The entry's 1-based position in the raw array, for label-less entries. */
			readonly position: number;
			readonly problems: readonly string[];
			readonly misconfigured: boolean;
	  }
	| {
			readonly kind: "legacy";
			readonly hint: LegacyHintViewKind;
			/** The leftover key: a record key for scoped-key hints, the setting id for the headers hints. */
			readonly oldKey: string;
			/** The setting id the leftover sits in, or the parked header names. */
			readonly detail: string;
	  }
	| {
			/** usage.alertThresholds entries outside (0, 1], dropped by normalization. */
			readonly kind: "thresholds";
			readonly dropped: number;
	  };

/**
 * The Diagnostics tab's Resolved-models view: the precomputed resolution
 * rendered two ways - the matcher-key inheritance trees and the flat
 * per-model provenance table. Serialized on demand (the readResolvedModels
 * request), never in state pushes: the view scales with models x fields.
 * Local to the dashboard by design - never part of issue reports.
 */
export interface ResolvedModelsView {
	/** One tree per record map that holds records, in render order. */
	readonly trees: readonly RecordTreeView[];
	/** One row per (server, model), every resolved field with provenance. */
	readonly rows: readonly ResolvedModelRow[];
	/** Total records across every map; 0 drives the no-records empty state. */
	readonly recordCount: number;
}

export interface RecordTreeView {
	readonly kind: "parameters" | "capabilities";
	readonly layer: "global" | "entry";
	/** The owning entry's label for entry-layer maps. */
	readonly entryLabel?: string | undefined;
	readonly roots: readonly RecordTreeNode[];
	/** Models this map matches with no record at all (the implicit "everything else" leaf). */
	readonly unmatchedModelIds: readonly string[];
	/** Invalid matcher keys in this map; they match nothing and sit outside the tree. */
	readonly invalidKeys: readonly string[];
}

/**
 * One record as a tree node: nested under its next-broader match (computed
 * against the live model set, so the tree changes when the model list does; a
 * key that sits under different parents for different models renders once
 * under each). Value texts are formatJsonValue renderings.
 */
export interface RecordTreeNode {
	readonly key: string;
	readonly fields: readonly {
		readonly name: string;
		readonly valueText: string;
		readonly inheritable: boolean;
		readonly forced: boolean;
		readonly fallback: boolean;
	}[];
	/** True when `_inherit_from` is false or the empty list: nothing flows past this record. */
	readonly barrier: boolean;
	/** The `_inherit_from` directive rendered for display ("true" or the named keys); absent for the default flow. */
	readonly inheritFrom?: string | undefined;
	readonly children: readonly RecordTreeNode[];
	/** Models whose most specific match in this map is this record, with their resolved values. */
	readonly models: readonly { readonly id: string; readonly resolvedText: string }[];
}

/** One record in a model's per-map matching chain; see RecordChainView. */
export interface RecordChainLink {
	readonly key: string;
	/** True when `_inherit_from` is false or the empty list: nothing flows past this record. */
	readonly barrier: boolean;
	/** The `_inherit_from` directive rendered for display ("true" or the named keys); absent for the default flow. */
	readonly inheritFrom?: string | undefined;
}

/**
 * One record map's matching chain for an inspected model, broadest to most
 * specific (the winner last): the inspectors' compact inheritance figure.
 * Computed extension-side from the same matchChain the resolvers run; the
 * webview holds no matcher logic. An entry-layer chain carries the declared
 * entry's label, so the figure and its edit jump never guess it.
 */
export type RecordChainView =
	| { readonly layer: "global"; readonly links: readonly RecordChainLink[] }
	| { readonly layer: "entry"; readonly entryLabel: string; readonly links: readonly RecordChainLink[] };

/** One flat-table cell: a resolved parameter with its provenance. */
export interface ResolvedParamCell {
	readonly name: string;
	readonly valueText: string;
	readonly layer: "entry" | "global";
	/** The record key whose literal field carries the value. */
	readonly key: string;
	readonly inheritedFrom?: string | undefined;
	readonly forced?: true | undefined;
}

/** One flat-table cell: a resolved capability with its provenance level. */
export interface ResolvedCapCell {
	readonly name: string;
	readonly valueText: string;
	readonly level: CapabilityLevel;
	readonly key?: string | undefined;
	readonly inheritedFrom?: string | undefined;
}

export interface ResolvedModelRow {
	readonly serverLabel: string;
	readonly rawId: string;
	/** The model's scope key (DashboardModel.scopeKey), for the per-row jump to the inspectors. */
	readonly scopeKey: string;
	/** Every matcher key that matched this model in any map; the filter's "show everything gpt-5* touched". */
	readonly matchedKeys: readonly string[];
	readonly parameters: readonly ResolvedParamCell[];
	readonly capabilities: readonly ResolvedCapCell[];
}

export interface DashboardState {
	readonly servers: readonly DashboardServer[];
	/**
	 * Groups the user explicitly removed, out of the servers table by design:
	 * rendered as the collapsed hidden-groups line with an Unhide per row.
	 * They contribute nothing to the overall verdict or the model counts.
	 */
	readonly hiddenGroups: readonly HiddenGroup[];
	readonly models: readonly DashboardModel[];
	readonly settings: DashboardSettings;
	/** The Usage tab's snapshot; see DashboardUsage. */
	readonly usage: DashboardUsage;
	/** Configuration problems found in the settings; see ConfigDiagnosticView. */
	readonly diagnostics: readonly ConfigDiagnosticView[];
	/**
	 * Legacy-registry servers (pre-migration installs and test mode) with no
	 * server row of their own; 0 once the registry is empty or every entry
	 * also surfaces as a live row. Labels and URLs stay extension-side: the
	 * Diagnostics tab only states the count.
	 */
	readonly legacyServerCount: number;
}

/**
 * The dashboard's top-level sections, one tab each. Servers and models share
 * the overview tab (they are one workflow: connect a server, see its models);
 * the settings form and the Diagnostics page get pages of their own. Declared
 * here because deep links cross the boundary: the extension's focusSection
 * message names a tab by ID (litellm.showDiagnostics lands on "diagnostics"),
 * and the webview's tab bar renders exactly this list.
 */
export const DASHBOARD_SECTION_IDS = ["overview", "usage", "settings", "diagnostics"] as const;

export type DashboardSectionId = (typeof DASHBOARD_SECTION_IDS)[number];

/**
 * Extension-to-webview messages: full state pushes (the webview never holds
 * partial truth), plus per-intent outcome notices. Server intents carry a
 * webview-generated requestId, echoed back in intentSucceeded/intentFailed so
 * an editor waits on its own save rather than on the next unrelated push. A
 * validation-kind failure produces no configuration change and therefore no
 * state push; an operation-kind failure committed its write, so a push
 * follows and must not be read as the intent succeeding.
 */
export type ExtensionToWebviewMessage =
	| { readonly type: "state"; readonly state: DashboardState }
	| {
			/**
			 * Switch the page to a section: the deep link litellm.showDiagnostics
			 * uses to land on the Diagnostics tab. The panel sends it after the
			 * webview's ready handshake when the dashboard was opened with a
			 * target section, or directly when the page is already live.
			 */
			readonly type: "focusSection";
			readonly section: DashboardSectionId;
	  }
	| {
			/**
			 * The answer to a readInlineSecrets request: the entry's secret values
			 * whose storage is inline in the servers setting, for the edit form's
			 * prefill. Inline values already sit in plaintext in the user's
			 * settings file, so this reveals nothing the Settings editor does not
			 * show. Fields stored in secure storage or absent carry NO key here
			 * (absence, not an empty string); their values never reach the
			 * webview. Deliberately not part of DashboardState: state pushes must
			 * never carry secret material.
			 */
			readonly type: "inlineSecrets";
			readonly requestId: string;
			readonly values: Readonly<Partial<Record<SecretFieldId, string>>>;
	  }
	| {
			/**
			 * The answer to a readModelCapabilities request: the extension-resolved
			 * effective capabilities of one model, produced by the same
			 * resolveModelCapabilities walk registration runs, so the inspector
			 * cannot drift from what is served. Absent `capabilities` means the
			 * requested scope or model no longer resolves (the store changed
			 * between the push and the request); the inspector says so instead of
			 * inventing values.
			 */
			readonly type: "modelCapabilities";
			readonly requestId: string;
			readonly capabilities?: EffectiveCapabilities | undefined;
			/**
			 * The most specific GLOBAL record key matching this model, for the
			 * inspector's configure-jump into the settings editor; absent when no
			 * global record matches (the jump creates an exact-ID draft instead).
			 * Extension-computed: the webview holds no matcher logic.
			 */
			readonly globalRecordKey?: string | undefined;
			/** The model's per-map matching chains (the inspector's inheritance figure); absent when nothing matches. */
			readonly chains?: readonly RecordChainView[] | undefined;
	  }
	| {
			/**
			 * The answer to a readModelParameters request: the params inspector's
			 * projection, resolved extension-side through the provider's SHARED
			 * flat resolution table - the same cache requests read - so the
			 * inspector cannot drift from the wire. Absent `projection` means the
			 * scope or model no longer resolves, exactly like modelCapabilities.
			 * Entry-layer source refs carry the declared entry's label themselves
			 * (ParameterSourceRef), so no separate label field rides here.
			 */
			readonly type: "modelParameters";
			readonly requestId: string;
			readonly projection?: EffectiveParametersProjection | undefined;
			/** See modelCapabilities.globalRecordKey; the parameters-map twin. */
			readonly globalRecordKey?: string | undefined;
			/** See modelCapabilities.chains; the parameters-map twin. */
			readonly chains?: readonly RecordChainView[] | undefined;
	  }
	| {
			/**
			 * The answer to a readResolvedModels request: the Diagnostics tab's
			 * Resolved-models view, computed extension-side from the same
			 * resolution the request path runs. On demand rather than in state
			 * pushes because it scales with models x fields.
			 */
			readonly type: "resolvedModels";
			readonly requestId: string;
			readonly view: ResolvedModelsView;
	  }
	| {
			/**
			 * The answer to a searchCatalog request: a bounded id/name list from
			 * the extension-side OpenRouter catalog snapshot. The catalog data
			 * itself never enters the webview bundle; only these summaries cross,
			 * per request.
			 */
			readonly type: "catalogSearchResults";
			readonly requestId: string;
			readonly results: readonly CatalogModelSummary[];
	  }
	| {
			readonly type: "intentSucceeded";
			readonly intentType: DashboardIntentType;
			readonly requestId: string;
			/**
			 * An optional caveat about a successful intent (e.g. an adoption that
			 * found no credentials to copy). Informational text only, never a
			 * value from the payload.
			 */
			readonly message?: string | undefined;
	  }
	| {
			readonly type: "intentFailed";
			readonly intentType: DashboardIntentType;
			readonly message: string;
			/**
			 * What the failure left behind. "validation": nothing landed (the
			 * intent was refused or its write failed), so the editor's draft is
			 * still the truth and returns to editing for a retry. "operation": the
			 * durable write committed but a follow-up effect failed, so drafts
			 * over the pre-save state are stale and the message carries the
			 * recovery path.
			 */
			readonly kind: "validation" | "operation";
			readonly requestId?: string | undefined;
			/**
			 * The transport classification behind a failed connection probe, when
			 * one exists. Classification only - enum ids and a status number,
			 * never message text - so it is safe to cross the webview boundary;
			 * the webview maps the setup-hint id to the matching
			 * troubleshooting-guide section link.
			 */
			readonly classification?: TransportErrorClassification | undefined;
	  };

/** One OpenRouter catalog entry as the picker lists it; id is what `_openrouter_model` takes. */
export interface CatalogModelSummary {
	readonly id: string;
	readonly name: string;
}

/**
 * The intent types that carry a correlation requestId, derived from the
 * message union itself. Intersected with DashboardIntentType so pure
 * request/response messages (readInlineSecrets, answered by its own
 * inlineSecrets message, never by an outcome notice) stay out.
 */
type AckedIntentType = Extract<WebviewToExtensionMessage, { requestId: string }>["type"] & DashboardIntentType;

/**
 * Every extension-to-webview discriminant, as a Record over the union: a
 * message type added to ExtensionToWebviewMessage stops compiling until it is
 * registered here, instead of being silently dropped by the webview's
 * receive guard.
 */
const EXTENSION_MESSAGE_TYPES: Readonly<Record<ExtensionToWebviewMessage["type"], true>> = {
	state: true,
	focusSection: true,
	inlineSecrets: true,
	modelCapabilities: true,
	modelParameters: true,
	resolvedModels: true,
	catalogSearchResults: true,
	intentSucceeded: true,
	intentFailed: true,
};

/** Whether an incoming discriminant names an extension-to-webview message; the webview's receive guard. */
export function isExtensionMessageType(type: unknown): type is ExtensionToWebviewMessage["type"] {
	return typeof type === "string" && Object.hasOwn(EXTENSION_MESSAGE_TYPES, type);
}

/**
 * The intents whose outcome arrives as its own correlated notice
 * (intentSucceeded or intentFailed echoing the intent's requestId). Their
 * failure notices survive state pushes: a push is not their success signal,
 * and a partially applied save requests a sync whose push would otherwise
 * erase the very warning the save raised. Every other intent's success signal
 * is the state push that follows its landed write, so a push retires those
 * notices (and nothing else would). A Record over the derived union: an
 * intent that gains a requestId without being registered here stops compiling
 * instead of silently regressing to notice erasure.
 */
const ACKED_INTENT_TYPES: Readonly<Record<AckedIntentType, true>> = {
	saveServerSetting: true,
	removeServerSetting: true,
	adoptServer: true,
	hideExternalServer: true,
	unhideServer: true,
	testServerDraft: true,
	setModelParameters: true,
	setModelCapabilities: true,
};

/** The failure notices a state push leaves standing, keyed like FailuresByIntent; see ACKED_INTENT_TYPES. */
export function failuresAfterStatePush<K extends string, V>(
	failures: Readonly<Partial<Record<K, V>>>
): Readonly<Partial<Record<K, V>>> {
	const kept = Object.entries(failures).filter(([intentType]) => Object.hasOwn(ACKED_INTENT_TYPES, intentType));
	if (kept.length === Object.keys(failures).length) {
		return failures;
	}
	return Object.fromEntries(kept) as Partial<Record<K, V>>;
}

/** Actions the webview can trigger; the extension maps each ID to the command it already registers. */
export const DASHBOARD_COMMAND_IDS = [
	"openGroupsFile",
	"syncModels",
	"testConnection",
	"openSettings",
	"reportIssue",
	"openOutput",
	"exportSettings",
	"importSettings",
] as const;

export type DashboardCommandId = (typeof DASHBOARD_COMMAND_IDS)[number];

/**
 * What to do with one secret field when saving a server entry. "keep" leaves
 * the field wherever it is (inline in the setting or in secret storage);
 * "clear" removes it from both; "set" replaces it in the chosen location and
 * removes it from the other. Values flow webview -> extension -> setting or
 * SecretStorage only: they are never logged and never echoed back into
 * DashboardState.
 */
export type SecretDirective =
	| { readonly action: "keep" }
	| { readonly action: "clear" }
	| { readonly action: "set"; readonly location: "settings" | "secure"; readonly value: string };

/**
 * The non-secret half of a litellm-vscode-chat.servers entry as the dashboard
 * form submits it. The label is the entry's identity: the sync engine names
 * the VS Code provider group after it, so renaming creates a new group (the
 * old one stays until its object is deleted from the models file).
 */
export interface SaveServerPayload extends NonSecretOptionalFields {
	readonly label: string;
	readonly baseUrl: string;
	/** The entry's per-entry modelParameters; absent or empty means the saved entry carries none. */
	readonly modelParameters?: EntryModelParametersPayload | undefined;
	/** The entry's per-entry modelCapabilities; empty means the saved entry carries none. */
	readonly modelCapabilities: EntryModelCapabilitiesPayload;
	/** The entry's expected discovery-failure categories; empty means none. */
	readonly expectedFailures: readonly ExpectedFailureCategory[];
	/**
	 * The entry's custom HTTP headers (plain settings text, not secrets);
	 * empty means the saved entry carries none. Always sent - the schema
	 * refuses a payload without it, so a save can never silently delete a
	 * stored record it did not mean to touch.
	 */
	readonly headers: Readonly<Record<string, HeaderScalar>>;
	/** The entry's discovery.declared model IDs; empty means none. */
	readonly declaredModels: readonly string[];
	/** The entry's manual usage budget in USD; null means none (clearing any stored budget). */
	readonly budget: number | null;
}

/** Webview-to-extension intents. The extension re-validates every one: the webview is a trust boundary. */
export type WebviewToExtensionMessage =
	| { readonly type: "ready" }
	| { readonly type: "setNumberSetting"; readonly setting: NumberSettingId; readonly value: number | null }
	| { readonly type: "setBooleanSetting"; readonly setting: BooleanSettingId; readonly value: boolean }
	/** Remove the setting from the highest-precedence scope that sets it; the next scope's value or the default shows through. */
	| { readonly type: "resetSetting"; readonly setting: ResettableSettingId }
	/** Open the user settings.json at "litellm-vscode-chat.<setting>"; only ids from REVEALABLE_SETTING_IDS cross. */
	| { readonly type: "revealSetting"; readonly setting: RevealableSettingId }
	| {
			readonly type: "setModelParameters";
			readonly value: Record<string, Record<string, unknown>>;
			readonly requestId: string;
	  }
	| {
			readonly type: "setModelCapabilities";
			readonly value: Record<string, Record<string, unknown>>;
			readonly requestId: string;
	  }
	| { readonly type: "setUsageStatusBar"; readonly value: UsageStatusBarModeSetting }
	/** Values must be fractions in (0, 1]; the extension re-validates and refuses out-of-range entries. */
	| { readonly type: "setUsageAlertThresholds"; readonly values: readonly number[] }
	| {
			/**
			 * Refresh the OpenRouter catalog now (the settings row's button; the
			 * same action as the palette command). Fire-and-forget on the panel
			 * side: the outcome lands in the next state push's catalog status
			 * (row status, never a toast).
			 */
			readonly type: "refreshCatalog";
	  }
	| {
			/**
			 * Refresh usage data for every server now (the Usage tab's button; the
			 * same action as LiteLLM: Refresh Usage Now). Fire-and-forget: the
			 * poller's completion re-pushes state, and `refreshing` in the pushed
			 * usage snapshot disables the button meanwhile.
			 */
			readonly type: "refreshUsage";
	  }
	| {
			readonly type: "saveServerSetting";
			readonly server: SaveServerPayload;
			readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
			/** When editing: the label of the entry to replace (differs from server.label on rename). */
			readonly replaceLabel?: string | undefined;
			/** Webview-generated correlation ID, echoed in the outcome notice. */
			readonly requestId: string;
	  }
	| {
			/**
			 * Test a DRAFT server configuration - possibly never saved - with one
			 * extension-side discovery probe. Read-only by contract: nothing is
			 * written, synced, or cached, so both outcome kinds leave configuration
			 * untouched. The payload mirrors saveServerSetting (same secret
			 * directives, same value rules: webview -> extension only, never
			 * logged, never echoed back); "keep" directives resolve extension-side
			 * against the entry `replaceLabel` names, exactly as a save would. The
			 * success notice's message is composed extension-side as static
			 * classification text plus the discovered model count, never payload
			 * or response text.
			 */
			readonly type: "testServerDraft";
			readonly server: SaveServerPayload;
			readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
			/** When editing: the label whose stored secrets "keep" directives resolve from. */
			readonly replaceLabel?: string | undefined;
			readonly requestId: string;
	  }
	| { readonly type: "removeServerSetting"; readonly label: string; readonly requestId: string }
	| {
			/**
			 * Remove (hide) an external provider group: writes its removal
			 * tombstone, so it answers with no models and moves to the
			 * hidden-groups line. Names the group by the opaque handle its row
			 * carried (DashboardServer.adoptHandle), resolved extension-side only
			 * against groups that are still external and still at `baseUrl` - the
			 * same trust rule the adopt intent follows, so a forged intent cannot
			 * hide a declared group.
			 */
			readonly type: "hideExternalServer";
			readonly baseUrl: string;
			readonly sourceHandle: string;
			readonly requestId: string;
	  }
	| {
			/**
			 * Clear one hidden group's tombstone (the identity its HiddenGroup row
			 * carried); its models return on the next host re-resolution, which
			 * the extension triggers itself.
			 */
			readonly type: "unhideServer";
			readonly label: string;
			readonly baseUrl: string;
			readonly requestId: string;
	  }
	| {
			/**
			 * Ask for a declared entry's inline secret values (the edit form's
			 * on-demand prefill; see the inlineSecrets response). Carries only the
			 * entry's label; the extension reads the values from the servers
			 * setting itself and answers with inline-stored fields only.
			 */
			readonly type: "readInlineSecrets";
			readonly label: string;
			readonly requestId: string;
	  }
	| {
			/**
			 * Ask for one model's effective capabilities (the capability
			 * inspector; see the modelCapabilities response). Names the model by
			 * its scope key (an opaque per-session server handle, so a stale key
			 * de-resolves instead of hitting another server) plus its raw ID;
			 * the extension resolves everything itself - no capability data
			 * rides the request.
			 */
			readonly type: "readModelCapabilities";
			readonly scopeKey: string;
			readonly rawId: string;
			readonly requestId: string;
	  }
	| {
			/**
			 * Ask for one model's effective-parameters projection (the params
			 * inspector; see the modelParameters response). Addressed like
			 * readModelCapabilities; resolved through the provider's shared flat
			 * resolution table.
			 */
			readonly type: "readModelParameters";
			readonly scopeKey: string;
			readonly rawId: string;
			readonly requestId: string;
	  }
	| {
			/**
			 * Ask for the Diagnostics tab's Resolved-models view (see the
			 * resolvedModels response). No parameters: the extension computes the
			 * whole view over the live model set and configuration.
			 */
			readonly type: "readResolvedModels";
			readonly requestId: string;
	  }
	| {
			/**
			 * Search the extension-side OpenRouter catalog snapshot (the
			 * `_openrouter_model` picker; see the catalogSearchResults response).
			 * The query is user-typed filter text, never a secret.
			 */
			readonly type: "searchCatalog";
			readonly query: string;
			readonly requestId: string;
	  }
	| {
			/**
			 * Adopt an external provider group into the servers setting: the entry
			 * is written under `label`, and the group's credentials (which exist
			 * extension-side only; the webview never sees them) are resolved by
			 * the extension and stored where `secrets` directs per field. The
			 * source group is named by `sourceHandle`, the opaque token its row
			 * carried (DashboardServer.adoptHandle); the extension resolves it
			 * only against groups that are still external and still at `baseUrl`.
			 */
			readonly type: "adoptServer";
			readonly label: string;
			readonly baseUrl: string;
			readonly sourceHandle: string;
			readonly secrets: Readonly<Record<SecretFieldId, Exclude<SecretLocation, "none">>>;
			readonly requestId: string;
	  }
	| { readonly type: "executeCommand"; readonly command: DashboardCommandId };

/**
 * The intents that can fail and be reported back; the ready handshake has no
 * failure mode, and the pure request/response reads (readInlineSecrets,
 * readModelCapabilities, readModelParameters, readResolvedModels,
 * searchCatalog) are each answered by their own response message (an unknown
 * label or scope simply yields no values).
 */
export type DashboardIntentType = Exclude<
	WebviewToExtensionMessage["type"],
	| "ready"
	| "readInlineSecrets"
	| "readModelCapabilities"
	| "readModelParameters"
	| "readResolvedModels"
	| "searchCatalog"
>;

export type ParsedJsonValue =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: string };

/**
 * Parse a model-parameter value typed into the dashboard: strict JSON, so
 * numbers, booleans, quoted strings, arrays, and objects all round-trip
 * unambiguously. Invalid input is a validation error, never a silent guess.
 */
export function parseJsonValue(text: string): ParsedJsonValue {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return { ok: false, error: l10n.t('Enter a JSON value, e.g. 0.2, true, or "text".') };
	}
	try {
		return { ok: true, value: JSON.parse(trimmed) as unknown };
	} catch {
		return { ok: false, error: l10n.t('Not valid JSON. Quote strings, e.g. "text".') };
	}
}

/**
 * Parse a header value typed into the dashboard. Header values are scalars,
 * and most are plain strings, so this is lenient where parseJsonValue is
 * strict: finite JSON scalars are taken as typed values ("true" is a boolean,
 * "42" a number, "\"42\"" a string) and anything else is the literal string.
 */
export function parseHeaderValue(text: string): HeaderScalar {
	const trimmed = text.trim();
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === "string" || typeof parsed === "boolean") {
			return parsed;
		}
		// Non-finite numbers (JSON.parse("1e999") is Infinity) fall through to
		// the literal string: isHeaderScalar refuses them at the header-record
		// parse boundary, so parsing them as numbers would make Apply a
		// silent no-op - the draft looks applied, no failure is acked, and the
		// setting is never written. The literal string is the only lossless,
		// sendable reading.
		if (typeof parsed === "number" && Number.isFinite(parsed)) {
			return parsed;
		}
	} catch {
		// Fall through: the text is a plain string value.
	}
	return trimmed;
}

/** Render a configured value back into the editable text the parse functions accept. */
export function formatJsonValue(value: unknown): string {
	return JSON.stringify(value) ?? "";
}

/**
 * Render a header value as parseHeaderValue-compatible text. Non-strings
 * print bare ("true", "42"); a string that would re-parse as a JSON scalar is
 * quoted so its type survives the round trip.
 */
export function formatHeaderValue(value: HeaderScalar): string {
	if (typeof value !== "string") {
		return String(value);
	}
	try {
		JSON.parse(value);
		return JSON.stringify(value);
	} catch {
		return value;
	}
}
