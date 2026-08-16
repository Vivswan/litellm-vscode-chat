/**
 * The removed default* token settings move into the models.capabilities "*"
 * record: the two below-server settings ride `_fallback`, the input limit
 * stays an override, existing user keys win the merge, and source-key absence
 * is the idempotency signal. The record is marked `_inheritable`, because the
 * old defaults applied to every model regardless of other records, and without
 * the marking any model with a more specific record of its own would lose them
 * wholesale under the most-specific-wins rule.
 *
 * A record this migration authors from scratch carries `_inheritable: true`;
 * merging into a user's existing "*" record instead appends only the fields
 * the migration added to an `_inheritable` list (or leaves a user's own `true`
 * alone), so the user's existing fields never silently start flowing into
 * more-specific records.
 *
 * The override-placed fill (max_input_tokens beat the server-reported value)
 * must never land demoted, so the merge protects it from the target's own
 * `_fallback`: a `_fallback: true` is expanded to the explicit list of the
 * record's PRE-EXISTING valid fields before the fill lands unmarked, and an
 * inert listed name is dropped rather than left to activate. The cost of the
 * expansion - fields the user adds later are no longer auto-marked - is paid
 * only when a max_input_tokens fill actually lands.
 *
 * Two accepted level shifts: a migrated max_output_tokens counts user-declared
 * (the request path's min(4096, limit) clamp no longer applies), and
 * max_input_tokens as a plain override now also beats an `_openrouter_model`
 * directive.
 */

import { isRecord } from "../../../shared/util/json";
import { normalizePositiveNumber } from "../../../shared/util/numbers";
import { isValidCapabilityField, REMOVED_TOKEN_DEFAULTS } from "./legacyIds";
import type { SettingsSnapshot } from "./types";

const CATCH_ALL_KEY = "*";
const FALLBACK_DIRECTIVE = "_fallback";
const INHERITABLE_DIRECTIVE = "_inheritable";

/**
 * A `_fallback` or `_inheritable` value read as a mergeable list base: `false`
 * marks nothing, which is the no-directive state, so it reads as absent rather
 * than blocking the move forever. Anything that is not boolean-or-array cannot
 * take additions without overwriting what the user wrote, so it blocks.
 */
function directiveBase(record: Record<string, unknown>, directive: string): { ok: boolean; value?: unknown } {
	const raw = Object.hasOwn(record, directive) ? record[directive] : undefined;
	const value = raw === false ? undefined : raw;
	if (value !== undefined && value !== true && !Array.isArray(value)) {
		return { ok: false };
	}
	return { ok: true, value };
}

export interface TokenDefaultsMerge {
	/** The updated capabilities value; undefined when nothing needed writing. */
	readonly capabilitiesValue?: Record<string, unknown> | undefined;
	/** The source ids to delete from user settings (empty when blocked or untouched). */
	readonly consumedIds: readonly string[];
	readonly movedFields: number;
	/** Sources drained without a fill (already covered, or values the removed readers never honored). */
	readonly drainedKeys: number;
	/** Sources left in place because the "*" record cannot take the merge. */
	readonly blockedValues: number;
}

const UNTOUCHED: TokenDefaultsMerge = { consumedIds: [], movedFields: 0, drainedKeys: 0, blockedValues: 0 };

/**
 * Merge the trio's user-layer values into the (already renamed, in-memory)
 * models.capabilities value. Existing user keys in the catch-all always win: a
 * field the user already set keeps its value and its level, and only missing
 * fields are filled - each at its removed setting's own level. A source value
 * the removed readers did not honor (zero, negative, fractional, non-numeric)
 * had no effect and is consumed without a fill. An unmergeable target blocks
 * the move and keeps the sources, so the pipeline retries every activation
 * until the user repairs the record.
 */
export function mergeTokenDefaults(capabilitiesValue: unknown, snapshot: SettingsSnapshot): TokenDefaultsMerge {
	const configured = REMOVED_TOKEN_DEFAULTS.filter((source) => snapshot[source.id]?.globalValue !== undefined);
	if (configured.length === 0) {
		return UNTOUCHED;
	}

	const capabilities = capabilitiesValue === undefined ? {} : capabilitiesValue;
	if (!isRecord(capabilities)) {
		return { ...UNTOUCHED, blockedValues: configured.length };
	}
	const freshCatchAll = !Object.hasOwn(capabilities, CATCH_ALL_KEY);
	const catchAll = freshCatchAll ? {} : capabilities[CATCH_ALL_KEY];
	if (!isRecord(catchAll)) {
		return { ...UNTOUCHED, blockedValues: configured.length };
	}
	const fallback = directiveBase(catchAll, FALLBACK_DIRECTIVE);
	const inheritable = directiveBase(catchAll, INHERITABLE_DIRECTIVE);
	if (!fallback.ok || !inheritable.ok) {
		return { ...UNTOUCHED, blockedValues: configured.length };
	}

	const merged: Record<string, unknown> = Object.fromEntries(Object.entries(catchAll));
	const addedFields: string[] = [];
	const overrideAdditions: string[] = [];
	const fallbackAdditions: string[] = [];
	for (const source of configured) {
		const value = normalizePositiveNumber(snapshot[source.id]?.globalValue);
		if (value === undefined || Object.hasOwn(catchAll, source.field)) {
			continue;
		}
		merged[source.field] = value;
		addedFields.push(source.field);
		(source.placement === "override" ? overrideAdditions : fallbackAdditions).push(source.field);
	}

	// The `_fallback` merge. With no override-placed fill, a user's `true` stays
	// exactly as written. An override-placed fill must land unmarked, so `true`
	// expands to the pre-existing valid fields and inert names of the filled
	// field drop from a list. An empty resulting list drops the directive.
	const writeFallback = (list: readonly string[]): void => {
		if (list.length === 0) {
			delete merged[FALLBACK_DIRECTIVE];
		} else {
			merged[FALLBACK_DIRECTIVE] = [...list];
		}
	};
	if (fallback.value === true) {
		if (overrideAdditions.length > 0) {
			const preExisting = Object.keys(catchAll).filter(
				(name) => !name.startsWith("_") && isValidCapabilityField(name, catchAll[name])
			);
			writeFallback([...preExisting, ...fallbackAdditions]);
		}
	} else {
		const base = (Array.isArray(fallback.value) ? fallback.value : []).filter(
			(name) => !overrideAdditions.includes(name as string)
		);
		const additions = fallbackAdditions.filter((field) => !base.includes(field));
		const list = [...base, ...additions];
		if (
			Array.isArray(fallback.value) ? list.length !== fallback.value.length || additions.length > 0 : list.length > 0
		) {
			writeFallback(list as string[]);
		}
	}

	if (addedFields.length > 0 && inheritable.value !== true) {
		if (freshCatchAll) {
			merged[INHERITABLE_DIRECTIVE] = true;
		} else {
			const listedInheritable = Array.isArray(inheritable.value) ? inheritable.value : [];
			const additions = addedFields.filter((field) => !listedInheritable.includes(field));
			if (additions.length > 0) {
				merged[INHERITABLE_DIRECTIVE] = [...listedInheritable, ...additions];
			}
		}
	}

	return {
		...(addedFields.length > 0
			? { capabilitiesValue: Object.fromEntries([...Object.entries(capabilities), [CATCH_ALL_KEY, merged]]) }
			: {}),
		consumedIds: configured.map((source) => source.id),
		movedFields: addedFields.length,
		drainedKeys: configured.length - addedFields.length,
		blockedValues: 0,
	};
}
