/**
 * Parsing the litellm-vscode-chat.servers setting: the acceptance rules for
 * declared entries live here and nowhere else.
 */

import { isRecord, isUnsafeRecordKey } from "../../shared/json";
import type { OptionalEntryFieldId, OptionalEntryFields } from "../../shared/serverEntry";
import { OPTIONAL_ENTRY_FIELDS } from "../../shared/serverEntry";

/** One parsed servers-setting entry: label and baseUrl usable, other fields present only with usable text. */
export type DeclaredServer = { readonly label: string; readonly baseUrl: string } & OptionalEntryFields;

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
		const reject = (why: string) => problems?.push(`entry ${index + 1} ${why}`);
		if (!isRecord(item)) {
			reject("is not an object");
			return;
		}
		const record = item;
		const label = usableString(record.label);
		const baseUrl = usableString(record.baseUrl);
		if (label === undefined || baseUrl === undefined) {
			reject("is missing a label or baseUrl");
			return;
		}
		if (isUnsafeRecordKey(label)) {
			reject("uses a reserved label");
			return;
		}
		if (seen.has(label)) {
			reject("repeats an earlier entry's label; the first entry wins");
			return;
		}
		seen.add(label);
		const entry: { label: string; baseUrl: string } & { -readonly [K in OptionalEntryFieldId]?: string } = {
			label,
			baseUrl,
		};
		for (const { id } of OPTIONAL_ENTRY_FIELDS) {
			const value = usableString(record[id]);
			if (value !== undefined) {
				entry[id] = value;
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
