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

	/** Sources whose value filled a capability field of the "*" record. */
	readonly movedFields: number;

	/** Sources drained without a fill (already covered, or values the removed readers never honored). */
	readonly drainedKeys: number;

	/** Sources left in place because the "*" record cannot take the merge. */
	readonly blockedValues: number;
}

const UNTOUCHED: TokenDefaultsMerge = { consumedIds: [], movedFields: 0, drainedKeys: 0, blockedValues: 0 };

type RemovedTokenDefault = (typeof REMOVED_TOKEN_DEFAULTS)[number];

/** What the fill added to the catch-all: the merged record, the fields filled, and each field by its placement. */
interface CatchAllFill {
	readonly merged: Record<string, unknown>;
	readonly addedFields: readonly string[];
	readonly overrideAdditions: readonly string[];
	readonly fallbackAdditions: readonly string[];
}

/** The fallback rewrite's inputs: the catch-all as read, its directive key and value, and the fill by placement. */
interface FallbackRewrite {
	readonly catchAll: Record<string, unknown>;
	readonly fallbackKey: string;
	readonly fallbackValue: unknown;
	readonly overrideAdditions: readonly string[];
	readonly fallbackAdditions: readonly string[];
}

/**
 * The inheritable rewrite's inputs: whether the catch-all is new, its directive key and value, and the filled
 * fields.
 */
interface InheritableRewrite {
	readonly freshCatchAll: boolean;
	readonly inheritableKey: string;
	readonly inheritableValue: unknown;
	readonly addedFields: readonly string[];
}

/**
 * Fills the catch-all's missing fields from the configured sources, each at its removed setting's own level. A source
 * value the removed readers did not honor (zero, negative, fractional, non-numeric) had no effect and fills nothing;
 * an existing user key always wins.
 */
function fillCatchAll(
	catchAll: Record<string, unknown>,
	configured: readonly RemovedTokenDefault[],
	snapshot: SettingsSnapshot
): CatchAllFill {
	const present = canonicalFieldNames("capabilities", Object.keys(catchAll));
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
	return { merged, addedFields, overrideAdditions, fallbackAdditions };
}

/**
 * Rewrites the merged catch-all's `_fallback` for the fill. An override-placed fill must land unmarked, so `true`
 * expands to what the parser marks under it today and inert names of the filled field drop from a list. An emptied
 * list takes every spelling with it, or an earlier shadowed spelling would surface.
 */
function applyFallbackDirective(merged: Record<string, unknown>, rewrite: FallbackRewrite): void {
	const writeFallback = (list: readonly string[]): void => {
		if (list.length === 0) {
			for (const key of Object.keys(merged).filter((key) =>
				canonicalFieldNames("capabilities", [key]).has(FALLBACK_DIRECTIVE)
			)) {
				delete merged[key];
			}
		} else {
			merged[rewrite.fallbackKey] = [...list];
		}
	};
	if (rewrite.fallbackValue === true) {
		if (rewrite.overrideAdditions.length > 0) {
			writeFallback([...fallbackMarksUnderTrue(rewrite.catchAll), ...rewrite.fallbackAdditions]);
		}
		return;
	}
	const listed = Array.isArray(rewrite.fallbackValue) ? rewrite.fallbackValue : [];
	const base = listed.filter(
		(name) => typeof name !== "string" || !rewrite.overrideAdditions.includes(canonicalFieldKey("capabilities", name))
	);
	const baseNames = canonicalFieldNames("capabilities", base);
	const additions = rewrite.fallbackAdditions.filter((field) => !baseNames.has(field));
	const list = [...base, ...additions];
	const changed = Array.isArray(rewrite.fallbackValue)
		? list.length !== rewrite.fallbackValue.length || additions.length > 0
		: list.length > 0;
	if (changed) {
		writeFallback(list as string[]);
	}
}

/**
 * Marks the filled fields `_inheritable`: a fresh catch-all takes `true`, a listed directive takes the fields it lacks,
 * and a user's `true` stays as it is.
 */
function applyInheritableDirective(merged: Record<string, unknown>, rewrite: InheritableRewrite): void {
	if (rewrite.addedFields.length === 0 || rewrite.inheritableValue === true) {
		return;
	}
	if (rewrite.freshCatchAll) {
		merged[rewrite.inheritableKey] = true;
		return;
	}
	const listedInheritable = Array.isArray(rewrite.inheritableValue) ? rewrite.inheritableValue : [];
	const listedNames = canonicalFieldNames("capabilities", listedInheritable);
	const additions = rewrite.addedFields.filter((field) => !listedNames.has(field));
	if (additions.length > 0) {
		merged[rewrite.inheritableKey] = [...listedInheritable, ...additions];
	}
}

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
	const fallbackKey = directiveKey("capabilities", catchAll, FALLBACK_DIRECTIVE);
	const inheritableKey = directiveKey("capabilities", catchAll, INHERITABLE_DIRECTIVE);
	const fallback = directiveBase(catchAll, fallbackKey);
	const inheritable = directiveBase(catchAll, inheritableKey);
	if (!fallback.ok || !inheritable.ok) {
		return { ...UNTOUCHED, blockedValues: configured.length };
	}

	const fill = fillCatchAll(catchAll, configured, snapshot);
	applyFallbackDirective(fill.merged, {
		catchAll,
		fallbackKey,
		fallbackValue: fallback.value,
		overrideAdditions: fill.overrideAdditions,
		fallbackAdditions: fill.fallbackAdditions,
	});
	applyInheritableDirective(fill.merged, {
		freshCatchAll,
		inheritableKey,
		inheritableValue: inheritable.value,
		addedFields: fill.addedFields,
	});

	return {
		...(fill.addedFields.length > 0
			? { capabilitiesValue: Object.fromEntries([...Object.entries(capabilities), [CATCH_ALL_KEY, fill.merged]]) }
			: {}),
		consumedIds: configured.map((source) => source.id),
		movedFields: fill.addedFields.length,
		drainedKeys: configured.length - fill.addedFields.length,
		blockedValues: 0,
	};
}
