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

// The effective-values inspector renders through the same resolution the
// request path runs; the webview may import only this module, so the pure
// functions are re-exported here (the isValidHeaderName precedent).
export type {
	EffectiveParameterRow,
	ModelParametersRecord,
	ParameterSourceRef,
	ProjectedMaxTokens,
	ShadowedParameterValue,
} from "../../shared/config/parameterResolution";
export { DEFAULT_MAX_TOKENS_CAP, projectEffectiveParameters } from "../../shared/config/parameterResolution";
export type { BooleanSettingId, NumberSettingId } from "../../shared/config/settingSpec";
export { NUMBER_SETTING_SPECS } from "../../shared/config/settingSpec";
export type { NonSecretOptionalFieldId, SecretFieldId, SecretLocation } from "../../shared/serverEntry";
export { NON_SECRET_OPTIONAL_FIELD_IDS, SECRET_FIELD_IDS } from "../../shared/serverEntry";
export type { HeaderScalar } from "../../shared/util/headers";
export { isValidHeaderName, isValidHeaderValue } from "../../shared/util/headers";
export { isRecord, isUnsafeRecordKey } from "../../shared/util/json";

import * as l10n from "@vscode/l10n";
import type { BooleanSettingId, NumberSettingId } from "../../shared/config/settingSpec";
import { BOOLEAN_SETTING_SPECS, NUMBER_SETTING_SPECS } from "../../shared/config/settingSpec";
import type { NonSecretOptionalFields, SecretFieldId, SecretLocation } from "../../shared/serverEntry";
import type { HeaderScalar } from "../../shared/util/headers";

/** A per-entry modelParameters record: model-ID prefix to request parameters. Non-secret user configuration. */
type EntryModelParametersPayload = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The non-secret configuration of a declared server, for the edit form's prefill. */
interface DashboardServerConfig extends NonSecretOptionalFields {
	/** Where each secret currently lives; the values themselves never reach the webview. */
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
	/** The entry's own modelParameters, when it has any; the edit form's prefill. */
	readonly modelParameters?: EntryModelParametersPayload | undefined;
}

/**
 * Row-level warning classifications for declared entries. Only the
 * classification crosses the extension-webview boundary; the user-facing copy
 * is rendered webview-side - the same rule the logs follow (classifications,
 * never free text).
 *
 * "entry-params-inactive": the entry declares per-entry modelParameters, but
 * the live group serving it did not join by the entry's exact labeled
 * identity - it predates entry labels, predates a rename, or carries someone
 * else's label - so the request path's label-and-URL check does not apply
 * those parameters. Recreating the group activates them.
 */
type DeclaredServerNotice = "entry-params-inactive";

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
 */
export type DashboardServer = DashboardServerBase &
	(
		| {
				/** In the servers setting (editable here); `config` is the edit form's prefill. */
				readonly origin: "declared";
				readonly config: DashboardServerConfig;
				readonly adoptHandle?: undefined;
				/** A warning classification for the row, when one applies; see DeclaredServerNotice. */
				readonly notice?: DeclaredServerNotice | undefined;
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
				readonly notice?: undefined;
				/** Why the group exists, when a removal or rename explains it; see ExternalServerProvenance. */
				readonly provenance?: ExternalServerProvenance | undefined;
				/**
				 * Whether Remove (hide) applies: true for provider-group rows, false
				 * for legacy-registry rows, whose models the registry path would
				 * keep serving - hiding those would only make the dashboard lie.
				 */
				readonly hideable: boolean;
		  }
	) &
	(
		| { readonly state: "ok"; readonly error?: string | undefined }
		| { readonly state: "error"; readonly error: string }
		| { readonly state: "unchecked"; readonly error?: undefined }
	);

/**
 * The overall configuration verdict, shared by the dashboard hero and the
 * Diagnostics tab so their headline judgement cannot drift. Each surface
 * renders it differently (the hero as a colored word, the tab as a line with
 * model counts and the first error), but the classification itself lives
 * here once. Only real failures count as failures: declared entries a
 * discovery pass has not reached yet stay neutral.
 */
export type OverallVerdict = "not-configured" | "error" | "degraded" | "waiting" | "connected";

export function classifyOverall(servers: readonly Pick<DashboardServer, "state">[]): OverallVerdict {
	if (servers.length === 0) {
		return "not-configured";
	}
	const errors = servers.filter((server) => server.state === "error").length;
	if (errors === servers.length) {
		return "error";
	}
	if (errors > 0) {
		return "degraded";
	}
	if (servers.every((server) => server.state === "unchecked")) {
		return "waiting";
	}
	return "connected";
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
			// only satisfies the type checker, which cannot see that.
			const firstError = servers.find((server) => server.state === "error")?.error ?? "Unknown error";
			return `Error: ${firstError}`;
		}
		case "degraded":
			return `Degraded (${modelCount} models, some servers failed)`;
		case "waiting":
			return "Waiting for first sync";
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

/**
 * serverOutcomeText decomposed, for surfaces that render the pieces
 * separately (the Diagnostics tab's outcome grid): the status verdict, the
 * model-count clause an "ok" line carries, the error the row carries, and the
 * params-inactive warning. The one-line form composes exactly these parts
 * (protocol.test.ts pins the equality), so a grid cell and the copied line
 * cannot drift apart in wording.
 */
export interface ServerOutcomeParts {
	/** The verdict as a Status cell shows it. */
	readonly status: "OK" | "Error" | "Not checked yet";
	/** The model-count clause an "ok" line parenthesizes ("3 models"); absent on other states. */
	readonly models?: string | undefined;
	/**
	 * The row's error: an "error" state's message, or the sync failure an "ok"
	 * row can still carry (a declared entry whose group upsert failed while an
	 * already-live group keeps serving).
	 */
	readonly error?: string | undefined;
	/** The entry-params-inactive warning, fixed classification text. */
	readonly notice?: string | undefined;
}

export function serverOutcomeParts(server: DashboardServer): ServerOutcomeParts {
	const notice = server.notice === "entry-params-inactive" ? ENTRY_PARAMS_INACTIVE_TEXT : undefined;
	switch (server.state) {
		case "ok":
			return { status: "OK", models: `${server.modelCount} models`, error: server.error, notice };
		case "error":
			return { status: "Error", error: server.error, notice };
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
	const error = parts.error === undefined ? "" : parts.status === "OK" ? ` - ${parts.error}` : `: ${parts.error}`;
	// The notice rides alongside whatever the state line says: a noticed row
	// is usually healthy ("ok"), which is exactly why it needs calling out.
	const notice = parts.notice === undefined ? "" : ` - ${parts.notice}`;
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
	/** Key into DashboardState.requestScopes for this model's serving server; push-local, never persisted. */
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
}

/**
 * What each number setting counts. Static classification, deliberately apart
 * from the localized presentation: value logic (the duration grammar in
 * draftValue, the clock rendering in defaultDisplay and equivalence) keys off
 * these codes, and the form renders the localized unit suffix from
 * numberSettingPresentation instead.
 */
export const NUMBER_SETTING_UNITS = {
	defaultMaxOutputTokens: "tokens",
	defaultContextLength: "tokens",
	defaultMaxInputTokens: "tokens",
	requestTimeout: "ms",
	discoveryTimeout: "ms",
	discoveryCacheTtl: "ms",
} as const satisfies Record<NumberSettingId, "ms" | "tokens">;

/** One number setting's presentation strings, resolved per call so the l10n bundle is honored. */
export interface NumberSettingPresentation {
	readonly label: string;
	readonly description: string;
	/** The input's unit suffix; display text only - the grammar keys off NUMBER_SETTING_UNITS, never off this. */
	readonly unit: string;
	/** What a configured 0 means, when 0 is legal and has a special reading (the cache TTL). */
	readonly zeroMeaning?: string;
	/** The empty field's hint on a nullable setting: what being unset means, e.g. "derived from context length". */
	readonly placeholder?: string;
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
		case "defaultMaxOutputTokens":
			return {
				label: l10n.t("Default max output tokens"),
				description: l10n.t("Used when the server does not report a limit."),
				unit: l10n.t("tokens"),
			};
		case "defaultContextLength":
			return {
				label: l10n.t("Default context length"),
				description: l10n.t("Used when the server does not report a context window."),
				unit: l10n.t("tokens"),
			};
		case "defaultMaxInputTokens":
			return {
				label: l10n.t("Default max input tokens"),
				description: l10n.t("Leave empty to derive it as context length minus output tokens."),
				unit: l10n.t("tokens"),
				placeholder: l10n.t("derived from context length"),
			};
		case "requestTimeout":
			return {
				label: l10n.t("Request timeout"),
				description: l10n.t("Hard bound for one chat completion call."),
				unit: l10n.t("ms"),
			};
		case "discoveryTimeout":
			return {
				label: l10n.t("Discovery timeout"),
				description: l10n.t("Hard bound for one model discovery call."),
				unit: l10n.t("ms"),
			};
		case "discoveryCacheTtl":
			return {
				label: l10n.t("Discovery cache lifetime"),
				description: l10n.t("How long discovered model lists are reused; 0 asks the server on every refresh."),
				unit: l10n.t("ms"),
				zeroMeaning: l10n.t("every refresh"),
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
 * on ms-unit settings, plain trim-and-Number elsewhere. Undefined when the
 * text has no reading (empty included). The single value extraction behind
 * parseNumberDraft AND isBoundViolation, so the two can never disagree about
 * what a draft is worth.
 */
function draftValue(id: NumberSettingId, text: string): number | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (NUMBER_SETTING_UNITS[id] === "ms") {
		return parseDurationDraftMs(trimmed);
	}
	const value = Number(trimmed);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * What a modified number row shows as the setting's built-in default. The one
 * null default (defaultMaxInputTokens) has no number to show - its effective
 * value is computed per model at request time - so it reads "derived", never
 * an invented number. Millisecond defaults speak the same duration idiom as
 * the field's equivalence hint ("5 min", not "300000"), so the two read
 * consistently side by side - but only when the duration is exact: a "~"
 * approximation would misstate what the default actually is, so those fall
 * back to the raw number.
 */
export function defaultDisplay(id: NumberSettingId): string {
	const spec = NUMBER_SETTING_SPECS[id];
	if (spec.default === null) {
		return l10n.t("derived");
	}
	if (NUMBER_SETTING_UNITS[id] === "ms") {
		const duration = formatDuration(spec.default);
		if (duration?.exact) {
			return duration.label;
		}
	}
	return String(spec.default);
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
		case "promptCaching.enabled":
			return {
				label: l10n.t("Prompt caching"),
				description: l10n.t("Cache the system prompt on models that advertise support."),
			};
		case "maskApiKeyInput":
			return {
				label: l10n.t("Mask API key input"),
				description: l10n.t("Hide the API key while typing it into configuration prompts."),
			};
	}
}

export const BOOLEAN_SETTING_IDS = Object.keys(BOOLEAN_SETTING_SPECS) as readonly BooleanSettingId[];

/**
 * The settings the revealSetting intent may name: exactly what the Settings
 * tab renders rows or editors for - the scalars plus the two record settings.
 * A classification list, not free text: only these ids cross the webview
 * boundary, and the extension resolves each to "litellm-vscode-chat.<id>"
 * itself.
 */
export type RevealableSettingId = NumberSettingId | BooleanSettingId | "modelParameters" | "headers";

export const REVEALABLE_SETTING_IDS: readonly RevealableSettingId[] = [
	...NUMBER_SETTING_IDS,
	...BOOLEAN_SETTING_IDS,
	"modelParameters",
	"headers",
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
		[3600000, l10n.t("h")],
		[60000, l10n.t("min")],
		[1000, l10n.t("s")],
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
		return {
			kind: "invalid",
			problem:
				NUMBER_SETTING_UNITS[id] === "ms" ? l10n.t("Not a duration - use ms, s, m, or h") : l10n.t("Not a number"),
		};
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
 * rules. Token counts get no equivalence (a digit-grouped echo of the same
 * number says nothing); their unit suffix on the input carries the meaning.
 */
export function equivalence(id: NumberSettingId, value: number): string | undefined {
	if (NUMBER_SETTING_UNITS[id] !== "ms") {
		return undefined;
	}
	if (value === 0) {
		const zeroMeaning = numberSettingPresentation(id).zeroMeaning;
		return zeroMeaning === undefined ? undefined : `= ${zeroMeaning}`;
	}
	const duration = formatDuration(value);
	return duration === undefined ? undefined : `= ${duration.label}`;
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
	readonly headers: ScopedRecordSetting<HeaderScalar>;
}

/**
 * What the request path would resolve for requests through one server: the
 * base-URL scope its modelParameters matching runs under, and - when a
 * declared entry's label and base URL both match the live group, resolved by
 * the SAME production resolver requests use - that entry's label and its own
 * modelParameters. Keyed per snapshot in DashboardState.requestScopes
 * (push-local keys): a label-keyed scope would misattribute entry parameters
 * across same-label duplicate snapshots.
 */
export interface RequestScope {
	/** The server's normalized base URL, as scoped modelParameters keys match it. */
	readonly baseUrlScope: string;
	/** The declared entry the request path resolves for this server, when one matches by label and base URL. */
	readonly entryLabel?: string | undefined;
	/** That entry's own modelParameters record. */
	readonly entryParameters?: EntryModelParametersPayload | undefined;
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
	/** Per-snapshot request scopes, keyed by DashboardModel.scopeKey; see RequestScope. */
	readonly requestScopes: Readonly<Record<string, RequestScope>>;
	readonly settings: DashboardSettings;
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
export const DASHBOARD_SECTION_IDS = ["overview", "settings", "diagnostics"] as const;

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
	  };

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
}

/** Webview-to-extension intents. The extension re-validates every one: the webview is a trust boundary. */
export type WebviewToExtensionMessage =
	| { readonly type: "ready" }
	| { readonly type: "setNumberSetting"; readonly setting: NumberSettingId; readonly value: number | null }
	| { readonly type: "setBooleanSetting"; readonly setting: BooleanSettingId; readonly value: boolean }
	/** Remove the setting from the highest-precedence scope that sets it; the next scope's value or the default shows through. */
	| { readonly type: "resetSetting"; readonly setting: NumberSettingId | BooleanSettingId }
	/** Open the user settings.json at "litellm-vscode-chat.<setting>"; only ids from REVEALABLE_SETTING_IDS cross. */
	| { readonly type: "revealSetting"; readonly setting: RevealableSettingId }
	| { readonly type: "setModelParameters"; readonly value: Record<string, Record<string, unknown>> }
	| { readonly type: "setHeaders"; readonly value: Record<string, HeaderScalar> }
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
 * failure mode, and readInlineSecrets is a read answered by its own response
 * message (an unknown label simply yields no values).
 */
export type DashboardIntentType = Exclude<WebviewToExtensionMessage["type"], "ready" | "readInlineSecrets">;

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
		// the literal string: isHeaderScalar refuses them at the setHeaders
		// intent boundary, so parsing them as numbers would make Apply a
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
