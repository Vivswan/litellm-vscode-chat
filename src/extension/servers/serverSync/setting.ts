/**
 * Parsing the litellm-vscode-chat.servers setting: the acceptance rules for declared entries live here and nowhere
 * else. Shape errors (a second form beside oauth, an oauth missing tokenUrl or clientId, an unknown key inside auth)
 * make the entry MISCONFIGURED: reported and skipped, never guessed at.
 *
 *   Auth grammar                                     -> exactly one form per entry, ranked oauth > apiKey > virtualKey
 *   A form                                           -> may carry companions of strictly lower primacy only
 *   missing its secret VALUE is not misconfiguration -> the entry works and the server's 401 tells the story
 *   the parsed DeclaredServer keeps the flat credential fields -> the wire shape of the provider-group args - and
 *                                                                 with it every stored sync fingerprint - is unchanged
 *                                                                 by the restructure
 */

import {
	normalizeCustomHeaders,
	normalizeModelCapabilities,
	normalizeModelParameters,
} from "../../../shared/config/settings";
import type {
	EntryViewFields,
	EntryViewFieldValues,
	ExpectedFailureCategory,
	McpOptIn,
	MutableEntryViewFields,
	NonChatMode,
	NonSecretOptionalFields,
	OptionalEntryFieldId,
	OptionalEntryFields,
	SecretFieldId,
} from "../../../shared/serverEntry";
import { isExpectedFailureCategory, isNonChatMode, NON_SECRET_OPTIONAL_FIELD_IDS } from "../../../shared/serverEntry";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { HEADER_NAME_PATTERN } from "../../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";
import { sameGroupIdentity } from "../groupRemovals";

export type EntryModelParameters = EntryViewFieldValues["modelParameters"];

export type EntryModelCapabilities = EntryViewFieldValues["modelCapabilities"];

/**
 * One parsed servers-setting entry: label and baseUrl usable, credential fields flattened from the entry's `auth`
 * object (present only with usable inline text; values resting in SecretStorage stay absent here and resolve at
 * group-args time). The remaining optional fields are the shared registry's EntryViewFields (present only when the raw
 * entry carries usable content); they are read extension-side and never enter the group configuration or its
 * fingerprint.
 */
export type DeclaredServer = {
	readonly label: string;
	readonly baseUrl: string;
} & EntryViewFields &
	OptionalEntryFields;

/**
 * These fields decide WHERE resolved secrets are sent (the OAuth client secret to the token URL, the keys to
 * the base URL), so any drift means the label's stored values no longer belong to those destinations. The
 * dashboard's save and probe paths and the Set Server Secret palette all refuse through this one comparison.
 */
export function nonSecretIdentityMatches(
	entry: DeclaredServer,
	other: NonSecretOptionalFields & { readonly baseUrl: string; readonly apiVersion?: string | undefined }
): boolean {
	return (
		normalizeBaseUrl(entry.baseUrl) === normalizeBaseUrl(other.baseUrl) &&
		entry.apiVersion === other.apiVersion &&
		NON_SECRET_OPTIONAL_FIELD_IDS.every((field) => entry[field] === other[field])
	);
}

function usableString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** An entry's manual usage budget in USD: finite and above zero (a zero budget could only read as fully spent). */
function usableBudget(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The URL itself is taken as written beyond trimming - the dashboard's write path is where http(s) shape is enforced,
 * exactly as it is for `baseUrl`.
 *
 *   `false` opts out                      -> an explicit off switch, not a mistake
 *   an explicit off switch, not a mistake -> it reports nothing
 *   an unusable `url` still leaves the entry opted in at the derived endpoint
 *     -> a typo costs the custom address, never the server
 */
function parseMcpOptIn(raw: unknown, report: (what: string) => void): McpOptIn | undefined {
	if (raw === true) {
		return true;
	}
	if (raw === false) {
		return undefined;
	}
	if (!isRecord(raw)) {
		report("has an mcp value that is not true, false, or an object, ignored");
		return undefined;
	}
	// Named on purpose, like the unknown auth and discovery keys: a typo silently reading as "the default endpoint"
	// would be invisible.
	for (const key of Object.keys(raw)) {
		if (key !== "url") {
			report(`has an unknown mcp key "${key}", ignored`);
		}
	}
	if (raw.url !== undefined && typeof raw.url !== "string") {
		report("has an mcp.url that is not a string, ignored");
		return true;
	}
	const url = usableString(raw.url);
	return url !== undefined ? { url } : true;
}

type FlatAuthFields = { -readonly [K in OptionalEntryFieldId]?: string };

function parseAuth(raw: unknown): { fields: FlatAuthFields } | { problems: string[] } {
	const fields: FlatAuthFields = {};
	if (raw === undefined) {
		return { fields };
	}
	if (!isRecord(raw)) {
		return { problems: ["has an auth value that is not an object"] };
	}
	const problems: string[] = [];
	const keys = Object.keys(raw);
	const known = ["apiKey", "oauth", "virtualKey"];
	for (const key of keys) {
		if (!known.includes(key)) {
			// Named on purpose: a typo silently reading as "no auth" would be the worst failure mode.
			problems.push(`has an unknown auth key "${key}"`);
		}
	}
	const hasOAuth = raw.oauth !== undefined;
	const hasApiKey = raw.apiKey !== undefined;
	const hasVirtualKey = raw.virtualKey !== undefined;
	if (!hasOAuth && !hasApiKey && !hasVirtualKey && problems.length === 0) {
		problems.push("has an auth object that configures no form (expected one of apiKey, oauth, virtualKey)");
	}
	if (hasOAuth && (hasApiKey || hasVirtualKey)) {
		for (const key of ["apiKey", "virtualKey"] as const) {
			if (raw[key] !== undefined) {
				problems.push(`has auth.${key} beside auth.oauth; move it to auth.oauth.${key}`);
			}
		}
	}
	if (problems.length > 0) {
		return { problems };
	}

	if (hasOAuth) {
		const oauthProblems = parseOAuthForm(raw.oauth, fields);
		return oauthProblems.length > 0 ? { problems: oauthProblems } : { fields };
	}
	if (hasApiKey) {
		if (typeof raw.apiKey !== "string") {
			return { problems: ["has an auth.apiKey that is not a string"] };
		}
		const apiKey = usableString(raw.apiKey);
		if (apiKey !== undefined) {
			fields.apiKey = apiKey;
		}
	}
	if (hasVirtualKey) {
		// Alone it is the virtualKey form; beside apiKey it is that form's companion. The flat fields are identical -
		// primacy already decides the wire semantics.
		const virtualKey = parseVirtualKeyObject(raw.virtualKey, "auth.virtualKey");
		if ("problems" in virtualKey) {
			return virtualKey;
		}
		Object.assign(fields, virtualKey.fields);
	}
	return { fields };
}

function parseOAuthForm(raw: unknown, fields: FlatAuthFields): string[] {
	if (!isRecord(raw)) {
		return ["has an auth.oauth value that is not an object"];
	}
	const problems: string[] = [];
	const known = ["tokenUrl", "clientId", "clientSecret", "scopes", "apiKey", "virtualKey"];
	for (const key of Object.keys(raw)) {
		if (!known.includes(key)) {
			problems.push(`has an unknown auth.oauth key "${key}"`);
		}
	}
	const tokenUrl = typeof raw.tokenUrl === "string" ? usableString(raw.tokenUrl) : undefined;
	const clientId = typeof raw.clientId === "string" ? usableString(raw.clientId) : undefined;
	if (tokenUrl === undefined || clientId === undefined) {
		problems.push("has an incomplete auth.oauth (tokenUrl and clientId are required)");
	}
	for (const key of ["clientSecret", "scopes", "apiKey"] as const) {
		if (raw[key] !== undefined && typeof raw[key] !== "string") {
			problems.push(`has an auth.oauth.${key} that is not a string`);
		}
	}
	let companionVirtualKey: FlatAuthFields | undefined;
	if (raw.virtualKey !== undefined) {
		const virtualKey = parseVirtualKeyObject(raw.virtualKey, "auth.oauth.virtualKey");
		if ("problems" in virtualKey) {
			problems.push(...virtualKey.problems);
		} else {
			companionVirtualKey = virtualKey.fields;
		}
	}
	if (problems.length > 0 || tokenUrl === undefined || clientId === undefined) {
		return problems;
	}
	if (companionVirtualKey !== undefined) {
		Object.assign(fields, companionVirtualKey);
	}
	fields.oauthTokenUrl = tokenUrl;
	fields.oauthClientId = clientId;
	const clientSecret = usableString(raw.clientSecret);
	if (clientSecret !== undefined) {
		fields.oauthClientSecret = clientSecret;
	}
	const scopes = usableString(raw.scopes);
	if (scopes !== undefined) {
		fields.oauthScopes = scopes;
	}
	const companionApiKey = usableString(raw.apiKey);
	if (companionApiKey !== undefined) {
		fields.apiKey = companionApiKey;
	}
	return [];
}

/**
 * A virtualKey object (the form or a companion): the header name is required and must be sendable; the value is the
 * secret-capable half and may rest in SecretStorage, so its absence is legal. Returns the parsed flat fields or the
 * shape problems - never both, so no caller can act on a half-parsed object.
 */
function parseVirtualKeyObject(raw: unknown, path: string): { fields: FlatAuthFields } | { problems: string[] } {
	if (!isRecord(raw)) {
		return { problems: [`has a ${path} value that is not an object`] };
	}
	const problems: string[] = [];
	for (const key of Object.keys(raw)) {
		if (key !== "header" && key !== "value") {
			problems.push(`has an unknown ${path} key "${key}"`);
		}
	}
	const header = typeof raw.header === "string" ? usableString(raw.header) : undefined;
	if (header === undefined) {
		problems.push(`has a ${path} without a usable header name`);
	} else if (!HEADER_NAME_PATTERN.test(header)) {
		problems.push(`has a ${path} header that is not a valid HTTP header name`);
	}
	if (raw.value !== undefined && typeof raw.value !== "string") {
		problems.push(`has a ${path}.value that is not a string`);
	}
	if (problems.length > 0 || header === undefined) {
		return { problems };
	}
	const fields: FlatAuthFields = { virtualKeyHeader: header };
	const value = usableString(raw.value);
	if (value !== undefined) {
		fields.virtualKeyValue = value;
	}
	return { fields };
}

export function parseServersSetting(raw: unknown): { entries: DeclaredServer[]; problems: string[] } {
	if (raw === undefined || raw === null) {
		return { entries: [], problems: [] };
	}
	if (!Array.isArray(raw)) {
		return { entries: [], problems: ["the servers setting is not an array"] };
	}
	const problems: string[] = [];
	return { entries: acceptEntries(raw, problems).map(({ entry }) => entry), problems };
}

/**
 * One raw servers-setting entry's acceptance verdict, for the dashboard's Configuration diagnostics and its
 * Misconfigured rows: the same acceptEntries pass parseServersSetting runs, reported per entry. `label` and `baseUrl`
 * are present when the raw entry carries usable text for them (reserved labels stay absent - callers key map records on
 * labels); `problems` are the parser's structural reports without the "entry N " prefix.
 *
 *   `accepted` false with a usable label and baseUrl -> the misconfigured-entry row
 */
export interface ServerEntryReport {
	/** The entry's position in the raw array (0-based). */
	readonly index: number;
	readonly label?: string | undefined;
	readonly baseUrl?: string | undefined;
	readonly problems: readonly string[];
	readonly accepted: boolean;
}

/** A rejected entry with the identity a row or a join needs: both fields narrowed, so no call site defaults them. */
export type DrawableReject = ServerEntryReport & { readonly label: string; readonly baseUrl: string };

/**
 * The labels the setting carries outside an accepted entry (rejected siblings, duplicates of an accepted label): the
 * group ownership (dashboard/declaredJoin.ts) reads these so a group stamped with, or holding the key of, a label the
 * setting still carries is never external.
 */
export function rejectedCarrierLabels(entryReports: readonly ServerEntryReport[]): string[] {
	return entryReports.flatMap((report) => (report.accepted || report.label === undefined ? [] : [report.label]));
}

/**
 * The secret values a rejected carrier still carries inline, by label: the parser refused the entry whole, but the
 * values sit in the setting, so a group holding one is the label's leftover like a stored value makes it (the
 * group ownership's holder evidence). Read at the auth grammar's paths, strings only; a shape the grammar never
 * accepts carries nothing here.
 */
export function rejectedCarrierInlineSecrets(
	raw: unknown,
	entryReports: readonly ServerEntryReport[]
): ReadonlyMap<string, Readonly<Partial<Record<SecretFieldId, string>>>> {
	const inline = new Map<string, Readonly<Partial<Record<SecretFieldId, string>>>>();
	if (!Array.isArray(raw)) {
		return inline;
	}
	const stringAt = (value: unknown, path: readonly string[]): string | undefined => {
		let cursor: unknown = value;
		for (const key of path) {
			if (!isRecord(cursor)) {
				return undefined;
			}
			cursor = cursor[key];
		}
		return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
	};
	for (const report of entryReports) {
		if (report.accepted || report.label === undefined) {
			continue;
		}
		const auth = isRecord(raw[report.index]) ? (raw[report.index] as Record<string, unknown>).auth : undefined;
		const values: { -readonly [K in SecretFieldId]?: string } = {};
		const apiKey = stringAt(auth, ["apiKey"]) ?? stringAt(auth, ["oauth", "apiKey"]);
		const oauthClientSecret = stringAt(auth, ["oauth", "clientSecret"]);
		const virtualKeyValue = stringAt(auth, ["virtualKey", "value"]) ?? stringAt(auth, ["oauth", "virtualKey", "value"]);
		if (apiKey !== undefined) {
			values.apiKey = apiKey;
		}
		if (oauthClientSecret !== undefined) {
			values.oauthClientSecret = oauthClientSecret;
		}
		if (virtualKeyValue !== undefined) {
			values.virtualKeyValue = virtualKeyValue;
		}
		if (Object.keys(values).length > 0) {
			inline.set(report.label, { ...(inline.get(report.label) ?? {}), ...values });
		}
	}
	return inline;
}

/**
 * The rejected entries that stand for a label nothing accepted holds, one per label in setting order. A reject sits
 * in the setting, so it must show somewhere; without a label and a base URL it has no identity to show under.
 *
 *   state.ts rejectsWithOwnRow      -> draws the Misconfigured rows from this, and Configuration diagnostics drop
 *                                      exactly the problems those rows state
 *   rowBoundWrite.ts carriersOfRow  -> the row a removal or declare acts for, when no accepted entry holds the label
 */
export function drawableRejects(
	entryReports: readonly ServerEntryReport[],
	acceptedLabels: ReadonlySet<string>
): readonly DrawableReject[] {
	const drawn = new Set<string>();
	const rows: DrawableReject[] = [];
	for (const report of entryReports) {
		if (
			report.accepted ||
			report.label === undefined ||
			report.baseUrl === undefined ||
			acceptedLabels.has(report.label) ||
			drawn.has(report.label)
		) {
			continue;
		}
		drawn.add(report.label);
		rows.push({ ...report, label: report.label, baseUrl: report.baseUrl });
	}
	return rows;
}

export function serverSettingReports(raw: unknown): ServerEntryReport[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const reports: { index: number; label?: string; baseUrl?: string; problems: string[]; accepted: boolean }[] = raw.map(
		(item, index) => {
			const record = isRecord(item) ? item : undefined;
			const label = record !== undefined ? usableString(record.label) : undefined;
			const baseUrl = record !== undefined ? usableString(record.baseUrl) : undefined;
			return {
				index,
				...(label !== undefined && !isUnsafeRecordKey(label) ? { label } : {}),
				...(baseUrl !== undefined ? { baseUrl } : {}),
				problems: [],
				accepted: false,
			};
		}
	);
	const accepted = acceptEntries(raw, undefined, (index, what) => {
		reports[index]?.problems.push(what);
	});
	for (const { index } of accepted) {
		const report = reports[index];
		if (report !== undefined) {
			report.accepted = true;
		}
	}
	return reports;
}

/** Unknown tokens are counted in the report, never echoed - they are user text. */
function knownTokens<T extends string>(
	raw: unknown,
	isKnown: (value: unknown) => value is T,
	field: string,
	report: (what: string) => void
): T[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const known = raw.filter(isKnown);
	if (known.length < raw.length) {
		report(`lists ${raw.length - known.length} unknown discovery.${field} value(s), ignored`);
	}
	return [...new Set(known)];
}

/**
 * The accepted entries with their raw-array indices: the single place the acceptance rules live, so
 * parseServersSetting and acceptedEntry cannot disagree about which raw entry a label resolves to.
 */
function acceptEntries(
	raw: readonly unknown[],
	problems?: string[],
	reportTo?: (index: number, what: string) => void
): { index: number; entry: DeclaredServer }[] {
	const accepted: { index: number; entry: DeclaredServer }[] = [];
	const seen = new Set<string>();
	raw.forEach((item: unknown, index) => {
		// One prefix for everything reported about this entry: the problems are logged, so they reference the entry by
		// index and structural key names only, never by entered values.
		const report = (what: string) => {
			problems?.push(`entry ${index + 1} ${what}`);
			reportTo?.(index, what);
		};
		if (!isRecord(item)) {
			report("is not an object");
			return;
		}
		const record = item;
		const label = usableString(record.label);
		const baseUrl = usableString(record.baseUrl);
		if (label === undefined || baseUrl === undefined) {
			report("is missing a label or baseUrl");
			return;
		}
		if (isUnsafeRecordKey(label)) {
			report("uses a reserved label");
			return;
		}
		if (seen.has(label)) {
			report("repeats an earlier entry's label; the first entry wins");
			return;
		}
		seen.add(label);

		//   Auth shape errors -> make the whole entry misconfigured
		//   still PRESENT - rawDeclaredLabels keeps its label -> no removal is inferred and its group is not hidden
		const auth = parseAuth(record.auth);
		if ("problems" in auth) {
			for (const problem of auth.problems) {
				report(problem);
			}
			report("is misconfigured and will not be used until its auth is fixed");
			return;
		}

		const entry: {
			label: string;
			baseUrl: string;
		} & MutableEntryViewFields &
			FlatAuthFields = {
			label,
			baseUrl,
			...auth.fields,
		};

		// "" is a real value (append nothing to the base URL), so this cannot funnel through usableString, which erases
		// it. Like budget, a malformed value is a diagnostic and is ignored; the entry stays usable.
		if (record.apiVersion !== undefined) {
			if (typeof record.apiVersion !== "string") {
				report("has an apiVersion that is not a string, ignored");
			} else {
				entry.apiVersion = record.apiVersion.trim();
			}
		}

		if (record.headers !== undefined) {
			// Header names are structural configuration (the same class the request-path narrowing logs); values never
			// enter the report.
			const headers = normalizeCustomHeaders(record.headers, (message, data) => {
				const name = isRecord(data) && typeof data.name === "string" ? ` ("${data.name}")` : "";
				report(`headers: ${message}${name}`);
			});
			if (Object.keys(headers).length > 0) {
				entry.headers = headers;
			}
		}

		// The models records are lenient like the global settings' own normalization: non-record values and malformed
		// sub-entries drop silently, and an empty result reads as absent. The capability vocabulary is enforced
		// downstream by parseCapabilityRecord.
		if (record.models !== undefined && !isRecord(record.models)) {
			report("has a models value that is not an object, ignored");
		} else if (isRecord(record.models)) {
			// Named on purpose, like the unknown auth keys: a typo silently reading as "no per-entry records" would be
			// invisible.
			for (const key of Object.keys(record.models)) {
				if (key !== "parameters" && key !== "capabilities") {
					report(`has an unknown models key "${key}", ignored`);
				}
			}
			const modelParameters = normalizeModelParameters(record.models.parameters);
			if (Object.keys(modelParameters).length > 0) {
				entry.modelParameters = modelParameters;
			}
			const modelCapabilities = normalizeModelCapabilities(record.models.capabilities);
			if (Object.keys(modelCapabilities).length > 0) {
				entry.modelCapabilities = modelCapabilities;
			}
		}

		if (record.discovery !== undefined && !isRecord(record.discovery)) {
			report("has a discovery value that is not an object, ignored");
		} else if (isRecord(record.discovery)) {
			const discovery = record.discovery;
			// Named on purpose: a typo silently reading as "no expected failures", "nothing declared", or "nothing
			// included" would be invisible.
			for (const key of Object.keys(discovery)) {
				if (key !== "expectedFailures" && key !== "declared" && key !== "includeModes") {
					report(`has an unknown discovery key "${key}", ignored`);
				}
			}
			const expectedFailures = knownTokens(
				discovery.expectedFailures,
				isExpectedFailureCategory,
				"expectedFailures",
				report
			);
			if (expectedFailures.length > 0) {
				entry.expectedFailures = expectedFailures;
			}
			if (Array.isArray(discovery.declared)) {
				const ids = discovery.declared.map(usableString).filter((id): id is string => id !== undefined);
				if (ids.length < discovery.declared.length) {
					const dropped = discovery.declared.length - ids.length;
					report(`lists ${dropped} unusable discovery.declared value(s), ignored`);
				}
				const unique = [...new Set(ids)];
				if (unique.length > 0) {
					entry.declaredModels = unique;
				}
			}
			const includeModes = knownTokens(discovery.includeModes, isNonChatMode, "includeModes", report);
			if (includeModes.length > 0) {
				entry.includeModes = includeModes;
			}
		}

		if (record.budget !== undefined) {
			const budget = usableBudget(record.budget);
			if (budget === undefined) {
				report("has a budget that is not a number greater than 0, ignored");
			} else {
				entry.budget = budget;
			}
		}

		if (record.mcp !== undefined) {
			const mcp = parseMcpOptIn(record.mcp, report);
			if (mcp !== undefined) {
				entry.mcp = mcp;
			}
		}
		accepted.push({ index, entry });
	});
	return accepted;
}

/**
 * The dashboard's per-entry reads and writes resolve through this so they act on exactly the entry the dashboard row
 * describes: a rejected same-label sibling earlier in the array cannot shadow the accepted entry, and a label the
 * parser rejects outright resolves to nothing.
 */
export function acceptedEntry(raw: unknown, label: string): { index: number; entry: DeclaredServer } | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const wanted = label.trim();
	return acceptEntries(raw).find(({ entry }) => entry.label === wanted);
}

/**
 * The removal detector reads this because "the user removed the entry" and "the entry is present but momentarily
 * malformed" must never be confused - a tombstone written for the latter would suppress a group the user did not
 * remove. Reserved labels stay out: the parser rejects them permanently, and the caller carries map records under these
 * labels.
 */
export function rawDeclaredLabels(raw: unknown): Set<string> {
	if (!Array.isArray(raw)) {
		return new Set();
	}
	const labels = new Set<string>();
	for (const item of raw) {
		if (isRecord(item) && typeof item.label === "string") {
			const label = item.label.trim();
			if (label.length > 0 && !isUnsafeRecordKey(label)) {
				labels.add(label);
			}
		}
	}
	return labels;
}

export function declaredEntryLabel(rawEntry: unknown): string | undefined {
	const [label] = rawDeclaredLabels([rawEntry]);
	return label;
}

/**
 * Presence rather than acceptance, so a mid-edit malformed entry stays declared and "the user removed it" is
 * never confused with "this pass could not accept it".
 *
 *   []                            -> a real "remove everything"
 *   the setting declares an array schema with a [] default -> a real "remove everything"
 *   undefined, null, or non-array -> a mid-edit or partial state that proves nothing
 *   a mid-edit or partial state that proves nothing -> every label reads as present
 */
export function stillDeclaredIn(raw: unknown): (label: string) => boolean {
	if (!Array.isArray(raw)) {
		return () => true;
	}
	const labels = rawDeclaredLabels(raw);
	return (label) => labels.has(label);
}

/**
 * Label plus base URL under the shared normalization, credentials deliberately playing no part, so a
 * hand-labeled native group at the entry's URL resolves while a same-label group at another URL gets only the
 * global settings. entryCredentials.ts's overlay resolver must match by this exact rule, the one headers,
 * parameters, and capabilities resolve by.
 */
export function matchedEntryFor(raw: unknown, label: string, baseUrl: string): DeclaredServer | undefined {
	const match = acceptedEntry(raw, label);
	if (match === undefined || !sameGroupIdentity(match.entry, { label, baseUrl })) {
		return undefined;
	}
	return match.entry;
}

/**
 * A LABELED live group carrying an entry's label at another URL is that entry's superseded leftover, because
 * the add-only host kept the old connection when the entry was re-pointed and one label cannot honestly name
 * two servers. The provider (entrySupersedingBaseUrl, over the live setting) and the dashboard (state.ts, over the
 * engine's declared views) hide groups through this one rule; matchedEntryFor is its complement.
 */
export function supersedingBaseUrl(
	declared: readonly { readonly label: string; readonly baseUrl: string }[],
	label: string,
	baseUrl: string
): string | undefined {
	const entry = declared.find((candidate) => candidate.label === label);
	if (entry === undefined) {
		return undefined;
	}
	const declaredUrl = normalizeBaseUrl(entry.baseUrl);
	return declaredUrl === normalizeBaseUrl(baseUrl) ? undefined : declaredUrl;
}

export function entrySupersedingBaseUrl(raw: unknown, label: string, baseUrl: string): string | undefined {
	const match = acceptedEntry(raw, label);
	return match === undefined ? undefined : supersedingBaseUrl([match.entry], label, baseUrl);
}

export function entryModelParametersFor(
	raw: unknown,
	label: string,
	baseUrl: string
): EntryModelParameters | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.modelParameters;
}

export function entryModelCapabilitiesFor(
	raw: unknown,
	label: string,
	baseUrl: string
): EntryModelCapabilities | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.modelCapabilities;
}

export function entryExpectedFailuresFor(
	raw: unknown,
	label: string,
	baseUrl: string
): readonly ExpectedFailureCategory[] | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.expectedFailures;
}

export function entryIncludeModesFor(raw: unknown, label: string, baseUrl: string): readonly NonChatMode[] | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.includeModes;
}

export function entryHeadersFor(
	raw: unknown,
	label: string,
	baseUrl: string
): Readonly<Record<string, string>> | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.headers;
}

/**
 *   the entry sets the empty override (append nothing) -> returns ""
 */
export function entryApiVersionFor(raw: unknown, label: string, baseUrl: string): string | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.apiVersion;
}

export function entryDeclaredModelsFor(raw: unknown, label: string, baseUrl: string): readonly string[] | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.declaredModels;
}
