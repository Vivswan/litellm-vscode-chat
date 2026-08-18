/**
 * Parsing the litellm-vscode-chat.servers setting: the acceptance rules for
 * declared entries live here and nowhere else.
 *
 * The settings shape is nested (auth / headers / models / discovery / budget);
 * the parsed DeclaredServer keeps the flat credential fields the rest of the
 * extension consumes, so the wire shape of the provider-group args - and with
 * it every stored sync fingerprint - is unchanged by the restructure.
 *
 * Auth grammar: exactly one form per entry, ranked oauth > apiKey >
 * virtualKey. A form may carry companions of strictly lower primacy only:
 * `oauth` nests optional `apiKey` and `virtualKey` companions inside its own
 * object; the string `apiKey` form may carry a sibling `virtualKey`
 * companion; `virtualKey` alone carries none. Shape errors (a second form
 * beside oauth, an oauth missing tokenUrl or clientId, an unknown key inside
 * auth) make the entry MISCONFIGURED: reported and skipped, never guessed
 * at. A form merely missing its secret VALUE is not misconfiguration - the
 * entry works and the server's 401 tells the story.
 */

import type { ModelCapabilitiesRecord } from "../../../shared/config/capabilityResolution";
import {
	normalizeCustomHeaders,
	normalizeModelCapabilities,
	normalizeModelParameters,
} from "../../../shared/config/settings";
import type { ExpectedFailureCategory, OptionalEntryFieldId, OptionalEntryFields } from "../../../shared/serverEntry";
import { isExpectedFailureCategory } from "../../../shared/serverEntry";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { HEADER_NAME_PATTERN } from "../../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";

/** An entry's per-entry models.parameters record: model matcher to request parameters, like the global setting. */
export type EntryModelParameters = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** An entry's per-entry models.capabilities record: model matcher to capability record, like the global setting. */
export type EntryModelCapabilities = ModelCapabilitiesRecord;

/**
 * One parsed servers-setting entry: label and baseUrl usable, credential fields
 * flattened from the entry's `auth` object (present only with usable inline
 * text; values resting in SecretStorage stay absent here and resolve at
 * group-args time). The remaining optional fields are present only when the raw
 * entry carries usable content; they are read extension-side and never enter
 * the group configuration or its fingerprint.
 */
export type DeclaredServer = {
	readonly label: string;
	readonly baseUrl: string;
	/**
	 * What apiRootOf appends to the base URL: absent means auto (keep a version
	 * segment already in the URL, else /v1), "" means append nothing. Resolved
	 * into the transport per request, like headers; never part of the group
	 * configuration.
	 */
	readonly apiVersion?: string;
	/** The entry's custom HTTP headers, sent on every request to this server; auth headers win conflicts. */
	readonly headers?: Readonly<Record<string, string>>;
	readonly modelParameters?: EntryModelParameters;
	readonly modelCapabilities?: EntryModelCapabilities;
	readonly expectedFailures?: readonly ExpectedFailureCategory[];
	/** Exact model IDs to register when discovery does not list them (discovery.declared). */
	readonly declaredModels?: readonly string[];
	/** The entry's manual usage budget in USD (non-secret user configuration); the usage surfaces read it. */
	readonly budget?: number;
} & OptionalEntryFields;

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

/** The flat credential fields an entry's auth object parses to; every value is usable inline text. */
type FlatAuthFields = { -readonly [K in OptionalEntryFieldId]?: string };

/**
 * Parse one entry's `auth` object into the flat credential fields, or the shape
 * problems that make the entry misconfigured. Key names in the problems are the
 * closed auth vocabulary or the user's own structural keys; entered VALUES
 * never appear.
 */
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
			// Named on purpose: a typo silently reading as "no auth" would be the
			// worst failure mode. Key names only, never values.
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
		// Alone it is the virtualKey form; beside apiKey it is that form's
		// companion. The flat fields are identical - primacy already decides the
		// wire semantics.
		const virtualKey = parseVirtualKeyObject(raw.virtualKey, "auth.virtualKey");
		if ("problems" in virtualKey) {
			return virtualKey;
		}
		Object.assign(fields, virtualKey.fields);
	}
	return { fields };
}

/** The oauth form: tokenUrl and clientId make the unit; clientSecret, scopes, and the companions are optional. */
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
 * A virtualKey object (the form or a companion): the header name is required
 * and must be sendable; the value is the secret-capable half and may rest in
 * SecretStorage, so its absence is legal. Returns the parsed flat fields or the
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

/**
 * Parse the raw setting value. Entries without a usable label or baseUrl, with
 * a reserved label, with a label an earlier entry already used, or with a
 * misconfigured auth object are skipped and reported.
 */
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
 * One raw servers-setting entry's acceptance verdict, for the dashboard's
 * Configuration diagnostics and its Misconfigured rows: the same acceptEntries
 * pass parseServersSetting runs, reported per entry. `label` and `baseUrl` are
 * present when the raw entry carries usable text for them (reserved labels stay
 * absent - callers key map records on labels); `problems` are the parser's
 * structural reports without the "entry N " prefix. `accepted` false with a
 * usable label and baseUrl is the misconfigured-entry row.
 */
export interface ServerEntryReport {
	/** The entry's position in the raw array (0-based). */
	readonly index: number;
	readonly label?: string | undefined;
	readonly baseUrl?: string | undefined;
	readonly problems: readonly string[];
	readonly accepted: boolean;
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

/**
 * The accepted entries with their raw-array indices: the single place the
 * acceptance rules live, so parseServersSetting and acceptedEntry cannot
 * disagree about which raw entry a label resolves to.
 */
function acceptEntries(
	raw: readonly unknown[],
	problems?: string[],
	reportTo?: (index: number, what: string) => void
): { index: number; entry: DeclaredServer }[] {
	const accepted: { index: number; entry: DeclaredServer }[] = [];
	const seen = new Set<string>();
	raw.forEach((item: unknown, index) => {
		// One prefix for everything reported about this entry: the problems are
		// logged, so they reference the entry by index and structural key names
		// only, never by entered values.
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

		// Auth shape errors make the whole entry misconfigured: skipped (never
		// synced or served) and reported, but still PRESENT - rawDeclaredLabels
		// keeps its label, so no removal is inferred and its group is not hidden.
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
			apiVersion?: string;
			headers?: Readonly<Record<string, string>>;
			modelParameters?: EntryModelParameters;
			modelCapabilities?: EntryModelCapabilities;
			expectedFailures?: readonly ExpectedFailureCategory[];
			declaredModels?: readonly string[];
			budget?: number;
		} & FlatAuthFields = {
			label,
			baseUrl,
			...auth.fields,
		};

		// "" is a real value (append nothing to the base URL), so this cannot
		// funnel through usableString, which erases it. Like budget, a malformed
		// value is a diagnostic and is ignored; the entry stays usable.
		if (record.apiVersion !== undefined) {
			if (typeof record.apiVersion !== "string") {
				report("has an apiVersion that is not a string, ignored");
			} else {
				entry.apiVersion = record.apiVersion.trim();
			}
		}

		if (record.headers !== undefined) {
			// Header names are structural configuration (the same class the
			// request-path narrowing logs); values never enter the report.
			const headers = normalizeCustomHeaders(record.headers, (message, data) => {
				const name = isRecord(data) && typeof data.name === "string" ? ` ("${data.name}")` : "";
				report(`headers: ${message}${name}`);
			});
			if (Object.keys(headers).length > 0) {
				entry.headers = headers;
			}
		}

		// The models records are lenient like the global settings' own
		// normalization: non-record values and malformed sub-entries drop
		// silently, and an empty result reads as absent. The capability vocabulary
		// is enforced downstream by parseCapabilityRecord.
		if (record.models !== undefined && !isRecord(record.models)) {
			report("has a models value that is not an object, ignored");
		} else if (isRecord(record.models)) {
			// Named on purpose, like the unknown auth keys: a typo silently reading
			// as "no per-entry records" would be invisible.
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
			// Named on purpose: a typo silently reading as "no expected failures" or
			// "nothing declared" would be invisible.
			for (const key of Object.keys(discovery)) {
				if (key !== "expectedFailures" && key !== "declared") {
					report(`has an unknown discovery key "${key}", ignored`);
				}
			}
			if (Array.isArray(discovery.expectedFailures)) {
				const knownCategories = discovery.expectedFailures.filter(isExpectedFailureCategory);
				if (knownCategories.length < discovery.expectedFailures.length) {
					// Counted, never echoed: unknown tokens are user text.
					const unknownCount = discovery.expectedFailures.length - knownCategories.length;
					report(`lists ${unknownCount} unknown discovery.expectedFailures value(s), ignored`);
				}
				const categories = [...new Set(knownCategories)];
				if (categories.length > 0) {
					entry.expectedFailures = categories;
				}
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
		}

		// An invalid budget is a diagnostic and is ignored; the entry itself stays
		// usable (it is not auth).
		if (record.budget !== undefined) {
			const budget = usableBudget(record.budget);
			if (budget === undefined) {
				report("has a budget that is not a number greater than 0, ignored");
			} else {
				entry.budget = budget;
			}
		}
		accepted.push({ index, entry });
	});
	return accepted;
}

/**
 * The entry parseServersSetting accepts for `label`, with its raw-array index,
 * or undefined when it accepts none. The dashboard's per-entry reads and writes
 * resolve through this so they act on exactly the entry the dashboard row
 * describes: a rejected same-label sibling earlier in the array cannot shadow
 * the accepted entry, and a label the parser rejects outright resolves to
 * nothing. The returned entry is the parsed view - usable fields only, trimmed.
 */
export function acceptedEntry(raw: unknown, label: string): { index: number; entry: DeclaredServer } | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const wanted = label.trim();
	return acceptEntries(raw).find(({ entry }) => entry.label === wanted);
}

/**
 * Every label the raw setting still CARRIES, acceptance aside: any object entry
 * with a usable label string counts, even one the parser would reject. The
 * removal detector reads this because "the user removed the entry" and "the
 * entry is present but momentarily malformed" must never be confused - a
 * tombstone written for the latter would suppress a group the user did not
 * remove. Reserved labels stay out: the parser rejects them permanently, and
 * the caller carries map records under these labels.
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

/** The label the sync side would keep for one raw entry (rawDeclaredLabels' rule, per element), or undefined. */
export function declaredEntryLabel(rawEntry: unknown): string | undefined {
	const [label] = rawDeclaredLabels([rawEntry]);
	return label;
}

/**
 * The still-declared predicate every removal decision shares (the sync
 * engine's removal detector and the usage poller's prunes): a label is still
 * declared while ANY raw entry carries it, acceptance aside, so a mid-edit
 * malformed entry stays present - "the user removed the entry" and "this pass
 * could not accept it" must never be confused. Removal proof also needs the
 * CONTAINER to be currently valid, and only an array is: the setting declares
 * an array schema with a [] default, so a real "remove everything" arrives as
 * an empty array, while an undefined, null, or otherwise non-array value is a
 * malformed or partial state that proves nothing about any label - everything
 * reads as present.
 */
export function stillDeclaredIn(raw: unknown): (label: string) => boolean {
	if (!Array.isArray(raw)) {
		return () => true;
	}
	const labels = rawDeclaredLabels(raw);
	return (label) => labels.has(label);
}

/**
 * The declared entry the extension-side per-entry reads resolve against: the
 * entry acceptedEntry resolves for `label`, and only when that entry also
 * declares the server the request or refresh is routed to (base URLs compared
 * under the shared normalization). The match is label plus URL - credentials
 * deliberately play no part - so any group carrying the entry's label at the
 * entry's URL resolves, a hand-labeled native group included. A same-label
 * group at another URL proves nothing about the connection: it resolves to
 * nothing and gets only the global settings.
 */
function matchedEntryFor(raw: unknown, label: string, baseUrl: string): DeclaredServer | undefined {
	const match = acceptedEntry(raw, label);
	if (match === undefined || normalizeBaseUrl(match.entry.baseUrl) !== normalizeBaseUrl(baseUrl)) {
		return undefined;
	}
	return match.entry;
}

/** The request path's resolution of one declared entry's per-entry models.parameters; see matchedEntryFor. */
export function entryModelParametersFor(
	raw: unknown,
	label: string,
	baseUrl: string
): EntryModelParameters | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.modelParameters;
}

/** The registration path's resolution of one declared entry's per-entry models.capabilities; see matchedEntryFor. */
export function entryModelCapabilitiesFor(
	raw: unknown,
	label: string,
	baseUrl: string
): EntryModelCapabilities | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.modelCapabilities;
}

/** The discovery path's resolution of one declared entry's expectedFailures; see matchedEntryFor. */
export function entryExpectedFailuresFor(
	raw: unknown,
	label: string,
	baseUrl: string
): readonly ExpectedFailureCategory[] | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.expectedFailures;
}

/** The request and discovery paths' resolution of one declared entry's custom headers; see matchedEntryFor. */
export function entryHeadersFor(
	raw: unknown,
	label: string,
	baseUrl: string
): Readonly<Record<string, string>> | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.headers;
}

/**
 * The request and discovery paths' resolution of one declared entry's
 * apiVersion override; see matchedEntryFor. Returns "" when the entry sets
 * the empty override (append nothing), undefined only when absent.
 */
export function entryApiVersionFor(raw: unknown, label: string, baseUrl: string): string | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.apiVersion;
}

/** The registration path's resolution of one declared entry's discovery.declared list; see matchedEntryFor. */
export function entryDeclaredModelsFor(raw: unknown, label: string, baseUrl: string): readonly string[] | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.declaredModels;
}
