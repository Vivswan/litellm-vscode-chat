/**
 *   every step keys on its own legacy state                -> Idempotency is state detection throughout
 *   entry restructure first                                -> scoped keys, declares, and the global headers have
 *                                                             their new-shaped destinations
 *   the `servers` setting is machine-scoped                -> its restructure has no workspace side
 *   SecretStorage keys and blob field ids stay as they are -> Secrets and sync state are untouched
 */

import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../../shared/util/json";
import {
	ENTRY_SLOTS,
	entrySlotAccepts,
	restructureServers,
	scopedMoveTargets,
	withEntryDeclares,
	withEntryHeaders,
	withEntryRecordAdditions,
} from "./entries";
import {
	LEGACY_HEADERS_ID,
	LEGACY_MODEL_CAPABILITIES_ID,
	LEGACY_MODEL_PARAMETERS_ID,
	LEGACY_SCALAR_RENAMES,
	LEGACY_SETTING_IDS,
	NEW_MODEL_CAPABILITIES_ID,
	NEW_MODEL_PARAMETERS_ID,
	SERVERS_ID,
} from "./legacyIds";
import type { RecordKind, ScopedMoveTarget, ScopedMoveTargetState } from "./records";
import { transformGlobalRecord } from "./records";
import { mergeTokenDefaults } from "./tokenDefaults";
import type { RedesignPlan, SettingsSnapshot, SettingWrite } from "./types";

/** Count-noun helper: "1 entry" / "3 entries" stays English (log lines feed public issue reports). */
function entriesNoun(count: number): string {
	return count === 1 ? "entry" : "entries";
}

/**
 * The plan under construction, shared by the steps below: the servers array as the moves land on it, the writes and
 * deletions gathered so far, and the counts the log lines report.
 */
interface PlanDraft {
	readonly snapshot: SettingsSnapshot;
	serversValue: unknown;
	readonly targets: readonly ScopedMoveTarget[];
	readonly counts: ReturnType<typeof restructureServers>["counts"];
	readonly logLines: string[];
	readonly valueWrites: SettingWrite[];
	readonly deletions: string[];
	renamedSettings: number;
	keptNewNames: number;
	movedScoped: number;
	inertScoped: number;
}

/** The user-scope value of a setting in the snapshot. */
function globalOf(draft: PlanDraft, id: string): unknown {
	return draft.snapshot[id]?.globalValue;
}

/** The raw entry at an index of the servers array as it stands now. */
function entryAt(draft: PlanDraft, index: number): unknown {
	return Array.isArray(draft.serversValue) ? draft.serversValue[index] : undefined;
}

/** Replaces one entry through `update`, copying the array only when the entry changed. */
function updateEntry(
	draft: PlanDraft,
	index: number,
	update: (entry: Record<string, unknown>) => Record<string, unknown>
): void {
	if (!Array.isArray(draft.serversValue)) {
		return;
	}
	const entry = draft.serversValue[index];
	if (!isRecord(entry)) {
		return;
	}
	const next = update(entry);
	if (next !== entry) {
		const copy = [...draft.serversValue];
		copy[index] = next;
		draft.serversValue = copy;
	}
}

/** Each scoped-move target with what its entry's slots can take right now. */
function slotStatesFor(draft: PlanDraft, kind: RecordKind): ScopedMoveTargetState[] {
	return draft.targets.map((target) => {
		const entry = entryAt(draft, target.entryIndex);
		return {
			...target,
			acceptsRecords: entrySlotAccepts(entry, ENTRY_SLOTS[kind]),
			acceptsDeclares: entrySlotAccepts(entry, ENTRY_SLOTS.declared),
		};
	});
}

/**
 * Moves one record setting to its new name, transformed, its URL-scoped keys landing in their entries, and returns
 * the value the new name holds afterwards. The sync-race rule, which is also the crash-recovery rule: a new name that
 * already holds a value (Settings Sync delivered it, or an earlier run wrote it and crashed before the deletion) keeps
 * it and the old key is dropped; under the Settings Sync reading that is knowingly lossy for THIS machine's entries.
 */
function moveRecordSetting(draft: PlanDraft, oldId: string, newId: string, kind: RecordKind): unknown {
	const oldValue = globalOf(draft, oldId);
	const newValue = globalOf(draft, newId);
	if (oldValue === undefined) {
		return newValue;
	}
	if (newValue !== undefined) {
		draft.deletions.push(oldId);
		draft.keptNewNames += 1;
		return newValue;
	}
	const transform = transformGlobalRecord(oldValue, kind, slotStatesFor(draft, kind));
	draft.counts.starredKeys += transform.starredKeys;
	draft.counts.droppedAliasKeys += transform.droppedAliasKeys;
	draft.counts.strippedInertDeclares += transform.strippedInertDeclares;
	draft.counts.rewroteForceDirectives += transform.rewroteForce;
	draft.movedScoped += transform.movedScopedKeys;
	draft.inertScoped += transform.inertScopedKeys;
	for (const [index, additions] of transform.entryAdditions) {
		updateEntry(draft, index, (entry) => withEntryRecordAdditions(entry, kind, additions));
	}
	for (const [index, ids] of transform.entryDeclares) {
		draft.counts.movedDeclares += ids.length;
		updateEntry(draft, index, (entry) => withEntryDeclares(entry, ids));
	}
	draft.valueWrites.push({ section: newId, value: transform.value });
	draft.deletions.push(oldId);
	draft.renamedSettings += 1;
	return transform.value;
}

/**
 * Copies the removed global headers setting into every accepted entry and deletes it, or leaves it in place. The
 * copies are the whole migration, so the deleted setting survives as plaintext in the user's own settings.json. A
 * value no entry can receive is left in place instead, and the inert-global-headers hint points at it: every accepted
 * entry sent these headers under the old runtime, so one blocked entry keeps the setting for all.
 */
function moveGlobalHeaders(draft: PlanDraft): void {
	const rawHeaders = globalOf(draft, LEGACY_HEADERS_ID);
	if (rawHeaders === undefined) {
		return;
	}
	if (!isRecord(rawHeaders) || Object.keys(rawHeaders).length === 0) {
		// Nothing any entry could receive: the old readers sent nothing for this value, so it drains without a copy.
		draft.deletions.push(LEGACY_HEADERS_ID);
		draft.logLines.push("Removed the global headers setting from user settings; it carried no usable headers");
		return;
	}
	const blocked = draft.targets.some(
		(target) => !entrySlotAccepts(entryAt(draft, target.entryIndex), ENTRY_SLOTS.headers)
	);
	if (draft.targets.length === 0 || blocked) {
		draft.logLines.push(
			"Left the global headers setting in place: no declared server entry can receive it, or one cannot (see the dashboard hint)"
		);
		return;
	}
	for (const target of draft.targets) {
		updateEntry(draft, target.entryIndex, (entry) => withEntryHeaders(entry, rawHeaders));
	}
	draft.deletions.push(LEGACY_HEADERS_ID);
	draft.logLines.push(
		`Copied the global headers setting into ${draft.targets.length} server ${entriesNoun(draft.targets.length)} and removed it`
	);
}

/** Merges the removed default* token settings into the capabilities "*" record; logs what moved, drained, or stayed. */
function mergeTokenDefaultsInto(draft: PlanDraft, capabilitiesValue: unknown): void {
	const trio = mergeTokenDefaults(capabilitiesValue, draft.snapshot);
	if (trio.capabilitiesValue !== undefined) {
		const existing = draft.valueWrites.findIndex((write) => write.section === NEW_MODEL_CAPABILITIES_ID);
		const write: SettingWrite = { section: NEW_MODEL_CAPABILITIES_ID, value: trio.capabilitiesValue };
		if (existing >= 0) {
			draft.valueWrites[existing] = write;
		} else {
			draft.valueWrites.push(write);
		}
	}
	draft.deletions.push(...trio.consumedIds);
	if (trio.movedFields > 0) {
		draft.logLines.push(
			`Moved ${trio.movedFields} default token setting value(s) into the models.capabilities "*" record in user settings`
		);
	}
	if (trio.drainedKeys > 0) {
		draft.logLines.push(
			`Removed ${trio.drainedKeys} default token setting key(s) from user settings; the models.capabilities "*" record already covered them`
		);
	}
	if (trio.blockedValues > 0) {
		draft.logLines.push(
			`Left ${trio.blockedValues} default token setting value(s) in user settings: the models.capabilities "*" record is not a mergeable record`
		);
	}
}

/**
 * Renames the scalar settings, values carried verbatim; a new name already holding a value keeps it (sync-race
 * rule).
 */
function renameScalars(draft: PlanDraft): void {
	for (const { oldId, newId } of LEGACY_SCALAR_RENAMES) {
		const oldValue = globalOf(draft, oldId);
		if (oldValue === undefined) {
			continue;
		}
		if (globalOf(draft, newId) !== undefined) {
			draft.deletions.push(oldId);
			draft.keptNewNames += 1;
			continue;
		}
		draft.valueWrites.push({ section: newId, value: oldValue });
		draft.deletions.push(oldId);
		draft.renamedSettings += 1;
	}
}

/** The count lines about record keys and directives, in the order the runner prints them. */
function appendRecordLines(draft: PlanDraft): void {
	const { counts, logLines } = draft;
	if (counts.starredKeys > 0) {
		logLines.push(`Rewrote ${counts.starredKeys} record key(s) to explicit matchers`);
	}
	if (counts.droppedAliasKeys > 0) {
		logLines.push(`Dropped ${counts.droppedAliasKeys} duplicate catch-all record key(s)`);
	}
	if (draft.movedScoped > 0) {
		logLines.push(`Moved ${draft.movedScoped} server-scoped record key(s) into their matching entries`);
	}
	if (draft.inertScoped > 0) {
		logLines.push(
			`Left ${draft.inertScoped} server-scoped record key(s) in place: no declared entry at their URL can receive them, or one cannot (see the dashboard hint)`
		);
	}
	if (counts.movedDeclares > 0) {
		logLines.push(`Moved ${counts.movedDeclares} _declare directive(s) into their entries' declared model lists`);
	}
	if (counts.strippedInertDeclares > 0) {
		logLines.push(`Removed ${counts.strippedInertDeclares} inert _declare directive(s)`);
	}
	if (counts.rewroteForceDirectives > 0) {
		logLines.push(
			`Rewrote ${counts.rewroteForceDirectives} migrated _force directive(s) to their old forceable coverage`
		);
	}
}

/** How many workspace-layer values of renamed or removed settings the snapshot holds; the migration leaves them. */
function workspaceLayerHits(snapshot: SettingsSnapshot): number {
	return LEGACY_SETTING_IDS.reduce((count, id) => {
		const layers = snapshot[id];
		return (
			count + (layers?.workspaceValue === undefined ? 0 : 1) + (layers?.workspaceFolderValue === undefined ? 0 : 1)
		);
	}, 0);
}

/** The summary lines in the order the runner prints them; the rename line leads whatever was logged on the way. */
function appendSummaryLines(draft: PlanDraft): void {
	const { counts, logLines } = draft;
	if (draft.renamedSettings > 0) {
		logLines.unshift(`Renamed ${draft.renamedSettings} setting(s) to their new names in user settings`);
	}
	if (draft.keptNewNames > 0) {
		logLines.push(`Dropped ${draft.keptNewNames} old setting key(s) whose new names already hold a value`);
	}
	if (counts.restructuredEntries > 0) {
		logLines.push(
			`Restructured ${counts.restructuredEntries} server ${entriesNoun(counts.restructuredEntries)} to the redesigned shape`
		);
	}
	if (counts.droppedJunkFields > 0) {
		logLines.push(`Dropped ${counts.droppedJunkFields} legacy entry field value(s) the old readers never honored`);
	}
	if (counts.blockedFields > 0) {
		logLines.push(
			`Left ${counts.blockedFields} legacy entry field(s) in place: the entry's destination slot holds a value that cannot take them`
		);
	}
	appendRecordLines(draft);
	const workspaceHits = workspaceLayerHits(draft.snapshot);
	if (workspaceHits > 0) {
		logLines.push(
			`${workspaceHits} workspace-layer value(s) of renamed or removed settings were left in place (use the new setting names in that scope instead)`
		);
	}
}

export function planSettingsRedesign(snapshot: SettingsSnapshot): RedesignPlan {
	const rawServers = snapshot[SERVERS_ID]?.globalValue;
	const restructured = restructureServers(rawServers);
	const draft: PlanDraft = {
		snapshot,
		serversValue: restructured.value,
		//   Acceptance over the restructured value; indices are stable -> targets stay valid while additions land
		targets: scopedMoveTargets(restructured.value),
		counts: restructured.counts,
		logLines: [],
		valueWrites: [],
		deletions: [],
		renamedSettings: 0,
		keptNewNames: 0,
		movedScoped: 0,
		inertScoped: 0,
	};

	moveRecordSetting(draft, LEGACY_MODEL_PARAMETERS_ID, NEW_MODEL_PARAMETERS_ID, "parameters");
	const capabilitiesValue = moveRecordSetting(
		draft,
		LEGACY_MODEL_CAPABILITIES_ID,
		NEW_MODEL_CAPABILITIES_ID,
		"capabilities"
	);
	moveGlobalHeaders(draft);
	mergeTokenDefaultsInto(draft, capabilitiesValue);
	renameScalars(draft);

	const writes: SettingWrite[] = [];
	if (!isDeepStrictEqual(draft.serversValue, rawServers)) {
		writes.push({ section: SERVERS_ID, value: draft.serversValue });
	}
	writes.push(...draft.valueWrites);
	writes.push(...draft.deletions.map((section) => ({ section, value: undefined })));

	appendSummaryLines(draft);
	return {
		writes,
		logLines: draft.logLines,
		outcome: writes.length > 0 ? "migrated" : "nothing-to-do",
	};
}
