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
import type { RecordKind, ScopedMoveTargetState } from "./records";
import { transformGlobalRecord } from "./records";
import { mergeTokenDefaults } from "./tokenDefaults";
import type { RedesignPlan, SettingsSnapshot, SettingWrite } from "./types";

/** Count-noun helper: "1 entry" / "3 entries" stays English (log lines feed public issue reports). */
function entriesNoun(count: number): string {
	return count === 1 ? "entry" : "entries";
}

export function planSettingsRedesign(snapshot: SettingsSnapshot): RedesignPlan {
	const globalOf = (id: string): unknown => snapshot[id]?.globalValue;
	const logLines: string[] = [];
	const valueWrites: SettingWrite[] = [];
	const deletions: string[] = [];

	let renamedSettings = 0;
	let keptNewNames = 0;
	let movedScoped = 0;
	let inertScoped = 0;

	const rawServers = globalOf(SERVERS_ID);
	const restructured = restructureServers(rawServers);
	let serversValue = restructured.value;
	const counts = restructured.counts;
	//   Acceptance over the restructured value; indices are stable -> targets stay valid while additions land
	const targets = scopedMoveTargets(serversValue);

	const entryAt = (index: number): unknown => (Array.isArray(serversValue) ? serversValue[index] : undefined);
	const updateEntry = (index: number, update: (entry: Record<string, unknown>) => Record<string, unknown>): void => {
		if (!Array.isArray(serversValue)) {
			return;
		}
		const entry = serversValue[index];
		if (!isRecord(entry)) {
			return;
		}
		const next = update(entry);
		if (next !== entry) {
			const copy = [...serversValue];
			copy[index] = next;
			serversValue = copy;
		}
	};

	const processRecord = (oldId: string, newId: string, kind: RecordKind): { value: unknown } => {
		const oldValue = globalOf(oldId);
		const newValue = globalOf(newId);
		if (oldValue === undefined) {
			return { value: newValue };
		}
		if (newValue !== undefined) {
			// The sync-race rule, which is also the crash-recovery rule: the new name already holds a value (Settings
			// Sync delivered it, or an earlier run wrote it and crashed before the deletion) - keep it, drop the old
			// key.
			//
			//   Under the Settings Sync reading -> knowingly lossy for THIS machine's entries
			deletions.push(oldId);
			keptNewNames += 1;
			return { value: newValue };
		}
		const slotStates: ScopedMoveTargetState[] = targets.map((target) => {
			const entry = entryAt(target.entryIndex);
			return {
				...target,
				acceptsRecords: entrySlotAccepts(entry, ENTRY_SLOTS[kind]),
				acceptsDeclares: entrySlotAccepts(entry, ENTRY_SLOTS.declared),
			};
		});
		const transform = transformGlobalRecord(oldValue, kind, slotStates);
		counts.starredKeys += transform.starredKeys;
		counts.droppedAliasKeys += transform.droppedAliasKeys;
		counts.strippedInertDeclares += transform.strippedInertDeclares;
		counts.rewroteForceDirectives += transform.rewroteForce;
		movedScoped += transform.movedScopedKeys;
		inertScoped += transform.inertScopedKeys;
		for (const [index, additions] of transform.entryAdditions) {
			updateEntry(index, (entry) => withEntryRecordAdditions(entry, kind, additions));
		}
		for (const [index, ids] of transform.entryDeclares) {
			counts.movedDeclares += ids.length;
			updateEntry(index, (entry) => withEntryDeclares(entry, ids));
		}
		valueWrites.push({ section: newId, value: transform.value });
		deletions.push(oldId);
		renamedSettings += 1;
		return { value: transform.value };
	};

	processRecord(LEGACY_MODEL_PARAMETERS_ID, NEW_MODEL_PARAMETERS_ID, "parameters");
	const capabilitiesState = processRecord(LEGACY_MODEL_CAPABILITIES_ID, NEW_MODEL_CAPABILITIES_ID, "capabilities");

	//   The copies are the whole migration -> the deleted setting survives as plaintext in the user's own settings.json
	//   A value no entry can receive is left in place instead -> the inert-global-headers hint points at it
	const rawHeaders = globalOf(LEGACY_HEADERS_ID);
	if (rawHeaders !== undefined) {
		if (!isRecord(rawHeaders) || Object.keys(rawHeaders).length === 0) {
			// Nothing any entry could receive: the old readers sent nothing for this value, so it drains without a
			// copy.
			deletions.push(LEGACY_HEADERS_ID);
			logLines.push("Removed the global headers setting from user settings; it carried no usable headers");
		} else {
			// Every accepted entry sent these headers under the old runtime, so one blocked entry keeps the setting for all.
			const blocked = targets.some((target) => !entrySlotAccepts(entryAt(target.entryIndex), ENTRY_SLOTS.headers));
			if (targets.length === 0 || blocked) {
				logLines.push(
					"Left the global headers setting in place: no declared server entry can receive it, or one cannot (see the dashboard hint)"
				);
			} else {
				for (const target of targets) {
					updateEntry(target.entryIndex, (entry) => withEntryHeaders(entry, rawHeaders));
				}
				deletions.push(LEGACY_HEADERS_ID);
				logLines.push(
					`Copied the global headers setting into ${targets.length} server ${entriesNoun(targets.length)} and removed it`
				);
			}
		}
	}

	const trio = mergeTokenDefaults(capabilitiesState.value, snapshot);
	if (trio.capabilitiesValue !== undefined) {
		const existing = valueWrites.findIndex((write) => write.section === NEW_MODEL_CAPABILITIES_ID);
		const write: SettingWrite = { section: NEW_MODEL_CAPABILITIES_ID, value: trio.capabilitiesValue };
		if (existing >= 0) {
			valueWrites[existing] = write;
		} else {
			valueWrites.push(write);
		}
	}
	deletions.push(...trio.consumedIds);
	if (trio.movedFields > 0) {
		logLines.push(
			`Moved ${trio.movedFields} default token setting value(s) into the models.capabilities "*" record in user settings`
		);
	}
	if (trio.drainedKeys > 0) {
		logLines.push(
			`Removed ${trio.drainedKeys} default token setting key(s) from user settings; the models.capabilities "*" record already covered them`
		);
	}
	if (trio.blockedValues > 0) {
		logLines.push(
			`Left ${trio.blockedValues} default token setting value(s) in user settings: the models.capabilities "*" record is not a mergeable record`
		);
	}

	for (const { oldId, newId } of LEGACY_SCALAR_RENAMES) {
		const oldValue = globalOf(oldId);
		if (oldValue === undefined) {
			continue;
		}
		if (globalOf(newId) !== undefined) {
			deletions.push(oldId);
			keptNewNames += 1;
			continue;
		}
		valueWrites.push({ section: newId, value: oldValue });
		deletions.push(oldId);
		renamedSettings += 1;
	}

	const writes: SettingWrite[] = [];
	if (!isDeepStrictEqual(serversValue, rawServers)) {
		writes.push({ section: SERVERS_ID, value: serversValue });
	}
	writes.push(...valueWrites);
	writes.push(...deletions.map((section) => ({ section, value: undefined })));

	if (renamedSettings > 0) {
		logLines.unshift(`Renamed ${renamedSettings} setting(s) to their new names in user settings`);
	}
	if (keptNewNames > 0) {
		logLines.push(`Dropped ${keptNewNames} old setting key(s) whose new names already hold a value`);
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
	if (counts.starredKeys > 0) {
		logLines.push(`Rewrote ${counts.starredKeys} record key(s) to explicit matchers`);
	}
	if (counts.droppedAliasKeys > 0) {
		logLines.push(`Dropped ${counts.droppedAliasKeys} duplicate catch-all record key(s)`);
	}
	if (movedScoped > 0) {
		logLines.push(`Moved ${movedScoped} server-scoped record key(s) into their matching entries`);
	}
	if (inertScoped > 0) {
		logLines.push(
			`Left ${inertScoped} server-scoped record key(s) in place: no declared entry at their URL can receive them, or one cannot (see the dashboard hint)`
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
	const workspaceHits = LEGACY_SETTING_IDS.reduce((count, id) => {
		const layers = snapshot[id];
		return (
			count + (layers?.workspaceValue !== undefined ? 1 : 0) + (layers?.workspaceFolderValue !== undefined ? 1 : 0)
		);
	}, 0);
	if (workspaceHits > 0) {
		logLines.push(
			`${workspaceHits} workspace-layer value(s) of renamed or removed settings were left in place (use the new setting names in that scope instead)`
		);
	}

	return {
		writes,
		logLines,
		outcome: writes.length > 0 ? "migrated" : "nothing-to-do",
	};
}
