/**
 * Pure presentation logic shared by the extension host and the webview: no
 * vscode, DOM, or Node. Localized strings resolve at call time, never as
 * module-level constants - modules load before the bundle is configured.
 */

import * as l10n from "@vscode/l10n";
import type { BooleanSettingId, NumberSettingId } from "../shared/config/settingSpec";
import { NUMBER_SETTING_SPECS } from "../shared/config/settingSpec";
import { statusErrorDetail, statusErrorHeadline } from "../shared/util/errorText";
import type { HeaderScalar } from "../shared/util/headers";
import type { DashboardServer, DeclaredServerNotice, SettingScope } from "./viewModels";

/**
 * The overall configuration verdict, shared by the dashboard hero and the
 * Diagnostics tab so their headline judgement cannot drift. Only real failures
 * count: unchecked entries stay neutral, and so do failures the entry's
 * expectedFailures declares (expected-and-serving-nothing yields
 * "needs-declare"). Misconfigured entries are neutral too - except that a
 * configuration of ONLY misconfigured entries is an error, not "waiting".
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
 * The verdict as one sentence, pinned by tests. English by policy: users paste
 * these lines into public issue reports, so localization sweeps must skip this
 * function. The legacy registry is real configuration even though it
 * contributes no server rows, so it overrides the not-configured claim.
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
			// The fallback only satisfies the type checker (the verdict guarantees an
			// error row). A transport failure outranks a misconfigured row's fixed
			// text: the real outage is the line worth pasting.
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
 * The entry-params-inactive classification as diagnostics prose: fixed text
 * derived from the classification alone, so every surface names it the same
 * way. English by policy - these lines land in public issue reports.
 */
const ENTRY_PARAMS_INACTIVE_TEXT =
	"per-entry modelParameters are not applied (the provider group does not carry this entry's labeled identity); delete the group's object from the models file (chatLanguageModels.json), reload the window, and run Sync Models Now, or save the entry under a new label";

/** The capabilities twin of ENTRY_PARAMS_INACTIVE_TEXT; English by the same issue-report policy. */
const ENTRY_CAPABILITIES_INACTIVE_TEXT =
	"per-entry modelCapabilities, declared models, and expectedFailures are not applied (the provider group does not carry this entry's labeled identity); delete the group's object from the models file (chatLanguageModels.json), reload the window, and run Sync Models Now, or save the entry under a new label";

/** The custom-headers twin of ENTRY_PARAMS_INACTIVE_TEXT; English by the same issue-report policy. */
const ENTRY_HEADERS_INACTIVE_TEXT =
	"per-entry custom headers are not applied (the provider group does not carry this entry's labeled identity); delete the group's object from the models file (chatLanguageModels.json), reload the window, and run Sync Models Now, or save the entry under a new label";

/** The apiVersion twin of ENTRY_PARAMS_INACTIVE_TEXT; English by the same issue-report policy. */
const ENTRY_API_VERSION_INACTIVE_TEXT =
	"the per-entry API version override is not applied, requests use the auto rule (the provider group does not carry this entry's labeled identity); delete the group's object from the models file (chatLanguageModels.json), reload the window, and run Sync Models Now, or save the entry under a new label";

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
		case "entry-api-version-inactive":
			return ENTRY_API_VERSION_INACTIVE_TEXT;
		case "expected-failures-nothing-declared":
			return EXPECTED_FAILURES_NOTHING_DECLARED_TEXT;
	}
}

/**
 * serverOutcomeText decomposed, for surfaces that render the pieces
 * separately. The one-line form composes exactly these parts, flattening a
 * two-part error's newline to " - " (the presenters suite pins the equality),
 * so a grid cell and the copied line cannot drift apart in wording.
 */
export interface ServerOutcomeParts {
	/** The verdict as a Status cell shows it. */
	readonly status: "OK" | "Error" | "Misconfigured" | "Not checked yet";
	/** The model-count clause an "ok" line parenthesizes ("3 models"); absent on other states. */
	readonly models?: string | undefined;
	/**
	 * The row's error: an "error" state's message (with the English
	 * "(expected)" annotation when the entry expects the category), or the sync
	 * failure an "ok" row can still carry.
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
				// Truthful error, expected presentation: the "(expected)" annotation
				// stays English (it lands in issue reports). A row still serving
				// declared models reads as OK-with-note.
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
 * issue reports.
 */
export function serverOutcomeText(server: DashboardServer): string {
	const parts = serverOutcomeParts(server);
	// "OK (2 models) - <sync error>" vs "Error: <error>": the error joins an
	// OK line as an aside and an Error line as its object.
	const status = parts.models === undefined ? parts.status : `${parts.status} (${parts.models})`;
	// A two-part error (headline "\n" detail) flattens to one physical line:
	// this is the copy-paste issue-report form.
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

/**
 * What each number setting counts. Value logic keys off these codes through
 * NUMBER_UNIT_BEHAVIOR; consumers read a setting's unit through unitBehavior().
 */
const NUMBER_SETTING_UNITS = {
	"chat.timeout": "ms",
	"chat.maxToolsPerRequest": "count",
	"discovery.timeout": "ms",
	"discovery.cacheTtl": "ms",
	"discovery.staleServeWindow": "ms",
	"usage.pollInterval": "ms",
	"usage.initialRefreshDelay": "ms",
	"usage.serversChangeRefreshDelay": "ms",
	"usage.pollingOffFreshnessWindow": "ms",
} as const satisfies Record<NumberSettingId, NumberSettingUnit>;

/**
 * One unit's value behavior: everything the display and validation paths key
 * off a setting's unit, so adding a unit is one NUMBER_UNIT_BEHAVIOR row.
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

/** Millisecond multipliers for the duration grammar's unit suffixes. */
const DURATION_SUFFIX_MS: Readonly<Record<string, number>> = {
	ms: 1,
	s: 1000,
	m: 60000,
	h: 3600000,
};

/**
 * A duration draft as milliseconds: "1500ms", "90s", "5m", "1h" (suffixes
 * case-insensitive), or a bare number meaning milliseconds; undefined for
 * everything else, so the form renders one grammar error. Module-private:
 * every consumer reads durations through parseNumberDraft's single verdict.
 */
function parseDurationDraftMs(text: string): number | undefined {
	const trimmed = text.trim();
	const match = /^(.*?)(ms|s|m|h)$/i.exec(trimmed);
	if (match === null) {
		// No suffix: the bare-number-is-ms reading. Number("") is 0, so the empty
		// draft must never reach this helper unguarded.
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
	// The scaling can overflow ("9e307h"): a non-finite product must not read as
	// a valid draft. Finite products round to whole milliseconds.
	return Number.isFinite(scaled) ? Math.round(scaled) : undefined;
}

/**
 * A millisecond count as humans read clocks: "5 min", "1 h 30 min". At most
 * two units; a truncated remainder gets a "~" instead of false precision, with
 * `exact` saying which happened. Sub-second values return undefined.
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
	count: {
		parseDraft: (text) => {
			const trimmed = text.trim();
			// Number("") is 0; an empty draft has no reading under any grammar.
			if (trimmed.length === 0) {
				return undefined;
			}
			const value = Number(trimmed);
			// Counts are whole by definition; a fractional draft has no reading
			// (the host-side getter floors hand-written fractions the same way).
			return Number.isInteger(value) ? value : undefined;
		},
		parseProblem: () => l10n.t("Not a whole number"),
		exactDisplay: () => undefined,
		// A digit-grouped echo of the same number would say nothing.
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
 * The presentation of one number setting the dashboard edits. A function, not
 * a module-level catalog: these strings localize, and module-level constants
 * would freeze the English text before l10n.config runs.
 */
export function numberSettingPresentation(id: NumberSettingId): NumberSettingPresentation {
	switch (id) {
		case "chat.timeout":
			return {
				label: l10n.t("Request timeout"),
				description: l10n.t("Hard bound for one chat completion call."),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
			};
		case "chat.maxToolsPerRequest":
			return {
				label: l10n.t("Max tools per request"),
				description: l10n.t("The most tools one request may carry."),
				// A key of its own, apart from the capability chip's "tools": a
				// count suffix may need a measure word where a chip label does not.
				unit: l10n.t({ message: "tools", comment: ["Unit suffix after the max-tools count input."] }),
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
				description: l10n.t("How long discovered model lists are reused."),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
				zeroMeaning: l10n.t("every refresh"),
			};
		case "discovery.staleServeWindow":
			return {
				label: l10n.t("Stale-list grace"),
				description: l10n.t("How long an unreachable server's last known models stay in the picker."),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
				zeroMeaning: l10n.t("no stale serving"),
			};
		case "usage.pollInterval":
			return {
				label: l10n.t("Usage poll interval"),
				description: l10n.t("How often per-server spend and budget data refresh."),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
				zeroMeaning: l10n.t("polling off"),
			};
		case "usage.initialRefreshDelay":
			return {
				label: l10n.t("First poll delay"),
				description: l10n.t("How long after startup the first usage poll runs."),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
			};
		case "usage.serversChangeRefreshDelay":
			return {
				label: l10n.t("Servers-change poll delay"),
				description: l10n.t("How long after a servers-setting edit usage data refreshes."),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
			};
		case "usage.pollingOffFreshnessWindow":
			return {
				label: l10n.t("Polling-off freshness window"),
				description: l10n.t("How long fetched usage data counts as fresh while polling is off."),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
				zeroMeaning: l10n.t("never fresh"),
			};
	}
}

/**
 * One draft's numeric reading under the field's grammar (the unit's
 * parseDraft); undefined when the text has no reading, empty included. The
 * single value extraction behind parseNumberDraft AND isBoundViolation, so the
 * two can never disagree about what a draft is worth.
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
 * unit's exact human rendering when it has one, the raw number otherwise. A
 * "~" approximation would misstate what the default actually is.
 */
export function defaultDisplay(id: NumberSettingId): string {
	const spec = NUMBER_SETTING_SPECS[id];
	return unitBehavior(id).exactDisplay(spec.default) ?? String(spec.default);
}

/**
 * Whether a rejected draft failed only the minimum bound. The form keeps these
 * quiet until the field blurs (typing the 5 of 5000 passes through honest
 * below-minimum values), while true parse failures stay live. Reads the draft
 * through the same draftValue extraction parseNumberDraft uses.
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
 * The presentation of one boolean setting the dashboard edits; a function for
 * the same lazy-localization reason as numberSettingPresentation.
 */
export function booleanSettingPresentation(id: BooleanSettingId): BooleanSettingPresentation {
	switch (id) {
		case "chat.promptCaching":
			return {
				label: l10n.t("Prompt caching"),
				description: l10n.t("Reuse the cached prompt prefix between turns."),
			};
		case "ui.maskSecretInputs":
			return {
				label: l10n.t("Mask secret inputs"),
				description: l10n.t("Hide API keys and other credentials while typing them into configuration prompts."),
			};
		case "models.openRouterCatalog":
			return {
				label: l10n.t("OpenRouter catalog"),
				// Not rendered (the row shows the live status cluster instead) and so
				// not filtered: this key and the tip's translate independently.
				description: l10n.t("Fill missing model capabilities from the OpenRouter catalog, refreshed weekly."),
			};
	}
}

/**
 * One number-setting draft parsed once: the error display, the commit, and the
 * equivalence hint all read this one parse, so a keystroke is judged exactly
 * once. ms-unit settings read drafts through the duration grammar.
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
 * The muted equivalence rendered next to a number input. Takes the value
 * parseNumberDraft committed to, so it cannot re-read the raw text by other
 * rules; the rendering itself is the unit's.
 */
export function equivalence(id: NumberSettingId, value: number): string | undefined {
	return unitBehavior(id).equivalence(value, numberSettingPresentation(id).zeroMeaning);
}

/**
 * The identity of a scalar setting's external state, which the settings form's
 * draft-resync effect keys on. Both halves are load-bearing: a reset can
 * change the configured scope while leaving the effective value untouched, and
 * the draft must resync on that push too.
 */
export function draftSyncKey(value: number | null, configuredScope: SettingScope | null): string {
	return `${value === null ? "" : String(value)}@${configuredScope ?? "default"}`;
}

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

export type ParsedJsonValue =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: string };

/**
 * Parse a model-parameter value typed into the dashboard: strict JSON, so
 * every type round-trips unambiguously. Invalid input is a validation error,
 * never a silent guess.
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
 * Parse a header value typed into the dashboard. Header values are scalars, so
 * this is lenient where parseJsonValue is strict: finite JSON scalars are
 * taken as typed values ("true" is a boolean, "42" a number, "\"42\"" a
 * string) and anything else is the literal string.
 */
export function parseHeaderValue(text: string): HeaderScalar {
	const trimmed = text.trim();
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === "string" || typeof parsed === "boolean") {
			return parsed;
		}
		// Non-finite numbers (JSON.parse("1e999") is Infinity) fall through to the
		// literal string: isHeaderScalar refuses them at the header-record parse
		// boundary, so parsing them as numbers would make Apply a silent no-op.
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
 * Render a header value as parseHeaderValue-compatible text. Non-strings print
 * bare ("true", "42"); a string that would re-parse as a JSON scalar is quoted
 * so its type survives the round trip.
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
