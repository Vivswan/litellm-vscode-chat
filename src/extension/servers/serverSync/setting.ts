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

import type { RecordShapeReport } from "../../../shared/config/settings";
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
} from "../../../shared/serverEntry";
import {
	isExpectedFailureCategory,
	isNonChatMode,
	NON_SECRET_OPTIONAL_FIELD_IDS,
	SECRET_FIELD_IDS,
	SECRET_FIELD_NESTED_PATHS,
} from "../../../shared/serverEntry";
import { canonicalBaseUrl, canonicalUrl, normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { HEADER_NAME_PATTERN, isHeaderScalar, trimHttpWhitespace, usableHttpText } from "../../../shared/util/headers";
import { isRecord, isUnsafeRecordKey, objectSlot } from "../../../shared/util/json";
import type { CollectableEntry } from "../../../shared/util/knownSecrets";
import { sameGroupIdentity } from "../groupRemovals";

export type EntryModelParameters = EntryViewFieldValues["modelParameters"];

export type EntryModelCapabilities = EntryViewFieldValues["modelCapabilities"];

/**
 * One parsed servers-setting entry: label and baseUrl usable, credential fields flattened from the entry's `auth`
 * object (present only with usable inline text; values resting in SecretStorage stay absent here and resolve at
 * group-args time). The remaining optional fields are the shared registry's EntryViewFields (present only when the raw
 * entry carries usable content); they are read extension-side and never enter the group configuration or its
 * fingerprint. Every URL field holds its one spelling (shared/util/baseUrl.ts canonicalUrl), so no reader of an entry
 * compares or scrubs spellings.
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

/**
 * How an entry report spells a wrong-shaped slot (the judgment itself is objectSlot); what the shape costs is the
 * slot's policy, and the sentence says so.
 *
 *   ignored  -> the slot reads as absent and the entry stays usable (models, discovery, mcp)
 *   rejects  -> the caller returns its problems; a wrong-shaped auth form has no repair
 */
function notAnObject(noun: string, policy: "ignored" | "rejects", legalShapes = "an object"): string {
	return `has ${noun} that is not ${legalShapes}${policy === "ignored" ? ", ignored" : ""}`;
}

function listSlot(value: unknown, path: string, report: (what: string) => void): readonly unknown[] | undefined {
	if (value === undefined || Array.isArray(value)) {
		return value;
	}
	report(`has a ${path} value that is not a list, ignored`);
	return undefined;
}

function optionalSlot(
	value: unknown,
	path: string,
	report: (what: string) => void
): Record<string, unknown> | undefined {
	return value === undefined ? undefined : objectSlot(value, notAnObject(`a ${path} value`, "ignored"), report);
}

/** An entry's manual usage budget in USD: finite and above zero (a zero budget could only read as fully spent). */
function usableBudget(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The URL is read in its one spelling (canonicalUrl); the http(s) shape is the dashboard write path's rule, exactly
 * as for `baseUrl`.
 *
 *   `false` opts out                       -> an explicit off switch, not a mistake, so it reports nothing
 *   a `url` with no canonical spelling     -> reported, and nothing is published; the chat entry stays usable
 *   a `url` of the wrong type, a blank one -> the derived endpoint, like `true`
 */
function parseMcpOptIn(raw: unknown, report: (what: string) => void): McpOptIn | undefined {
	if (raw === true) {
		return true;
	}
	if (raw === false) {
		return undefined;
	}
	const mcp = objectSlot(raw, notAnObject("an mcp value", "ignored", "true, false, or an object"), report);
	if (mcp === undefined) {
		return undefined;
	}
	// Named on purpose, like the unknown auth and discovery keys: a typo silently reading as "the default endpoint"
	// would be invisible.
	for (const key of Object.keys(mcp)) {
		if (key !== "url") {
			report(`has an unknown mcp key "${key}", ignored`);
		}
	}
	if (mcp.url !== undefined && typeof mcp.url !== "string") {
		report("has an mcp.url that is not a string, ignored");
		return true;
	}
	const text = usableHttpText(mcp.url);
	if (text === undefined) {
		return true;
	}
	const url = canonicalUrl(text);
	if (url === undefined) {
		report("has an mcp.url that is not a URL with a host; no MCP server is published for this entry");
		return undefined;
	}
	return { url };
}

type FlatAuthFields = { -readonly [K in OptionalEntryFieldId]?: string };

function parseAuth(raw: unknown): { fields: FlatAuthFields } | { problems: string[] } {
	const fields: FlatAuthFields = {};
	if (raw === undefined) {
		return { fields };
	}
	const problems: string[] = [];
	const auth = objectSlot(raw, notAnObject("an auth value", "rejects"), (what) => problems.push(what));
	if (auth === undefined) {
		return { problems };
	}
	const keys = Object.keys(auth);
	const known = ["apiKey", "oauth", "virtualKey"];
	for (const key of keys) {
		if (!known.includes(key)) {
			// Named on purpose: a typo silently reading as "no auth" would be the worst failure mode.
			problems.push(`has an unknown auth key "${key}"`);
		}
	}
	const hasOAuth = auth.oauth !== undefined;
	const hasApiKey = auth.apiKey !== undefined;
	const hasVirtualKey = auth.virtualKey !== undefined;
	if (!hasOAuth && !hasApiKey && !hasVirtualKey && problems.length === 0) {
		problems.push("has an auth object that configures no form (expected one of apiKey, oauth, virtualKey)");
	}
	if (hasOAuth && (hasApiKey || hasVirtualKey)) {
		for (const key of ["apiKey", "virtualKey"] as const) {
			if (auth[key] !== undefined) {
				problems.push(`has auth.${key} beside auth.oauth; move it to auth.oauth.${key}`);
			}
		}
	}
	if (problems.length > 0) {
		return { problems };
	}

	if (hasOAuth) {
		const oauthProblems = parseOAuthForm(auth.oauth, fields);
		if (oauthProblems.length > 0) {
			return { problems: oauthProblems };
		}
		assignNestedSecrets(auth, fields);
		return { fields };
	}
	if (hasApiKey && typeof auth.apiKey !== "string") {
		return { problems: ["has an auth.apiKey that is not a string"] };
	}
	if (hasVirtualKey) {
		// Alone it is the virtualKey form; beside apiKey it is that form's companion. The flat fields are identical -
		// primacy already decides the wire semantics.
		const virtualKey = parseVirtualKeyObject(auth.virtualKey, "auth.virtualKey");
		if ("problems" in virtualKey) {
			return virtualKey;
		}
		Object.assign(fields, virtualKey.fields);
	}
	assignNestedSecrets(auth, fields);
	return { fields };
}

function valueAt(root: unknown, path: readonly string[]): unknown {
	let node = root;
	for (const segment of path) {
		node = isRecord(node) ? node[segment] : undefined;
	}
	return node;
}

/** The secret values at the table's nested positions (SECRET_FIELD_NESTED_PATHS), usable text only. */
function assignNestedSecrets(auth: Readonly<Record<string, unknown>>, fields: FlatAuthFields): void {
	for (const field of SECRET_FIELD_IDS) {
		for (const path of SECRET_FIELD_NESTED_PATHS[field]) {
			// The first segment is "auth", the object in hand.
			const value = usableHttpText(valueAt(auth, path.slice(1)));
			if (value !== undefined) {
				fields[field] = value;
			}
		}
	}
}

/**
 * The collectable view of EVERY raw record, over-inclusive by design: every string at every secret position is a
 * value, the one the parser selects and the ones it passes over, in an entry it accepts or rejects (an auth conflict,
 * a bad URL), since a line can quote any of them. SECRET_FIELD_NESTED_PATHS stays the one table of the positions.
 *   URL fields    -> baseUrl, the flat and the nested token URL, mcp.url
 *   secret values -> every flat secret field and every nested position of the table
 *   headers       -> every raw header entry with a scalar value, the normalizer's rejections included
 *   carriers      -> the flat virtualKeyHeader and the header beside each nested virtual-key value
 */
export function collectableEntries(raw: unknown): CollectableEntry[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const strings = (values: readonly unknown[]): string[] =>
		values.map(usableHttpText).filter((value): value is string => value !== undefined);
	return raw.filter(isRecord).map((record) => {
		// A null prototype: a raw header named "__proto__" must become an own entry, not reach the inherited setter.
		const headers: Record<string, string> = Object.create(null);
		if (isRecord(record.headers)) {
			for (const [name, value] of Object.entries(record.headers)) {
				if (isHeaderScalar(value)) {
					headers[name] = String(value);
				}
			}
		}
		return {
			urls: strings([
				record.baseUrl,
				record.oauthTokenUrl,
				valueAt(record, ["auth", "oauth", "tokenUrl"]),
				valueAt(record, ["mcp", "url"]),
			]),
			secrets: strings(
				SECRET_FIELD_IDS.flatMap((id) => [
					record[id],
					...SECRET_FIELD_NESTED_PATHS[id].map((path) => valueAt(record, path)),
				])
			),
			headers,
			carriers: strings([
				record.virtualKeyHeader,
				...SECRET_FIELD_NESTED_PATHS.virtualKeyValue.map((path) => valueAt(record, [...path.slice(0, -1), "header"])),
			]),
		};
	});
}

function parseOAuthForm(raw: unknown, fields: FlatAuthFields): string[] {
	const problems: string[] = [];
	const form = objectSlot(raw, notAnObject("an auth.oauth value", "rejects"), (what) => problems.push(what));
	if (form === undefined) {
		return problems;
	}
	const known = ["tokenUrl", "clientId", "clientSecret", "scopes", "apiKey", "virtualKey"];
	for (const key of Object.keys(form)) {
		if (!known.includes(key)) {
			problems.push(`has an unknown auth.oauth key "${key}"`);
		}
	}
	const tokenUrlText = typeof form.tokenUrl === "string" ? usableHttpText(form.tokenUrl) : undefined;
	const clientId = typeof form.clientId === "string" ? usableHttpText(form.clientId) : undefined;
	if (tokenUrlText === undefined || clientId === undefined) {
		problems.push("has an incomplete auth.oauth (tokenUrl and clientId are required)");
	}
	const tokenUrl = tokenUrlText === undefined ? undefined : canonicalUrl(tokenUrlText);
	if (tokenUrlText !== undefined && tokenUrl === undefined) {
		problems.push("has an auth.oauth.tokenUrl that is not a URL with a host");
	}
	for (const key of ["clientSecret", "scopes", "apiKey"] as const) {
		if (form[key] !== undefined && typeof form[key] !== "string") {
			problems.push(`has an auth.oauth.${key} that is not a string`);
		}
	}
	let companionVirtualKey: FlatAuthFields | undefined;
	if (form.virtualKey !== undefined) {
		const virtualKey = parseVirtualKeyObject(form.virtualKey, "auth.oauth.virtualKey");
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
	const scopes = usableHttpText(form.scopes);
	if (scopes !== undefined) {
		fields.oauthScopes = scopes;
	}
	// The secret values (clientSecret, the companion apiKey) are assigned from the table by the caller.
	return [];
}

/**
 * A virtualKey object (the form or a companion): the header name is required and must be sendable; the value is the
 * secret-capable half and may rest in SecretStorage, so its absence is legal. Returns the parsed flat fields or the
 * shape problems - never both, so no caller can act on a half-parsed object.
 */
function parseVirtualKeyObject(raw: unknown, path: string): { fields: FlatAuthFields } | { problems: string[] } {
	const problems: string[] = [];
	const object = objectSlot(raw, notAnObject(`an ${path} value`, "rejects"), (what) => problems.push(what));
	if (object === undefined) {
		return { problems };
	}
	for (const key of Object.keys(object)) {
		if (key !== "header" && key !== "value") {
			problems.push(`has an unknown ${path} key "${key}"`);
		}
	}
	const header = typeof object.header === "string" ? usableHttpText(object.header) : undefined;
	if (header === undefined) {
		problems.push(`has a ${path} without a usable header name`);
	} else if (!HEADER_NAME_PATTERN.test(header)) {
		problems.push(`has a ${path} header that is not a valid HTTP header name`);
	}
	if (object.value !== undefined && typeof object.value !== "string") {
		problems.push(`has a ${path}.value that is not a string`);
	}
	if (problems.length > 0 || header === undefined) {
		return { problems };
	}
	// The value is assigned from the table by the caller.
	return { fields: { virtualKeyHeader: header } };
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
 * values sit in the setting, so a group holding one is the label's leftover like a stored value makes it (the group
 * ownership's holder evidence). Read at every flat secret field and every nested position of the one table the
 * parser assigns through (SECRET_FIELD_NESTED_PATHS), like collectableEntries.
 */
export function rejectedCarrierInlineSecrets(
	raw: unknown,
	entryReports: readonly ServerEntryReport[]
): ReadonlyMap<string, readonly string[]> {
	const inline = new Map<string, readonly string[]>();
	if (!Array.isArray(raw)) {
		return inline;
	}
	for (const report of entryReports) {
		const record = raw[report.index];
		if (report.accepted || report.label === undefined || !isRecord(record)) {
			continue;
		}
		const values = SECRET_FIELD_IDS.flatMap((id) =>
			[record[id], ...SECRET_FIELD_NESTED_PATHS[id].map((path) => valueAt(record, path))]
				.map(usableHttpText)
				.filter((value): value is string => value !== undefined)
		);
		if (values.length > 0) {
			inline.set(report.label, [...new Set([...(inline.get(report.label) ?? []), ...values])]);
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
			const label = record !== undefined ? usableHttpText(record.label) : undefined;
			const baseUrl = record !== undefined ? usableHttpText(record.baseUrl) : undefined;
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
	discovery: Record<string, unknown>,
	field: string,
	isKnown: (value: unknown) => value is T,
	report: (what: string) => void
): T[] {
	const raw = listSlot(discovery[field], `discovery.${field}`, report);
	if (raw === undefined) {
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
		const record = objectSlot(item, "is not an object", report);
		if (record === undefined) {
			return;
		}
		const label = usableHttpText(record.label);
		const baseUrlText = usableHttpText(record.baseUrl);
		if (label === undefined || baseUrlText === undefined) {
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

		// A reject, not a drop: the entry keeps its label (no removal is inferred) and its row names the field.
		const baseUrl = canonicalBaseUrl(baseUrlText);
		if (baseUrl === undefined) {
			report("has a baseUrl that is not a URL with a host; the entry is not used until it is fixed");
			return;
		}

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

		// "" is a real value (append nothing to the base URL), so this cannot funnel through usableHttpText, which erases
		// it. Like budget, a malformed value is a diagnostic and is ignored; the entry stays usable.
		if (record.apiVersion !== undefined) {
			if (typeof record.apiVersion !== "string") {
				report("has an apiVersion that is not a string, ignored");
			} else {
				entry.apiVersion = trimHttpWhitespace(record.apiVersion);
			}
		}

		// Header names are structural configuration (the same class the request-path narrowing logs); values never
		// enter the report.
		const headers = normalizeCustomHeaders(record.headers, (message, data) => {
			const name = isRecord(data) && typeof data.name === "string" ? ` ("${data.name}")` : "";
			report(`headers: ${message}${name}`);
		});
		if (Object.keys(headers).length > 0) {
			entry.headers = headers;
		}

		// An empty models result reads as absent. The capability vocabulary is enforced downstream by
		// parseCapabilityRecord.
		const models = optionalSlot(record.models, "models", report);
		if (models !== undefined) {
			// Named on purpose, like the unknown auth keys: a typo silently reading as "no per-entry records" would be
			// invisible.
			for (const key of Object.keys(models)) {
				if (key !== "parameters" && key !== "capabilities") {
					report(`has an unknown models key "${key}", ignored`);
				}
			}
			// The records normalizer is the one shape classifier; its refusals ride this entry's report so a
			// `"gpt-4": "oops"` does not read as "no per-entry records" in silence.
			const shapeReport =
				(slot: "parameters" | "capabilities"): RecordShapeReport =>
				(problem) => {
					switch (problem.kind) {
						case "map":
							report(`has a models.${slot} value that is not an object, ignored`);
							break;
						case "entry":
							report(`has a models.${slot} entry "${problem.key}" that is not an object, ignored`);
							break;
						case "reserved-key":
							report(`has a models.${slot} entry "${problem.key}" under a reserved name, ignored`);
							break;
					}
				};
			const modelParameters = normalizeModelParameters(models.parameters, shapeReport("parameters"));
			if (Object.keys(modelParameters).length > 0) {
				entry.modelParameters = modelParameters;
			}
			const modelCapabilities = normalizeModelCapabilities(models.capabilities, shapeReport("capabilities"));
			if (Object.keys(modelCapabilities).length > 0) {
				entry.modelCapabilities = modelCapabilities;
			}
		}

		const discovery = optionalSlot(record.discovery, "discovery", report);
		if (discovery !== undefined) {
			// Named on purpose: a typo silently reading as "no expected failures", "nothing declared", or "nothing
			// included" would be invisible.
			for (const key of Object.keys(discovery)) {
				if (key !== "expectedFailures" && key !== "declared" && key !== "includeModes") {
					report(`has an unknown discovery key "${key}", ignored`);
				}
			}
			const expectedFailures = knownTokens(discovery, "expectedFailures", isExpectedFailureCategory, report);
			if (expectedFailures.length > 0) {
				entry.expectedFailures = expectedFailures;
			}
			const declared = listSlot(discovery.declared, "discovery.declared", report);
			if (declared !== undefined) {
				const ids = declared.map(usableHttpText).filter((id): id is string => id !== undefined);
				if (ids.length < declared.length) {
					const dropped = declared.length - ids.length;
					report(`lists ${dropped} unusable discovery.declared value(s), ignored`);
				}
				const unique = [...new Set(ids)];
				if (unique.length > 0) {
					entry.declaredModels = unique;
				}
			}
			const includeModes = knownTokens(discovery, "includeModes", isNonChatMode, report);
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
 * describes. An element rejected before it claims its label (not an object, no label or baseUrl, a reserved label)
 * cannot shadow the accepted entry; a misconfigured claimant (a refused base URL or auth shape) still owns the label,
 * so a later same-label element resolves to nothing, as does a label the parser rejects outright.
 */
export function acceptedEntry(raw: unknown, label: string): { index: number; entry: DeclaredServer } | undefined {
	const wanted = trimHttpWhitespace(label);
	return acceptedEntries(raw).find(({ entry }) => entry.label === wanted);
}

/** Every accepted entry with its raw-array index, in one acceptance pass. */
export function acceptedEntries(raw: unknown): { index: number; entry: DeclaredServer }[] {
	return Array.isArray(raw) ? acceptEntries(raw) : [];
}

/**
 * The URL field of a raw entry the parser refuses, when there is one: usable text with no canonical spelling. The
 * settings import skips such an entry by this judgment instead of landing it, so a working entry under the label is
 * never overwritten by one the parser would reject.
 */
export function refusedUrlField(raw: Readonly<Record<string, unknown>>): "baseUrl" | "auth.oauth.tokenUrl" | undefined {
	const baseUrlText = usableHttpText(raw.baseUrl);
	if (baseUrlText !== undefined && canonicalBaseUrl(baseUrlText) === undefined) {
		return "baseUrl";
	}
	const tokenUrlText =
		isRecord(raw.auth) && isRecord(raw.auth.oauth) ? usableHttpText(raw.auth.oauth.tokenUrl) : undefined;
	return tokenUrlText !== undefined && canonicalUrl(tokenUrlText) === undefined ? "auth.oauth.tokenUrl" : undefined;
}

/**
 * A raw entry with its URL fields in the one spelling the parser reads, every other byte untouched: what a settings
 * import writes and what the one-time migration rewrites, so a stored entry reads back as itself. `oldBaseUrl` is the
 * trimmed spelling the base URL had when it changed: the one field the sync fingerprint hashes (engine.ts
 * groupIdentityArgs), so the one whose old spelling a record carry needs.
 */
export function respellEntryUrls(raw: Readonly<Record<string, unknown>>): {
	readonly record: Record<string, unknown>;
	readonly changed: boolean;
	readonly oldBaseUrl?: string;
} {
	const record: Record<string, unknown> = { ...raw };
	let changed = false;
	let oldBaseUrl: string | undefined;
	const baseUrlText = usableHttpText(raw.baseUrl);
	const baseUrl = baseUrlText === undefined ? undefined : canonicalBaseUrl(baseUrlText);
	if (baseUrl !== undefined && baseUrl !== raw.baseUrl) {
		record.baseUrl = baseUrl;
		changed = true;
		oldBaseUrl = baseUrlText;
	}
	if (isRecord(raw.auth) && isRecord(raw.auth.oauth)) {
		const tokenUrlText = usableHttpText(raw.auth.oauth.tokenUrl);
		const tokenUrl = tokenUrlText === undefined ? undefined : canonicalUrl(tokenUrlText);
		if (tokenUrl !== undefined && tokenUrl !== raw.auth.oauth.tokenUrl) {
			record.auth = { ...raw.auth, oauth: { ...raw.auth.oauth, tokenUrl } };
			changed = true;
		}
	}
	if (isRecord(raw.mcp)) {
		const urlText = usableHttpText(raw.mcp.url);
		const url = urlText === undefined ? undefined : canonicalUrl(urlText);
		if (url !== undefined && url !== raw.mcp.url) {
			record.mcp = { ...raw.mcp, url };
			changed = true;
		}
	}
	return { record, changed, ...(oldBaseUrl !== undefined ? { oldBaseUrl } : {}) };
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
			const label = trimHttpWhitespace(item.label);
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
