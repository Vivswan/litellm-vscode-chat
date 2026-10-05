/**
 * Pure presentation logic shared by the extension host and the webview: no vscode, DOM, or Node. Localized strings
 * resolve at call time, never as module-level constants - modules load before the bundle is configured.
 */

import * as l10n from "@vscode/l10n";
import type { BooleanSettingId, NumberSettingId } from "../shared/config/settingSpec";
import {
	acceptsNumberSetting,
	isUsableThreshold,
	NUMBER_SETTING_SPECS,
	numberSettingOffValue,
} from "../shared/config/settingSpec";
import { DECIMAL_TEXT_PATTERN, parseDecimalText } from "../shared/util/decimalText";
import { statusErrorDetail, statusErrorHeadline } from "../shared/util/errorText";
import type { HeaderScalar } from "../shared/util/headers";
import { trimHttpWhitespace } from "../shared/util/headers";
import { nonFiniteNumberPath } from "../shared/util/json";
import type { DashboardServer, DeclaredServerNotice, SettingScope } from "./viewModels";

/**
 * Shared by the hero, the status bar, the notifier, and the Diagnostics tab, so their headline judgement cannot
 * drift; serving through an unexpected failure reads "degraded", never dead, matching the row pills.
 */
export type OverallVerdict = "not-configured" | "error" | "degraded" | "waiting" | "connected" | "needs-declare";

export function classifyOverall(
	servers: readonly (Pick<DashboardServer, "state" | "expected" | "servedModelCount"> & {
		readonly origin?: DashboardServer["origin"];
	})[],
	context: { readonly hiddenGroupCount?: number } = {}
): OverallVerdict {
	// Hidden groups leave the server list, but the status window carries each one as an ok status serving zero models.
	// Synthesizing the same members here makes the two classifier inputs equal BY CONSTRUCTION, so the rows verdict
	// cannot diverge from the bar's on any mix of hidden groups with unchecked, failed, or misconfigured rows.
	const hiddenAsRows = Array.from(
		{ length: context.hiddenGroupCount ?? 0 },
		() => ({ state: "ok", servedModelCount: 0, origin: undefined }) as const
	);
	const all = [...servers, ...hiddenAsRows];
	if (all.length === 0) {
		return "not-configured";
	}
	const transport = all.filter((server) => server.origin !== "misconfigured");
	if (transport.length === 0) {
		return "error";
	}
	// The serving test precedes the all-failed verdict: servedModelCount answers "does this server serve right now" on
	// every state, so a failure still serving stale or declared models can never read as dead.
	const serving = transport.some((server) => server.state === "ok" || server.servedModelCount > 0);
	const errors = transport.filter((server) => server.state === "error" && server.expected !== true).length;
	if (errors === transport.length && !serving) {
		return "error";
	}
	if (errors > 0) {
		return "degraded";
	}
	if (serving) {
		return "connected";
	}
	// Nothing serves and nothing failed unexpectedly: expected failures with no declared models are the actionable
	// case, plain unchecked entries wait.
	if (transport.some((server) => server.state === "error")) {
		return "needs-declare";
	}
	return "waiting";
}

/**
 * The verdict as one sentence, pinned by tests. English by policy: users paste these lines into public issue reports,
 * so localization sweeps must skip this function.
 *
 *   their groups still answer -> Hidden groups claim the connected verdict (through classifyOverall)
 */
export function overallStatusText(
	servers: readonly DashboardServer[],
	modelCount: number,
	context: { readonly hiddenGroupCount?: number } = {}
): string {
	const hiddenGroupCount = context.hiddenGroupCount ?? 0;
	switch (classifyOverall(servers, { hiddenGroupCount })) {
		case "not-configured":
			return "Not configured";
		case "error": {
			// The fallback only satisfies the type checker (the verdict guarantees an error row). A transport failure
			// outranks a misconfigured row's fixed text: the real outage is the line worth pasting.
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
		case "connected": {
			if (modelCount !== 0) {
				return `Connected (${modelCount} models)`;
			}
			// One English detail names the causes, shared with the log rendering (zeroModelEnglishDetail).
			//
			//   The zero-model reading -> the same warning every other surface gives this state (see zeroModelJudgment)
			return `Connected, but 0 models are served (${zeroModelEnglishDetail(
				hiddenGroupCount,
				servers.filter((server) => server.state === "ok").length
			)})`;
		}
	}
}

/**
 * The zero-model verdict's one explanation, shared by the status bar tooltip, the notifier and Test Connection toasts,
 * and the edit form's draft probe so the surfaces cannot phrase the same fact differently. Localized;
 * zeroModelEnglishDetail is the English mirror for logs and pasted reports.
 */
export function zeroModelExplanation(hiddenCount: number, answeredCount: number): string {
	const sentences: string[] = [];
	if (hiddenCount > 0) {
		sentences.push(
			hiddenCount === 1
				? l10n.t(
						"1 server is hidden and serves no models: it was removed here, or its entry now points at another URL. The dashboard's server list shows which."
					)
				: l10n.t(
						"{0} servers are hidden and serve no models: they were removed here, or their entries now point at other URLs. The dashboard's server list shows which.",
						hiddenCount
					)
		);
		if (answeredCount > 0) {
			sentences.push(l10n.t("The remaining servers answered but listed no models."));
		}
	} else {
		sentences.push(
			answeredCount === 1
				? l10n.t("The server answered but listed no models.")
				: l10n.t("Your servers answered but listed no models.")
		);
	}
	return sentences.join(" ");
}

/**
 * The zero-model causes as the English parenthetical logs and pasted reports carry (classifications and counts only,
 * never server text); the localized twin is zeroModelExplanation. English by the issue-report policy.
 */
export function zeroModelEnglishDetail(hiddenCount: number, answeredCount: number): string {
	return hiddenCount > 0
		? `${hiddenCount} hidden by the user's configuration${answeredCount > 0 ? `; ${answeredCount} answered with an empty listing` : ""}`
		: "answered with an empty listing";
}

/**
 * The entry-*-inactive classifications as diagnostics prose: each notice names its affected fields, and one composer
 * appends the shared cause-and-remedy clause so the four texts cannot drift apart. English by policy - these lines land
 * in public issue reports.
 */
function entryInactiveText(subject: string): string {
	return (
		`${subject} (the provider group does not carry this entry's labeled identity); ` +
		"delete the group in Manage Language Models (or remove its object from the models file, chatLanguageModels.json, and reload the window), " +
		"then run Sync Models Now, or save the entry under a new label"
	);
}

const ENTRY_PARAMS_INACTIVE_TEXT = entryInactiveText("per-entry modelParameters are not applied");

const ENTRY_CAPABILITIES_INACTIVE_TEXT = entryInactiveText(
	"per-entry modelCapabilities, declared models, expectedFailures, and includeModes are not applied"
);

const ENTRY_HEADERS_INACTIVE_TEXT = entryInactiveText("per-entry custom headers are not applied");

const ENTRY_API_VERSION_INACTIVE_TEXT = entryInactiveText(
	"the per-entry API version override is not applied, requests use the auto rule"
);

/** The expected-failure-with-nothing-to-serve line; English by the same issue-report policy. */
const EXPECTED_FAILURES_NOTHING_DECLARED_TEXT =
	"discovery fails in an expected category and no models are declared; add IDs to the entry's discovery.declared list to serve models without discovery";

/** The nothing-registered-and-modes-skipped line; English by the same issue-report policy. */
const NON_CHAT_MODES_SKIPPED_TEXT =
	"no models registered, and discovery skipped models by mode; add the modes to the entry's discovery.includeModes list to register them";

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
		case "non-chat-modes-skipped":
			return NON_CHAT_MODES_SKIPPED_TEXT;
	}
}

/**
 * The English outcome line below and the Servers row's localized headline both render from this, so the row can never
 * contradict its own served count. Discovery registers declared models into the served set, so "mixed" means
 * served > declared >= 1: both surfaces' mixed wording is plural on purpose, with no singular form to drift.
 */
export type ServedModelsBreakdown =
	| { readonly kind: "declared"; readonly declared: number }
	| { readonly kind: "mixed"; readonly served: number; readonly declared: number }
	| { readonly kind: "stale"; readonly served: number };

export function servedModelsBreakdown(served: number, declared: number): ServedModelsBreakdown {
	if (declared === served) {
		return { kind: "declared", declared };
	}
	return declared > 0 ? { kind: "mixed", served, declared } : { kind: "stale", served };
}

/**
 * serverOutcomeText composes exactly these parts, flattening a two-part error's newline to " - " (the presenters suite
 * pins the equality), so the pieces and the copied line cannot drift apart in wording.
 */
export interface ServerOutcomeParts {
	readonly status: "OK" | "Error" | "Misconfigured" | "Not checked yet";
	readonly models?: string | undefined;
	/**
	 * The row's error: an "error" state's message, with the English "(expected)" annotation when the entry expects the
	 * category. A sync failure is an error row (declaredOutcome), so an "ok" row never carries one.
	 */
	readonly error?: string | undefined;
	/** The row's warning notices, fixed classification text, one line each. */
	readonly notice: readonly string[];
}

export function serverOutcomeParts(server: DashboardServer): ServerOutcomeParts {
	const notice = (server.notices ?? []).map(noticeText);
	if (server.origin === "misconfigured") {
		// The parser's structural reports (configuration key names, never entered values); English like the notices -
		// these lines land in issue reports.
		return { status: "Misconfigured", error: server.problems.join("; "), notice };
	}
	switch (server.state) {
		case "ok":
			return { status: "OK", models: `${server.servedModelCount} models`, notice };
		case "error": {
			if (server.expected === true) {
				// Truthful error, expected presentation: the "(expected)" annotation stays English (it lands in issue
				// reports). A row still serving - declared models, or the stale window's last known list - reads as
				// OK-with-note, the same quiet verdict the row pill gives it.
				const detail = statusErrorDetail(server.error);
				const headline = `${statusErrorHeadline(server.error)} (expected)`;
				const error = detail === undefined ? headline : `${headline}\n${detail}`;
				const served = server.servedModelCount;
				if (served > 0) {
					// The models part always states the served total (the count the row and the merged surfaces show);
					// the declared subset rides as a qualifier, owning the wording only when it IS the whole set.
					const breakdown = servedModelsBreakdown(served, server.declaredModelCount ?? 0);
					const models =
						breakdown.kind === "declared"
							? breakdown.declared === 1
								? "1 declared model"
								: `${breakdown.declared} declared models`
							: breakdown.kind === "mixed"
								? `${breakdown.served} models, ${breakdown.declared} declared`
								: breakdown.served === 1
									? "1 model still served"
									: `${breakdown.served} models still served`;
					return { status: "OK", models, error, notice };
				}
				return { status: "Error", error, notice };
			}
			// An unexpected failure that still serves (stale-window or declared models) says so beside the truthful
			// error, so the paste line agrees with the row pill that the server is degraded, not dead.
			if (server.servedModelCount > 0) {
				const models =
					server.servedModelCount === 1 ? "1 model still served" : `${server.servedModelCount} models still served`;
				return { status: "Error", models, error: server.error, notice };
			}
			return { status: "Error", error: server.error, notice };
		}
		case "unchecked":
			return { status: "Not checked yet", notice };
	}
}

/**
 * One server's diagnostics outcome line, pinned by tests like overallStatusText. English by policy: users paste these
 * lines into public issue reports.
 */
export function serverOutcomeText(server: DashboardServer): string {
	const parts = serverOutcomeParts(server);
	// "OK (2 declared models) - <error (expected)>" vs "Error: <error>": the error joins an OK line as an aside and an
	// Error line as its object.
	const status = parts.models === undefined ? parts.status : `${parts.status} (${parts.models})`;
	// A two-part error (headline "\n" detail) flattens to one physical line: this is the copy-paste issue-report form.
	const flatError = parts.error
		?.split("\n")
		.map((line) => trimHttpWhitespace(line))
		.filter((line) => line.length > 0)
		.join(" - ");
	const error = flatError === undefined ? "" : parts.status === "OK" ? ` - ${flatError}` : `: ${flatError}`;
	// Notices ride alongside whatever the state line says: a noticed row is usually healthy ("ok"), which is exactly
	// why it needs calling out.
	const notice = parts.notice.map((text) => ` - ${text}`).join("");
	return `${status}${error}${notice}`;
}

export function latestCheckedMs(servers: readonly Pick<DashboardServer, "lastChecked">[]): number | undefined {
	const times = servers.map((server) => server.lastChecked).filter((time) => time !== undefined);
	return times.length > 0 ? Math.max(...times) : undefined;
}

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
 * One unit's value behavior: everything the display and validation paths key off a setting's unit, so adding a unit is
 * one NUMBER_UNIT_BEHAVIOR row.
 */
export interface NumberUnitBehavior {
	readonly parseDraft: (text: string) => number | undefined;
	readonly parseProblem: () => string;
	/** An exact human rendering of a value ("5 min"), or undefined to show the raw number. */
	readonly exactDisplay: (value: number) => string | undefined;
	/** The muted "= ..." equivalence beside the input, or undefined when the unit offers none. */
	readonly equivalence: (value: number, zeroMeaning: string | undefined) => string | undefined;
	/** A bound as failure-detail text, unit-suffixed; stays English (it rides intent-failure detail lines). */
	readonly boundText: (minimum: number) => string;
	/** Whether the grammar needs a free-text input (a number input would swallow suffix letters). */
	readonly freeTextInput: boolean;
}

const DURATION_SUFFIX_MS: Readonly<Record<string, number>> = {
	ms: 1,
	s: 1000,
	m: 60000,
	h: 3600000,
};

/**
 * A duration draft as milliseconds: "1500ms", "90s", "5m", "1h" (suffixes case-insensitive), or a bare number meaning
 * milliseconds; undefined for everything else, so the form renders one grammar error.
 */
function parseDurationDraftMs(text: string): number | undefined {
	const trimmed = trimHttpWhitespace(text);
	const match = /^(.*?)(ms|s|m|h)$/i.exec(trimmed);
	if (match === null) {
		// No suffix: the bare-number-is-ms reading, through the same exact arithmetic as a suffixed one so an authored
		// fraction below float precision is refused here too. The empty draft never reaches this helper unguarded.
		return trimmed.length === 0 ? undefined : scaledDecimal(trimmed, 1);
	}
	const prefix = match[1] ?? "";
	const suffix = (match[2] ?? "").toLowerCase();
	if (trimHttpWhitespace(prefix).length === 0) {
		return undefined;
	}
	const factor = DURATION_SUFFIX_MS[suffix] ?? Number.NaN;
	return Number.isNaN(factor) ? undefined : scaledDecimal(prefix, factor);
}

/**
 * The prefix times the unit factor in exact decimal arithmetic, so "1.001s" is 1001 (its float product is
 * 1000.9999999999999). A whole result is exact; a non-whole one, an exponent past 400 digits either way, or a result
 * beyond Number's range is reported as NaN, a reading the contract refuses (not a grammar failure), so
 * "1.0000000000000000001s" cannot round back to an accepted 1000 and "1e309s" is refused by its bound, not its
 * spelling. Anything outside decimal notation is no reading.
 */
function scaledDecimal(prefix: string, factor: number): number | undefined {
	const match = DECIMAL_TEXT_PATTERN.exec(trimHttpWhitespace(prefix));
	if (match === null) {
		return undefined;
	}
	const [, sign = "", whole = "", dotFraction, leadingFraction, exponent = "0"] = match;
	const fraction = dotFraction ?? leadingFraction ?? "";
	// The mantissa as significant digits only: leading and trailing zeros spell nothing, so neither counts against the
	// exponent guard ("1" + 401 zeros + "e-401" is 1).
	const spelled = `${whole}${fraction}`.replace(/^0+/, "");
	const digits = spelled.replace(/0+$/, "");
	if (digits === "") {
		return 0;
	}
	const power = Number(exponent) - fraction.length + (spelled.length - digits.length);
	// The value has digits.length + power integer digits; past 16 it exceeds every setting maximum before the unit factor
	// is applied, so a pasted million-digit draft is refused without building its BigInt.
	if (!Number.isSafeInteger(power) || Math.abs(power) > 400 || digits.length + power > 16) {
		return Number.NaN;
	}
	let product = BigInt(digits) * BigInt(factor);
	let scale = 1n;
	if (power >= 0) {
		product *= 10n ** BigInt(power);
	} else {
		scale = 10n ** BigInt(-power);
	}
	if (product % scale !== 0n) {
		return Number.NaN;
	}
	const result = Number(product / scale);
	return Number.isFinite(result) ? (sign === "-" ? -result : result) : Number.NaN;
}

/**
 * A millisecond count as humans read clocks: "5 min", "1 h 30 min". At most two units; a truncated remainder gets a
 * "~" instead of false precision, with `exact` saying which happened.
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
		boundText: (minimum) => `${minimum} ms`,
		freeTextInput: true,
	},
	count: {
		parseDraft: (text) => {
			const trimmed = trimHttpWhitespace(text);
			// The same exact arithmetic as a duration, so "1.0000000000000000001" is a fraction the contract refuses
			// rather than the 1 that Number would make of it. An empty draft has no reading under any grammar.
			return trimmed.length === 0 ? undefined : scaledDecimal(trimmed, 1);
		},
		parseProblem: () => l10n.t("Not a whole number"),
		exactDisplay: () => undefined,
		// A digit-grouped echo of the same number would say nothing.
		equivalence: () => undefined,
		boundText: (minimum) => String(minimum),
		freeTextInput: false,
	},
} as const satisfies Record<string, NumberUnitBehavior>;

type NumberSettingUnit = keyof typeof NUMBER_UNIT_BEHAVIOR;

export function unitBehavior(id: NumberSettingId): NumberUnitBehavior {
	return NUMBER_UNIT_BEHAVIOR[NUMBER_SETTING_UNITS[id]];
}

export interface NumberSettingPresentation {
	readonly label: string;
	readonly description: string;
	/** The input's unit suffix; display text only - the grammar keys off NUMBER_SETTING_UNITS, never off this. */
	readonly unit: string;
	/** What a configured 0 means, when 0 is legal and has a special reading (the cache TTL). */
	readonly zeroMeaning?: string;
}

/**
 * A function, not a module-level catalog: these strings localize, and module-level constants would freeze the English
 * text before l10n.config runs.
 */
export function numberSettingPresentation(id: NumberSettingId): NumberSettingPresentation {
	switch (id) {
		case "chat.timeout":
			return {
				label: l10n.t("Request timeout"),
				description: l10n.t(
					"Hard bound for one chat, commit-message, pull-request-description, consult-tool, or quick-fix call."
				),
				unit: l10n.t({ message: "ms", comment: ["Abbreviation for milliseconds; unit suffix after duration inputs."] }),
			};
		case "chat.maxToolsPerRequest":
			return {
				label: l10n.t("Max tools per request"),
				description: l10n.t("The most tools one request may carry."),
				// A key of its own, apart from the capability chip's "tools": a count suffix may need a measure word
				// where a chip label does not.
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
 * single value extraction behind parseNumberDraft AND violatesContract, so the
 * two can never disagree about what a draft is worth.
 */
function draftValue(id: NumberSettingId, text: string): number | undefined {
	const trimmed = trimHttpWhitespace(text);
	if (trimmed.length === 0) {
		return undefined;
	}
	return unitBehavior(id).parseDraft(trimmed);
}

/**
 * What a modified number row shows as the setting's built-in default: the unit's exact human rendering when it has
 * one, the raw number otherwise. A "~" approximation would misstate what the default actually is.
 */
export function defaultDisplay(id: NumberSettingId): string {
	const spec = NUMBER_SETTING_SPECS[id];
	return unitBehavior(id).exactDisplay(spec.default) ?? String(spec.default);
}

/**
 * Whether a rejected draft has a reading the spec refuses (outside a bound, or a fraction on an integer-only setting).
 * The form keeps these quiet until the field blurs (typing the 5 of 5000 passes through honest below-minimum values),
 * while true parse failures stay live. Reads the draft through the same draftValue extraction parseNumberDraft uses.
 */
export function violatesContract(id: NumberSettingId, text: string): boolean {
	const value = draftValue(id, text);
	return value !== undefined && !acceptsNumberSetting(id, value);
}

export interface BooleanSettingPresentation {
	readonly label: string;
	readonly description: string;
}

/**
 * The presentation of one boolean setting the dashboard edits; a function for the same lazy-localization reason as
 * numberSettingPresentation.
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
				// Not rendered (the row shows the live status cluster instead) and so not filtered: this key and the
				// tip's translate independently.
				description: l10n.t("Fill missing model capabilities from the OpenRouter catalog, refreshed weekly."),
			};
		case "inlineCompletions.enabled":
			return {
				label: l10n.t("Enable inline completions"),
				description: l10n.t(
					"Ghost text suggestions from a LiteLLM model. Requires enabling this and choosing a model below."
				),
			};
		case "commitGeneration.enabled":
			return {
				label: l10n.t("Enable commit message generation"),
				description: l10n.t(
					"Drafts the commit message from your changes with a LiteLLM model. Requires enabling this and choosing a model below."
				),
			};
		case "prGeneration.enabled":
			return {
				label: l10n.t("Enable PR description generation"),
				description: l10n.t(
					"Drafts PR titles and descriptions from your commits with a LiteLLM model. Requires enabling this and choosing a model below."
				),
			};
		case "consultTool.enabled":
			return {
				label: l10n.t("Enable the consult tool"),
				description: l10n.t(
					"Lets a chat agent ask a second LiteLLM model for another opinion. Requires enabling this and choosing a model below."
				),
			};
		case "quickFix.enabled":
			return {
				label: l10n.t("Enable quick fixes"),
				description: l10n.t(
					"Fix and Explain actions on diagnostics, answered through @litellm chat or the model below."
				),
			};
		case "reviewComments.enabled":
			return {
				label: l10n.t("Enable review comments"),
				description: l10n.t("AI review comments on your changes from a LiteLLM model."),
			};
		case "chatParticipant.enabled":
			return {
				label: l10n.t("Enable the @litellm participant"),
				description: l10n.t("Answers @litellm chat turns with the request's own model; costs nothing until invoked."),
			};
		case "agentTools.enabled":
			return {
				label: l10n.t("Enable agent tools"),
				description: l10n.t(
					"Gives Copilot's agent tools that read this extension's diagnostics and configuration. Each tool that changes something has its own switch below."
				),
			};
		case "agentTools.setSetting.enabled":
			return {
				label: l10n.t("Let the agent change plain settings"),
				description: l10n.t(
					"Timeouts, toggles, feature models, and other scalar settings, through the dashboard's validation. Never servers, model records, or these switches."
				),
			};
		case "agentTools.editModelRecords.enabled":
			return {
				label: l10n.t("Let the agent edit model records"),
				description: l10n.t(
					"models.capabilities and models.parameters, one matcher key at a time, globally or on a servers entry."
				),
			};
		case "agentTools.saveServer.enabled":
			return {
				label: l10n.t("Let the agent add and edit servers"),
				description: l10n.t(
					"Add, edit, rename, or adopt a servers entry. You type secret values unless the switch below allows the agent to pass them."
				),
			};
		case "agentTools.removeServer.enabled":
			return {
				label: l10n.t("Let the agent remove servers"),
				description: l10n.t("Remove a servers entry or hide an external provider group."),
			};
		case "agentTools.runAction.enabled":
			return {
				label: l10n.t("Let the agent run actions"),
				description: l10n.t(
					"Test a stored server's connection, re-sync models, refresh the catalog or usage numbers, or send a fixed probe prompt to a feature's picked model (a billable model request)."
				),
			};
		case "agentTools.secretValues.enabled":
			return {
				label: l10n.t("Let the agent pass secret values"),
				description: l10n.t(
					"Off, the agent chooses only where a key is stored and VS Code asks you to type it. On, tool input may carry the key itself."
				),
			};
	}
}

/**
 *   One number-setting draft -> parsed once
 *   parsed once              -> the error display, the commit, and the equivalence hint all read this one parse
 */
export type NumberDraftParse =
	| { readonly kind: "invalid"; readonly problem: string }
	| { readonly kind: "clear" }
	| { readonly kind: "value"; readonly value: number };

export function parseNumberDraft(id: NumberSettingId, text: string): NumberDraftParse {
	const spec = NUMBER_SETTING_SPECS[id];
	const trimmed = trimHttpWhitespace(text);
	if (trimmed.length === 0) {
		return spec.nullable ? { kind: "clear" } : { kind: "invalid", problem: l10n.t("Enter a number") };
	}
	const value = draftValue(id, text);
	if (value === undefined) {
		return { kind: "invalid", problem: unitBehavior(id).parseProblem() };
	}
	// The spec's own contract, the rule the host write and the settings reader apply: a fraction or an out-of-range
	// value is refused as typed, never rounded or clamped, so nothing the form commits reads back as the default.
	if (!acceptsNumberSetting(id, value)) {
		return { kind: "invalid", problem: numberContractSentence(id) };
	}
	return { kind: "value", value };
}

/**
 * The one localized sentence for a number setting's contract: the dashboard row, the Diagnostics tab, and the
 * settings-import preview all show this text, so a user meets one wording for one rule.
 */
export function numberContractSentence(id: NumberSettingId): string {
	const spec = NUMBER_SETTING_SPECS[id];
	const offValue = numberSettingOffValue(id);
	return offValue === undefined
		? l10n.t("{0} must be a whole number between {1} and {2}.", id, spec.minimum, spec.maximum)
		: l10n.t(
				"{0} must be a whole number between {1} and {2}, or {3} to turn it off.",
				id,
				spec.minimum,
				spec.maximum,
				offValue
			);
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
 * The identity of a scalar setting's external state, which the settings form's draft-resync effect keys on. Both
 * halves are load-bearing: a reset can change the configured scope while leaving the effective value untouched, and
 * the draft must resync on that push too.
 */
export function draftSyncKey(value: number | null, configuredScope: SettingScope | null): string {
	return `${value === null ? "" : String(value)}@${configuredScope ?? "default"}`;
}

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

/** Invalid input is a validation error, never a silent guess. */
export function parseJsonValue(text: string): ParsedJsonValue {
	const trimmed = trimHttpWhitespace(text);
	if (trimmed.length === 0) {
		return { ok: false, error: l10n.t('Enter a JSON value, e.g. 0.2, true, or "text".') };
	}
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		return { ok: false, error: l10n.t('Not valid JSON. Quote strings, e.g. "text".') };
	}
	const overflowAt = nonFiniteNumberPath(value);
	if (overflowAt !== undefined) {
		return {
			ok: false,
			error:
				overflowAt === ""
					? l10n.t("Number too large for JSON; it would be saved as null")
					: l10n.t("Number too large for JSON at {0}; it would be saved as null", overflowAt),
		};
	}
	return { ok: true, value };
}

/**
 * Header values are scalars, so this is lenient where parseJsonValue is strict: finite JSON scalars are taken as typed
 * values ("true" is a boolean, "42" a number, "\"42\"" a string) and anything else is the literal string.
 */
export function parseHeaderValue(text: string): HeaderScalar {
	const trimmed = trimHttpWhitespace(text);
	const parsed = parseJsonValue(trimmed);
	// Non-finite numbers (parseJsonValue refuses "1e999") fall through to the literal string: isHeaderScalar refuses
	// them at the header-record parse boundary, so parsing them as numbers would make Apply a silent no-op.
	if (
		parsed.ok &&
		(typeof parsed.value === "string" || typeof parsed.value === "boolean" || typeof parsed.value === "number")
	) {
		return parsed.value;
	}
	return trimmed;
}

export function formatJsonValue(value: unknown): string {
	return JSON.stringify(value) ?? "";
}

/**
 * Non-strings print bare ("true", "42"); a string that would re-parse as a JSON scalar is quoted so its type survives
 * the round trip.
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

/**
 * One threshold box's parse: a fraction (0.8), a percentage (80%), or a bare number above 1 read as percent. The docs'
 * bound applies after conversion: (0, 1]. Lossy in value space by an ulp ("53.3%" is not 0.533 back), but render ->
 * parse -> render IS a fixed point, which is the space the settings page's commit compares in.
 */
export function parseThresholdBox(
	text: string
): { readonly kind: "empty" } | { readonly kind: "value"; readonly value: number } | { readonly kind: "invalid" } {
	const trimmed = trimHttpWhitespace(text);
	if (trimmed.length === 0) {
		return { kind: "empty" };
	}
	const percent = trimmed.endsWith("%");
	const numberText = percent ? trimHttpWhitespace(trimmed.slice(0, -1)) : trimmed;
	const parsed = parseDecimalText(numberText);
	if (parsed === undefined) {
		return { kind: "invalid" };
	}
	const value = percent || parsed > 1 ? parsed / 100 : parsed;
	if (!isUsableThreshold(value)) {
		return { kind: "invalid" };
	}
	return { kind: "value", value };
}
