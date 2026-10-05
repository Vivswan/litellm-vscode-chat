/**
 * The removed default* token settings move into the models.capabilities "*" record, each at the level its removed
 * reader had. The record is marked `_inheritable` because the old defaults applied to every model, and without the
 * mark any model with a more specific record of its own would lose them under most-specific-wins.
 *
 *   context_length, max_output_tokens      -> ride `_fallback`; max_output_tokens now reads as user-declared and
 *                                             escapes the min(4096, limit) clamp
 *   max_input_tokens                       -> plain override
 *   it beat the server's value             -> plain override
 *   plain override                         -> now also beats an `_openrouter_model` directive
 *   existing "*" record                    -> only added fields join its `_inheritable` list (a user's `true` stays);
 *                                             no old field is newly marked
 *   `_fallback: true` as an override lands -> expands to the fields the live parser marks under it, so the fill lands
 *                                             unmarked; later fields lose auto-marking
 */

import { canonicalFieldKey } from "../../../shared/config/recordResolution";
import { isRecord } from "../../../shared/util/json";
import { normalizePositiveNumber } from "../../../shared/util/numbers";
import { canonicalFieldNames, directiveKey, fallbackMarksUnderTrue } from "./entries";
import { REMOVED_TOKEN_DEFAULTS } from "./legacyIds";
import type { SettingsSnapshot } from "./types";

const CATCH_ALL_KEY = "*";
const FALLBACK_DIRECTIVE = "_fallback";
const INHERITABLE_DIRECTIVE = "_inheritable";

/**
 * A `_fallback` or `_inheritable` value read as a mergeable list base: `false` marks nothing, which is the no-directive
 * state, so it reads as absent rather than blocking the move forever. Anything that is not boolean-or-array cannot take
 * additions without overwriting what the user wrote, so it blocks.
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
 * A source value the removed readers did not honor (zero, negative, fractional, non-numeric) had no effect and is
 * consumed without a fill.
 *
 *   Existing user keys in the catch-all always win -> only missing fields are filled - each at its removed setting's
 *     own level
 *   An unmergeable target blocks the move and keeps the sources -> the pipeline retries every activation until the
 *                                                                  user repairs the record
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
	// Fields, list entries, and directive keys are identified the way parseCapabilityRecord identifies them, so a padded
	// spelling is the user's own value for that field or directive.
	const names = (keys: readonly unknown[]): Set<string> => canonicalFieldNames("capabilities", keys);
	const fallbackKey = directiveKey("capabilities", catchAll, FALLBACK_DIRECTIVE);
	const inheritableKey = directiveKey("capabilities", catchAll, INHERITABLE_DIRECTIVE);
	const fallback = directiveBase(catchAll, fallbackKey);
	const inheritable = directiveBase(catchAll, inheritableKey);
	if (!fallback.ok || !inheritable.ok) {
		return { ...UNTOUCHED, blockedValues: configured.length };
	}

	const present = names(Object.keys(catchAll));
	const merged: Record<string, unknown> = Object.fromEntries(Object.entries(catchAll));
	const addedFields: string[] = [];
	const overrideAdditions: string[] = [];
	const fallbackAdditions: string[] = [];
	for (const source of configured) {
		const value = normalizePositiveNumber(snapshot[source.id]?.globalValue);
		if (value === undefined || present.has(source.field)) {
			continue;
		}
		merged[source.field] = value;
		addedFields.push(source.field);
		(source.placement === "override" ? overrideAdditions : fallbackAdditions).push(source.field);
	}

	// An override-placed fill must land unmarked, so `true` expands to what the parser marks under it today and inert
	// names of the filled field drop from a list. An emptied list takes every spelling with it, or an earlier shadowed
	// spelling would surface.
	const writeFallback = (list: readonly string[]): void => {
		if (list.length === 0) {
			for (const key of Object.keys(merged).filter((key) => names([key]).has(FALLBACK_DIRECTIVE))) {
				delete merged[key];
			}
		} else {
			merged[fallbackKey] = [...list];
		}
	};
	if (fallback.value === true) {
		if (overrideAdditions.length > 0) {
			writeFallback([...fallbackMarksUnderTrue(catchAll), ...fallbackAdditions]);
		}
	} else {
		const base = (Array.isArray(fallback.value) ? fallback.value : []).filter(
			(name) => typeof name !== "string" || !overrideAdditions.includes(canonicalFieldKey("capabilities", name))
		);
		const baseNames = names(base);
		const additions = fallbackAdditions.filter((field) => !baseNames.has(field));
		const list = [...base, ...additions];
		if (
			Array.isArray(fallback.value) ? list.length !== fallback.value.length || additions.length > 0 : list.length > 0
		) {
			writeFallback(list as string[]);
		}
	}

	if (addedFields.length > 0 && inheritable.value !== true) {
		if (freshCatchAll) {
			merged[inheritableKey] = true;
		} else {
			const listedInheritable = Array.isArray(inheritable.value) ? inheritable.value : [];
			const listedNames = names(listedInheritable);
			const additions = addedFields.filter((field) => !listedNames.has(field));
			if (additions.length > 0) {
				merged[inheritableKey] = [...listedInheritable, ...additions];
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
