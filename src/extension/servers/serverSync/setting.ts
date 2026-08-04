/**
 * Parsing the litellm-vscode-chat.servers setting: the acceptance rules for
 * declared entries live here and nowhere else.
 */

import type { ModelCapabilitiesRecord } from "../../../shared/config/capabilityResolution";
import { normalizeModelCapabilities, normalizeModelParameters } from "../../../shared/config/settings";
import type { ExpectedFailureCategory, OptionalEntryFieldId, OptionalEntryFields } from "../../../shared/serverEntry";
import { isExpectedFailureCategory, OPTIONAL_ENTRY_FIELDS } from "../../../shared/serverEntry";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";

/** An entry's per-entry modelParameters: model-ID prefix to request parameters, like the global setting. */
export type EntryModelParameters = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** An entry's per-entry modelCapabilities: model-ID prefix to capability record, like the global setting. */
export type EntryModelCapabilities = ModelCapabilitiesRecord;

/**
 * One parsed servers-setting entry: label and baseUrl usable, other fields
 * present only with usable text. `modelParameters`, `modelCapabilities`, and
 * `expectedFailures` are present only when the raw entry carries usable
 * content; they scope request parameters, capability overrides, and expected
 * discovery failures to models served through this entry and are read
 * extension-side - they never enter the group configuration or its
 * fingerprint (buildGroupArgs does not emit them).
 */
export type DeclaredServer = {
	readonly label: string;
	readonly baseUrl: string;
	readonly modelParameters?: EntryModelParameters;
	readonly modelCapabilities?: EntryModelCapabilities;
	readonly expectedFailures?: readonly ExpectedFailureCategory[];
} & OptionalEntryFields;

function usableString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse the raw setting value. Entries without a usable label or baseUrl,
 * with a reserved label, or with a label an earlier entry already used are
 * skipped and reported; everything the sync engine acts on comes out of here.
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
 * The accepted entries with their raw-array indices: the single place the
 * acceptance rules live, so parseServersSetting and acceptedEntry cannot
 * disagree about which raw entry a label resolves to.
 */
function acceptEntries(raw: readonly unknown[], problems?: string[]): { index: number; entry: DeclaredServer }[] {
	const accepted: { index: number; entry: DeclaredServer }[] = [];
	const seen = new Set<string>();
	raw.forEach((item: unknown, index) => {
		// One prefix for everything reported about this entry, rejecting or
		// not: the problems are logged, so they reference the entry by index
		// only, never by user text.
		const report = (what: string) => problems?.push(`entry ${index + 1} ${what}`);
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
		const entry: {
			label: string;
			baseUrl: string;
			modelParameters?: EntryModelParameters;
			modelCapabilities?: EntryModelCapabilities;
			expectedFailures?: readonly ExpectedFailureCategory[];
		} & {
			-readonly [K in OptionalEntryFieldId]?: string;
		} = {
			label,
			baseUrl,
		};
		for (const { id } of OPTIONAL_ENTRY_FIELDS) {
			const value = usableString(record[id]);
			if (value !== undefined) {
				entry[id] = value;
			}
		}
		// Lenient like the optional fields above and the global setting's own
		// normalization (the shared rule): non-record values and malformed
		// sub-entries drop silently, and an empty result reads as absent.
		const modelParameters = normalizeModelParameters(record.modelParameters);
		if (Object.keys(modelParameters).length > 0) {
			entry.modelParameters = modelParameters;
		}
		// Shape-lenient like modelParameters; the capability vocabulary is
		// enforced downstream by parseCapabilityRecord, which owns the
		// diagnostics the dashboard renders.
		const modelCapabilities = normalizeModelCapabilities(record.modelCapabilities);
		if (Object.keys(modelCapabilities).length > 0) {
			entry.modelCapabilities = modelCapabilities;
		}
		if (Array.isArray(record.expectedFailures)) {
			const known = record.expectedFailures.filter(isExpectedFailureCategory);
			if (known.length < record.expectedFailures.length) {
				// Counted, never echoed: unknown tokens are user text.
				const unknownCount = record.expectedFailures.length - known.length;
				report(`lists ${unknownCount} unknown expectedFailures value(s), ignored`);
			}
			const categories = [...new Set(known)];
			if (categories.length > 0) {
				entry.expectedFailures = categories;
			}
		}
		accepted.push({ index, entry });
	});
	return accepted;
}

/**
 * The entry parseServersSetting accepts for `label`, with its raw-array
 * index, or undefined when it accepts none. The dashboard's per-entry reads
 * and writes (the edit form's inline-value prefill, the save target) resolve
 * through this so they act on exactly the entry the dashboard row describes:
 * a rejected same-label sibling earlier in the array (no usable baseUrl, say)
 * cannot shadow the accepted entry, and a label the parser rejects outright
 * (a reserved name, a never-declared junk entry) resolves to nothing. The
 * returned entry is the parsed view - usable fields only, trimmed - so
 * callers consume what the sync engine would read, not the raw record.
 */
export function acceptedEntry(raw: unknown, label: string): { index: number; entry: DeclaredServer } | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const wanted = label.trim();
	return acceptEntries(raw).find(({ entry }) => entry.label === wanted);
}

/**
 * Every label the raw setting still CARRIES, acceptance aside: any object
 * entry with a usable label string counts, even when the parser would reject
 * it (no usable baseUrl, a duplicate). The removal detector reads this
 * because "the user removed the entry" and "the entry is present but
 * momentarily malformed" (a mid-edit settings.json, say) must never be
 * confused - a tombstone written for the latter would suppress a group the
 * user did not remove. Reserved labels stay out: the parser rejects them
 * permanently (never synced, never fingerprinted), and the caller carries
 * map records under these labels, so a prototype-polluting key must not
 * come back from here.
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

/**
 * The declared entry the extension-side per-entry reads resolve against: the
 * entry acceptedEntry resolves for `label`, and only when that entry also
 * declares the server the request or refresh is routed to (base URLs compared
 * under the shared normalization). The match is label plus URL - credentials
 * deliberately play no part - so any group carrying the entry's label at the
 * entry's URL resolves, a hand-labeled native group included. What the URL
 * check excludes is a label that proves nothing about the connection: a
 * same-label group at another URL (a stale group outliving a label reuse or
 * a baseUrl edit) resolves to nothing and gets only the global settings.
 */
function matchedEntryFor(raw: unknown, label: string, baseUrl: string): DeclaredServer | undefined {
	const match = acceptedEntry(raw, label);
	if (match === undefined || normalizeBaseUrl(match.entry.baseUrl) !== normalizeBaseUrl(baseUrl)) {
		return undefined;
	}
	return match.entry;
}

/** The request path's resolution of one declared entry's per-entry modelParameters; see matchedEntryFor. */
export function entryModelParametersFor(
	raw: unknown,
	label: string,
	baseUrl: string
): EntryModelParameters | undefined {
	return matchedEntryFor(raw, label, baseUrl)?.modelParameters;
}

/** The registration path's resolution of one declared entry's per-entry modelCapabilities; see matchedEntryFor. */
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
